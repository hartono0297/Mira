//! Office and own stickers, sticker messages (v0.5.1, docs/plans/chat-sticker.md).

use std::path::PathBuf;

use super::super::testutil::{Laptop, Office, Who, pull, run_fetches};
use super::super::view::{MessageView, OfficeStickerState, StickerCatalog, StickerSource};
use super::{feature, messages, sign_as};
use crate::blobs::BlobHash;
use crate::chat::model::{self, Body, FileRef, StickerState};
use crate::error::AppError;
use crate::network::feature::{BlobSource, FeatureSync};

/// `testutil` leaves `members.app_version` NULL, which `compat` counts as
/// older than 0.5.1, so `sticker_set` would never be offered. Every laptop
/// here reports this build.
fn modern(o: &Office) {
    o.exec(
        "UPDATE members SET app_version = ?1",
        &[crate::device::APP_VERSION],
    );
}

fn office_with(people: &[(&str, Who)]) -> Office {
    let o = Office::new(people);
    modern(&o);
    o.connect_all();
    o
}

/// Sari superadmin, Budi and Citra members.
fn office() -> Office {
    office_with(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Member),
    ])
}

fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c ^= u32::from(b);
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
    }
    !c
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend(u32::try_from(data.len()).unwrap().to_be_bytes());
    let mut body = kind.to_vec();
    body.extend(data);
    out.extend(&body);
    out.extend(crc32(&body).to_be_bytes());
}

/// A small valid RGBA PNG, `side` x `side`, every pixel `shade`.
fn png(side: u32, shade: u8) -> Vec<u8> {
    let side_px = usize::try_from(side).unwrap();
    // Each row: filter byte 0, then the pixels.
    let mut row = vec![0u8];
    row.extend([shade, shade, 255 - shade, 255].repeat(side_px));
    let raw = row.repeat(side_px);
    let len = u16::try_from(raw.len()).unwrap();
    let mut z = vec![0x78, 0x01, 0x01];
    z.extend(len.to_le_bytes());
    z.extend((!len).to_le_bytes());
    z.extend(&raw);
    let (mut a, mut b) = (1u32, 0u32);
    for &x in &raw {
        a = (a + u32::from(x)) % 65521;
        b = (b + a) % 65521;
    }
    z.extend(((b << 16) | a).to_be_bytes());
    let mut ihdr = Vec::new();
    ihdr.extend(side.to_be_bytes());
    ihdr.extend(side.to_be_bytes());
    ihdr.extend([8, 6, 0, 0, 0]);
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &z);
    chunk(&mut out, b"IEND", &[]);
    out
}

/// The classic 1x1 transparent GIF89a.
const GIF: &[u8] = &[
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00,
    0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00,
    0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x01, 0x44, 0x00, 0x3b,
];

fn write_file(l: &Laptop, name: &str, bytes: &[u8]) -> PathBuf {
    let path = l.data_dir().join(name);
    std::fs::write(&path, bytes).unwrap();
    path
}

fn add_office(l: &Laptop, name: &str, bytes: &[u8]) -> String {
    let path = write_file(l, &format!("{name}.png"), bytes);
    l.chat
        .office_sticker_add(&path, "Kantor", name, &["lucu".to_owned()])
        .unwrap()
        .id
}

fn catalog(l: &Laptop) -> StickerCatalog {
    l.chat.stickers().unwrap()
}

/// `(id, pack, name, keywords, hash, state)` of the office stickers.
fn office_list(l: &Laptop) -> Vec<(String, String, String, Vec<String>, String, OfficeStickerState)> {
    catalog(l)
        .office
        .into_iter()
        .map(|s| (s.id, s.pack, s.name, s.keywords, s.hash, s.state))
        .collect()
}

fn has_blob(l: &Laptop, hash: &str) -> bool {
    l.chat.blobs.contains(&BlobHash::parse(hash).unwrap())
}

