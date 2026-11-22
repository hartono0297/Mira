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
pub fn x25519_public(ed_public_hex: &str) -> Result<[u8; 32], String> {
    let bytes = <[u8; 32]>::from_hex(ed_public_hex).map_err(|_| "kunci bukan 64 hex")?;
    let vk = VerifyingKey::from_bytes(&bytes).map_err(|_| "kunci Ed25519 tidak sah")?;
    Ok(vk.to_montgomery().to_bytes())
}

/// X25519 secret scalar for this laptop's Ed25519 key. Wiped when dropped.
pub fn x25519_secret(identity: &Identity) -> Zeroizing<[u8; 32]> {
    let seed = identity.secret_bytes();
    let sk = SigningKey::from_bytes(&seed);
    Zeroizing::new(sk.to_scalar_bytes())
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
