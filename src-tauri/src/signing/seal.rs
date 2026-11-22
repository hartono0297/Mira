//! Penguncian hasil tanda tangan dan jejak audit.
//!
//! - Hash berkas: BLAKE3, ditulis sebagai 64 hex huruf kecil.
//! - Catatan jejak audit (`EventRecord`) ditandatangani kunci laptop pelaku.
//!   Format byte yang ditandatangani (`record_bytes`):
//!
//!   ```text
//!   mira-sign-event-v1\n<request_id atau kosong>\n<kind>\n<actor>\n<actor_name>\n<at>\n<hash_before atau kosong>\n<hash_after atau kosong>\n<detail>
//!   ```
//!
//!   Field yang berisi karakter kontrol (termasuk `\n` dan `\r`) ditolak,
//!   supaya batas field tidak bisa dipalsukan. `request_id` kalau ada harus
//!   32 hex, hash kalau ada harus 64 hex, jadi `Some("")` tidak bisa
//!   menghasilkan byte yang sama dengan `None`.
//! - Penanda berkas Mira: kata kunci `mira-doc:<id 32 hex>` di metadata PDF,
//!   dicari dengan memindai byte (`find_mira_doc_id`).

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::identity::{self, Identity};
use crate::org::is_lower_hex;

/// Domain pemisah untuk tanda tangan catatan jejak audit.
pub const SEAL_DOMAIN: &str = "mira-sign-event-v1";

/// Awalan kata kunci penanda berkas Mira di metadata PDF.
pub const MIRA_DOC_TAG_PREFIX: &str = "mira-doc:";

/// Panjang id permintaan tanda tangan dalam hex.
const REQUEST_ID_HEX_LEN: usize = 32;

/// Panjang kunci publik Ed25519 dalam hex.
const KEY_HEX_LEN: usize = 64;

/// Panjang hash BLAKE3 dalam hex.
const HASH_HEX_LEN: usize = 64;

/// `%PDF-` harus muncul di awal berkas; sebagian PDF punya sampah di depan,
/// jadi pembaca PDF umumnya memeriksa 1024 byte pertama.
const PDF_HEADER_WINDOW: usize = 1024;

/// Hash BLAKE3 dari `bytes` sebagai 64 hex huruf kecil.
pub fn hash_hex(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// Tepat 64 karakter `0-9a-f`.
pub fn is_hash_hex(s: &str) -> bool {
    is_lower_hex(s, HASH_HEX_LEN)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Created,
    Signed,
    Completed,
    Cancelled,
    Exported,
    SignatureSaved,
    SignatureDeleted,
}

impl EventKind {
    pub const ALL: [EventKind; 7] = [
        EventKind::Created,
        EventKind::Signed,
        EventKind::Completed,
        EventKind::Cancelled,
        EventKind::Exported,
        EventKind::SignatureSaved,
        EventKind::SignatureDeleted,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            EventKind::Created => "created",
            EventKind::Signed => "signed",
            EventKind::Completed => "completed",
            EventKind::Cancelled => "cancelled",
            EventKind::Exported => "exported",
            EventKind::SignatureSaved => "signature_saved",
            EventKind::SignatureDeleted => "signature_deleted",
        }
    }

    pub fn parse(s: &str) -> Option<EventKind> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

/// Satu catatan jejak audit, sebelum atau sesudah disimpan di `sign_events`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventRecord {
    pub request_id: Option<String>,
    pub kind: EventKind,
    /// Kunci publik pelaku (64 hex).
    pub actor: String,
    pub actor_name: String,
    /// Waktu RFC 3339 UTC.
    pub at: String,
    pub hash_before: Option<String>,
    pub hash_after: Option<String>,
    pub detail: String,
}

fn invalid(message: String) -> AppError {
    AppError::Internal(format!("Catatan jejak audit tidak valid: {message}"))
}

fn check_text(field: &str, value: &str) -> AppResult<()> {
    if value.chars().any(char::is_control) {
        return Err(invalid(format!(
            "{field} berisi baris baru atau karakter kontrol."
        )));
    }
    Ok(())
}

