//! Forged, tampered and foreign records are refused and logged; ingest is
//! idempotent.

use super::super::testutil::{Office, Who};
use super::{feature, messages, sign_as, text_message};
use crate::chat::model::SignedRecord;
use crate::network::feature::{FeatureRecord, FeatureSync};

#[test]
fn bad_records_are_rejected_logged_and_ingest_is_idempotent() {
    let o = Office::new(&[("Sari", Who::Superadmin), ("Budi", Who::Member)]);
    let (a, b) = (&o.l[0], &o.l[1]);
    let umum = o.umum();
    let now = crate::clock::now();
    let good = sign_as(a, &o.org_id, now, text_message(&umum, "asli"));

    let tampered = FeatureRecord::new(good.body_json.replace("asli", "palsu"));
    let mut signed: SignedRecord = serde_json::from_str(&good.body_json).unwrap();
    signed.payload = signed.payload.replace(&a.pk, &b.pk);
    let swapped = FeatureRecord::new(serde_json::to_string(&signed).unwrap());
    let foreign = sign_as(a, &"f".repeat(32), now, text_message(&umum, "kantor lain"));
    let garbage = FeatureRecord::new("bukan json");

    let got = b
        .chat
        .ingest(&a.pk, vec![tampered, swapped, feature(&foreign), garbage])
        .unwrap();
    assert_eq!((got.accepted, got.rejected), (0, 4));
    let codes = b.rejected_codes();
    assert_eq!(
        codes,
        vec!["chat_bad_signature", "chat_bad_signature", "chat_wrong_org", "chat_bad_format"]
    );

    for _ in 0..3 {
        b.chat.ingest(&a.pk, vec![feature(&good)]).unwrap();
    }
    assert_eq!(messages(b, &umum).len(), 1);
    assert_eq!(b.count("SELECT count(*) FROM chat_receipts"), 1, "one delivered receipt");
    let again = b.chat.ingest(&a.pk, vec![feature(&good)]).unwrap();
    assert_eq!((again.accepted, again.rejected, again.changed), (0, 0, false));
    assert_eq!(b.rejected_codes().len(), 4, "duplicates are not logged");
}

#[test]
fn unknown_channel_and_unknown_author_are_deferred_not_logged() {
    let o = Office::new(&[("Sari", Who::Superadmin), ("Budi", Who::Member), ("Citra", Who::Member)]);
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let now = crate::clock::now();
    let unknown_channel = sign_as(a, &o.org_id, now, text_message(&format!("ch:{}", "7".repeat(32)), "?"));
    let got = b.chat.ingest(&a.pk, vec![feature(&unknown_channel)]).unwrap();
    assert_eq!((got.accepted, got.rejected), (0, 0));
    assert_eq!(b.chat.unknown_ids(std::slice::from_ref(&unknown_channel.id)).unwrap().len(), 1);

    // Citra is unknown on a fresh laptop that only knows Sari and Budi.
    b.with_conn(|conn| {
        conn.execute("DELETE FROM members WHERE public_key = ?1", [&c.pk]).unwrap();
    });
    let from_c = sign_as(c, &o.org_id, now, text_message(&o.umum(), "halo"));
    let got = b.chat.ingest(&a.pk, vec![feature(&from_c)]).unwrap();
    assert_eq!((got.accepted, got.rejected), (0, 0));
    assert!(b.rejected_codes().is_empty());
}
