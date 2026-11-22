//! TLS for QUIC: a self-signed Ed25519 certificate made from the laptop key,
//! and custom verifiers that take the peer's key from its certificate
//! (plan 2.1).
//!
//! The verifiers accept any well-formed Ed25519 certificate (no CA, no host
//! name, no validity period) but always check the TLS 1.3 `CertificateVerify`
//! signature against the key in that certificate. That signature covers the
//! handshake transcript, so a peer can only present a certificate whose
//! private key it holds. The peer identity is then the key from the
//! certificate rustls actually verified, never one named in a message.

use std::sync::Arc;
use std::time::Duration;

use ed25519_dalek::pkcs8::EncodePrivateKey;
use ed25519_dalek::{Signature, SigningKey, VerifyingKey};
use quinn::crypto::rustls::{QuicClientConfig, QuicServerConfig};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, WebPkiSupportedAlgorithms, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::sign::CertifiedKey;
use rustls::{
    CertificateError, DigitallySignedStruct, DistinguishedName, Error as TlsError, PeerMisbehaved,
    SignatureScheme,
};

/// ALPN for members of an organization.
pub const ALPN_MEMBER: &[u8] = b"mira/1";
/// ALPN for a laptop that redeems an invite code.
pub const ALPN_JOIN: &[u8] = b"mira-join/1";

/// Server name sent in the ClientHello. Ignored by the verifiers.
pub const SERVER_NAME: &str = "mira.peer";

pub const KEEP_ALIVE: Duration = Duration::from_secs(5);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(20);
/// Streams a peer may have open at once on one connection.
pub const MAX_BIDI_STREAMS: u32 = 8;
pub const MAX_UNI_STREAMS: u32 = 4;
/// Incoming connection attempts quinn buffers before refusing new ones.
pub const MAX_INCOMING: usize = 256;
/// Flow-control window per stream and for the whole connection. The
/// connection window bounds what a peer can park in memory on streams the
/// application never reads (it is replenished as data is read, so it limits
/// throughput, not frame size).
///
/// The stream window is small enough that `MAX_BIDI_STREAMS - 1` busy
/// streams (one op sync, four feature sessions and two blob downloads hold
/// 3.5 MiB) cannot fill the connection window: there is always room left
/// for the op-sync session and `Removed` pushes.
pub const STREAM_WINDOW: u32 = 512 * 1024;
pub const CONNECTION_WINDOW: u32 = 4 * 1024 * 1024;
const _: () = assert!(
    (MAX_BIDI_STREAMS as u64 - 1) * (STREAM_WINDOW as u64) < CONNECTION_WINDOW as u64,
    "seven busy streams must not fill the connection window"
);

/// DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410): SEQUENCE,
/// AlgorithmIdentifier { id-Ed25519 } with no parameters, BIT STRING of 32
/// bytes. The full SPKI is this prefix followed by the raw key.
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// This laptop's certificate and signing key for TLS.
#[derive(Clone)]
pub struct TlsIdentity {
    pub(crate) certified: Arc<CertifiedKey>,
    pub(crate) public_key: String,
}

impl std::fmt::Debug for TlsIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TlsIdentity")
            .field("public_key", &self.public_key)
            .finish_non_exhaustive()
    }
}