fn check_hash(field: &str, value: Option<&str>) -> AppResult<()> {
    match value {
        Some(h) if !is_hash_hex(h) => Err(invalid(format!(
            "{field} harus 64 karakter hex huruf kecil."
        ))),
        _ => Ok(()),
    }
}

/// Byte kanonik yang ditandatangani untuk satu catatan; lihat dokumentasi modul.
pub fn record_bytes(rec: &EventRecord) -> AppResult<Vec<u8>> {
    if let Some(id) = &rec.request_id
        && !is_lower_hex(id, REQUEST_ID_HEX_LEN)
    {
        return Err(invalid(
            "id permintaan harus 32 karakter hex huruf kecil.".into(),
        ));
    }
    if !is_lower_hex(&rec.actor, KEY_HEX_LEN) {
        return Err(invalid(
            "kunci pelaku harus 64 karakter hex huruf kecil.".into(),
        ));
    }
    check_text("nama pelaku", &rec.actor_name)?;
    check_text("waktu", &rec.at)?;
    check_text("keterangan", &rec.detail)?;
    check_hash("hash sebelum", rec.hash_before.as_deref())?;
    check_hash("hash sesudah", rec.hash_after.as_deref())?;

    let fields = [
        SEAL_DOMAIN,
        rec.request_id.as_deref().unwrap_or(""),
        rec.kind.as_str(),
        &rec.actor,
        &rec.actor_name,
        &rec.at,
        rec.hash_before.as_deref().unwrap_or(""),
        rec.hash_after.as_deref().unwrap_or(""),
        &rec.detail,
    ];
    Ok(fields.join("\n").into_bytes())
}

/// Tanda tangan Ed25519 (128 hex) kunci laptop atas `record_bytes(rec)`.
/// `rec.actor` harus kunci publik laptop ini, kalau tidak catatannya tidak
/// akan pernah lolos `verify_event`.
pub fn sign_event(identity: &Identity, rec: &EventRecord) -> AppResult<String> {
    if rec.actor != identity.public_key_hex() {
        return Err(invalid(
            "pelaku harus kunci laptop yang menandatangani.".into(),
        ));
    }
    let msg = record_bytes(rec)?;
    Ok(hex::encode(identity.sign(&msg).to_bytes()))
}

/// Benar kalau `sig_hex` adalah tanda tangan sah `rec.actor` atas catatan ini.
/// Catatan atau tanda tangan yang rusak menghasilkan false.
pub fn verify_event(rec: &EventRecord, sig_hex: &str) -> bool {
    match record_bytes(rec) {
        Ok(msg) => identity::verify_hex(&rec.actor, &msg, sig_hex),
        Err(_) => false,
    }
}

/// Kata kunci penanda untuk metadata PDF: `mira-doc:<request_id>`.
pub fn doc_tag(request_id: &str) -> String {
    format!("{MIRA_DOC_TAG_PREFIX}{request_id}")
}

fn is_lower_hex_byte(b: u8) -> bool {
    matches!(b, b'0'..=b'9' | b'a'..=b'f')
}

/// Id permintaan pertama dari penanda `mira-doc:` yang diikuti tepat 32 hex
/// huruf kecil (byte sesudahnya bukan hex). Memindai byte tanpa menyalin
/// berkas, cukup cepat untuk PDF 50 MB.
pub fn find_mira_doc_id(bytes: &[u8]) -> Option<String> {
    let prefix = MIRA_DOC_TAG_PREFIX.as_bytes();
    let needed = prefix.len() + REQUEST_ID_HEX_LEN;
    let mut start = 0;
    while bytes.len().saturating_sub(start) >= needed {
        let i = start + bytes[start..].iter().position(|&b| b == prefix[0])?;
        let id_start = i + prefix.len();
        let id_end = id_start + REQUEST_ID_HEX_LEN;
        if id_end <= bytes.len()
            && bytes[i..id_start] == *prefix
            && bytes[id_start..id_end]
                .iter()
                .all(|&b| is_lower_hex_byte(b))
            && bytes.get(id_end).is_none_or(|b| !b.is_ascii_hexdigit())
        {
            // Semua byte ASCII hex, jadi konversi ini tidak pernah gagal.
            return Some(String::from_utf8_lossy(&bytes[id_start..id_end]).into_owned());
        }
        start = i + 1;
    }
    None
}

