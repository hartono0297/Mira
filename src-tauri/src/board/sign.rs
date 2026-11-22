//! Signed Automerge changes, the unit stored in `board_changes` and sent to
//! other laptops.
//!
//! # Signed bytes (version 1)
//!
//! ```text
//! "mira-board-v1\n" || project id (32 lowercase hex, ASCII) || "\n" || raw change bytes
//! ```
//!
//! The raw change bytes are `Change::raw_bytes` (uncompressed chunk). The
//! signature is Ed25519 by the laptop key and is checked with `verify_strict`.
//! The change's Automerge actor must be the signer's 32-byte public key, so a
//! laptop cannot sign a change in someone else's name. Binding the project id
//! keeps a change from being replayed into another project.

use automerge::Change;
use serde::{Deserialize, Serialize};

use crate::identity::{self, Identity};
use crate::org::is_lower_hex;

pub const BOARD_DOMAIN_V1: &[u8] = b"mira-board-v1\n";
/// Largest accepted change. A local change with a full description (10000
/// characters) and every other field stays far below this.
pub const MAX_CHANGE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedChange {
    pub project_id: String,
    /// Automerge change hash, 64 lowercase hex.
    pub hash: String,
    /// Signer public key, 64 lowercase hex; equals the change actor.
    pub author: String,
    pub seq: u64,
    #[serde(with = "serde_bytes_hex")]
    pub bytes: Vec<u8>,
    /// Ed25519 signature, 128 lowercase hex.
    pub sig: String,
}

/// Version of the record body sent to other laptops.
pub const RECORD_VERSION: u32 = 1;

/// The body of the `FeatureRecord` that carries a change to other laptops:
/// `{"v":1,"project_id","hash","author","seq","bytes","sig"}` with `bytes`
/// as hex, fields in this order. Every laptop builds the same body from the
/// same change, so the record id (BLAKE3 of the body) is the same everywhere.
#[derive(Serialize)]
struct RecordBodyRef<'a> {
    v: u32,
    project_id: &'a str,
    hash: &'a str,
    author: &'a str,
    seq: u64,
    bytes: String,
    sig: &'a str,
}

/// Parsed record body; unknown fields are refused.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordBody {
    v: u32,
    project_id: String,
    hash: String,
    author: String,
    seq: u64,
    bytes: String,
    sig: String,
}

impl SignedChange {
    pub fn record_body(&self) -> String {
        let body = RecordBodyRef {
            v: RECORD_VERSION,
            project_id: &self.project_id,
            hash: &self.hash,
            author: &self.author,
            seq: self.seq,
            bytes: hex::encode(&self.bytes),
            sig: &self.sig,
        };
        serde_json::to_string(&body).unwrap_or_default()
    }

    /// BLAKE3 of [`SignedChange::record_body`], 64 lowercase hex.
    pub fn record_id(&self) -> String {
        blake3::hash(self.record_body().as_bytes())
            .to_hex()
            .to_string()
    }

    /// Parses a record body. Only the shape is checked here (version, hex
    /// bytes, canonical form so the id is stable); signature and content are
    /// checked by `verify_envelope` and `parse_change`.
    pub fn from_record_body(body: &str) -> Result<SignedChange, ChangeRejection> {
        let bad = |d: &str| ChangeRejection::new("board_bad_format", d.to_owned());
        let r: RecordBody = serde_json::from_str(body).map_err(|_| bad("isi record board tidak bisa dibaca"))?;
        if r.v != RECORD_VERSION {
            return Err(bad("versi record board tidak dikenal"));
        }
        if r.bytes.len() > MAX_CHANGE_BYTES * 2 {
            return Err(bad("record board terlalu besar"));
        }
        let bytes = hex::decode(&r.bytes).map_err(|_| bad("isi perubahan bukan hex"))?;
        let sc = SignedChange {
            project_id: r.project_id,
            hash: r.hash,
            author: r.author,
            seq: r.seq,
            bytes,
            sig: r.sig,
        };
        if sc.record_body() != body {
            return Err(bad("record board tidak dalam bentuk baku"));
        }
        Ok(sc)
    }
}

/// Bytes stay compact in JSON as hex rather than a number array.
mod serde_bytes_hex {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(b: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(b))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        hex::decode(s).map_err(serde::de::Error::custom)
    }
}

/// Why a change was refused; `code` goes to `rejected_changes.code`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeRejection {
    pub code: &'static str,
    pub detail: String,
}