impl TlsIdentity {
    /// Builds the certificate from the laptop's Ed25519 secret key.
    pub fn new(secret: &[u8; 32]) -> Result<Self, String> {
        let signing = SigningKey::from_bytes(secret);
        let public_key = hex::encode(signing.verifying_key().as_bytes());
        // `SecretDocument` wipes itself on drop.
        let pkcs8 = signing
            .to_pkcs8_der()
            .map_err(|e| format!("kunci PKCS#8 gagal dibuat: {e}"))?;
        let der = PrivatePkcs8KeyDer::from(pkcs8.as_bytes());

        let rc_key = rcgen::KeyPair::from_pkcs8_der_and_sign_algo(&der, &rcgen::PKCS_ED25519)
            .map_err(|e| format!("kunci sertifikat tidak bisa dibaca: {e}"))?;
        let mut params = rcgen::CertificateParams::new(vec![SERVER_NAME.to_owned()])
            .map_err(|e| format!("parameter sertifikat salah: {e}"))?;
        params.distinguished_name.push(
            rcgen::DnType::CommonName,
            format!("mira {}", &public_key[..16]),
        );
        let cert = params
            .self_signed(&rc_key)
            .map_err(|e| format!("sertifikat gagal dibuat: {e}"))?;
        let cert_der = cert.der().clone();

        let signer = rustls::crypto::ring::sign::any_eddsa_type(&der)
            .map_err(|e| format!("kunci TLS tidak bisa dipakai: {e}"))?;

        // The certificate must carry exactly this key.
        let in_cert = public_key_from_cert(cert_der.as_ref())?;
        if hex::encode(in_cert) != public_key {
            return Err("sertifikat tidak cocok dengan kunci laptop".into());
        }
        Ok(Self {
            certified: Arc::new(CertifiedKey::new(vec![cert_der], signer)),
            public_key,
        })
    }

    pub fn public_key(&self) -> &str {
        &self.public_key
    }
}

/// Extracts the Ed25519 public key from a DER certificate. Rejects anything
/// that is not a complete, well-formed X.509 certificate with an Ed25519 key.
pub fn public_key_from_cert(der: &[u8]) -> Result<[u8; 32], String> {
    let (rest, cert) =
        x509_parser::parse_x509_certificate(der).map_err(|e| format!("sertifikat rusak: {e}"))?;
    if !rest.is_empty() {
        return Err("sertifikat berisi data tambahan".into());
    }
    let spki = cert.public_key().raw;
    if spki.len() != ED25519_SPKI_PREFIX.len() + 32 || !spki.starts_with(&ED25519_SPKI_PREFIX) {
        return Err("sertifikat bukan kunci Ed25519".into());
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&spki[ED25519_SPKI_PREFIX.len()..]);
    let vk = VerifyingKey::from_bytes(&key).map_err(|_| "kunci Ed25519 tidak sah".to_owned())?;
    if vk.is_weak() {
        return Err("kunci Ed25519 lemah ditolak".into());
    }
    Ok(key)
}

/// Hex public key of the peer, from the certificate it presented and proved
/// during the handshake. `None` if the connection has no peer certificate.
pub fn peer_public_key(conn: &quinn::Connection) -> Option<String> {
    let identity = conn.peer_identity()?;
    let certs = identity.downcast::<Vec<CertificateDer<'static>>>().ok()?;
    if certs.len() != 1 {
        return None;
    }
    let first = certs.first()?;
    public_key_from_cert(first.as_ref()).ok().map(hex::encode)
}

/// ALPN agreed in the handshake.
pub fn negotiated_alpn(conn: &quinn::Connection) -> Option<Vec<u8>> {
    let data = conn.handshake_data()?;
    let data = data
        .downcast::<quinn::crypto::rustls::HandshakeData>()
        .ok()?;
    data.protocol
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Verifier used on both sides. See the module docs.
#[derive(Debug)]
pub(crate) struct PeerVerifier {
    algs: WebPkiSupportedAlgorithms,
}

impl PeerVerifier {
    pub(crate) fn new() -> Self {
        Self {
            algs: rustls::crypto::ring::default_provider().signature_verification_algorithms,
        }
    }

    fn check_cert(
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
    ) -> Result<(), TlsError> {
        if !intermediates.is_empty() {
            return Err(TlsError::InvalidCertificate(CertificateError::BadEncoding));
        }
        public_key_from_cert(end_entity.as_ref())
            .map(|_| ())
            .map_err(|_| TlsError::InvalidCertificate(CertificateError::BadEncoding))
    }

    fn check_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        if dss.scheme != SignatureScheme::ED25519 {
            return Err(PeerMisbehaved::SignedHandshakeWithUnadvertisedSigScheme.into());
        }
        // rustls/webpki check with the provider's algorithms.
        let valid = verify_tls13_signature(message, cert, dss, &self.algs)?;
        // Same check against the exact key we take as the peer identity, so
        // the identity and the verified key cannot come from different
        // parsers' readings of the certificate.
        let key = public_key_from_cert(cert.as_ref())
            .map_err(|_| TlsError::InvalidCertificate(CertificateError::BadEncoding))?;
        let vk = VerifyingKey::from_bytes(&key)
            .map_err(|_| TlsError::InvalidCertificate(CertificateError::BadEncoding))?;
        let sig = Signature::from_slice(dss.signature())
            .map_err(|_| TlsError::InvalidCertificate(CertificateError::BadSignature))?;
        vk.verify_strict(message, &sig)
            .map_err(|_| TlsError::InvalidCertificate(CertificateError::BadSignature))?;
        Ok(valid)
    }
}