/// Benar kalau `%PDF-` muncul di 1024 byte pertama.
pub fn looks_like_pdf(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(PDF_HEADER_WINDOW)];
    head.windows(5).any(|w| w == b"%PDF-")
}

/// Keadaan berkas dibanding hash yang dikunci.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Integrity {
    Intact,
    Changed,
    Missing,
}

/// `Missing` kalau berkas tidak ada, `Intact` kalau hash-nya sama dengan
/// `expected_hash`, selain itu `Changed`.
pub fn check_bytes(expected_hash: &str, bytes: Option<&[u8]>) -> Integrity {
    match bytes {
        None => Integrity::Missing,
        Some(b) if hash_hex(b) == expected_hash => Integrity::Intact,
        Some(_) => Integrity::Changed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::identity::{MemoryKeyStore, ensure_identity};

    const ID: &str = "0123456789abcdef0123456789abcdef";

    type Mutation = Box<dyn Fn(&mut EventRecord)>;

    fn identity() -> (tempfile::TempDir, Identity) {
        let tmp = tempfile::tempdir().unwrap();
        let conn = db::open(tmp.path()).unwrap();
        let identity = ensure_identity(&conn, &MemoryKeyStore::new()).unwrap();
        (tmp, identity)
    }

    fn record(actor: &str) -> EventRecord {
        EventRecord {
            request_id: Some(ID.into()),
            kind: EventKind::Signed,
            actor: actor.into(),
            actor_name: "Budi Santoso".into(),
            at: "2026-11-22T08:30:00Z".into(),
            hash_before: Some("a".repeat(64)),
            hash_after: Some("b".repeat(64)),
            detail: "posisi 1".into(),
        }
    }

    #[test]
    fn hash_hex_is_blake3_lowercase() {
        let h = hash_hex(b"abc");
        assert_eq!(
            h,
            "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85"
        );
        assert!(is_hash_hex(&h));
        assert!(!is_hash_hex(&h.to_uppercase()));
        assert!(!is_hash_hex(&h[..63]));
        assert!(!is_hash_hex(&format!("{h}0")));
        assert!(!is_hash_hex(&"g".repeat(64)));
    }

    #[test]
    fn event_kind_round_trips() {
        let names = [
            "created",
            "signed",
            "completed",
            "cancelled",
            "exported",
            "signature_saved",
            "signature_deleted",
        ];
        for (kind, name) in EventKind::ALL.into_iter().zip(names) {
            assert_eq!(kind.as_str(), name);
            assert_eq!(EventKind::parse(name), Some(kind));
            assert_eq!(serde_json::to_value(kind).unwrap(), name);
        }
        assert_eq!(EventKind::parse("Signed"), None);
        assert_eq!(EventKind::parse(""), None);
    }

    #[test]
    fn record_bytes_exact_format() {
        let actor = "c".repeat(64);
        let bytes = record_bytes(&record(&actor)).unwrap();
        let expected = format!(
            "mira-sign-event-v1\n{ID}\nsigned\n{actor}\nBudi Santoso\n2026-11-22T08:30:00Z\n{}\n{}\nposisi 1",
            "a".repeat(64),
            "b".repeat(64)
        );
        assert_eq!(bytes, expected.as_bytes());

        let rec = EventRecord {
            request_id: None,
            kind: EventKind::SignatureDeleted,
            actor: actor.clone(),
            actor_name: "Ani".into(),
            at: "2026-11-22T09:00:00Z".into(),
            hash_before: None,
            hash_after: None,
            detail: String::new(),
        };
        let expected = format!(
            "mira-sign-event-v1\n\nsignature_deleted\n{actor}\nAni\n2026-11-22T09:00:00Z\n\n\n"
        );
        assert_eq!(record_bytes(&rec).unwrap(), expected.as_bytes());
    }

    #[test]
    fn record_bytes_rejects_forged_field_boundaries() {
        let actor = "c".repeat(64);
        let cases: Vec<Mutation> = vec![
            Box::new(|r| r.actor_name = "Budi\nsigned".into()),
            Box::new(|r| r.actor_name = "Budi\r".into()),
            Box::new(|r| r.at = "2026\n".into()),
            Box::new(|r| r.detail = "a\nb".into()),
            Box::new(|r| r.detail = "tab\there".into()),
            Box::new(|r| r.detail = "nul\0".into()),
            Box::new(|r| r.actor = "C".repeat(64)),
            Box::new(|r| r.actor = "c".repeat(63)),
            Box::new(|r| r.actor = format!("{}\n", "c".repeat(63))),
            Box::new(|r| r.request_id = Some(String::new())),
            Box::new(|r| r.request_id = Some(format!("{}\n", &ID[..31]))),
            Box::new(|r| r.request_id = Some(ID.to_uppercase())),
            Box::new(|r| r.hash_before = Some(String::new())),
            Box::new(|r| r.hash_before = Some("a".repeat(63))),
            Box::new(|r| r.hash_after = Some("A".repeat(64))),
            Box::new(|r| r.hash_after = Some(format!("{}\n", "a".repeat(63)))),
        ];
        for (i, mutate) in cases.iter().enumerate() {
            let mut rec = record(&actor);
            mutate(&mut rec);
            let err = record_bytes(&rec).expect_err(&format!("kasus {i}"));
            assert_eq!(err.code(), "internal", "kasus {i}");
        }
    }

    #[test]
    fn sign_then_verify() {
        let (_tmp, id) = identity();
        let rec = record(id.public_key_hex());
        let sig = sign_event(&id, &rec).unwrap();
        assert_eq!(sig.len(), 128);
        assert!(sig.bytes().all(is_lower_hex_byte));
        assert!(verify_event(&rec, &sig));
    }

    #[test]
    fn sign_rejects_foreign_actor_and_bad_record() {
        let (_tmp, id) = identity();
        assert_eq!(
            sign_event(&id, &record(&"c".repeat(64)))
                .unwrap_err()
                .code(),
            "internal"
        );
        let mut rec = record(id.public_key_hex());
        rec.detail = "a\nb".into();
        assert_eq!(sign_event(&id, &rec).unwrap_err().code(), "internal");
    }

    #[test]
    fn verify_fails_when_any_field_or_sig_changes() {
        let (_tmp, id) = identity();
        let (_tmp2, other) = identity();
        let rec = record(id.public_key_hex());
        let sig = sign_event(&id, &rec).unwrap();

        let mutations: Vec<Mutation> = vec![
            Box::new(|r| r.request_id = None),
            Box::new(|r| r.request_id = Some("f".repeat(32))),
            Box::new(|r| r.kind = EventKind::Completed),
            Box::new(|r| r.actor_name = "Budi Santosa".into()),
            Box::new(|r| r.at = "2026-11-22T08:30:01Z".into()),
            Box::new(|r| r.hash_before = None),
            Box::new(|r| r.hash_before = Some("d".repeat(64))),
            Box::new(|r| r.hash_after = Some("e".repeat(64))),
            Box::new(|r| r.detail = "posisi 2".into()),
            Box::new(|r| r.detail = "posisi 1\n".into()),
        ];
        for (i, mutate) in mutations.iter().enumerate() {
            let mut changed = rec.clone();
            mutate(&mut changed);
            assert!(!verify_event(&changed, &sig), "kasus {i}");
        }

        let mut foreign = rec.clone();
        foreign.actor = other.public_key_hex().into();
        assert!(!verify_event(&foreign, &sig));

        let mut bad = sig.clone().into_bytes();
        bad[0] = if bad[0] == b'0' { b'1' } else { b'0' };
        assert!(!verify_event(&rec, std::str::from_utf8(&bad).unwrap()));
        assert!(!verify_event(&rec, &sig[..126]));
        assert!(!verify_event(&rec, ""));
        assert!(!verify_event(&rec, &format!("{sig}00")));
    }

    #[test]
    fn find_mira_doc_id_cases() {
        let tag = doc_tag(ID);
        assert_eq!(tag, format!("mira-doc:{ID}"));

        assert_eq!(find_mira_doc_id(b""), None);
        assert_eq!(find_mira_doc_id(b"%PDF-1.7 tanpa penanda"), None);
        assert_eq!(find_mira_doc_id(b"mira-doc:"), None);

        let found = format!("%PDF-1.7 /Keywords ({tag}) /X");
        assert_eq!(find_mira_doc_id(found.as_bytes()), Some(ID.into()));

        let short = format!("({MIRA_DOC_TAG_PREFIX}{})", &ID[..31]);
        assert_eq!(find_mira_doc_id(short.as_bytes()), None);

        let long = format!("({tag}0)");
        assert_eq!(find_mira_doc_id(long.as_bytes()), None);
        let long_upper = format!("({tag}A)");
        assert_eq!(find_mira_doc_id(long_upper.as_bytes()), None);

        let upper = format!("({MIRA_DOC_TAG_PREFIX}{})", ID.to_uppercase());
        assert_eq!(find_mira_doc_id(upper.as_bytes()), None);

        let second = "f".repeat(32);
        let many = format!(
            "mira-doc:xyz mira-mira-doc:{} ({tag}) mira-doc:{second}",
            &ID[..31]
        );
        assert_eq!(find_mira_doc_id(many.as_bytes()), Some(ID.into()));
        let first_valid_wins = format!("{} {tag}", doc_tag(&second));
        assert_eq!(
            find_mira_doc_id(first_valid_wins.as_bytes()),
            Some(second.clone())
        );

        let at_end = format!("data {tag}");
        assert_eq!(find_mira_doc_id(at_end.as_bytes()), Some(ID.into()));
        assert_eq!(find_mira_doc_id(tag.as_bytes()), Some(ID.into()));

        let mut binary = vec![0xffu8, 0x00, b'm', 0x80];
        binary.extend_from_slice(tag.as_bytes());
        binary.push(0xe2);
        assert_eq!(find_mira_doc_id(&binary), Some(ID.into()));
    }

    #[test]
    fn find_mira_doc_id_in_large_buffer() {
        let mut big = vec![b'm'; 50 * 1024 * 1024];
        assert_eq!(find_mira_doc_id(&big), None);
        let tag = doc_tag(ID);
        let at = big.len() - tag.len();
        big[at..].copy_from_slice(tag.as_bytes());
        assert_eq!(find_mira_doc_id(&big), Some(ID.into()));
    }

    #[test]
    fn looks_like_pdf_cases() {
        assert!(looks_like_pdf(b"%PDF-1.7\n"));
        assert!(looks_like_pdf(b"%PDF-"));
        let mut junk = vec![b' '; 1019];
        junk.extend_from_slice(b"%PDF-1.4");
        assert!(looks_like_pdf(&junk));
        let mut too_late = vec![b' '; 1020];
        too_late.extend_from_slice(b"%PDF-1.4");
        assert!(!looks_like_pdf(&too_late));
        assert!(!looks_like_pdf(b""));
        assert!(!looks_like_pdf(b"%PDF"));
        assert!(!looks_like_pdf(b"PK\x03\x04 bukan pdf"));
    }

    #[test]
    fn check_bytes_cases() {
        let data = b"%PDF-1.7 isi";
        let h = hash_hex(data);
        assert_eq!(check_bytes(&h, Some(data)), Integrity::Intact);
        assert_eq!(check_bytes(&h, Some(b"%PDF-1.7 isi!")), Integrity::Changed);
        assert_eq!(check_bytes(&h, None), Integrity::Missing);
        assert_eq!(check_bytes("bukan-hash", Some(data)), Integrity::Changed);
        assert_eq!(serde_json::to_value(Integrity::Intact).unwrap(), "intact");
        assert_eq!(serde_json::to_value(Integrity::Changed).unwrap(), "changed");
        assert_eq!(serde_json::to_value(Integrity::Missing).unwrap(), "missing");
    }
}