fn served(l: &Laptop, peer: &Laptop, hash: &str) -> bool {
    l.chat.blob_path_for(&peer.pk, hash).is_some()
}

fn last(l: &Laptop, conv: &str) -> MessageView {
    messages(l, conv).pop().expect("a message")
}

fn sticker_record_ids(l: &Laptop) -> Vec<String> {
    l.with_conn(|c| {
        let mut stmt = c
            .prepare("SELECT id FROM chat_records WHERE kind = 'sticker_set' ORDER BY rowid")
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    })
}

fn sticker_records(l: &Laptop) -> Vec<crate::network::feature::FeatureRecord> {
    let ids = sticker_record_ids(l);
    l.with_conn(|c| {
        ids.iter()
            .map(|id| crate::network::feature::FeatureRecord {
                id: id.clone(),
                body: c
                    .query_row("SELECT body FROM chat_records WHERE id = ?1", [id], |r| {
                        r.get(0)
                    })
                    .unwrap(),
            })
            .collect()
    })
}

fn png_ref(name: &str, bytes: &[u8]) -> FileRef {
    FileRef {
        hash: BlobHash::of_bytes(bytes).to_string(),
        size: bytes.len() as u64,
        name: format!("{name}.sticker.png"),
        mime: "image/png".into(),
    }
}

fn set_body(id: &str, name: &str, state: StickerState, bytes: &[u8]) -> Body {
    Body::StickerSet {
        sticker: id.to_owned(),
        pack: "Kantor".into(),
        name: name.to_owned(),
        keywords: vec![],
        file: png_ref(name, bytes),
        state,
    }
}

fn ago(secs: i64) -> time::OffsetDateTime {
    crate::clock::now() - time::Duration::seconds(secs)
}

#[test]
fn office_sticker_reaches_every_laptop_with_its_image() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let bytes = png(4, 10);
    let path = write_file(a, "Kucing Lucu.png", &bytes);
    let picked = a.chat.inspect_picked(&path).unwrap();
    assert_eq!(
        (picked.name.as_str(), picked.mime.as_str(), picked.width, picked.frames),
        ("kucing_lucu", "image/png", 4, 1)
    );
    let v = a
        .chat
        .office_sticker_add(&path, " Kantor ", ":Kucing:", &["Lucu".into(), "lucu".into()])
        .unwrap();
    assert_eq!((v.pack.as_str(), v.name.as_str()), ("Kantor", "kucing"));
    assert_eq!(v.keywords, vec!["lucu"]);
    assert!(v.ready && !v.name_taken && v.state == OfficeStickerState::Active);
    assert!(catalog(a).can_manage);

    o.sync_all();
    let cb = catalog(b);
    assert!(!cb.can_manage);
    assert_eq!(cb.office.len(), 1);
    assert!(!cb.office[0].ready, "image still downloading");
    assert_eq!(run_fetches(b, &[a]), 1);
    assert!(catalog(b).office[0].ready);
    // Budi fetched it for the catalog, so he serves it to Citra.
    assert!(served(b, c, &v.hash));
    assert_eq!(run_fetches(c, &[b]), 1);
    assert_eq!(office_list(a), office_list(b));
    assert_eq!(office_list(a), office_list(c));
    let url = c.chat.sticker_image(&v.hash).unwrap();
    assert!(url.starts_with("data:image/png;base64,"), "{url}");

    // The same name again is refused on the superadmin's laptop.
    let other = write_file(a, "lain.png", &png(3, 20));
    let err = a
        .chat
        .office_sticker_add(&other, "Kantor", "kucing", &[])
        .unwrap_err();
    assert!(err.to_string().contains(":kucing: sudah dipakai"), "{err}");
}

