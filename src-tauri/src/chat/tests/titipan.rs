//! TITIPAN: a message reaches an offline colleague through a third laptop,
//! even after the sender is switched off (plan section 5, "Selesai kalau").

use super::super::testutil::{Laptop, Office, Who, all_bytes_under, pull, run_fetches, sync};
use super::super::view::{DeliveryState, FileState};
use super::{messages, sign_as, status_of};
use crate::chat::model::Body;
use crate::network::feature::FeatureSync;

fn office() -> Office {
    Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Member),
    ])
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn assert_no_plaintext(l: &Laptop, secret: &[u8]) {
    for (path, bytes) in all_bytes_under(&l.data_dir()) {
        assert!(
            !contains(&bytes, secret),
            "plaintext found in {}",
            path.display()
        );
    }
}

#[test]
fn titipan_reaches_offline_recipient_after_sender_is_off() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    a.hooks.set_connected(&[&b.pk]);
    let dm = a.chat.open_dm(&c.pk).unwrap().id;
    let secret = "Gaji bulan ini naik, rahasia ya Citra";
    let m = a.chat.send(&dm, secret, None, vec![], vec![]).unwrap();
    assert_eq!(m.status.unwrap().state, DeliveryState::Pending);
    assert_eq!(
        a.count("SELECT count(*) FROM chat_envelopes WHERE recipient IS NOT NULL"),
        1
    );

    // B holds the envelope; A sees "Dititipkan".
    pull(a, b);
    pull(b, a);
    assert_eq!(status_of(a, &dm, &m.id), DeliveryState::Deposited);
    assert_eq!(
        b.count("SELECT count(*) FROM chat_envelopes WHERE acked = 0"),
        1
    );
    assert_eq!(b.count("SELECT count(*) FROM chat_messages"), 0);
    assert_eq!(
        b.chat.conversation(&dm, None, 10).unwrap_err().code(),
        "forbidden"
    );
    assert_no_plaintext(b, secret.as_bytes());

    // A is switched off. B and C meet.
    sync(&[b, c]);
    let ms = messages(c, &dm);
    assert_eq!(ms.len(), 1);
    assert_eq!(ms[0].text, secret);
    assert_eq!(ms[0].author.public_key, a.pk);
    assert!(c.count("SELECT count(*) FROM chat_records WHERE kind = 'envelope_ack'") == 1);
    c.chat.mark_read(&dm).unwrap();
    sync(&[b, c]);
    assert_eq!(
        b.count("SELECT count(*) FROM chat_records WHERE kind = 'envelope' AND body IS NOT NULL"),
        0,
        "B purged the envelope after the ack"
    );
    assert_eq!(b.count("SELECT count(*) FROM chat_messages"), 0);
    assert_no_plaintext(b, secret.as_bytes());

    // A comes back and meets only B: the ack says it arrived.
    sync(&[a, b]);
    assert_eq!(status_of(a, &dm, &m.id), DeliveryState::Delivered);
    assert_eq!(
        a.count("SELECT count(*) FROM chat_records WHERE kind = 'envelope' AND body IS NOT NULL"),
        0
    );
    // Later A meets C: read receipt.
    sync(&[a, c]);
    assert_eq!(status_of(a, &dm, &m.id), DeliveryState::Read);
    assert_eq!(
        c.count("SELECT count(*) FROM chat_messages"),
        1,
        "no duplicate from the direct copy"
    );
}

