//! Review findings: which blobs chat serves, records that must be stored
//! the same way on every laptop whatever order they arrive in, opening files
//! by message, and smaller fixes.

use super::super::testutil::{Laptop, Office, Who, pull, run_fetches, sync};
use super::super::view::{DeliveryState, NotifyMode};
use super::{feature, messages, sign_as, status_of};
use crate::blobs::BlobHash;
use crate::chat::model::{self, Body, ChannelScope, CipherFileRef, FileRef};
use crate::network::feature::{BlobSource, FeatureSync};

fn office() -> Office {
    Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Member),
    ])
}

fn connect_all(o: &Office) {
    for l in &o.l {
        let others: Vec<&str> =
            o.l.iter()
                .filter(|x| x.pk != l.pk)
                .map(|x| x.pk.as_str())
                .collect();
        l.hooks.set_connected(&others);
    }
}

fn write_file(l: &Laptop, name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let path = l.data_dir().join(name);
    std::fs::write(&path, bytes).unwrap();
    path
}

fn file_ref(bytes: &[u8], name: &str) -> FileRef {
    FileRef {
        hash: BlobHash::of_bytes(bytes).to_string(),
        size: bytes.len() as u64,
        name: name.to_owned(),
        mime: "application/pdf".to_owned(),
    }
}

fn served(l: &Laptop, peer: &Laptop, hash: &str) -> bool {
    l.chat.blob_path_for(&peer.pk, hash).is_some()
}

// --- 1. Plain blobs are served by origin, not because a message names them.

#[test]
fn preexisting_document_blob_named_by_someone_elses_message_is_refused() {
    let o = office();
    connect_all(&o);
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let doc = b"Kontrak klien, disimpan modul dokumen".repeat(10);
    // The documents module put this blob on Budi's laptop.
    let hash = b.chat.blobs.put_bytes(&doc).unwrap().hash.to_string();
    // Sari knows the hash and names it in a message in #umum.
    let lure = sign_as(
        a,
        &o.org_id,
        crate::clock::now(),
        Body::Message {
            conv: o.umum(),
            text: "tolong kirim".into(),
            reply_to: None,
            mentions: vec![],
            files: vec![file_ref(&doc, "kontrak.pdf")],
        },
    );
    assert_eq!(b.chat_ingest(&a.pk, vec![feature(&lure)]).accepted, 1);
    assert!(!served(b, c, &hash), "preexisting blob named by another");
    assert!(!served(b, a, &hash));

    // Budi attaching the same file to his own message does serve it.
    let src = write_file(b, "kontrak.pdf", &doc);
    b.chat
        .send(&o.umum(), "ini filenya", None, vec![], vec![src])
        .unwrap();
    assert!(served(b, c, &hash), "attached by this laptop");
}

#[test]
fn team_blob_is_refused_to_a_non_member_and_allowed_to_a_member() {
    let o = office();
    connect_all(&o);
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let (_team, conv) = o.add_team("Keuangan", &[(&a.pk, true), (&b.pk, false)]);
    let bytes = b"Laporan laba rugi kuartal tiga".repeat(10);
    let src = write_file(a, "laba-rugi.pdf", &bytes);
    let m = a.chat.send(&conv, "", None, vec![], vec![src]).unwrap();
    let hash = m.files[0].hash.clone();
    pull(a, b);
    assert_eq!(run_fetches(b, &[a]), 1);
    assert!(served(a, b, &hash), "sender serves a member");
    assert!(served(b, a, &hash), "fetched copy serves a member");
    assert!(!served(a, c, &hash), "sender refuses a non-member");
    assert!(!served(b, c, &hash), "fetched copy refuses a non-member");

    // Citra names the hash in #umum: still refused.
    let lure = sign_as(
        c,
        &o.org_id,
        crate::clock::now(),
        Body::Message {
            conv: o.umum(),
            text: "minta".into(),
            reply_to: None,
            mentions: vec![],
            files: vec![file_ref(&bytes, "laba-rugi.pdf")],
        },
    );
    assert_eq!(b.chat_ingest(&c.pk, vec![feature(&lure)]).accepted, 1);
    assert_eq!(a.chat_ingest(&c.pk, vec![feature(&lure)]).accepted, 1);
    assert!(!served(b, c, &hash));
    assert!(!served(a, c, &hash));
}

// --- 2. Envelope cipher files.