#[test]
fn only_superadmins_set_office_stickers_and_older_laptops_are_not_offered() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let path = write_file(b, "kucing.png", &png(2, 1));
    assert!(matches!(
        b.chat.office_sticker_add(&path, "Kantor", "kucing", &[]),
        Err(AppError::Forbidden(_))
    ));
    let forged = sign_as(
        b,
        &o.org_id,
        ago(5),
        set_body(&model::random_hex32(), "kucing", StickerState::Active, &png(2, 1)),
    );
    let got = a.chat_ingest(&b.pk, vec![feature(&forged)]);
    assert_eq!((got.accepted, got.rejected), (0, 1));
    assert!(a.rejected_codes().contains(&"chat_forbidden".to_owned()));
    assert!(catalog(a).office.is_empty());

    // An unknown author waits (Defer): neither stored nor logged.
    let stranger = office_with(&[("Asing", Who::Superadmin)]);
    let unknown = sign_as(
        &stranger.l[0],
        &o.org_id,
        ago(5),
        set_body(&model::random_hex32(), "asing", StickerState::Active, &png(2, 2)),
    );
    let before = a.rejected_codes().len();
    let got = a.chat_ingest(&stranger.l[0].pk, vec![feature(&unknown)]);
    assert_eq!((got.accepted, got.rejected), (0, 0));
    assert_eq!(a.rejected_codes().len(), before);

    add_office(a, "kucing", &png(2, 3));
    let id = sticker_record_ids(a).pop().unwrap();
    assert!(a.chat.record_ids_for(&b.pk).unwrap().contains(&id));
    // A laptop below the threshold (0.5.1, or this build's own version
    // while it is numbered lower; `compat::sticker_threshold`).
    o.exec(
        "UPDATE members SET app_version = '0.4.9' WHERE public_key = ?1",
        &[c.pk.as_str()],
    );
    assert!(!a.chat.record_ids_for(&c.pk).unwrap().contains(&id));
    o.exec(
        "UPDATE members SET app_version = NULL WHERE public_key = ?1",
        &[c.pk.as_str()],
    );
    assert!(!a.chat.record_ids_for(&c.pk).unwrap().contains(&id));
    o.sync_all();
    assert!(catalog(c).office.is_empty());
    assert_eq!(catalog(b).office.len(), 1);
}

#[test]
fn concurrent_changes_end_the_same_everywhere() {
    let o = office_with(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Superadmin),
    ]);
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let bytes = png(3, 7);
    let id = model::random_hex32();
    let create = sign_as(a, &o.org_id, ago(100), set_body(&id, "kucing", StickerState::Active, &bytes));
    let hide = sign_as(a, &o.org_id, ago(50), set_body(&id, "kucing", StickerState::Hidden, &bytes));
    let rename = sign_as(c, &o.org_id, ago(40), set_body(&id, "meong", StickerState::Active, &bytes));
    let recs = [feature(&create), feature(&hide), feature(&rename)];
    // Budi gets them in order, Sari newest first, Citra one at a time backwards.
    b.chat_ingest(&a.pk, recs.to_vec());
    a.chat_ingest(&c.pk, recs.iter().rev().cloned().collect());
    for r in recs.iter().rev() {
        c.chat_ingest(&a.pk, vec![r.clone()]);
    }
    let row = |l: &Laptop| {
        l.with_conn(|cn| {
            cn.query_row(
                "SELECT name, state, created_record, record_id, file_name FROM chat_office_stickers WHERE id = ?1",
                [&id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                },
            )
            .unwrap()
        })
    };
    let want = (
        "meong".to_owned(),
        "active".to_owned(),
        create.id.clone(),
        rename.id.clone(),
        "meong.sticker.png".to_owned(),
    );
    assert_eq!(row(a), want);
    assert_eq!(row(b), want);
    assert_eq!(row(c), want);

    // Deleted wins over everything older; members no longer see it.
    let delete = sign_as(c, &o.org_id, ago(10), set_body(&id, "meong", StickerState::Deleted, &bytes));
    for l in [a, b, c] {
        l.chat_ingest(&c.pk, vec![feature(&delete)]);
        assert!(catalog(l).office.is_empty(), "{}", l.name);
    }
}