#[test]
fn titipan_with_small_attachment_goes_encrypted_through_custodian() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    a.hooks.set_connected(&[&b.pk]);
    let dm = a.chat.open_dm(&c.pk).unwrap().id;
    let file_secret = b"Isi kontrak rahasia nomor 4471 untuk Citra saja".repeat(20);
    let src = a.data_dir().join("kontrak.txt");
    std::fs::write(&src, &file_secret).unwrap();
    let m = a
        .chat
        .send(&dm, "", None, vec![], vec![src.clone()])
        .unwrap();
    assert_eq!(m.files.len(), 1);
    let hash = m.files[0].hash.clone();
    assert_eq!(m.files[0].mime, "text/plain");
    assert_eq!(m.files[0].state, FileState::Local);

    pull(a, b);
    assert_eq!(run_fetches(b, &[a]), 1, "custodian copies the cipher file");
    assert_no_plaintext(b, &file_secret);
    assert_eq!(
        b.count("SELECT count(*) FROM chat_blobs WHERE kind = 'cipher'"),
        1
    );

    // A is off.
    sync(&[b, c]);
    let view = c.chat.file_view(&hash).unwrap();
    assert_eq!(view.state, FileState::Fetching);
    assert_eq!(run_fetches(c, &[b]), 1);
    assert_eq!(c.chat.file_view(&hash).unwrap().state, FileState::Local);
    let path = c.chat.open_file_path(&m.id, &hash).unwrap();
    assert!(path.ends_with("kontrak.txt"));
    assert_eq!(std::fs::read(&path).unwrap(), file_secret);

    sync(&[b, c]);
    assert_eq!(
        b.count("SELECT count(*) FROM chat_envelopes WHERE acked = 1"),
        1
    );
    assert_eq!(
        b.count("SELECT count(*) FROM chat_blobs"),
        0,
        "cipher blob released"
    );
    let cipher_files = all_bytes_under(&b.data_dir().join("blobs"))
        .into_iter()
        .filter(|(p, _)| !p.components().any(|c| c.as_os_str() == "tmp"))
        .count();
    assert_eq!(cipher_files, 0, "cipher blob removed from B");
    assert_no_plaintext(b, &file_secret);

    sync(&[a, b]);
    assert_eq!(status_of(a, &dm, &m.id), DeliveryState::Delivered);
    assert_eq!(
        a.count("SELECT count(*) FROM chat_blobs WHERE kind = 'cipher'"),
        0
    );
    assert_eq!(
        a.count("SELECT count(*) FROM chat_blobs WHERE kind = 'plain'"),
        1,
        "original kept"
    );
}

#[test]
fn envelope_for_an_online_recipient_is_not_made() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    a.hooks.set_connected(&[&b.pk, &c.pk]);
    let dm = a.chat.open_dm(&c.pk).unwrap().id;
    a.chat.send(&dm, "langsung", None, vec![], vec![]).unwrap();
    assert_eq!(a.count("SELECT count(*) FROM chat_envelopes"), 0);
    pull(a, c);
    assert_eq!(messages(c, &dm).len(), 1);
}

#[test]
fn acks_count_only_from_the_recipient_even_when_early() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    a.hooks.set_connected(&[&b.pk]);
    let dm = a.chat.open_dm(&c.pk).unwrap().id;
    a.chat
        .send(&dm, "untuk Citra", None, vec![], vec![])
        .unwrap();
    let env: String = a.with_conn(|conn| {
        conn.query_row("SELECT id FROM chat_envelopes", [], |r| r.get(0))
            .unwrap()
    });
    let now = crate::clock::now();
    let fake = sign_as(
        b,
        &o.org_id,
        now,
        Body::EnvelopeAck {
            envelope: env.clone(),
            failed: false,
        },
    );
    // Known envelope, wrong author: stored (every laptop keeps the same
    // records) but it does nothing.
    let got = a.chat_ingest(&b.pk, vec![fake.to_feature_record()]);
    assert_eq!((got.accepted, got.rejected), (1, 0));
    assert!(a.rejected_codes().is_empty());
    assert_eq!(
        a.count("SELECT count(*) FROM chat_envelopes WHERE acked = 0"),
        1,
        "still live on the sender"
    );
    // Unknown envelope: stored, but it does nothing when the envelope arrives.
    assert_eq!(
        c.chat_ingest(&b.pk, vec![fake.to_feature_record()])
            .accepted,
        1
    );
    pull(a, b);
    assert_eq!(
        b.count("SELECT count(*) FROM chat_envelopes WHERE acked = 0"),
        1
    );
    sync(&[b, c]);
    assert_eq!(
        b.count("SELECT count(*) FROM chat_envelopes WHERE acked = 1"),
        1,
        "real ack"
    );
    assert_eq!(messages(c, &dm).len(), 1);
}

