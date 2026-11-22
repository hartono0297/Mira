//! Talking to colleagues' laptops (plan section 2, contract 3.1).
//!
//! One QUIC endpoint per instance listens and dials. Both sides present a
//! self-signed Ed25519 certificate made from the laptop key and prove it in
//! the TLS 1.3 handshake (`tls`). After the handshake the application checks
//! membership through `SyncBackend::peer_auth` and exchanges `Hello`
//! (`node`). Members then sync opaque signed ops (`node`), non-members may
//! only redeem an invite on the join ALPN (`join`). Peers are found with
//! mDNS and remembered or manual addresses (`discovery`).
//!
//! This module knows nothing about SQLite or the op format beyond the op id
//! (BLAKE3 of the payload). Everything else is decided by the backend.

mod discovery;
pub mod feature;
mod join;
mod node;
pub mod route;
pub mod tls;
pub mod wire;

#[cfg(test)]
pub mod testing;
#[cfg(test)]
mod tests;

use std::net::SocketAddr;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use node::Inner;

/// Settings for `Network::start`.
pub struct NetConfig {
    /// The laptop's Ed25519 secret key, used for the TLS certificate.
    pub identity_secret: zeroize::Zeroizing<[u8; 32]>,
    /// 64 hex; must match `identity_secret`.
    pub public_key: String,
    /// `MIRA_PORT`. `None`: first free port of 47800..=47809.
    /// `Some(0)`: an ephemeral port chosen by the OS (used by tests).
    pub port: Option<u16>,
    /// `!MIRA_DISABLE_MDNS`.
    pub mdns_enabled: bool,
}

impl std::fmt::Debug for NetConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NetConfig")
            .field("public_key", &self.public_key)
            .field("port", &self.port)
            .field("mdns_enabled", &self.mdns_enabled)
            .finish_non_exhaustive()
    }
}

/// A signed op as sent on the wire; same shape as `permissions::SignedOp`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireOp {
    pub payload: String,
    pub sig: String,
}

/// Genesis record of an organization, as sent to a laptop that joins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrgRecord {
    pub id: String,
    pub name: String,
    pub founder_public_key: String,
    pub created_at: String,
    pub genesis_signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinChallenge {
    pub org: String,
    pub invite: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinProof {
    pub member: String,
    pub name: String,
    pub invite_sig: String,
    pub member_sig: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinAccepted {
    pub org: OrgRecord,
    pub ops: Vec<WireOp>,
}

/// What the backend says about a key proven in a handshake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerAuth {
    Member {
        display_name: String,
    },
    /// Removed from the organization. `removal` is the op that removed them,
    /// sent once so their laptop learns about it.
    Removed {
        removal: Option<WireOp>,
    },
    Unknown,
}

/// Why a join attempt failed. Codes: `invite_not_found`, `invite_expired`,
/// `invite_used`, `invite_revoked`, `invalid_proof`, `rate_limited`,
/// `no_peer_found`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinReject {
    pub code: String,
    pub message: String,
}

impl JoinReject {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.to_owned(),
            message: message.to_owned(),
        }
    }
}

impl std::fmt::Display for JoinReject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for JoinReject {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct IngestOutcome {
    pub new_ops: usize,
}

/// An address to dial: remembered for a key, or manual (`public_key` may be
/// `None` until a connection proves who is there).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownAddress {
    pub public_key: Option<String>,
    pub address: SocketAddr,
    pub last_success_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AddressSource {
    Mdns,
    Hello,
    Incoming,
    Outgoing,
    Manual,
}

impl AddressSource {
    pub fn as_str(self) -> &'static str {
        match self {
            AddressSource::Mdns => "mdns",
            AddressSource::Hello => "hello",
            AddressSource::Incoming => "incoming",
            AddressSource::Outgoing => "outgoing",
            AddressSource::Manual => "manual",
        }
    }
}