#[test]
fn same_name_made_at_the_same_time_is_taken_by_the_newer() {
    let o = office_with(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Superadmin),
    ]);
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let older_id = model::random_hex32();
    let newer_id = model::random_hex32();
    let older = sign_as(a, &o.org_id, ago(60), set_body(&older_id, "kucing", StickerState::Active, &png(2, 4)));
    let newer = sign_as(c, &o.org_id, ago(30), set_body(&newer_id, "kucing", StickerState::Active, &png(2, 5)));
    for l in [a, b, c] {
        l.chat_ingest(&a.pk, vec![feature(&newer), feature(&older)]);
    }
    for l in [a, c] {
        let cat = catalog(l);
        let taken: Vec<(String, bool)> = cat
            .office
            .iter()
            .map(|s| (s.id.clone(), s.name_taken))
            .collect();
        assert_eq!(cat.office.len(), 2);
        assert!(taken.contains(&(older_id.clone(), false)), "{}", l.name);
        assert!(taken.contains(&(newer_id.clone(), true)), "{}", l.name);
    }
    // A member sees only the sticker that owns the name.
    let ids: Vec<String> = catalog(b).office.into_iter().map(|s| s.id).collect();
    assert_eq!(ids, vec![older_id.clone()]);
    // Renaming the newer one is refused while the name is used.
    assert!(
        a.chat
            .office_sticker_update(&newer_id, "Kantor", "kucing", &[], OfficeStickerState::Hidden)
            .is_err()
    );
    a.chat
        .office_sticker_update(&newer_id, "Kantor", "kucing_dua", &[], OfficeStickerState::Active)
        .unwrap();
    let names: Vec<(String, bool)> = catalog(a)
        .office
        .into_iter()
        .map(|s| (s.name, s.name_taken))
        .collect();
    assert_eq!(
        names,
        vec![("kucing".to_owned(), false), ("kucing_dua".to_owned(), false)]
    );
}

#[test]
fn member_sends_an_office_sticker_and_others_see_a_sticker() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let id = add_office(a, "kucing", &png(4, 30));
    o.sync_all();
    // Not here yet: sending waits for the image.
    let early = b.chat.send_sticker(&o.umum(), StickerSource::Office { id: id.clone() }, None);
    assert!(matches!(early, Err(AppError::NotFound(_))), "{early:?}");
    assert_eq!(run_fetches(b, &[a]), 1);
    let sent = b
        .chat
        .send_sticker(&o.umum(), StickerSource::Office { id: id.clone() }, None)
        .unwrap();
    assert_eq!(sent.text, ":kucing:");
    assert_eq!(sent.files.len(), 1);
    assert_eq!(sent.files[0].name, "kucing.sticker.png");
    let st = sent.sticker.clone().expect("a sticker");
    assert!(st.ready && !st.saved && st.name == "kucing");

    o.sync_all();
    // Citra's copy of the image comes as the message attachment.
    let seen = last(c, &o.umum());
    assert!(!seen.sticker.as_ref().unwrap().ready);
    assert!(run_fetches(c, &[b]) >= 1);
    let seen = last(c, &o.umum());
    assert!(seen.sticker.as_ref().unwrap().ready);
    assert_eq!(seen.sticker.as_ref().unwrap().hash, st.hash);

    // A 0.5.0 laptop gets a plain message: `:kucing:` and one image file.
    let rec = c.record_of(&o.umum(), "message");
    let v = model::parse_stored(&rec.body).unwrap();
    let Body::Message { text, files, .. } = v.body() else {
        panic!("not a message");
    };
    assert_eq!(text, ":kucing:");
    assert_eq!(files.len(), 1);
    assert_eq!(
        (files[0].name.as_str(), files[0].mime.as_str()),
        ("kucing.sticker.png", "image/png")
    );

    // Hidden office stickers are not sent.
    a.chat
        .office_sticker_update(&id, "Kantor", "kucing", &[], OfficeStickerState::Hidden)
        .unwrap();
    o.sync_all();
    assert!(
        b.chat
            .send_sticker(&o.umum(), StickerSource::Office { id }, None)
            .is_err()
    );
}