#[test]
fn early_ack_from_someone_else_leaves_the_envelope_live() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    a.hooks.set_connected(&[&b.pk]);
    let dm = a.chat.open_dm(&c.pk).unwrap().id;
    a.chat
        .send(&dm, "untuk Citra", None, vec![], vec![])
        .unwrap();
    let env: String = a.with_conn(|conn| {
        conn.query_row("SELECT id FROM chat_envelopes", [], |r| r.get(0))
            .unwrap()
    });
    let fake = sign_as(
        a,
        &o.org_id,
        crate::clock::now(),
        Body::EnvelopeAck {
            envelope: env,
            failed: false,
        },
    );
    assert_eq!(
        b.chat_ingest(&a.pk, vec![fake.to_feature_record()])
            .accepted,
        1
    );
    pull(a, b);
    assert_eq!(
        b.count("SELECT count(*) FROM chat_envelopes WHERE acked = 0"),
        1,
        "fake ack ignored"
    );
}

#[test]
fn old_envelopes_and_envelopes_for_removed_members_expire() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let now = crate::clock::now();
    let old = sign_as(
        a,
        &o.org_id,
        now - time::Duration::days(31),
        Body::Envelope {
            to: c.pk.clone(),
            sealed: "AAAA".into(),
            cipher_files: vec![],
        },
    );
    assert_eq!(
        b.chat_ingest(&a.pk, vec![old.to_feature_record()]).accepted,
        1
    );
    assert_eq!(
        b.count("SELECT count(*) FROM chat_envelopes WHERE acked = 2"),
        1
    );
    assert!(b.chat.record_ids_for(&c.pk).unwrap().is_empty());

    a.hooks.set_connected(&[&b.pk]);
    let dm = a.chat.open_dm(&c.pk).unwrap().id;
    let m = a.chat.send(&dm, "terlambat", None, vec![], vec![]).unwrap();
    pull(a, b);
    o.remove_member(&c.pk, &crate::permissions::format::format_time(now));
    a.chat.fetch_jobs().unwrap();
    b.chat.fetch_jobs().unwrap();
    for l in [a, b] {
        assert_eq!(
            l.count(
                "SELECT count(*) FROM chat_records WHERE kind = 'envelope' AND body IS NOT NULL"
            ),
            0
        );
    }
    let st = messages(a, &dm)
        .into_iter()
        .find(|x| x.id == m.id)
        .unwrap()
        .status
        .unwrap();
    assert_eq!(st.total, 0, "Citra is no longer in the conversation");
}

#[test]
fn unobtainable_cipher_file_backs_off_then_is_given_up_and_acked() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    a.hooks.set_connected(&[&b.pk]);
    let dm = a.chat.open_dm(&c.pk).unwrap().id;
    let src = a.data_dir().join("foto.jpg");
    std::fs::write(&src, b"bukan foto sungguhan").unwrap();
    a.chat
        .send(&dm, "fotonya", None, vec![], vec![src])
        .unwrap();
    pull(a, b);
    sync(&[b, c]); // B never copied the cipher file.
    assert_eq!(run_fetches(c, &[b]), 0);
    assert!(
        c.chat.fetch_jobs().unwrap().is_empty(),
        "waiting before the next try"
    );
    let hash: String = c.with_conn(|conn| {
        conn.query_row("SELECT hash FROM chat_files", [], |r| r.get(0))
            .unwrap()
    });
    assert_eq!(c.chat.file_view(&hash).unwrap().state, FileState::Missing);
    c.with_conn(|conn| {
        conn.execute(
            "UPDATE chat_fetch_queue SET next_try_at = NULL, first_error_at = '2020-01-01T00:00:00Z'",
            [],
        )
        .unwrap();
    });
    assert_eq!(run_fetches(c, &[b]), 0);
    assert_eq!(
        c.count("SELECT count(*) FROM chat_fetch_queue"),
        0,
        "dropped after 7 days"
    );
    assert_eq!(
        c.count("SELECT count(*) FROM chat_envelopes WHERE acked = 1"),
        1,
        "acked anyway"
    );
    assert_eq!(c.chat.file_view(&hash).unwrap().state, FileState::Missing);
    assert_eq!(messages(c, &dm).len(), 1);
}