#[test]
fn envelope_naming_a_plain_team_blob_does_not_make_it_downloadable() {
    let o = office();
    connect_all(&o);
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let (_team, conv) = o.add_team("Keuangan", &[(&a.pk, true), (&b.pk, false)]);
    let bytes = b"Daftar gaji".repeat(30);
    let src = write_file(a, "gaji.xlsx", &bytes);
    let m = a.chat.send(&conv, "", None, vec![], vec![src]).unwrap();
    let hash = m.files[0].hash.clone();
    pull(a, b);
    assert_eq!(run_fetches(b, &[a]), 1);
    let env = sign_as(
        c,
        &o.org_id,
        crate::clock::now(),
        Body::Envelope {
            to: a.pk.clone(),
            sealed: "AAAA".into(),
            cipher_files: vec![CipherFileRef {
                hash: hash.clone(),
                size: bytes.len() as u64,
            }],
        },
    );
    assert_eq!(b.chat_ingest(&c.pk, vec![feature(&env)]).accepted, 1);
    b.chat.fetch_jobs().unwrap();
    assert!(!served(b, c, &hash), "custodian side");
    let env_for_b = sign_as(
        c,
        &o.org_id,
        crate::clock::now(),
        Body::Envelope {
            to: b.pk.clone(),
            sealed: "AAAA".into(),
            cipher_files: vec![CipherFileRef {
                hash: hash.clone(),
                size: bytes.len() as u64,
            }],
        },
    );
    assert_eq!(a.chat_ingest(&c.pk, vec![feature(&env_for_b)]).accepted, 1);
    assert!(!served(a, c, &hash), "sender side");
}

// --- 3. Records judged the same whatever order they arrive in.

#[test]
fn reply_into_another_conversation_is_stored_and_ignored_in_any_order() {
    let o = office();
    connect_all(&o);
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let (_team, team_conv) = o.add_team("Proyek", &[(&a.pk, true), (&b.pk, false)]);
    let secret = a
        .chat
        .send(&team_conv, "rahasia tim", None, vec![], vec![])
        .unwrap();
    pull(a, b);
    let reply = sign_as(
        b,
        &o.org_id,
        crate::clock::now(),
        Body::Message {
            conv: o.umum(),
            text: "lihat ini".into(),
            reply_to: Some(secret.id.clone()),
            mentions: vec![],
            files: vec![],
        },
    );
    // A knows the target, C does not: both store the reply.
    for l in [a, c] {
        let got = l.chat_ingest(&b.pk, vec![feature(&reply)]);
        assert_eq!((got.accepted, got.rejected), (1, 0), "{}", l.name);
        assert!(l.rejected_codes().is_empty());
    }
    let shown = messages(a, &o.umum())
        .into_iter()
        .find(|m| m.id == reply.id)
        .unwrap();
    assert!(shown.reply_to.is_none(), "cross-conversation reply hidden");
    assert_eq!(shown.text, "lihat ini");
}

#[test]
fn delete_with_wrong_author_or_conversation_is_stored_and_does_nothing() {
    let o = office();
    connect_all(&o);
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let umum = o.umum();
    let m = a
        .chat
        .send(&umum, "pesan asli", None, vec![], vec![])
        .unwrap();
    pull(a, c);
    let now = crate::clock::now();
    let wrong_author = sign_as(
        b,
        &o.org_id,
        now,
        Body::MessageDelete {
            conv: umum.clone(),
            message: m.id.clone(),
            message_author: b.pk.clone(),
            message_at: m.at.clone(),
        },
    );
    let wrong_conv = sign_as(
        b,
        &o.org_id,
        now,
        Body::MessageDelete {
            conv: model::dm_conv(&b.pk, &c.pk),
            message: m.id.clone(),
            message_author: b.pk.clone(),
            message_at: m.at.clone(),
        },
    );
    let got = c.chat_ingest(&b.pk, vec![feature(&wrong_author), feature(&wrong_conv)]);
    assert_eq!((got.accepted, got.rejected), (2, 0));
    assert!(c.rejected_codes().is_empty());
    let ms = messages(c, &umum);
    assert_eq!(ms.len(), 1);
    assert!(!ms[0].deleted);
    assert_eq!(ms[0].text, "pesan asli");

    // B receives the deletes before the message: same outcome.
    let got = b.chat_ingest(&c.pk, vec![feature(&wrong_author), feature(&wrong_conv)]);
    assert_eq!((got.accepted, got.rejected), (2, 0));
    pull(a, b);
    let ms = messages(b, &umum);
    assert_eq!(ms.len(), 1);
    assert!(!ms[0].deleted);
    assert_eq!(
        b.count(&format!(
            "SELECT count(*) FROM chat_messages WHERE id = '{}'",
            m.id
        )),
        1,
        "no placeholder left in the other conversation"
    );
    for l in [b, c] {
        assert_eq!(
            l.count("SELECT count(*) FROM chat_records WHERE kind = 'message_delete'"),
            2
        );
    }
}

// --- 4. Channel ids.

