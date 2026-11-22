//! Sealed envelopes for offline recipients (docs/plans/tahap-2.md, section 5).
//!
//! Key conversion. Every laptop has one Ed25519 key. Encryption needs X25519,
//! so both halves are mapped the way libsodium does it:
//! - public: the Edwards point is mapped to its Montgomery u-coordinate
//!   (`VerifyingKey::to_montgomery`, libsodium
//!   `crypto_sign_ed25519_pk_to_curve25519`);
//! - secret: the first 32 bytes of SHA-512(seed), the same scalar Ed25519
//!   signs with (`SigningKey::to_scalar_bytes`, libsodium
//!   `crypto_sign_ed25519_sk_to_curve25519`).
//!
//! Format. The content is JSON `{"v":1,"record":..,"files":[..]}` prefixed
//! with `SEAL_DOMAIN`, sealed with `crypto_box` sealed boxes (ephemeral
//! X25519 key + XSalsa20-Poly1305, the libsodium `crypto_box_seal` layout:
//! `ephemeral_pk(32) || box`), then base64. Only the recipient's secret key
//! opens it; a custodian sees the recipient, the size and the time.
//!
//! Attachments. A small file is encrypted once with XChaCha20-Poly1305 under
//! a random key: cipher file = `nonce(24) || ciphertext+tag`. The cipher file
//! is an ordinary blob any member may hold; its key travels inside the seal.

use chacha20poly1305::aead::Aead;
use chacha20poly1305::{KeyInit, XChaCha20Poly1305};
use crypto_box::{PublicKey, SecretKey};
use ed25519_dalek::{SigningKey, VerifyingKey};
use hex::FromHex;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::identity::Identity;

/// Prefix of the sealed plaintext, so a sealed blob made for another purpose
/// with the same key never parses as an envelope.
pub const SEAL_DOMAIN: &[u8] = b"mira-seal-v1\n";
pub const SEAL_VERSION: u32 = 1;
/// Nonce length of XChaCha20-Poly1305.
pub const FILE_NONCE_LEN: usize = 24;
/// Poly1305 tag length.
pub const FILE_TAG_LEN: usize = 16;

/// Key for one encrypted attachment: plain hash, cipher hash, key (64 hex).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileKey {
    pub hash: String,
    pub cipher: String,
    pub key: String,
}

/// What an envelope carries for its recipient.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SealedContent {
    pub v: u32,
    /// Body of the signed `message` record.
    pub record: String,
    #[serde(default)]
    pub files: Vec<FileKey>,
}

impl SealedContent {
    pub fn new(record: String, files: Vec<FileKey>) -> Self {
        Self {
            v: SEAL_VERSION,
            record,
            files,
        }
    }
}

/// X25519 public key for an Ed25519 public key given as 64 hex.
///
/// Like libsodium, rejects small-order keys and keys outside the prime-order
/// subgroup: sealing to one gives a shared secret anyone can guess, so a
/// custodian could read the envelope.
pub fn x25519_public(ed_public_hex: &str) -> Result<[u8; 32], String> {
    let bytes = <[u8; 32]>::from_hex(ed_public_hex).map_err(|_| "kunci bukan 64 hex")?;
    let vk = VerifyingKey::from_bytes(&bytes).map_err(|_| "kunci Ed25519 tidak sah")?;
    if vk.is_weak() || !vk.to_edwards().is_torsion_free() {
        return Err("kunci Ed25519 tidak sah".into());
    }
    Ok(vk.to_montgomery().to_bytes())
}

/// X25519 secret scalar for this laptop's Ed25519 key, clamped as libsodium
/// does (crypto_box clamps again, which changes nothing). Wiped when dropped.
pub fn x25519_secret(identity: &Identity) -> Zeroizing<[u8; 32]> {
    let seed = identity.secret_bytes();
    let sk = SigningKey::from_bytes(&seed);
    let mut scalar = Zeroizing::new(sk.to_scalar_bytes());
    scalar[0] &= 248;
    scalar[31] &= 127;
    scalar[31] |= 64;
    scalar
}

/// Seals `content` for the holder of `recipient` (Ed25519 public key, 64 hex)
/// and returns base64.
pub fn seal_for(recipient: &str, content: &SealedContent) -> Result<String, String> {
    let pk = PublicKey::from(x25519_public(recipient)?);
    let json = serde_json::to_vec(content).map_err(|e| e.to_string())?;
    let mut plain = Zeroizing::new(Vec::with_capacity(SEAL_DOMAIN.len() + json.len()));
    plain.extend_from_slice(SEAL_DOMAIN);
    plain.extend_from_slice(&json);
    let sealed = pk
        .seal(&mut OsRng, &plain)
        .map_err(|_| "titipan tidak bisa disegel".to_owned())?;
    Ok(data_encoding::BASE64.encode(&sealed))
}