impl ServerCertVerifier for PeerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        Self::check_cert(end_entity, intermediates)?;
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        Err(TlsError::General("TLS 1.2 tidak diterima".into()))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        self.check_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }
}

impl ClientCertVerifier for PeerVerifier {
    fn offer_client_auth(&self) -> bool {
        true
    }

    fn client_auth_mandatory(&self) -> bool {
        true
    }

    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, TlsError> {
        Self::check_cert(end_entity, intermediates)?;
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        Err(TlsError::General("TLS 1.2 tidak diterima".into()))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        self.check_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }
}

#[derive(Debug)]
struct FixedServerCert(Arc<CertifiedKey>);

impl rustls::server::ResolvesServerCert for FixedServerCert {
    fn resolve(&self, _hello: rustls::server::ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(self.0.clone())
    }
}

#[derive(Debug)]
struct FixedClientCert(Arc<CertifiedKey>);

impl rustls::client::ResolvesClientCert for FixedClientCert {
    fn resolve(
        &self,
        _root_hint_subjects: &[&[u8]],
        sigschemes: &[SignatureScheme],
    ) -> Option<Arc<CertifiedKey>> {
        sigschemes
            .contains(&SignatureScheme::ED25519)
            .then(|| self.0.clone())
    }

    fn has_certs(&self) -> bool {
        true
    }
}

pub(crate) fn transport_config() -> Result<quinn::TransportConfig, String> {
    let mut t = quinn::TransportConfig::default();
    t.keep_alive_interval(Some(KEEP_ALIVE));
    t.max_idle_timeout(Some(
        quinn::IdleTimeout::try_from(IDLE_TIMEOUT).map_err(|e| e.to_string())?,
    ));
    t.max_concurrent_bidi_streams(MAX_BIDI_STREAMS.into());
    t.max_concurrent_uni_streams(MAX_UNI_STREAMS.into());
    // Mira never uses datagrams; quinn would otherwise buffer about 1.25 MB
    // of them per connection for anyone who completes a handshake.
    t.datagram_receive_buffer_size(None);
    t.stream_receive_window(STREAM_WINDOW.into());
    t.receive_window(CONNECTION_WINDOW.into());
    Ok(t)
}

/// Server side: TLS 1.3 only, client certificate required, both ALPNs,
/// no session tickets or resumption, no 0-RTT.
pub(crate) fn server_config(id: &TlsIdentity) -> Result<quinn::ServerConfig, String> {
    let mut tls = rustls::ServerConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| e.to_string())?
        .with_client_cert_verifier(Arc::new(PeerVerifier::new()))
        .with_cert_resolver(Arc::new(FixedServerCert(id.certified.clone())));
    tls.alpn_protocols = vec![ALPN_MEMBER.to_vec(), ALPN_JOIN.to_vec()];
    tls.max_early_data_size = 0;
    tls.send_tls13_tickets = 0;
    tls.session_storage = Arc::new(rustls::server::NoServerSessionStorage {});

    let quic = QuicServerConfig::try_from(tls).map_err(|e| e.to_string())?;
    let mut cfg = quinn::ServerConfig::with_crypto(Arc::new(quic));
    cfg.transport_config(Arc::new(transport_config()?));
    cfg.max_incoming(MAX_INCOMING);
    Ok(cfg)
}