#[test]
fn non_superadmin_org_channel_is_not_accepted_at_ingest() {
    let o = office();
    let (a, b) = (&o.l[0], &o.l[1]);
    let rec = sign_as(
        b,
        &o.org_id,
        crate::clock::now(),
        Body::ChannelCreate {
            channel: String::new(),
            name: "kantor-baru".into(),
            scope: ChannelScope::Org,
        },
    );
    let got = a.chat_ingest(&b.pk, vec![feature(&rec)]);
    assert_eq!(got.accepted, 0);
    assert_eq!(a.count("SELECT count(*) FROM chat_records"), 0);
    assert_eq!(a.count("SELECT count(*) FROM chat_channels"), 0);
}

// --- 5. Envelopes the judge refuses.

#[test]
fn envelope_between_members_sharing_no_conversation_is_not_accepted() {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Gita", Who::Guest),
    ]);
    let (a, b, g) = (&o.l[0], &o.l[1], &o.l[2]);
    let env = sign_as(
        g,
        &o.org_id,
        crate::clock::now(),
        Body::Envelope {
            to: b.pk.clone(),
            sealed: "AAAA".into(),
            cipher_files: vec![],
        },
    );
    let got = a.chat_ingest(&g.pk, vec![feature(&env)]);
    assert_eq!(got.accepted, 0);
    assert_eq!(a.count("SELECT count(*) FROM chat_records"), 0);
    assert_eq!(a.count("SELECT count(*) FROM chat_envelopes"), 0);
}

#[test]
fn envelope_with_an_oversized_cipher_file_is_rejected() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let env = sign_as(
        a,
        &o.org_id,
        crate::clock::now(),
        Body::Envelope {
            to: c.pk.clone(),
            sealed: "AAAA".into(),
            cipher_files: vec![CipherFileRef {
                hash: "1".repeat(64),
                size: crate::chat::judge::max_cipher_bytes() + 1,
            }],
        },
    );
    let got = b.chat_ingest(&a.pk, vec![feature(&env)]);
    assert_eq!((got.accepted, got.rejected), (0, 1));
    assert_eq!(b.rejected_codes(), vec!["chat_bad_format"]);
    assert_eq!(b.count("SELECT count(*) FROM chat_fetch_queue"), 0);
}

// --- 6. Downloads and blobs.

#[test]
fn fetch_done_with_the_wrong_content_is_refused() {
    let o = office();
    connect_all(&o);
    let (a, b) = (&o.l[0], &o.l[1]);
    let src = write_file(a, "denah.pdf", &b"denah lantai dua".repeat(10));
    let m = a.chat.send(&o.umum(), "", None, vec![], vec![src]).unwrap();
    pull(a, b);
    let jobs = b.chat.fetch_jobs().unwrap();
    assert_eq!(jobs.len(), 1);
    let dest = b.data_dir().join("palsu.tmp");
    std::fs::write(&dest, vec![b'x'; usize::try_from(jobs[0].size).unwrap()]).unwrap();
    assert!(b.chat.fetch_done(&jobs[0], &dest).is_err());
    assert!(
        !b.chat
            .blobs
            .contains(&BlobHash::parse(&m.files[0].hash).unwrap())
    );
    assert_eq!(b.count("SELECT count(*) FROM chat_blobs"), 0);
    assert_eq!(
        b.count("SELECT attempts FROM chat_fetch_queue"),
        1,
        "counted as a failed try"
    );
    assert!(!dest.exists());
}

#[test]
fn preexisting_blob_survives_purge() {
    let o = office();
    connect_all(&o);
    let (a, b) = (&o.l[0], &o.l[1]);
    let doc = b"Gambar kerja, dari modul dokumen".repeat(10);
    let blob = b.chat.blobs.put_bytes(&doc).unwrap().hash;
    let src = write_file(a, "gambar.pdf", &doc);
    let m = a.chat.send(&o.umum(), "", None, vec![], vec![src]).unwrap();
    pull(a, b);
    assert_eq!(
        b.count("SELECT preexisting FROM chat_blobs"),
        1,
        "tracked as preexisting"
    );
    a.chat.delete_message(&o.umum(), &m.id).unwrap();
    pull(a, b);
    assert!(messages(b, &o.umum())[0].deleted);
    assert!(b.chat.blobs.contains(&blob), "document blob kept");
}

#[test]
fn opened_copy_is_removed_when_its_message_is_deleted() {
    let o = office();
    connect_all(&o);
    let a = &o.l[0];
    let src = write_file(a, "catatan.txt", b"catatan rapat");
    let m = a.chat.send(&o.umum(), "", None, vec![], vec![src]).unwrap();
    let hash = m.files[0].hash.clone();
    let path = a.chat.open_file_path(&m.id, &hash).unwrap();
    assert!(path.is_file());
    a.chat.delete_message(&o.umum(), &m.id).unwrap();
    assert!(!a.data_dir().join("chat-files").join(&hash).exists());
}