/// Everything the network needs from the rest of the app. Methods are
/// synchronous and should be fast; the network calls the slow ones (sync and
/// join) on tokio's blocking pool.
pub trait SyncBackend: Send + Sync + 'static {
    /// `None`: not joined yet, or removed.
    fn org_id(&self) -> Option<String>;
    fn display_name(&self) -> Option<String>;
    fn peer_auth(&self, public_key: &str) -> PeerAuth;
    /// Public keys of active members, without this laptop.
    fn active_members(&self) -> Vec<String>;
    /// Ids of the ops `peer` may receive.
    fn op_ids_for(&self, peer: &str) -> Result<Vec<String>, String>;
    /// The ops among `ids` that `peer` may receive (filtered again).
    fn ops_for(&self, peer: &str, ids: &[String]) -> Result<Vec<WireOp>, String>;
    fn ingest(&self, from: &str, ops: Vec<WireOp>) -> Result<IngestOutcome, String>;
    fn join_lookup(&self, tag: &str) -> Result<JoinChallenge, JoinReject>;
    fn join_accept(
        &self,
        tls_key: &str,
        challenge: &JoinChallenge,
        proof: JoinProof,
    ) -> Result<JoinAccepted, JoinReject>;
    /// Remembered and manual addresses.
    fn known_addresses(&self) -> Vec<KnownAddress>;
    fn remember_address(&self, public_key: &str, address: SocketAddr, source: AddressSource);
    /// Result of dialing an address from `known_addresses`: `Ok(pk)` or
    /// `Err(message)`. Called for every such address; the adapter updates the
    /// row only if the address is a manual one.
    fn manual_attempt(&self, address: SocketAddr, result: Result<String, String>);
    fn log_rejection(
        &self,
        peer: Option<&str>,
        address: Option<SocketAddr>,
        code: &str,
        detail: &str,
    );

    /// Of the offered op ids, the ones this laptop does not have yet (answer
    /// to `SyncHave`). Addition to plan 3.1: the default asks for every id,
    /// which is correct (ingest ignores duplicates) but sends everything on
    /// every sync. The adapter should override it with a database lookup.
    fn unknown_op_ids(&self, ids: &[String]) -> Result<Vec<String>, String> {
        Ok(ids.to_vec())
    }
}

/// Sent to the UI (`mira://network`, `mira://directory`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetEvent {
    /// Connection state or peer list changed.
    StatusChanged,
    /// New ops were applied.
    OrgChanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetState {
    Starting,
    NoOrg,
    Alone,
    Lan,
    Vpn,
    Offline,
    /// Set by the adapter; the network never produces it.
    Removed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Route {
    Lan,
    Vpn,
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerConn {
    pub public_key: String,
    pub address: SocketAddr,
    pub route: Route,
    pub connected_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetStatusSnapshot {
    pub state: NetState,
    pub listen_port: Option<u16>,
    /// Shareable IPv4 addresses of this laptop with the listen port.
    pub local_addresses: Vec<SocketAddr>,
    /// Peers with a live connection.
    pub peers: Vec<PeerConn>,
    pub mdns_ok: bool,
    pub mdns_error: Option<String>,
}

/// Builds the `JoinProof` for a challenge (called at most once per join).
pub type ProveFn = Box<dyn FnOnce(&JoinChallenge) -> Result<JoinProof, String> + Send>;

/// Handle to the running network. Cheap to clone.
#[derive(Clone)]
pub struct Network {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Network {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Network")
            .field("public_key", &self.inner.me)
            .field("listen_port", &self.inner.listen_port)
            .finish_non_exhaustive()
    }
}

impl Network {
    /// Binds the endpoint and starts listening, mDNS, dialing and sync.
    /// Must be called inside a tokio runtime.
    pub async fn start(
        cfg: NetConfig,
        backend: Arc<dyn SyncBackend>,
        events: Arc<dyn Fn(NetEvent) + Send + Sync>,
    ) -> Result<Network, String> {
        let inner = Inner::start(cfg, backend, events).await?;
        Ok(Network { inner })
    }

    /// The organization or ops changed: re-advertise mDNS, re-check peers,
    /// dial members that are not connected, and sync with everyone.
    pub fn refresh(&self) {
        self.inner.refresh();
    }

    pub fn status(&self) -> NetStatusSnapshot {
        self.inner.status()
    }

    /// Public keys of the peers with a live connection. Addition to 3.1.
    pub fn connected_peers(&self) -> Vec<String> {
        self.inner.connected_peers()
    }

    /// Redeems an invite on a laptop that is already a member. Candidates are
    /// the `extra` addresses and laptops found with mDNS. `prove` is called
    /// once, with the first challenge received.
    pub async fn join(
        &self,
        tag: &str,
        extra: Vec<SocketAddr>,
        prove: ProveFn,
    ) -> Result<JoinAccepted, JoinReject> {
        join::join(&self.inner, tag, extra, prove).await
    }

    /// Closes all connections and the endpoint, and stops mDNS.
    pub async fn shutdown(&self) {
        self.inner.shutdown().await;
    }
}