/// Opens an envelope made for this laptop. Fails for envelopes made for
/// another key, tampered data or an unknown format.
pub fn open_sealed(identity: &Identity, sealed_b64: &str) -> Result<SealedContent, String> {
    let sealed = data_encoding::BASE64
        .decode(sealed_b64.as_bytes())
        .map_err(|_| "isi titipan bukan base64")?;
    let secret = x25519_secret(identity);
    let sk = SecretKey::from(*secret);
    let plain = Zeroizing::new(
        sk.unseal(&sealed)
            .map_err(|_| "titipan tidak bisa dibuka dengan kunci laptop ini".to_owned())?,
    );
    let json = plain
        .strip_prefix(SEAL_DOMAIN)
        .ok_or("titipan tanpa penanda mira-seal-v1")?;
    let content: SealedContent =
        serde_json::from_slice(json).map_err(|e| format!("isi titipan tidak dikenal: {e}"))?;
    if content.v != SEAL_VERSION {
        return Err(format!("versi titipan {} tidak dikenal", content.v));
    }
    Ok(content)
}

/// Encrypts a file with a fresh random key. Returns the key and the cipher
/// file (`nonce || ciphertext`).
pub fn encrypt_file(plain: &[u8]) -> Result<(Zeroizing<[u8; 32]>, Vec<u8>), String> {
    let mut key = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(&mut *key);
    let mut nonce = [0u8; FILE_NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let cipher = XChaCha20Poly1305::new((&*key).into());
    let ct = cipher
        .encrypt((&nonce).into(), plain)
        .map_err(|_| "file tidak bisa dienkripsi".to_owned())?;
    let mut out = Vec::with_capacity(FILE_NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok((key, out))
}

/// Opens a cipher file made by [`encrypt_file`].
pub fn decrypt_file(key: &[u8; 32], cipher_file: &[u8]) -> Result<Vec<u8>, String> {
    if cipher_file.len() < FILE_NONCE_LEN + FILE_TAG_LEN {
        return Err("file titipan terlalu pendek".into());
    }
    let (nonce, ct) = cipher_file.split_at(FILE_NONCE_LEN);
    let nonce: [u8; FILE_NONCE_LEN] = nonce.try_into().map_err(|_| "nonce tidak sah")?;
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .decrypt((&nonce).into(), ct)
        .map_err(|_| "file titipan rusak atau kuncinya salah".to_owned())
}

/// Size of the cipher file for a plain file of `plain_len` bytes.
pub fn cipher_len(plain_len: u64) -> u64 {
    plain_len + (FILE_NONCE_LEN + FILE_TAG_LEN) as u64
}

/// Parses a key from [`FileKey::key`].
pub fn parse_file_key(hex_key: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    let k = <[u8; 32]>::from_hex(hex_key).map_err(|_| "kunci file bukan 64 hex")?;
    Ok(Zeroizing::new(k))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{KeyStore, MemoryKeyStore, ensure_identity, keystore_account};
    use curve25519_dalek::MontgomeryPoint;
    use proptest::prelude::*;
    // Explicit, since proptest's prelude also exports an `RngCore`.
    use rand_core::RngCore;

    /// Identity with a fixed Ed25519 seed (keystore entry + identity row).
    fn identity_from_seed(seed: [u8; 32]) -> Identity {
        let tmp = tempfile::tempdir().unwrap();
        let conn = crate::db::open(tmp.path()).unwrap();
        let pk = hex::encode(SigningKey::from_bytes(&seed).verifying_key().as_bytes());
        let ks = MemoryKeyStore::new();
        ks.set(&keystore_account(&pk), &seed).unwrap();
        conn.execute(
            "INSERT INTO identity (id, public_key, display_name, created_at) \
             VALUES (1, ?1, NULL, '2026-11-22T08:00:00Z')",
            [&pk],
        )
        .unwrap();
        ensure_identity(&conn, &ks).unwrap()
    }

    fn random_identity() -> Identity {
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        identity_from_seed(seed)
    }

    fn sample() -> SealedContent {
        let files = vec![FileKey {
            hash: "a".repeat(64),
            cipher: "b".repeat(64),
            key: hex::encode([7u8; 32]),
        }];
        SealedContent::new(r#"{"kind":"message","text":"halo"}"#.into(), files)
    }

    /// Seals raw plaintext for `id` without the envelope framing.
    fn seal_raw(id: &Identity, plain: &[u8]) -> String {
        let pk = PublicKey::from(x25519_public(id.public_key_hex()).unwrap());
        b64(&pk.seal(&mut OsRng, plain).unwrap())
    }

    fn b64(bytes: &[u8]) -> String {
        data_encoding::BASE64.encode(bytes)
    }

    fn unb64(s: &str) -> Vec<u8> {
        data_encoding::BASE64.decode(s.as_bytes()).unwrap()
    }

    // --- envelope roundtrip and rejection ---

    #[test]
    fn roundtrip_with_and_without_files() {
        let b = random_identity();
        for content in [sample(), SealedContent::new("rec".into(), vec![])] {
            let sealed = seal_for(b.public_key_hex(), &content).unwrap();
            assert_eq!(open_sealed(&b, &sealed).unwrap(), content);
        }
    }

    #[test]
    fn missing_files_field_defaults_to_empty() {
        let b = random_identity();
        let mut plain = SEAL_DOMAIN.to_vec();
        plain.extend_from_slice(br#"{"v":1,"record":"r"}"#);
        let got = open_sealed(&b, &seal_raw(&b, &plain)).unwrap();
        assert_eq!(got, SealedContent::new("r".into(), vec![]));
    }

    #[test]
    fn other_key_cannot_open() {
        let (b, c) = (random_identity(), random_identity());
        let sealed = seal_for(b.public_key_hex(), &sample()).unwrap();
        assert!(open_sealed(&c, &sealed).is_err());
    }

    #[test]
    fn any_tampered_byte_fails() {
        let b = random_identity();
        let bytes = unb64(&seal_for(b.public_key_hex(), &sample()).unwrap());
        for i in 0..bytes.len() {
            let mut t = bytes.clone();
            t[i] ^= 0x01;
            assert!(open_sealed(&b, &b64(&t)).is_err(), "byte {i}");
        }
        // X25519 ignores bit 255 of the ephemeral key; the nonce still covers it.
        let mut t = bytes.clone();
        t[31] ^= 0x80;
        assert!(open_sealed(&b, &b64(&t)).is_err());
    }

    #[test]
    fn truncated_or_extended_fails() {
        let b = random_identity();
        let bytes = unb64(&seal_for(b.public_key_hex(), &sample()).unwrap());
        for len in [0, 1, 31, 32, 33, 47, 48, bytes.len() - 1] {
            assert!(open_sealed(&b, &b64(&bytes[..len])).is_err(), "len {len}");
        }
        let mut longer = bytes.clone();
        longer.push(0);
        assert!(open_sealed(&b, &b64(&longer)).is_err());
    }

    #[test]
    fn non_base64_fails() {
        let b = random_identity();
        let sealed = seal_for(b.public_key_hex(), &sample()).unwrap();
        for bad in ["", "!!!!", "abc", &sealed[1..], &format!("{sealed} ")] {
            assert!(open_sealed(&b, bad).is_err(), "{bad:?}");
        }
        let err = open_sealed(&b, "@@@@").unwrap_err();
        assert!(err.contains("base64"), "{err}");
    }

    #[test]
    fn plaintext_without_domain_fails() {
        let b = random_identity();
        let json = serde_json::to_vec(&sample()).unwrap();
        let err = open_sealed(&b, &seal_raw(&b, &json)).unwrap_err();
        assert!(err.contains("mira-seal-v1"), "{err}");

        let mut other = b"mira-seal-v2\n".to_vec();
        other.extend_from_slice(&json);
        assert!(open_sealed(&b, &seal_raw(&b, &other)).is_err());
        // Domain without the newline.
        let mut short = b"mira-seal-v1".to_vec();
        short.extend_from_slice(&json);
        assert!(open_sealed(&b, &seal_raw(&b, &short)).is_err());
    }

    #[test]
    fn unknown_version_fails() {
        let b = random_identity();
        let mut content = sample();
        content.v = 2;
        let sealed = seal_for(b.public_key_hex(), &content).unwrap();
        let err = open_sealed(&b, &sealed).unwrap_err();
        assert!(err.contains("versi"), "{err}");
    }

    #[test]
    fn garbage_json_fails() {
        let b = random_identity();
        for body in [
            &b"not json"[..],
            b"",
            b"{}",
            b"[1,2]",
            br#"{"v":1}"#,
            br#"{"v":1,"record":"r","extra":1}"#,
            br#"{"v":1,"record":"r","files":[{"hash":"h","cipher":"c"}]}"#,
            br#"{"v":"1","record":"r"}"#,
        ] {
            let mut plain = SEAL_DOMAIN.to_vec();
            plain.extend_from_slice(body);
            let r = open_sealed(&b, &seal_raw(&b, &plain));
            assert!(r.is_err(), "{:?}", String::from_utf8_lossy(body));
        }
    }

    #[test]
    fn bad_recipient_key_fails_to_seal() {
        for bad in ["", "zz", &"0".repeat(63), &"g".repeat(64), &"00".repeat(33)] {
            assert!(seal_for(bad, &sample()).is_err(), "{bad:?}");
        }
    }

    // --- key conversion ---

    // libsodium test/default/ed25519_convert.c and .exp (master branch).
    const LIBSODIUM_SEED: &str = "421151a459faeade3d247115f94aedae42318124095afabe4d1451a559faedee";
    const LIBSODIUM_X_PK: &str = "f1814f0e8ff1043d8a44d25babff3cedcae6c22c3edaa48f857ae70de2baae50";
    const LIBSODIUM_X_SK: &str = "8052030376d47112be7f73ed7a019293dd12ad910b654455798b4667d73de166";

    #[test]
    fn conversion_matches_libsodium_vectors() {
        let seed = <[u8; 32]>::from_hex(LIBSODIUM_SEED).unwrap();
        let id = identity_from_seed(seed);
        let public = x25519_public(id.public_key_hex()).unwrap();
        assert_eq!(hex::encode(public), LIBSODIUM_X_PK);
        assert_eq!(hex::encode(*x25519_secret(&id)), LIBSODIUM_X_SK);
        // crypto_box derives the same public key from the converted secret.
        let sk = SecretKey::from(*x25519_secret(&id));
        assert_eq!(hex::encode(sk.public_key().as_bytes()), LIBSODIUM_X_PK);
    }

    #[test]
    fn rejects_keys_libsodium_rejects() {
        // The three keys ed25519_convert.c expects to fail, plus the neutral
        // element (also small order).
        for bad in [
            "0000000000000000000000000000000000000000000000000000000000000000",
            "0200000000000000000000000000000000000000000000000000000000000000",
            "0500000000000000000000000000000000000000000000000000000000000000",
            "0100000000000000000000000000000000000000000000000000000000000000",
        ] {
            assert!(x25519_public(bad).is_err(), "{bad}");
            assert!(seal_for(bad, &sample()).is_err(), "{bad}");
        }
    }

    #[test]
    fn rejects_mixed_order_key() {
        // A valid key plus a point of order 8: on the curve and not small
        // order, but outside the prime-order subgroup.
        let id = random_identity();
        let torsion = curve25519_dalek::constants::EIGHT_TORSION[1];
        let mixed = (id.verifying_key().to_edwards() + torsion).compress();
        assert!(VerifyingKey::from_bytes(mixed.as_bytes()).is_ok());
        assert!(x25519_public(&hex::encode(mixed.as_bytes())).is_err());
    }

    #[test]
    fn converted_secret_matches_converted_public() {
        for _ in 0..16 {
            let id = random_identity();
            let from_secret = MontgomeryPoint::mul_base_clamped(*x25519_secret(&id));
            let public = x25519_public(id.public_key_hex()).unwrap();
            assert_eq!(from_secret.to_bytes(), public);
        }
    }

    #[test]
    fn diffie_hellman_is_symmetric() {
        let (a, b) = (random_identity(), random_identity());
        let a_pub = MontgomeryPoint(x25519_public(a.public_key_hex()).unwrap());
        let b_pub = MontgomeryPoint(x25519_public(b.public_key_hex()).unwrap());
        let ab = b_pub.mul_clamped(*x25519_secret(&a));
        let ba = a_pub.mul_clamped(*x25519_secret(&b));
        assert_eq!(ab, ba);
        assert_ne!(ab.to_bytes(), [0u8; 32]);
    }

    // --- sealed box layout ---

    #[test]
    fn sealed_box_has_libsodium_layout() {
        let b = random_identity();
        let content = sample();
        let plain_len = SEAL_DOMAIN.len() + serde_json::to_vec(&content).unwrap().len();
        let s1 = unb64(&seal_for(b.public_key_hex(), &content).unwrap());
        let s2 = unb64(&seal_for(b.public_key_hex(), &content).unwrap());
        assert_eq!(s1.len(), 32 + 16 + plain_len);
        assert_ne!(s1, s2);
        assert_ne!(s1[..32], s2[..32], "fresh ephemeral key per seal");
        // The prefix is the ephemeral public key, a valid curve point.
        let eph = MontgomeryPoint(s1[..32].try_into().unwrap());
        assert!(eph.to_edwards(0).is_some());
    }

    // --- file encryption ---

    #[test]
    fn file_roundtrip_and_length() {
        for len in [0usize, 1, 15, 16, 17, 1000, 70_000] {
            let plain: Vec<u8> = (0..len).map(|i| (i * 31 % 251) as u8).collect();
            let (key, cipher) = encrypt_file(&plain).unwrap();
            assert_eq!(cipher.len() as u64, cipher_len(len as u64), "len {len}");
            assert_eq!(decrypt_file(&key, &cipher).unwrap(), plain);
            // The key survives the hex form carried in FileKey.
            let parsed = parse_file_key(&hex::encode(*key)).unwrap();
            assert_eq!(*parsed, *key);
        }
    }

    #[test]
    fn file_fresh_key_and_nonce() {
        let (k1, c1) = encrypt_file(b"same").unwrap();
        let (k2, c2) = encrypt_file(b"same").unwrap();
        assert_ne!(*k1, *k2);
        assert_ne!(c1[..FILE_NONCE_LEN], c2[..FILE_NONCE_LEN]);
    }

    #[test]
    fn file_wrong_key_fails() {
        let (key, cipher) = encrypt_file(b"rahasia").unwrap();
        let mut wrong = *key;
        wrong[0] ^= 1;
        assert!(decrypt_file(&wrong, &cipher).is_err());
        let (other, _) = encrypt_file(b"x").unwrap();
        assert!(decrypt_file(&other, &cipher).is_err());
    }

    #[test]
    fn file_flipped_byte_fails() {
        let (key, cipher) = encrypt_file(b"isi lampiran kecil").unwrap();
        for i in 0..cipher.len() {
            let mut t = cipher.clone();
            t[i] ^= 0x80;
            assert!(decrypt_file(&key, &t).is_err(), "byte {i}");
        }
    }

    #[test]
    fn file_too_short_or_truncated_fails() {
        let (key, cipher) = encrypt_file(b"").unwrap();
        assert_eq!(cipher.len(), FILE_NONCE_LEN + FILE_TAG_LEN);
        for len in 0..cipher.len() {
            let err = decrypt_file(&key, &cipher[..len]).unwrap_err();
            assert!(err.contains("pendek"), "{err}");
        }
        let (key, cipher) = encrypt_file(b"abc").unwrap();
        assert!(decrypt_file(&key, &cipher[..cipher.len() - 1]).is_err());
    }

    #[test]
    fn parse_file_key_rejects_bad_hex() {
        for bad in ["", "00", &"0".repeat(63), &"0".repeat(65), &"x".repeat(64)] {
            assert!(parse_file_key(bad).is_err(), "{bad:?}");
        }
    }

    // --- properties ---

    fn file_keys() -> impl Strategy<Value = Vec<FileKey>> {
        prop::collection::vec(any::<([u8; 32], [u8; 32], [u8; 32])>(), 0..4).prop_map(|v| {
            v.into_iter()
                .map(|(h, c, k)| FileKey {
                    hash: hex::encode(h),
                    cipher: hex::encode(c),
                    key: hex::encode(k),
                })
                .collect()
        })
    }

    static RECIPIENT: std::sync::LazyLock<Identity> = std::sync::LazyLock::new(random_identity);

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(32))]

        #[test]
        fn prop_roundtrip(record in any::<String>(), files in file_keys()) {
            let content = SealedContent::new(record, files);
            let sealed = seal_for(RECIPIENT.public_key_hex(), &content).unwrap();
            prop_assert_eq!(open_sealed(&RECIPIENT, &sealed).unwrap(), content);
        }

        #[test]
        fn prop_flip_never_opens(
            record in ".{0,64}",
            pos in any::<prop::sample::Index>(),
            mask in 1u8..=255,
        ) {
            let content = SealedContent::new(record, vec![]);
            let mut bytes = unb64(&seal_for(RECIPIENT.public_key_hex(), &content).unwrap());
            let i = pos.index(bytes.len());
            bytes[i] ^= mask;
            prop_assert!(open_sealed(&RECIPIENT, &b64(&bytes)).is_err());
        }

        #[test]
        fn prop_file_roundtrip(plain in prop::collection::vec(any::<u8>(), 0..2048)) {
            let (key, cipher) = encrypt_file(&plain).unwrap();
            prop_assert_eq!(cipher.len() as u64, cipher_len(plain.len() as u64));
            prop_assert_eq!(decrypt_file(&key, &cipher).unwrap(), plain);
        }
    }
}