#[test]
fn peer_connected_resets_download_backoff() {
    let o = office();
    connect_all(&o);
    let (a, b) = (&o.l[0], &o.l[1]);
    let src = write_file(a, "foto.jpg", b"bukan foto sungguhan");
    a.chat.send(&o.umum(), "", None, vec![], vec![src]).unwrap();
    pull(a, b);
    assert_eq!(run_fetches(b, &[]), 0);
    assert!(b.chat.fetch_jobs().unwrap().is_empty(), "backing off");
    b.chat.peer_connected(&a.pk);
    assert_eq!(b.chat.fetch_jobs().unwrap().len(), 1);
    assert_eq!(run_fetches(b, &[a]), 1);
}

// --- 7. Notifications and statuses.

#[test]
fn mentions_mode_notifies_for_the_newest_message_that_mentions_me() {
    let o = office();
    connect_all(&o);
    let (a, b) = (&o.l[0], &o.l[1]);
    let umum = o.umum();
    b.chat.set_notify(NotifyMode::Mentions).unwrap();
    a.chat
        .send(&umum, "untuk Budi", None, vec![b.pk.clone()], vec![])
        .unwrap();
    a.chat
        .send(&umum, "tanpa sebutan", None, vec![], vec![])
        .unwrap();
    pull(a, b);
    let got = b.hooks.take_notifications();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].body, "untuk Budi");
}

#[test]
fn ack_after_a_failed_open_is_not_shown_as_delivered() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    a.hooks.set_connected(&[&b.pk, &c.pk]);
    let dm = a.chat.open_dm(&c.pk).unwrap().id;
    let m = a
        .chat
        .send(&dm, "untuk Citra", None, vec![], vec![])
        .unwrap();
    // An envelope for that message that Citra cannot open.
    let broken = sign_as(
        a,
        &o.org_id,
        crate::clock::now(),
        Body::Envelope {
            to: c.pk.clone(),
            sealed: "AAAA".into(),
            cipher_files: vec![],
        },
    );
    assert_eq!(a.chat_ingest(&b.pk, vec![feature(&broken)]).accepted, 1);
    a.with_conn(|conn| {
        conn.execute(
            "UPDATE chat_envelopes SET message_id = ?2 WHERE id = ?1",
            [&broken.id, &m.id],
        )
        .unwrap();
    });
    pull(a, b);
    assert_eq!(status_of(a, &dm, &m.id), DeliveryState::Deposited);
    sync(&[b, c]);
    assert_eq!(
        c.count("SELECT count(*) FROM chat_envelopes WHERE acked = 1"),
        1,
        "Citra acked the broken envelope"
    );
    sync(&[a, b]);
    assert_eq!(
        a.count("SELECT count(*) FROM chat_envelopes WHERE acked = 1"),
        1
    );
    assert_ne!(status_of(a, &dm, &m.id), DeliveryState::Delivered);
}

// --- 8. Opening a file by message.

#[test]
fn open_file_uses_the_name_in_that_message() {
    let o = office();
    connect_all(&o);
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let bytes = b"isi yang sama".to_vec();
    let first = a
        .chat
        .send(
            &o.umum(),
            "",
            None,
            vec![],
            vec![write_file(a, "laporan.pdf", &bytes)],
        )
        .unwrap();
    let second = a
        .chat
        .send(
            &o.umum(),
            "",
            None,
            vec![],
            vec![write_file(a, "salinan.pdf", &bytes)],
        )
        .unwrap();
    let hash = first.files[0].hash.clone();
    assert!(
        a.chat
            .open_file_path(&first.id, &hash)
            .unwrap()
            .ends_with("laporan.pdf")
    );
    assert!(
        a.chat
            .open_file_path(&second.id, &hash)
            .unwrap()
            .ends_with("salinan.pdf")
    );

    let other = a
        .chat
        .send(&o.umum(), "teks saja", None, vec![], vec![])
        .unwrap();
    assert_eq!(
        a.chat.open_file_path(&other.id, &hash).unwrap_err().code(),
        "not_found",
        "file not in that message"
    );
    assert_eq!(
        a.chat
            .open_file_path(&"0".repeat(64), &hash)
            .unwrap_err()
            .code(),
        "not_found"
    );

    // A message in a team channel Citra is not in.
    let (_team, conv) = o.add_team("Keuangan", &[(&a.pk, true), (&b.pk, false)]);
    let team_msg = a
        .chat
        .send(
            &conv,
            "",
            None,
            vec![],
            vec![write_file(a, "gaji.pdf", &bytes)],
        )
        .unwrap();
    pull(a, c);
    assert!(c.chat.open_file_path(&team_msg.id, &hash).is_err());
}
