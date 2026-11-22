//! Signed envelope for feature records sent to rekan (documents and signing).
//!
//! A [`FeatureRecord`] body is the JSON `{"a":<author>,"p":<payload>,"s":<sig>}`:
//! - `a`: the author's public key (64 lowercase hex);
//! - `p`: the payload, itself a JSON text, kept as an exact string so the
//!   signature never depends on re-serializing;
//! - `s`: Ed25519 signature (128 hex) of `<domain>\n<a>\n<p>` by `a`.
//!
//! The domain separates record families (`mira-docs-v1`, `mira-sign-sync-v1`),
//! so a record of one feature can never be replayed as another. The record id
//! is the BLAKE3 of the whole body (see `network::feature`), so the same
//! payload signed twice is still one id per exact body.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::identity::{self, Identity};
use crate::network::feature::FeatureRecord;
use crate::org::is_lower_hex;

/// Domain of document records (`documents::peer_sync`).
pub const DOCS_DOMAIN: &str = "mira-docs-v1";
/// Domain of signing records (`signing::peer_sync`).
pub const SIGN_DOMAIN: &str = "mira-sign-sync-v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Body {
    a: String,
    p: String,
    s: String,
}

fn message(domain: &str, author: &str, payload: &str) -> Vec<u8> {
    let mut m = Vec::with_capacity(domain.len() + author.len() + payload.len() + 2);
    m.extend_from_slice(domain.as_bytes());
    m.push(b'\n');
    m.extend_from_slice(author.as_bytes());
    m.push(b'\n');
    m.extend_from_slice(payload.as_bytes());
    m
}

/// Serializes `payload` to JSON, signs it with this laptop's key and returns
/// the record (id = BLAKE3 of the body).
pub fn seal<T: Serialize>(
    identity: &Identity,
    domain: &str,
    payload: &T,
) -> Result<FeatureRecord, String> {
    let p = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    let a = identity.public_key_hex().to_owned();
    let s = hex::encode(identity.sign(&message(domain, &a, &p)).to_bytes());
    let body = serde_json::to_string(&Body { a, p, s }).map_err(|e| e.to_string())?;
    Ok(FeatureRecord::new(body))
}

/// A verified record: the author and the parsed payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened<T> {
    pub author: String,
    pub payload: T,
}

/// Checks the record id, the envelope shape, the author key and the
/// signature, then parses the payload. Every failure is an `Err` with a short
/// reason (for the rejection log), never a panic.
pub fn open<T: DeserializeOwned>(
    domain: &str,
    record: &FeatureRecord,
) -> Result<Opened<T>, String> {
    if !record.id_matches() {
        return Err("id tidak cocok dengan isi".into());
    }
    let body: Body = serde_json::from_str(&record.body).map_err(|_| "amplop rusak".to_owned())?;
    if !is_lower_hex(&body.a, 64) {
        return Err("kunci penulis tidak valid".into());
    }
    if !identity::verify_hex(&body.a, &message(domain, &body.a, &body.p), &body.s) {
        return Err("tanda tangan penulis tidak sah".into());
    }
    let payload = serde_json::from_str(&body.p).map_err(|e| format!("isi tidak terbaca: {e}"))?;
    Ok(Opened {
        author: body.a,
        payload,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::identity::MemoryKeyStore;

    #[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct P {
        x: u32,
    }

    fn me() -> (tempfile::TempDir, Identity) {
        let tmp = tempfile::tempdir().unwrap();
        let conn = db::open(tmp.path()).unwrap();
        let id = identity::ensure_identity(&conn, &MemoryKeyStore::new()).unwrap();
        (tmp, id)
    }

    #[test]
    fn round_trip_and_tamper_detection() {
        let (_t, id) = me();
        let r = seal(&id, DOCS_DOMAIN, &P { x: 7 }).unwrap();
        let o: Opened<P> = open(DOCS_DOMAIN, &r).unwrap();
        assert_eq!(o.payload, P { x: 7 });
        assert_eq!(o.author, id.public_key_hex());

        // Other domain.
        assert!(open::<P>(SIGN_DOMAIN, &r).is_err());

        // Changed payload with a recomputed id.
        let forged = FeatureRecord::new(r.body.replace("\\\"x\\\":7", "\\\"x\\\":8"));
        assert_ne!(forged.body, r.body);
        assert!(open::<P>(DOCS_DOMAIN, &forged).is_err());

        // Other author claimed.
        let (_t2, other) = me();
        let claimed = r.body.replace(id.public_key_hex(), other.public_key_hex());
        assert!(open::<P>(DOCS_DOMAIN, &FeatureRecord::new(claimed)).is_err());

        // Id that does not match.
        let wrong = FeatureRecord {
            id: "0".repeat(64),
            body: r.body.clone(),
        };
        assert!(open::<P>(DOCS_DOMAIN, &wrong).is_err());

        // Extra fields are refused.
        let extra = r.body.replacen('{', "{\"z\":1,", 1);
        assert!(open::<P>(DOCS_DOMAIN, &FeatureRecord::new(extra)).is_err());
    }
}
