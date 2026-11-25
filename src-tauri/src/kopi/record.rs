//! Sealing and checking Kopi records (docs/plans/kopi.md, 3.1).
//!
//! A record is a `documents::envelope` with domain [`DOMAIN`]
//! (`mira-kopi-v1`), so no other feature's record can be replayed as Kopi.
//! [`validate_shape`] holds every check that needs no context (no org state,
//! no clock); the role and clock checks happen at ingest (`sync.rs`) and
//! the counting rules in `rules.rs`.

use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::types::{
    DOMAIN, Payload, REASON_MAX, StoredRecord, TARGET_ID_MAX, Target, WORK_SNAPSHOT_MAX,
};
use crate::documents::envelope;
use crate::identity::Identity;
use crate::network::feature::FeatureRecord;
use crate::org::is_lower_hex;

/// Checks the payload, then signs it with this laptop's key.
pub fn seal(identity: &Identity, payload: &Payload) -> Result<FeatureRecord, String> {
    validate_shape(identity.public_key_hex(), payload)?;
    envelope::seal(identity, DOMAIN, payload)
}

/// Checks id, envelope, signature and shape. Every failure is a short
/// reason for the rejection log.
pub fn open(record: &FeatureRecord) -> Result<StoredRecord, String> {
    let opened: envelope::Opened<Payload> = envelope::open(DOMAIN, record)?;
    validate_shape(&opened.author, &opened.payload)?;
    Ok(StoredRecord {
        id: record.id.clone(),
        author: opened.author,
        payload: opened.payload,
    })
}

/// `at` of any payload.
pub fn payload_at(p: &Payload) -> &str {
    match p {
        Payload::Give { at, .. }
        | Payload::Hide { at, .. }
        | Payload::Settings { at, .. }
        | Payload::Work { at, .. } => at,
    }
}

/// Short name of the payload kind, as stored in `kopi_records.kind`.
pub fn kind_name(p: &Payload) -> &'static str {
    match p {
        Payload::Give { .. } => "give",
        Payload::Hide { .. } => "hide",
        Payload::Settings { .. } => "settings",
        Payload::Work { .. } => "work",
    }
}

/// RFC 3339 instant, or `None`.
pub fn parse_at(at: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(at, &Rfc3339).ok()
}

/// The date written in `at`, at the offset written in `at`, as `YYYY-MM-DD`.
/// `2026-11-24T23:30:00+07:00` is `2026-11-24` although it is the 24th
/// 16:30 UTC; `2026-11-25T00:30:00+07:00` is `2026-11-25`.
pub fn local_day(at: &str) -> Option<String> {
    let d = parse_at(at)?.date();
    Some(format!(
        "{:04}-{:02}-{:02}",
        d.year(),
        u8::from(d.month()),
        d.day()
    ))
}

fn check_at(at: &str) -> Result<(), String> {
    parse_at(at)
        .map(|_| ())
        .ok_or_else(|| "waktu bukan RFC 3339".to_owned())
}

fn check_reason(reason: &str) -> Result<(), String> {
    if reason.chars().any(char::is_control) {
        return Err("alasan memuat karakter kontrol".into());
    }
    let n = reason.trim().chars().count();
    if n == 0 {
        return Err("alasan kosong".into());
    }
    if n > REASON_MAX {
        return Err(format!("alasan lebih dari {REASON_MAX} karakter"));
    }
    Ok(())
}

fn is_message_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= TARGET_ID_MAX
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':'))
}

fn check_target(target: &Target, at: &str) -> Result<(), String> {
    match target {
        Target::Message { id } => {
            if !is_message_id(id) {
                return Err("id pesan tidak valid".into());
            }
        }
        Target::Task { project, task } => {
            if !is_lower_hex(project, 32) || !is_lower_hex(task, 32) {
                return Err("id proyek atau task bukan 32 hex".into());
            }
        }
        Target::Profile { day } => {
            if local_day(at).as_deref() != Some(day.as_str()) {
                return Err("hari profil tidak sama dengan tanggal pada waktu".into());
            }
        }
    }
    Ok(())
}