#[test]
fn saving_a_sticker_from_a_message_and_sending_my_own() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let id = add_office(a, "kucing", &png(4, 40));
    o.sync_all();
    run_fetches(b, &[a]);
    let sent = b
        .chat
        .send_sticker(&o.umum(), StickerSource::Office { id }, None)
        .unwrap();
    o.sync_all();
    run_fetches(c, &[b]);
    let mine = c.chat.my_sticker_save(&sent.id).unwrap();
    assert_eq!(mine.name, "kucing");
    assert_eq!(c.chat.my_sticker_save(&sent.id).unwrap().id, mine.id, "saved once");
    assert!(last(c, &o.umum()).sticker.unwrap().saved);
    // A message without the sticker shape cannot be saved.
    let plain = c.chat.send(&o.umum(), "halo", None, vec![], vec![]).unwrap();
    assert!(c.chat.my_sticker_save(&plain.id).is_err());

    // My own image, sent in a chat pribadi.
    let path = write_file(c, "Hore.gif", GIF);
    let hore = c.chat.my_sticker_add(&path, "hore", &["senang".into()]).unwrap();
    assert_eq!(hore.mime, "image/gif");
    let again = c.chat.my_sticker_add(&path, "hore_lagi", &[]).unwrap_err();
    assert!(again.to_string().contains(":hore:"), "{again}");
    let names: Vec<String> = catalog(c).mine.into_iter().map(|m| m.name).collect();
    assert_eq!(names, vec!["hore", "kucing"], "newest first");

    let dm = c.chat.open_dm(&b.pk).unwrap().id;
    let out = c
        .chat
        .send_sticker(&dm, StickerSource::Mine { id: hore.id.clone() }, None)
        .unwrap();
    assert_eq!(out.text, ":hore:");
    assert_eq!(out.files[0].name, "hore.sticker.gif");
    assert!(served(c, b, &hore.hash), "attached by this laptop");
    assert!(!served(c, a, &hore.hash), "not in the chat pribadi");
    o.sync_all();
    assert!(!last(b, &dm).sticker.unwrap().ready);
    assert_eq!(run_fetches(b, &[c]), 1);
    let got = last(b, &dm).sticker.unwrap();
    assert!(got.ready && got.name == "hore" && got.mime == "image/gif");
    assert!(b.chat.sticker_image(&hore.hash).unwrap().starts_with("data:image/gif;base64,"));
}

#[test]
fn sticker_image_is_only_for_stickers_i_may_see() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    // An ordinary image attachment is not a sticker.
    let photo = png(3, 50);
    let path = write_file(b, "foto.png", &photo);
    let m = b.chat.send(&o.umum(), "", None, vec![], vec![path]).unwrap();
    assert!(m.sticker.is_none());
    assert!(matches!(
        b.chat.sticker_image(&m.files[0].hash),
        Err(AppError::Forbidden(_))
    ));
    // A sticker message in a department Citra is not in.
    let (_team, conv) = o.add_team("Keuangan", &[(&a.pk, true), (&b.pk, false)]);
    let path = write_file(b, "rahasia.png", &png(3, 60));
    let mine = b.chat.my_sticker_add(&path, "rahasia", &[]).unwrap();
    b.chat
        .send_sticker(&conv, StickerSource::Mine { id: mine.id }, None)
        .unwrap();
    o.sync_all();
    run_fetches(a, &[b]);
    assert!(a.chat.sticker_image(&mine.hash).is_ok());
    assert!(matches!(
        c.chat.sticker_image(&mine.hash),
        Err(AppError::Forbidden(_))
    ));
    assert!(!served(b, c, &mine.hash));
    // Not a hash at all.
    assert!(c.chat.sticker_image("bukan-hash").is_err());
}