impl ChangeRejection {
    pub fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

pub fn signing_message(project_id: &str, raw: &[u8]) -> Vec<u8> {
    let mut m = Vec::with_capacity(BOARD_DOMAIN_V1.len() + project_id.len() + 1 + raw.len());
    m.extend_from_slice(BOARD_DOMAIN_V1);
    m.extend_from_slice(project_id.as_bytes());
    m.push(b'\n');
    m.extend_from_slice(raw);
    m
}

pub fn sign_change(identity: &Identity, project_id: &str, change: &Change) -> SignedChange {
    let bytes = change.raw_bytes().to_vec();
    let sig = identity.sign(&signing_message(project_id, &bytes));
    SignedChange {
        project_id: project_id.to_owned(),
        hash: change.hash().to_string(),
        author: hex::encode(change.actor_id().to_bytes()),
        seq: change.seq(),
        bytes,
        sig: hex::encode(sig.to_bytes()),
    }
}

/// Offset of the chunk type byte: 4 magic bytes, then a 4-byte checksum.
const CHUNK_TYPE_OFFSET: usize = 8;
/// Chunk type of an uncompressed change. Compressed changes (type 2) are
/// refused because inflating them has no size limit.
const CHUNK_TYPE_CHANGE: u8 = 1;

/// Checks format, size, signature, actor and hash; returns the parsed change.
pub fn verify_change(sc: &SignedChange) -> Result<Change, ChangeRejection> {
    verify_envelope(sc)?;
    parse_change(sc)
}

/// The checks that do not parse the change: hex fields, size, chunk type
/// and signature. Run these (and the author's permission) before
/// [`parse_change`], so a stranger cannot make this laptop parse anything.
pub fn verify_envelope(sc: &SignedChange) -> Result<(), ChangeRejection> {
    if !is_lower_hex(&sc.project_id, 32)
        || !is_lower_hex(&sc.hash, 64)
        || !is_lower_hex(&sc.author, 64)
        || !is_lower_hex(&sc.sig, 128)
    {
        return Err(ChangeRejection::new(
            "board_bad_format",
            "id proyek, hash, penulis, atau tanda tangan tidak berformat hex yang benar",
        ));
    }
    if sc.bytes.len() > MAX_CHANGE_BYTES {
        return Err(ChangeRejection::new(
            "board_too_large",
            format!(
                "perubahan {} byte melebihi batas {MAX_CHANGE_BYTES} byte",
                sc.bytes.len()
            ),
        ));
    }
    if sc.bytes.get(CHUNK_TYPE_OFFSET) != Some(&CHUNK_TYPE_CHANGE) {
        return Err(ChangeRejection::new(
            "board_bad_format",
            "perubahan harus berupa change Automerge yang tidak dikompresi",
        ));
    }
    if !identity::verify_hex(
        &sc.author,
        &signing_message(&sc.project_id, &sc.bytes),
        &sc.sig,
    ) {
        return Err(ChangeRejection::new(
            "board_bad_signature",
            "tanda tangan perubahan board tidak cocok dengan penulisnya",
        ));
    }
    Ok(())
}

/// Parses a change that passed [`verify_envelope`] and checks that its actor,
/// hash and sequence number match the envelope.
pub fn parse_change(sc: &SignedChange) -> Result<Change, ChangeRejection> {
    let change = Change::try_from(sc.bytes.as_slice()).map_err(|e| {
        ChangeRejection::new(
            "board_bad_format",
            format!("perubahan tidak bisa dibaca: {e}"),
        )
    })?;
    if hex::encode(change.actor_id().to_bytes()) != sc.author {
        return Err(ChangeRejection::new(
            "board_actor_mismatch",
            "pembuat perubahan di dalam dokumen bukan laptop yang menandatanganinya",
        ));
    }
    if change.hash().to_string() != sc.hash {
        return Err(ChangeRejection::new(
            "board_hash_mismatch",
            "hash perubahan tidak cocok dengan isinya",
        ));
    }
    if change.seq() != sc.seq {
        return Err(ChangeRejection::new(
            "board_bad_format",
            "nomor urut perubahan tidak cocok dengan isinya",
        ));
    }
    Ok(change)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::doc::{BoardDoc, ProjectMeta};
    use crate::db;
    use crate::identity::{MemoryKeyStore, ensure_identity};

    fn identity() -> (tempfile::TempDir, Identity) {
        let tmp = tempfile::tempdir().unwrap();
        let conn = db::open(tmp.path()).unwrap();
        let id = ensure_identity(&conn, &MemoryKeyStore::new()).unwrap();
        (tmp, id)
    }

    fn pk_bytes(id: &Identity) -> [u8; 32] {
        id.verifying_key().to_bytes()
    }

    fn change_by(actor: &[u8]) -> Change {
        let meta = ProjectMeta {
            id: "1".repeat(32),
            code: "PA".into(),
            name: "Proyek".into(),
            team_id: None,
        };
        let mut d = BoardDoc::create(actor, &meta).unwrap();
        d.commit(0).unwrap();
        d.changes_after(&[]).pop().unwrap()
    }

    #[test]
    fn signed_change_verifies() {
        let (_t, id) = identity();
        let change = change_by(&pk_bytes(&id));
        let sc = sign_change(&id, &"1".repeat(32), &change);
        assert_eq!(sc.author, id.public_key_hex());
        assert_eq!(sc.seq, 1);
        assert_eq!(sc.hash.len(), 64);
        let back = verify_change(&sc).unwrap();
        assert_eq!(back.hash(), change.hash());
    }

    #[test]
    fn tampered_bytes_are_rejected() {
        let (_t, id) = identity();
        let mut sc = sign_change(&id, &"1".repeat(32), &change_by(&pk_bytes(&id)));
        let last = sc.bytes.len() - 1;
        sc.bytes[last] ^= 1;
        assert_eq!(verify_change(&sc).unwrap_err().code, "board_bad_signature");
    }

    #[test]
    fn other_project_is_rejected() {
        let (_t, id) = identity();
        let mut sc = sign_change(&id, &"1".repeat(32), &change_by(&pk_bytes(&id)));
        sc.project_id = "2".repeat(32);
        assert_eq!(verify_change(&sc).unwrap_err().code, "board_bad_signature");
    }

    #[test]
    fn wrong_signer_is_rejected() {
        let (_t, a) = identity();
        let (_u, b) = identity();
        let mut sc = sign_change(&a, &"1".repeat(32), &change_by(&pk_bytes(&a)));
        sc.author = b.public_key_hex().to_owned();
        assert_eq!(verify_change(&sc).unwrap_err().code, "board_bad_signature");
    }

    #[test]
    fn actor_must_be_signer() {
        let (_t, a) = identity();
        let (_u, b) = identity();
        // B signs a change whose actor is A.
        let sc = sign_change(&b, &"1".repeat(32), &change_by(&pk_bytes(&a)));
        assert_eq!(
            sc.author,
            a.public_key_hex(),
            "author comes from the change"
        );
        assert_eq!(verify_change(&sc).unwrap_err().code, "board_bad_signature");
        // Claiming B as author with B's valid signature still fails on the actor.
        let sc = SignedChange {
            author: b.public_key_hex().to_owned(),
            ..sc
        };
        assert_eq!(verify_change(&sc).unwrap_err().code, "board_actor_mismatch");
    }

    #[test]
    fn hash_and_seq_must_match() {
        let (_t, id) = identity();
        let sc = sign_change(&id, &"1".repeat(32), &change_by(&pk_bytes(&id)));
        let bad_hash = SignedChange {
            hash: "0".repeat(64),
            ..sc.clone()
        };
        assert_eq!(
            verify_change(&bad_hash).unwrap_err().code,
            "board_hash_mismatch"
        );
        let bad_seq = SignedChange {
            seq: 7,
            ..sc.clone()
        };
        assert_eq!(
            verify_change(&bad_seq).unwrap_err().code,
            "board_bad_format"
        );
        let bad_hex = SignedChange {
            sig: "zz".into(),
            ..sc
        };
        assert_eq!(
            verify_change(&bad_hex).unwrap_err().code,
            "board_bad_format"
        );
    }

    #[test]
    fn oversized_change_is_rejected_before_parsing() {
        let (_t, id) = identity();
        let mut sc = sign_change(&id, &"1".repeat(32), &change_by(&pk_bytes(&id)));
        sc.bytes = vec![0; MAX_CHANGE_BYTES + 1];
        assert_eq!(verify_change(&sc).unwrap_err().code, "board_too_large");
    }

    #[test]
    fn compressed_chunk_is_rejected_before_inflating() {
        let (_t, id) = identity();
        let meta = ProjectMeta {
            id: "1".repeat(32),
            code: "PA".into(),
            name: "a".repeat(80),
            team_id: Some("b".repeat(4000)),
        };
        let mut d = BoardDoc::create(&pk_bytes(&id), &meta).unwrap();
        d.commit(0).unwrap();
        let mut change = d.changes_after(&[]).pop().unwrap();
        let compressed = change.bytes().to_vec();
        assert_eq!(
            compressed[CHUNK_TYPE_OFFSET], 2,
            "test needs a compressed chunk"
        );
        assert!(compressed.len() < change.raw_bytes().len());
        let project = "1".repeat(32);
        let sc = SignedChange {
            project_id: project.clone(),
            hash: change.hash().to_string(),
            author: id.public_key_hex().to_owned(),
            seq: change.seq(),
            sig: hex::encode(id.sign(&signing_message(&project, &compressed)).to_bytes()),
            bytes: compressed,
        };
        assert_eq!(verify_envelope(&sc).unwrap_err().code, "board_bad_format");
        assert_eq!(verify_change(&sc).unwrap_err().code, "board_bad_format");
        let plain = sign_change(&id, &project, &change);
        assert_eq!(plain.bytes[CHUNK_TYPE_OFFSET], CHUNK_TYPE_CHANGE);
        verify_change(&plain).unwrap();
    }

    #[test]
    fn serializes_bytes_as_hex() {
        let (_t, id) = identity();
        let sc = sign_change(&id, &"1".repeat(32), &change_by(&pk_bytes(&id)));
        let json = serde_json::to_value(&sc).unwrap();
        assert!(json["bytes"].is_string());
        let back: SignedChange = serde_json::from_value(json).unwrap();
        assert_eq!(back, sc);
    }
}