/// Checks that need no context. See the plan, 3.1.
pub fn validate_shape(author: &str, p: &Payload) -> Result<(), String> {
    if !is_lower_hex(author, 64) {
        return Err("kunci penulis tidak valid".into());
    }
    check_at(payload_at(p))?;
    match p {
        Payload::Give {
            to,
            target,
            reason,
            at,
            nonce,
        } => {
            if !is_lower_hex(to, 64) {
                return Err("kunci penerima tidak valid".into());
            }
            if to == author {
                return Err("kopi untuk diri sendiri".into());
            }
            check_reason(reason)?;
            if !is_lower_hex(nonce, 16) {
                return Err("nonce bukan 16 hex".into());
            }
            check_target(target, at)?;
        }
        Payload::Hide { record, .. } => {
            if !is_lower_hex(record, 64) {
                return Err("id record yang disembunyikan tidak valid".into());
            }
        }
        Payload::Settings { .. } => {}
        Payload::Work { items, .. } => {
            if items.len() > WORK_SNAPSHOT_MAX {
                return Err(format!("snapshot kerja lebih dari {WORK_SNAPSHOT_MAX} item"));
            }
            for item in items {
                if !is_lower_hex(&item.p, 32) || !is_lower_hex(&item.t, 32) {
                    return Err("id proyek atau task bukan 32 hex".into());
                }
                check_at(&item.done)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::db;
    use crate::documents::envelope::DOCS_DOMAIN;
    use crate::identity::{self, MemoryKeyStore};
    use crate::kopi::types::{WorkItem, WorkWhy};
    use crate::network::feature::MAX_RECORD_BYTES;

    pub(crate) fn me() -> (tempfile::TempDir, Identity) {
        let tmp = tempfile::tempdir().unwrap();
        let conn = db::open(tmp.path()).unwrap();
        let id = identity::ensure_identity(&conn, &MemoryKeyStore::new()).unwrap();
        (tmp, id)
    }

    const OTHER: &str = "bb";

    fn other() -> String {
        OTHER.repeat(32)
    }

    fn give(to: &str, target: Target, reason: &str, at: &str) -> Payload {
        Payload::Give {
            to: to.to_owned(),
            target,
            reason: reason.to_owned(),
            at: at.to_owned(),
            nonce: "0123456789abcdef".into(),
        }
    }

    fn msg() -> Target {
        Target::Message { id: "aa".repeat(32) }
    }

    const AT: &str = "2026-11-24T14:05:00+07:00";

    #[test]
    fn seal_open_round_trip() {
        let (_t, id) = me();
        let p = give(&other(), msg(), "Bantu cek laporan", AT);
        let r = seal(&id, &p).unwrap();
        let opened = open(&r).unwrap();
        assert_eq!(opened.id, r.id);
        assert_eq!(opened.author, id.public_key_hex());
        assert_eq!(opened.payload, p);

        let s = Payload::Settings {
            enabled: false,
            board: true,
            at: AT.into(),
        };
        assert_eq!(open(&seal(&id, &s).unwrap()).unwrap().payload, s);
    }

    #[test]
    fn record_of_other_domain_is_refused() {
        let (_t, id) = me();
        let p = give(&other(), msg(), "Terima kasih", AT);
        let docs = envelope::seal(&id, DOCS_DOMAIN, &p).unwrap();
        assert!(open(&docs).is_err());
        let tampered = FeatureRecord::new(seal(&id, &p).unwrap().body.replace("Terima", "Tarima"));
        assert!(open(&tampered).is_err());
    }

    #[test]
    fn seal_refuses_bad_shape() {
        let (_t, id) = me();
        let me_pk = id.public_key_hex().to_owned();
        assert!(seal(&id, &give(&me_pk, msg(), "aku", AT)).is_err());
    }

    #[test]
    fn validate_shape_reason() {
        let a = "aa".repeat(32);
        let ok = |r: &str| validate_shape(&a, &give(&other(), msg(), r, AT));
        assert!(ok("Mantap").is_ok());
        assert!(ok("").is_err());
        assert!(ok("   ").is_err());
        assert!(ok("baris\nbaru").is_err());
        assert!(ok("tab\tdi").is_err());
        assert!(ok("nol\u{0}").is_err());
        assert!(ok(&"x".repeat(REASON_MAX)).is_ok());
        assert!(ok(&format!("  {}  ", "x".repeat(REASON_MAX))).is_ok());
        assert!(ok(&"x".repeat(REASON_MAX + 1)).is_err());
        // Characters, not bytes.
        assert!(ok(&"é".repeat(REASON_MAX)).is_ok());
    }

    #[test]
    fn validate_shape_people_time_nonce_and_targets() {
        let a = "aa".repeat(32);
        let v = |p: &Payload| validate_shape(&a, p);
        assert!(v(&give(&a, msg(), "diri", AT)).is_err(), "to == author");
        assert!(v(&give("xyz", msg(), "x", AT)).is_err(), "bad to");
        assert!(validate_shape("AA", &give(&other(), msg(), "x", AT)).is_err());
        assert!(v(&give(&other(), msg(), "x", "kemarin")).is_err());
        assert!(v(&give(&other(), msg(), "x", "2026-11-24 14:05:00")).is_err());
        assert!(v(&give(&other(), msg(), "x", "2026-11-24T07:05:00Z")).is_ok());

        let mut bad_nonce = give(&other(), msg(), "x", AT);
        if let Payload::Give { nonce, .. } = &mut bad_nonce {
            *nonce = "0123456789ABCDEF".into();
        }
        assert!(v(&bad_nonce).is_err(), "uppercase nonce");
        if let Payload::Give { nonce, .. } = &mut bad_nonce {
            *nonce = "0123".into();
        }
        assert!(v(&bad_nonce).is_err(), "short nonce");

        let empty = Target::Message { id: String::new() };
        assert!(v(&give(&other(), empty, "x", AT)).is_err());
        let long = Target::Message {
            id: "a".repeat(TARGET_ID_MAX + 1),
        };
        assert!(v(&give(&other(), long, "x", AT)).is_err());
        let spaced = Target::Message { id: "a b".into() };
        assert!(v(&give(&other(), spaced, "x", AT)).is_err());

        let task = |p: &str, t: &str| Target::Task {
            project: p.into(),
            task: t.into(),
        };
        let h32 = "ab".repeat(16);
        assert!(v(&give(&other(), task(&h32, &h32), "x", AT)).is_ok());
        assert!(v(&give(&other(), task("p", &h32), "x", AT)).is_err());
        assert!(v(&give(&other(), task(&h32, ""), "x", AT)).is_err());

        let day = |d: &str| Target::Profile { day: d.into() };
        assert!(v(&give(&other(), day("2026-11-24"), "x", AT)).is_ok());
        assert!(
            v(&give(&other(), day("2026-11-24"), "x", "2026-11-25T00:30:00+07:00")).is_err(),
            "day must match the local date in at"
        );
        assert!(
            v(&give(&other(), day("2026-11-24"), "x", "2026-11-24T17:30:00Z")).is_ok(),
            "UTC offset: UTC date"
        );
        assert!(v(&give(&other(), day("24-11-2026"), "x", AT)).is_err());
    }

    #[test]
    fn validate_shape_hide_settings_work() {
        let a = "aa".repeat(32);
        let hide = |r: &str| Payload::Hide {
            record: r.into(),
            hidden: true,
            at: AT.into(),
        };
        assert!(validate_shape(&a, &hide(&"cd".repeat(32))).is_ok());
        assert!(validate_shape(&a, &hide("cd")).is_err());
        let settings = Payload::Settings {
            enabled: true,
            board: false,
            at: "x".into(),
        };
        assert!(validate_shape(&a, &settings).is_err());

        let item = |done: &str| WorkItem {
            p: "ab".repeat(16),
            t: "cd".repeat(16),
            done: done.into(),
            why: WorkWhy::Assigned,
        };
        let work = |items: Vec<WorkItem>| Payload::Work {
            at: AT.into(),
            items,
        };
        assert!(validate_shape(&a, &work(vec![item("2026-11-24T01:00:00Z")])).is_ok());
        assert!(validate_shape(&a, &work(vec![item("besok")])).is_err());
        let many = vec![item("2026-11-24T01:00:00Z"); WORK_SNAPSHOT_MAX + 1];
        assert!(validate_shape(&a, &work(many)).is_err());
    }

    #[test]
    fn largest_work_snapshot_fits_in_one_record() {
        let (_t, id) = me();
        let items = vec![
            WorkItem {
                p: "ab".repeat(16),
                t: "cd".repeat(16),
                done: "2026-11-24T01:00:00.123456789+07:00".into(),
                why: WorkWhy::OnTime,
            };
            WORK_SNAPSHOT_MAX
        ];
        let r = seal(&id, &Payload::Work { at: AT.into(), items }).unwrap();
        assert!(r.body.len() <= MAX_RECORD_BYTES, "{} bytes", r.body.len());
    }

    #[test]
    fn local_day_uses_the_written_offset() {
        assert_eq!(local_day("2026-11-24T23:30:00+07:00").unwrap(), "2026-11-24");
        assert_eq!(local_day("2026-11-25T00:30:00+07:00").unwrap(), "2026-11-25");
        assert_eq!(local_day("2026-11-24T20:00:00-05:00").unwrap(), "2026-11-24");
        assert_eq!(local_day("bukan waktu"), None);
    }
}