#[test]
fn deleting_sticker_messages_keeps_sticker_images() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let id = add_office(a, "kucing", &png(4, 70));
    o.sync_all();
    run_fetches(b, &[a]);
    let sent = b
        .chat
        .send_sticker(&o.umum(), StickerSource::Office { id: id.clone() }, None)
        .unwrap();
    let office_hash = sent.files[0].hash.clone();
    o.sync_all();
    run_fetches(c, &[b]);
    // Citra keeps her own copy.
    let saved = c.chat.my_sticker_save(&sent.id).unwrap();

    // Sari (superadmin) deletes Budi's sticker message: the old flow.
    a.chat.delete_message(&o.umum(), &sent.id).unwrap();
    o.sync_all();
    for l in [a, b, c] {
        let m = messages(l, &o.umum()).into_iter().find(|m| m.id == sent.id).unwrap();
        assert!(m.deleted && m.sticker.is_none(), "{}", l.name);
        assert!(has_blob(l, &office_hash), "office image kept on {}", l.name);
    }

    // My own sticker: sent, deleted, still in my collection.
    let path = write_file(c, "hore.gif", GIF);
    let hore = c.chat.my_sticker_add(&path, "hore", &[]).unwrap();
    let out = c
        .chat
        .send_sticker(&o.umum(), StickerSource::Mine { id: hore.id.clone() }, None)
        .unwrap();
    c.chat.delete_message(&o.umum(), &out.id).unwrap();
    assert!(has_blob(c, &hore.hash));
    assert!(c.chat.sticker_image(&hore.hash).is_ok());
    // Removing it from the collection drops the blob chat created.
    c.chat.my_sticker_remove(&hore.id).unwrap();
    assert!(!has_blob(c, &hore.hash));
    assert!(c.chat.my_sticker_remove(&hore.id).is_err());

    // The office sticker deleted: Budi's catalog copy goes, Citra's saved
    // copy stays.
    a.chat
        .office_sticker_update(&id, "Kantor", "kucing", &[], OfficeStickerState::Deleted)
        .unwrap();
    o.sync_all();
    assert!(!has_blob(b, &office_hash));
    assert!(has_blob(c, &office_hash));
    assert_eq!(saved.hash, office_hash);
    assert!(c.chat.sticker_image(&office_hash).is_ok());
    assert!(matches!(
        b.chat.sticker_image(&office_hash),
        Err(AppError::Forbidden(_))
    ));
}

#[test]
fn office_images_are_served_to_members_but_not_a_blob_already_here() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let bytes = png(5, 80);
    // The documents module put the same bytes on Budi's laptop first.
    let hash = b.chat.blobs.put_bytes(&bytes).unwrap().hash.to_string();
    let path = write_file(a, "kucing.png", &bytes);
    a.chat
        .office_sticker_add(&path, "Kantor", "kucing", &[])
        .unwrap();
    assert!(served(a, b, &hash));
    assert!(served(a, c, &hash));
    o.sync_all();
    assert_eq!(run_fetches(b, &[a]), 0, "already here");
    assert!(!served(b, c, &hash), "preexisting blob is not served");
    // Not chat's own copy: not offered as a sticker, not sendable, not shown.
    assert!(!catalog(b).office[0].ready);
    let id = catalog(b).office[0].id.clone();
    let err = b
        .chat
        .send_sticker(&o.umum(), StickerSource::Office { id }, None)
        .unwrap_err();
    assert!(err.to_string().contains("sama persis"), "{err}");
    assert!(b.chat.sticker_image(&hash).is_err());
    // A removed member gets nothing.
    o.remove_member(&c.pk, "2026-06-01T00:00:00Z");
    assert!(!served(a, c, &hash));
}

#[test]
fn sticker_records_replayed_keep_one_row() {
    let o = office();
    let (a, b) = (&o.l[0], &o.l[1]);
    add_office(a, "kucing", &png(2, 90));
    o.sync_all();
    let recs = sticker_records(a);
    let got = b.chat_ingest(&a.pk, recs);
    assert_eq!(got.accepted, 0, "already known");
    assert_eq!(b.count("SELECT count(*) FROM chat_office_stickers"), 1);
}