/// Client side for one ALPN: TLS 1.3 only, presents our certificate, no
/// resumption, no 0-RTT.
pub(crate) fn client_config(id: &TlsIdentity, alpn: &[u8]) -> Result<quinn::ClientConfig, String> {
    let mut tls = rustls::ClientConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PeerVerifier::new()))
        .with_client_cert_resolver(Arc::new(FixedClientCert(id.certified.clone())));
    tls.alpn_protocols = vec![alpn.to_vec()];
    tls.enable_early_data = false;
    tls.resumption = rustls::client::Resumption::disabled();

    let quic = QuicClientConfig::try_from(tls).map_err(|e| e.to_string())?;
    let mut cfg = quinn::ClientConfig::new(Arc::new(quic));
    cfg.transport_config(Arc::new(transport_config()?));
    Ok(cfg)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::net::{Ipv4Addr, SocketAddr};

    pub(crate) fn secret(n: u8) -> [u8; 32] {
        [n; 32]
    }

    /// Certificate of `cert_secret` paired with the signing key of
    /// `key_secret`: a peer claiming a key it does not hold.
    pub(crate) fn forged_identity(cert_secret: u8, key_secret: u8) -> TlsIdentity {
        let real = TlsIdentity::new(&secret(cert_secret)).unwrap();
        let other = TlsIdentity::new(&secret(key_secret)).unwrap();
        TlsIdentity {
            certified: Arc::new(CertifiedKey::new(
                real.certified.cert.clone(),
                other.certified.key.clone(),
            )),
            public_key: real.public_key,
        }
    }

    fn server(id: &TlsIdentity) -> quinn::Endpoint {
        let sock = std::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        quinn::Endpoint::new(
            quinn::EndpointConfig::default(),
            Some(server_config(id).unwrap()),
            sock,
            quinn::default_runtime().unwrap(),
        )
        .unwrap()
    }

    fn client() -> quinn::Endpoint {
        quinn::Endpoint::client(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap()
    }

    #[test]
    fn certificate_carries_the_laptop_key() {
        let id = TlsIdentity::new(&secret(7)).unwrap();
        let expected = hex::encode(
            SigningKey::from_bytes(&secret(7))
                .verifying_key()
                .as_bytes(),
        );
        assert_eq!(id.public_key(), expected);
        let cert = id.certified.cert.first().unwrap();
        assert_eq!(
            hex::encode(public_key_from_cert(cert.as_ref()).unwrap()),
            expected
        );
    }

    #[test]
    fn garbage_certificates_are_rejected() {
        assert!(public_key_from_cert(b"").is_err());
        assert!(public_key_from_cert(b"\x30\x03\x02\x01\x00").is_err());
        let id = TlsIdentity::new(&secret(3)).unwrap();
        let mut der = id.certified.cert[0].as_ref().to_vec();
        der.push(0);
        assert!(public_key_from_cert(&der).is_err(), "trailing bytes");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn both_sides_learn_the_proven_key() {
        let a = TlsIdentity::new(&secret(1)).unwrap();
        let b = TlsIdentity::new(&secret(2)).unwrap();
        let srv = server(&a);
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, srv.local_addr().unwrap().port()));
        let cli = client();

        let accept = tokio::spawn(async move {
            let inc = srv.accept().await.unwrap();
            let conn = inc.await.unwrap();
            let pk = peer_public_key(&conn);
            let alpn = negotiated_alpn(&conn);
            (pk, alpn, srv, conn)
        });
        let conn = cli
            .connect_with(client_config(&b, ALPN_MEMBER).unwrap(), addr, SERVER_NAME)
            .unwrap()
            .await
            .unwrap();
        assert_eq!(peer_public_key(&conn).as_deref(), Some(a.public_key()));
        assert_eq!(negotiated_alpn(&conn).as_deref(), Some(ALPN_MEMBER));
        let (pk, alpn, _srv, _sconn) = accept.await.unwrap();
        assert_eq!(pk.as_deref(), Some(b.public_key()));
        assert_eq!(alpn.as_deref(), Some(ALPN_MEMBER));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn client_with_a_key_it_does_not_hold_fails() {
        let a = TlsIdentity::new(&secret(1)).unwrap();
        let forged = forged_identity(2, 9);
        let srv = server(&a);
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, srv.local_addr().unwrap().port()));
        let cli = client();
        let accept = tokio::spawn(async move {
            let inc = srv.accept().await.unwrap();
            let r = inc.await.map(|c| peer_public_key(&c));
            (r.is_err(), srv)
        });
        let r = tokio::time::timeout(
            Duration::from_secs(10),
            cli.connect_with(
                client_config(&forged, ALPN_MEMBER).unwrap(),
                addr,
                SERVER_NAME,
            )
            .unwrap(),
        )
        .await
        .unwrap();
        // The client may see the handshake complete before the server checks
        // its CertificateVerify, but the server must refuse it.
        let (server_failed, _srv) = accept.await.unwrap();
        assert!(server_failed, "server accepted a forged client certificate");
        if let Ok(conn) = r {
            let reason = tokio::time::timeout(Duration::from_secs(10), conn.closed())
                .await
                .unwrap();
            let _ = reason;
        }
    }

    /// Writes on `s` until the peer's flow control stops it; bytes accepted.
    async fn push_until_blocked(s: &mut quinn::SendStream) -> usize {
        let chunk = vec![0u8; 64 * 1024];
        let mut total = 0;
        while let Ok(Ok(n)) =
            tokio::time::timeout(Duration::from_millis(300), s.write(&chunk)).await
        {
            total += n;
        }
        total
    }

    /// Any laptop that completes a handshake (on the join ALPN it stays
    /// connected for a while) must not be able to park more than a few MiB
    /// in this laptop's memory: no datagrams, and a connection-wide window
    /// over all streams the application never reads.
    #[tokio::test(flavor = "multi_thread")]
    async fn unread_data_from_a_peer_is_bounded() {
        let a = TlsIdentity::new(&secret(1)).unwrap();
        let stranger = TlsIdentity::new(&secret(5)).unwrap();
        let srv = server(&a);
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, srv.local_addr().unwrap().port()));
        let cli = client();
        // The server completes the handshake and then never reads a stream.
        let accept = tokio::spawn(async move {
            let conn = srv.accept().await.unwrap().await.unwrap();
            (srv, conn)
        });
        let conn = cli
            .connect_with(
                client_config(&stranger, ALPN_JOIN).unwrap(),
                addr,
                SERVER_NAME,
            )
            .unwrap()
            .await
            .unwrap();
        let _held = accept.await.unwrap();
        assert_eq!(conn.max_datagram_size(), None, "datagrams must be off");

        let mut total = 0;
        for _ in 0..MAX_UNI_STREAMS {
            let mut s = conn.open_uni().await.unwrap();
            total += push_until_blocked(&mut s).await;
        }
        for _ in 0..MAX_BIDI_STREAMS {
            let (mut s, _r) = conn.open_bi().await.unwrap();
            total += push_until_blocked(&mut s).await;
        }
        assert!(
            total <= CONNECTION_WINDOW as usize + 64 * 1024,
            "peer could buffer {total} bytes"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn server_with_a_key_it_does_not_hold_fails() {
        let forged = forged_identity(1, 9);
        let b = TlsIdentity::new(&secret(2)).unwrap();
        let srv = server(&forged);
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, srv.local_addr().unwrap().port()));
        let cli = client();
        let _accept = tokio::spawn(async move {
            if let Some(inc) = srv.accept().await {
                let _ = inc.await;
            }
            srv
        });
        let r = tokio::time::timeout(
            Duration::from_secs(10),
            cli.connect_with(client_config(&b, ALPN_MEMBER).unwrap(), addr, SERVER_NAME)
                .unwrap(),
        )
        .await
        .unwrap();
        assert!(r.is_err(), "client accepted a forged server certificate");
    }
}