/// A forged `sticker_set` naming the hash of a file in Budi and Citra's chat
/// pribadi, made by a superadmin outside it.
fn dm_lure(o: &Office) -> (String, String, crate::network::feature::FeatureRecord) {
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let dm = b.chat.open_dm(&c.pk).unwrap().id;
    let bytes = png(6, 11);
    let path = write_file(c, "foto.png", &bytes);
    c.chat.send(&dm, "", None, vec![], vec![path]).unwrap();
    let lure = sign_as(
        a,
        &o.org_id,
        ago(5),
        set_body(&model::random_hex32(), "curian", StickerState::Active, &bytes),
    );
    (dm, BlobHash::of_bytes(&bytes).to_string(), feature(&lure))
}

#[test]
fn office_sticker_naming_a_dm_file_queued_first_is_not_served_to_others() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let (_dm, hash, lure) = dm_lure(&o);
    pull(c, b);
    assert_eq!(b.chat_ingest(&a.pk, vec![lure]).accepted, 1);
    assert!(run_fetches(b, &[c]) >= 1);
    assert!(has_blob(b, &hash));
    assert!(served(b, c, &hash), "the chat pribadi still works");
    assert!(!served(b, a, &hash), "not to someone outside the chat pribadi");
}

#[test]
fn office_sticker_naming_a_dm_file_that_comes_later_is_not_served_to_others() {
    let o = office();
    let (a, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let (_dm, hash, lure) = dm_lure(&o);
    assert_eq!(b.chat_ingest(&a.pk, vec![lure]).accepted, 1);
    pull(c, b);
    assert!(run_fetches(b, &[c]) >= 1);
    assert!(has_blob(b, &hash));
    assert!(served(b, c, &hash));
    assert!(!served(b, a, &hash));
}

#[test]
fn preexisting_message_image_cannot_be_saved_but_an_own_upload_can() {
    let o = office();
    let (b, c) = (&o.l[1], &o.l[2]);
    let bytes = png(4, 120);
    // Citra's laptop holds the same bytes for documents or signing.
    c.chat.blobs.put_bytes(&bytes).unwrap();
    let path = write_file(b, "hore.png", &bytes);
    let mine = b.chat.my_sticker_add(&path, "hore", &[]).unwrap();
    let sent = b
        .chat
        .send_sticker(&o.umum(), StickerSource::Mine { id: mine.id }, None)
        .unwrap();
    o.sync_all();
    let err = c.chat.my_sticker_save(&sent.id).unwrap_err();
    assert!(err.to_string().contains("sama persis"), "{err}");
    // Picking the file herself is her own choice: allowed and sendable.
    let path = write_file(c, "hore.png", &bytes);
    let own = c.chat.my_sticker_add(&path, "hore", &[]).unwrap();
    c.chat
        .send_sticker(&o.umum(), StickerSource::Mine { id: own.id }, None)
        .unwrap();
}

#[test]
fn missing_office_image_is_queued_again_at_most_hourly() {
    let o = office();
    let (a, b) = (&o.l[0], &o.l[1]);
    // Nobody has this image.
    let lure = sign_as(
        a,
        &o.org_id,
        ago(5),
        set_body(&model::random_hex32(), "hilang", StickerState::Active, &png(2, 77)),
    );
    b.chat_ingest(&a.pk, vec![feature(&lure)]);
    let queued = || b.count("SELECT count(*) FROM chat_fetch_queue");
    assert_eq!(queued(), 1);
    let drop_queue = || b.with_conn(|c| c.execute("DELETE FROM chat_fetch_queue", []).unwrap());
    drop_queue();
    catalog(b);
    assert_eq!(queued(), 1, "queued again once");
    drop_queue();
    catalog(b);
    catalog(b);
    assert_eq!(queued(), 0, "not again within the hour");
}
