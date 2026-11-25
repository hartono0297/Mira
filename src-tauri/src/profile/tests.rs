//! Profile sync between test laptops: each has its own data folder, key,
//! database and `ProfileSync`. Organization and member rows are written
//! directly on every laptop (profile only reads the derived tables), like
//! `chat::testutil`.

use std::collections::BTreeMap;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use rusqlite::{Connection, params};

use super::record::{self, OwnerState, ProfileRecord, RecordKind};
use super::store;
use super::sync::{ProfileHooks, ProfileSync, TMP_DIR};
use super::{
    MAX_PHOTO_BYTES, PHOTO_NO_ORG, PHOTO_NOT_ADMIN, PHOTO_NOT_MEMBER, PHOTO_SEQ_LIMIT,
};
use crate::blobs::BlobHash;
use crate::chat::audience::Directory;
use crate::identity::{self, Identity, MemoryKeyStore};
use crate::network::feature::{BlobSource, FeatureRecord, FeatureSync, testing};
use crate::org;
use crate::state::MiraState;

const AT: &str = "2026-11-24T08:00:00Z";

#[derive(Default)]
struct Hooks {
    notified: AtomicUsize,
    ui: AtomicUsize,
    wakes: AtomicUsize,
}

impl ProfileHooks for Hooks {
    fn notify_changed(&self) {
        self.notified.fetch_add(1, Ordering::SeqCst);
    }
    fn ui_changed(&self) {
        self.ui.fetch_add(1, Ordering::SeqCst);
    }
    fn wake_fetcher(&self) {
        self.wakes.fetch_add(1, Ordering::SeqCst);
    }
}

struct Laptop {
    tmp: tempfile::TempDir,
    state: MiraState,
    sync: ProfileSync,
    hooks: Arc<Hooks>,
    pk: String,
    name: String,
}

impl Laptop {
    fn new(name: &str) -> Laptop {
        let tmp = tempfile::tempdir().unwrap();
        let state = MiraState::new(
            Ok(tmp.path().to_path_buf()),
            Box::new(MemoryKeyStore::new()),
        );
        let pk = state
            .with_core(|c| {
                identity::save_display_name(&mut c.db, &mut c.identity, name)?;
                Ok(c.identity.public_key_hex().to_owned())
            })
            .unwrap();
        let hooks = Arc::new(Hooks::default());
        let sync = ProfileSync::new(state.clone(), hooks.clone()).unwrap();
        Laptop {
            tmp,
            state,
            sync,
            hooks,
            pk,
            name: name.to_owned(),
        }
    }

    fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> T) -> T {
        self.state.with_core(|c| Ok(f(&c.db))).unwrap()
    }

    fn with_identity<T>(&self, f: impl FnOnce(&Identity) -> T) -> T {
        self.state.with_core(|c| Ok(f(&c.identity))).unwrap()
    }

    fn feature(&self) -> (&str, &dyn FeatureSync) {
        (self.pk.as_str(), &self.sync as &dyn FeatureSync)
    }

    fn rejected_codes(&self) -> Vec<String> {
        self.with_conn(|c| {
            let mut stmt = c
                .prepare("SELECT code FROM rejected_changes ORDER BY id")
                .unwrap();
            stmt.query_map([], |r| r.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        })
    }

    /// Effective state per owner as this laptop computes it.
    fn states(&self) -> BTreeMap<String, OwnerState> {
        let blobs = self.sync.blobs().clone();
        self.with_conn(|c| {
            let dir = Directory::load(c, &self.pk).unwrap().unwrap();
            let rows = store::rows(c).unwrap();
            let local = |h: &str| BlobHash::parse(h).is_ok_and(|h| blobs.contains(&h));
            record::effective(&rows, &dir, &local)
        })
    }

    fn wanted(&self, owner: &str) -> Option<String> {
        self.states().get(owner).and_then(|s| s.wanted.clone())
    }

    fn shown(&self) -> Vec<(String, String)> {
        self.sync
            .photos()
            .unwrap()
            .into_iter()
            .map(|e| (e.owner, e.hash))
            .collect()
    }

    fn has_blob(&self, hash: &str) -> bool {
        self.sync.blobs().contains(&BlobHash::parse(hash).unwrap())
    }

    fn record_count(&self) -> i64 {
        self.with_conn(|c| {
            c.query_row("SELECT count(*) FROM profile_records", [], |r| r.get(0))
                .unwrap()
        })
    }

    /// Ids of records that lost and are kept as tombstones.
    fn seen_count(&self) -> i64 {
        self.with_conn(|c| {
            c.query_row("SELECT count(*) FROM profile_seen", [], |r| r.get(0))
                .unwrap()
        })
    }

    fn is_bad(&self, hash: &str) -> bool {
        self.with_conn(|c| store::is_bad(c, hash).unwrap())
    }

    /// Stored record bodies, oldest first.
    fn records(&self) -> Vec<FeatureRecord> {
        self.with_conn(|c| {
            let mut stmt = c
                .prepare("SELECT id, body FROM profile_records ORDER BY rowid")
                .unwrap();
            stmt.query_map([], |r| {
                Ok(FeatureRecord {
                    id: r.get(0)?,
                    body: r.get(1)?,
                })
            })
            .unwrap()
            .map(Result::unwrap)
            .collect()
        })
    }

    fn latest_seq(&self) -> u64 {
        self.with_conn(|c| store::max_seq(c, &self.pk).unwrap())
    }

    fn set(&self, seed: u8) -> String {
        self.sync.set_photo(&photo(seed)).unwrap().hash
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Who {
    Superadmin,
    Member,
    Guest,
}

struct Office {
    org_id: String,
    l: Vec<Laptop>,
}

impl Office {
    fn new(people: &[(&str, Who)]) -> Office {
        let l: Vec<Laptop> = people.iter().map(|(n, _)| Laptop::new(n)).collect();
        let org = l[0]
            .state
            .with_core(|c| {
                org::create_organization(&mut c.db, &c.identity, "CV Maju Jaya")?;
                Ok(org::load_organization(&c.db)?.unwrap())
            })
            .unwrap();
        for laptop in &l[1..] {
            laptop.with_conn(|c| {
                c.execute(
                    "INSERT INTO organizations (id, name, founder_public_key, created_at, genesis_signature)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![org.id, org.name, org.founder_public_key, org.created_at, org.genesis_signature],
                )
                .unwrap();
            });
        }
        let office = Office { org_id: org.id, l };
        for (laptop, (_, who)) in office.l.iter().zip(people) {
            office.set_member(&laptop.pk, &laptop.name, *who);
        }
        office
    }

    fn each(&self, f: impl Fn(&Connection)) {
        for laptop in &self.l {
            laptop.with_conn(&f);
        }
    }

    fn set_member(&self, pk: &str, name: &str, who: Who) {
        let (role, kind, sa) = match who {
            Who::Superadmin => ("superadmin", "member", 1),
            Who::Member => ("member", "member", 0),
            Who::Guest => ("guest", "guest", 0),
        };
        let org = self.org_id.clone();
        self.each(|c| {
            c.execute(
                "INSERT OR REPLACE INTO members
                   (organization_id, public_key, display_name, role, added_at, status, is_superadmin, kind)
                 VALUES (?1, ?2, ?3, ?4, '2026-01-01T00:00:00Z', 'active', ?5, ?6)",
                params![org, pk, name, role, sa, kind],
            )
            .unwrap();
        });
    }

    fn remove_member(&self, pk: &str) {
        self.each(|c| {
            c.execute(
                "UPDATE members SET status = 'removed', is_superadmin = 0,
                   removed_at = '2026-11-24T09:00:00Z' WHERE public_key = ?1",
                [pk],
            )
            .unwrap();
        });
    }

    fn sync(&self, idx: &[usize]) {
        let list: Vec<(&str, &dyn FeatureSync)> =
            idx.iter().map(|i| self.l[*i].feature()).collect();
        testing::sync_all(&list).unwrap();
    }

    fn sync_all(&self) {
        let idx: Vec<usize> = (0..self.l.len()).collect();
        self.sync(&idx);
    }

    /// Runs every laptop's download queue against all the others, twice (a
    /// photo can travel A to B to C).
    fn fetch_all(&self) {
        for _ in 0..2 {
            for to in &self.l {
                let sources: Vec<&Laptop> = self.l.iter().filter(|s| s.pk != to.pk).collect();
                fetch(to, &sources);
            }
        }
    }
}

/// A valid profile photo: 256x256 JPEG, different per seed.
fn photo(seed: u8) -> Vec<u8> {
    let img = ::image::RgbImage::from_fn(super::PHOTO_SIZE, super::PHOTO_SIZE, |x, y| {
        ::image::Rgb([seed, (x % 256) as u8, (y % 256) as u8])
    });
    let mut out = Vec::new();
    ::image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80)
        .encode_image(&img)
        .unwrap();
    out
}

/// Runs `to`'s download queue against `sources` like the fetcher would.
/// Returns how many photos landed.
fn fetch(to: &Laptop, sources: &[&Laptop]) -> usize {
    let mut done = 0;
    for (i, job) in to.sync.fetch_jobs().unwrap().iter().enumerate() {
        let dest = to.tmp.path().join(format!("download-{i}.tmp"));
        let got = sources.iter().any(|s| {
            testing::copy_blob(&s.sync, &to.pk, &job.hash, MAX_PHOTO_BYTES, &dest).is_ok()
        });
        if got {
            to.sync.fetch_done(job, &dest).unwrap();
            done += 1;
        } else {
            to.sync.fetch_failed(job).unwrap();
        }
        let _ = std::fs::remove_file(&dest);
    }
    done
}

fn sign(by: &Laptop, mut rec: ProfileRecord) -> FeatureRecord {
    by.with_identity(|id| rec.sign_with(id));
    FeatureRecord::new(rec.to_body())
}

fn raw(
    org: &str,
    kind: RecordKind,
    owner: &str,
    author: &str,
    photo: Option<&str>,
    size: Option<u64>,
    seq: u64,
) -> ProfileRecord {
    ProfileRecord {
        v: 1,
        kind,
        org: org.to_owned(),
        owner: owner.to_owned(),
        author: author.to_owned(),
        photo: photo.map(str::to_owned),
        size,
        seq,
        at: AT.to_owned(),
        sig: String::new(),
    }
}

fn hash_of(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

#[test]
fn migration_creates_the_tables() {
    let l = Laptop::new("Ani");
    let n: i64 = l.with_conn(|c| {
        c.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table'
             AND name IN ('profile_records', 'profile_seen', 'profile_fetch')",
            [],
            |r| r.get(0),
        )
        .unwrap()
    });
    assert_eq!(n, 3);
}

#[test]
fn no_organization_means_no_photos_and_no_changes() {
    let l = Laptop::new("Ani");
    assert!(l.sync.photos().unwrap().is_empty());
    let mine = l.sync.my_photo().unwrap();
    assert_eq!(mine.hash, None);
    assert!(!mine.removed_by_admin);
    let err = l.sync.set_photo(&photo(1)).unwrap_err();
    assert_eq!(err.to_string(), PHOTO_NO_ORG);
    assert_eq!(l.sync.clear_photo().unwrap_err().to_string(), PHOTO_NO_ORG);
    assert!(l.sync.ensure_can_set().is_err());
    assert!(l.sync.record_ids_for(&"a".repeat(64)).unwrap().is_empty());
}

#[test]
fn set_photo_refuses_bytes_that_are_not_a_photo() {
    let o = Office::new(&[("Ani", Who::Superadmin)]);
    assert_eq!(
        o.l[0].sync.set_photo(b"not a jpeg").unwrap_err().code(),
        "invalid_input"
    );
    assert_eq!(o.l[0].record_count(), 0);
}

#[test]
fn owner_sets_a_photo_and_every_active_member_gets_it() {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Tamu", Who::Guest),
    ]);
    let (s, b, g) = (&o.l[0], &o.l[1], &o.l[2]);
    let h = b.set(1);
    assert_eq!(h, hash_of(&photo(1)));
    assert_eq!(b.hooks.notified.load(Ordering::SeqCst), 1);
    assert_eq!(b.hooks.ui.load(Ordering::SeqCst), 1);
    assert_eq!(b.sync.my_photo().unwrap().hash, Some(h.clone()));
    assert_eq!(b.shown(), vec![(b.pk.clone(), h.clone())]);
    // The guest is offered the record too.
    assert_eq!(b.sync.record_ids_for(&g.pk).unwrap().len(), 1);
    o.sync_all();
    // Record known but photo not here yet: wanted, not shown, fetcher woken.
    assert_eq!(s.wanted(&b.pk), Some(h.clone()));
    assert!(s.shown().is_empty());
    assert!(s.hooks.wakes.load(Ordering::SeqCst) > 0);
    o.fetch_all();
    for l in [s, g] {
        assert_eq!(l.shown(), vec![(b.pk.clone(), h.clone())], "{}", l.name);
        assert_eq!(l.sync.photo_data(&h).unwrap(), photo(1));
    }
    // A fetched photo is reported to the screen.
    assert!(s.hooks.ui.load(Ordering::SeqCst) > 0);
    assert!(s.sync.photo_data(&"0".repeat(64)).is_err());
    assert!(s.sync.photo_data("nope").is_err());
}

#[test]
fn latest_record_wins_whatever_order_the_laptops_see_them_in() {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Member),
        ("Dewi", Who::Member),
        ("Eko", Who::Member),
    ]);
    let (a, b, c, d, e) = (&o.l[0], &o.l[1], &o.l[2], &o.l[3], &o.l[4]);
    let h1 = b.set(1);
    let first = b.records();
    o.sync(&[1, 0]);
    fetch(a, &[b]);
    assert!(a.has_blob(&h1));
    let h2 = b.set(2);
    let second = b.records();
    assert_eq!(b.latest_seq(), 2);
    // B's old photo is not kept on B.
    assert!(!b.has_blob(&h1));
    o.sync(&[1, 2]);
    // A knows only the first record, C only the second.
    assert_eq!(a.wanted(&b.pk), Some(h1.clone()));
    assert_eq!(c.wanted(&b.pk), Some(h2.clone()));
    assert_eq!(c.record_count(), 1, "the losing record is not offered");
    o.sync(&[0, 1, 2]);
    for l in [a, b, c] {
        assert_eq!(l.wanted(&b.pk), Some(h2.clone()), "{}", l.name);
    }
    // The replaced photo is deleted where it was fetched.
    assert!(!a.has_blob(&h1));
    fetch(a, &[b]);
    fetch(c, &[a]);
    for l in [a, b, c] {
        assert_eq!(l.shown(), vec![(b.pk.clone(), h2.clone())], "{}", l.name);
    }
    // Only the winning record is stored in full.
    assert_eq!(a.record_count(), 1);
    // D and E get both records in opposite orders: same result.
    let recs = [first[0].clone(), second[0].clone()];
    d.sync.ingest(&a.pk, vec![recs[0].clone()]).unwrap();
    d.sync.ingest(&a.pk, vec![recs[1].clone()]).unwrap();
    e.sync.ingest(&a.pk, vec![recs[1].clone()]).unwrap();
    let late = e.sync.ingest(&a.pk, vec![recs[0].clone()]).unwrap();
    assert_eq!(
        (late.accepted, late.changed),
        (1, false),
        "an older record changes nothing"
    );
    assert_eq!(d.states(), e.states());
    assert_eq!(d.wanted(&b.pk), Some(h2));
}

#[test]
fn only_the_owner_can_set_or_clear_their_photo() {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Member),
    ]);
    let (s, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let h = b.set(1);
    o.sync_all();
    let fake = hash_of(&photo(9));
    // C signs a record naming B as owner and author: bad signature.
    let forged_set = sign(
        c,
        raw(
            &o.org_id,
            RecordKind::Set,
            &b.pk,
            &b.pk,
            Some(&fake),
            Some(10),
            9,
        ),
    );
    let forged_clear = sign(
        c,
        raw(&o.org_id, RecordKind::Clear, &b.pk, &b.pk, None, None, 9),
    );
    // C signs as itself for B: not the owner.
    let as_self = sign(
        c,
        raw(
            &o.org_id,
            RecordKind::Set,
            &b.pk,
            &c.pk,
            Some(&fake),
            Some(10),
            9,
        ),
    );
    // Even a superadmin cannot clear someone else's photo.
    let by_admin = sign(
        s,
        raw(&o.org_id, RecordKind::Clear, &b.pk, &s.pk, None, None, 9),
    );
    let out = s
        .sync
        .ingest(&c.pk, vec![forged_set, forged_clear, as_self, by_admin])
        .unwrap();
    assert_eq!(out.rejected, 4);
    assert_eq!(out.accepted, 0);
    assert!(!out.changed);
    let codes = s.rejected_codes();
    assert_eq!(codes.len(), 4);
    assert!(codes.iter().all(|c| c.starts_with("profile_")), "{codes:?}");
    assert_eq!(s.wanted(&b.pk), Some(h));
    // Rejected records stay unknown, so they are not stored.
    assert_eq!(s.record_count(), 1);
}

#[test]
fn other_encodings_bad_signatures_and_other_orgs_are_refused_on_ingest() {
    let o = Office::new(&[("Sari", Who::Superadmin), ("Budi", Who::Member)]);
    let (s, b) = (&o.l[0], &o.l[1]);
    let good = sign(
        b,
        raw(
            &o.org_id,
            RecordKind::Set,
            &b.pk,
            &b.pk,
            Some(&hash_of(&photo(1))),
            Some(100),
            1,
        ),
    );
    let spaced = FeatureRecord::new(good.body.replace(",\"kind\"", ", \"kind\""));
    let extra = FeatureRecord::new(good.body.replacen('{', r#"{"extra":true,"#, 1));
    let value: serde_json::Value = serde_json::from_str(&good.body).unwrap();
    let reordered = {
        let obj = value.as_object().unwrap();
        let mut keys: Vec<&String> = obj.keys().collect();
        keys.sort();
        let parts: Vec<String> = keys
            .iter()
            .map(|k| format!("{}:{}", serde_json::to_string(k).unwrap(), obj[k.as_str()]))
            .collect();
        FeatureRecord::new(format!("{{{}}}", parts.join(",")))
    };
    let mut tampered = raw(
        &o.org_id,
        RecordKind::Set,
        &b.pk,
        &b.pk,
        Some(&hash_of(&photo(1))),
        Some(100),
        1,
    );
    b.with_identity(|id| tampered.sign_with(id));
    tampered.size = Some(101);
    let tampered = FeatureRecord::new(tampered.to_body());
    let other_org = sign(
        b,
        raw(
            &"e".repeat(32),
            RecordKind::Set,
            &b.pk,
            &b.pk,
            Some(&hash_of(&photo(1))),
            Some(100),
            1,
        ),
    );
    let stranger = Laptop::new("Asing");
    let not_member = sign(
        &stranger,
        raw(
            &o.org_id,
            RecordKind::Set,
            &stranger.pk,
            &stranger.pk,
            Some(&hash_of(&photo(1))),
            Some(100),
            1,
        ),
    );
    let out = s
        .sync
        .ingest(
            &b.pk,
            vec![spaced, extra, reordered, tampered, other_org, not_member],
        )
        .unwrap();
    assert_eq!(out.rejected, 6);
    assert_eq!(out.accepted, 0);
    let codes = s.rejected_codes();
    assert!(
        codes[..4].iter().all(|c| c == "profile_invalid"),
        "{codes:?}"
    );
    assert_eq!(codes[4], "profile_org");
    assert_eq!(codes[5], "profile_not_member");
    // The good record is accepted, once.
    let out = s.sync.ingest(&b.pk, vec![good.clone()]).unwrap();
    assert_eq!((out.accepted, out.rejected), (1, 0));
    assert!(out.changed);
    let again = s.sync.ingest(&b.pk, vec![good]).unwrap();
    assert_eq!(
        (again.accepted, again.rejected, again.changed),
        (0, 0, false)
    );
}

#[test]
fn superadmin_remove_hides_the_photo_until_the_owner_sets_another() {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Member),
    ]);
    let (s, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let h1 = b.set(1);
    o.sync_all();
    o.fetch_all();
    assert_eq!(c.shown(), vec![(b.pk.clone(), h1.clone())]);

    // A plain member may not remove, through the command or a record.
    let err = c.sync.admin_remove(&b.pk).unwrap_err();
    assert_eq!(err.code(), "forbidden");
    assert_eq!(err.to_string(), PHOTO_NOT_ADMIN);
    let by_member = sign(
        c,
        raw(
            &o.org_id,
            RecordKind::Remove,
            &b.pk,
            &c.pk,
            Some(&h1),
            None,
            0,
        ),
    );
    let out = s.sync.ingest(&c.pk, vec![by_member]).unwrap();
    assert_eq!(out.rejected, 1);
    assert_eq!(
        s.rejected_codes(),
        vec!["profile_not_superadmin".to_owned()]
    );
    assert_eq!(s.shown(), vec![(b.pk.clone(), h1.clone())]);

    // Superadmin checks: not their own photo, only members, only a photo.
    assert!(s.sync.admin_remove(&s.pk).is_err());
    assert_eq!(
        s.sync
            .admin_remove(&"d".repeat(64))
            .unwrap_err()
            .to_string(),
        PHOTO_NOT_MEMBER
    );
    assert_eq!(s.sync.admin_remove(&c.pk).unwrap_err().code(), "not_found");

    s.sync.admin_remove(&b.pk).unwrap();
    // Removing again is a no-op.
    s.sync.admin_remove(&b.pk).unwrap();
    o.sync_all();
    for l in &o.l {
        assert!(l.shown().is_empty(), "{}", l.name);
        assert!(l.sync.photo_data(&h1).is_err(), "{}", l.name);
    }
    let mine = b.sync.my_photo().unwrap();
    assert_eq!(mine.hash, None);
    assert!(mine.removed_by_admin);
    // Nobody serves the removed photo; only its owner keeps the bytes.
    assert!(b.has_blob(&h1));
    assert!(!c.has_blob(&h1));
    assert!(!s.has_blob(&h1));
    assert!(b.sync.blob_path_for(&c.pk, &h1).is_none());

    // The owner sets another photo: shown everywhere.
    let h2 = b.set(2);
    o.sync_all();
    o.fetch_all();
    for l in &o.l {
        assert_eq!(l.shown(), vec![(b.pk.clone(), h2.clone())], "{}", l.name);
    }
    let mine = b.sync.my_photo().unwrap();
    assert_eq!(mine.hash, Some(h2));
    assert!(!mine.removed_by_admin);
    assert!(!b.has_blob(&h1));
}

#[test]
fn removed_members_get_nothing_and_guests_get_records() {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Tamu", Who::Guest),
        ("Keluar", Who::Member),
    ]);
    let (b, g, x) = (&o.l[1], &o.l[2], &o.l[3]);
    let h = b.set(1);
    o.remove_member(&x.pk);
    let ids = b.sync.record_ids_for(&x.pk).unwrap();
    assert!(ids.is_empty());
    let all = b.sync.record_ids_for(&g.pk).unwrap();
    assert_eq!(all.len(), 1);
    assert!(b.sync.records_for(&x.pk, &all).unwrap().is_empty());
    assert_eq!(b.sync.records_for(&g.pk, &all).unwrap().len(), 1);
    assert!(b.sync.blob_path_for(&x.pk, &h).is_none());
    assert!(b.sync.blob_path_for(&g.pk, &h).is_some());
    // Not to itself, and not to a stranger.
    assert!(b.sync.record_ids_for(&b.pk).unwrap().is_empty());
    assert!(b.sync.blob_path_for(&b.pk, &h).is_none());
    assert!(b.sync.blob_path_for(&"c".repeat(64), &h).is_none());
    o.sync_all();
    o.fetch_all();
    assert_eq!(g.shown(), vec![(b.pk.clone(), h.clone())]);
    assert_eq!(x.record_count(), 0);
    assert!(x.shown().is_empty());
}

#[test]
fn blob_path_for_serves_only_effective_local_photos() {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Member),
    ]);
    let (s, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let h1 = b.set(1);
    let h2 = b.set(2);
    assert!(b.sync.blob_path_for(&c.pk, &h1).is_none(), "replaced photo");
    assert!(b.sync.blob_path_for(&c.pk, &h2).is_some());
    assert!(
        b.sync.blob_path_for(&c.pk, &"0".repeat(64)).is_none(),
        "unknown hash"
    );
    assert!(b.sync.blob_path_for(&c.pk, "not-a-hash").is_none());
    // Any laptop that holds the photo may serve it: C copies from S.
    o.sync(&[0, 1]);
    fetch(s, &[b]);
    o.sync(&[0, 2]);
    assert!(s.sync.blob_path_for(&c.pk, &h2).is_some());
    assert_eq!(fetch(c, &[s]), 1);
    assert_eq!(c.shown(), vec![(b.pk.clone(), h2.clone())]);
    // After a superadmin remove, nobody serves it, the owner included.
    s.sync.admin_remove(&b.pk).unwrap();
    o.sync_all();
    assert!(b.has_blob(&h2));
    assert!(b.sync.blob_path_for(&c.pk, &h2).is_none());
    assert!(s.sync.blob_path_for(&c.pk, &h2).is_none());
}

#[test]
fn new_seq_is_the_highest_known_plus_one() {
    let o = Office::new(&[("Sari", Who::Superadmin), ("Budi", Who::Member)]);
    let (s, b) = (&o.l[0], &o.l[1]);
    b.set(1);
    assert_eq!(b.latest_seq(), 1);
    b.sync.clear_photo().unwrap();
    assert_eq!(b.latest_seq(), 2);
    assert!(b.shown().is_empty());
    // B's own record with seq 7 comes back from a colleague (an older copy
    // of this laptop's data, for example).
    let rec = sign(
        b,
        raw(&o.org_id, RecordKind::Clear, &b.pk, &b.pk, None, None, 7),
    );
    b.sync.ingest(&s.pk, vec![rec]).unwrap();
    assert_eq!(b.latest_seq(), 7);
    let h = b.set(3);
    assert_eq!(b.latest_seq(), 8);
    assert_eq!(b.sync.my_photo().unwrap().hash, Some(h));
    // A superadmin's remove does not count as a seq of the owner.
    s.sync.ingest(&b.pk, b.records()).unwrap();
    s.sync.admin_remove(&b.pk).unwrap();
    o.sync_all();
    assert_eq!(b.latest_seq(), 8);
}

#[test]
fn bad_downloads_are_never_retried_and_failures_back_off() {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Member),
    ]);
    let (s, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let h = b.set(1);
    o.sync_all();
    // Nobody online: the job waits.
    let jobs = s.sync.fetch_jobs().unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].hash, h);
    assert_eq!(jobs[0].owner, b.pk);
    s.sync.fetch_failed(&jobs[0]).unwrap();
    assert!(s.sync.fetch_jobs().unwrap().is_empty(), "backing off");
    // A colleague comes online: try again now.
    s.sync.peer_connected(&b.pk);
    assert_eq!(s.sync.fetch_jobs().unwrap().len(), 1);
    // Bytes that are not this photo are refused and never tried again.
    let tmp = s.tmp.path().join("bad.part");
    std::fs::write(&tmp, b"garbage").unwrap();
    assert!(s.sync.fetch_done(&jobs[0], &tmp).is_err());
    assert!(s.sync.fetch_jobs().unwrap().is_empty());
    s.sync.peer_connected(&b.pk);
    assert!(s.sync.fetch_jobs().unwrap().is_empty());
    assert!(s.shown().is_empty());
    assert!(s.is_bad(&h));
    // C, unaffected, fetches normally, and a photo that passes leaves no mark.
    assert_eq!(fetch(c, &[b]), 1);
    assert!(!c.is_bad(&h));
    assert_eq!(store::retry_delay(0), time::Duration::seconds(60));
    assert_eq!(store::retry_delay(1), time::Duration::seconds(120));
    assert_eq!(store::retry_delay(50), time::Duration::hours(1));
}

#[test]
fn a_removed_laptop_cannot_change_its_photo() {
    let o = Office::new(&[("Sari", Who::Superadmin), ("Budi", Who::Member)]);
    let b = &o.l[1];
    o.remove_member(&b.pk);
    assert_eq!(b.sync.set_photo(&photo(1)).unwrap_err().code(), "removed");
    assert_eq!(b.sync.clear_photo().unwrap_err().code(), "removed");
}

#[test]
fn records_that_lost_are_kept_as_ids_only() {
    let o = Office::new(&[("Sari", Who::Superadmin), ("Budi", Who::Member)]);
    let (s, b) = (&o.l[0], &o.l[1]);
    b.set(1);
    let first = b.records();
    b.set(2);
    b.sync.clear_photo().unwrap();
    let h3 = b.set(3);
    assert_eq!(b.record_count(), 1);
    assert_eq!(b.seen_count(), 3);
    // Known, so never asked for again, but never offered or sent.
    let old_id = first[0].id.clone();
    assert!(b.sync.unknown_ids(std::slice::from_ref(&old_id)).unwrap().is_empty());
    assert_eq!(b.sync.record_ids_for(&s.pk).unwrap().len(), 1);
    assert!(b.sync.records_for(&s.pk, &[old_id]).unwrap().is_empty());
    o.sync_all();
    assert_eq!(s.record_count(), 1);
    assert_eq!(s.seen_count(), 0);
    // An old record arriving late is remembered by its id only.
    let late = s.sync.ingest(&b.pk, first.clone()).unwrap();
    assert_eq!((late.accepted, late.changed), (1, false));
    assert_eq!(s.record_count(), 1);
    assert_eq!(s.seen_count(), 1);
    assert_eq!(s.wanted(&b.pk), Some(h3));
    let again = s.sync.ingest(&b.pk, first).unwrap();
    assert_eq!((again.accepted, again.rejected), (0, 0));
}

#[test]
fn a_flood_of_records_keeps_one_per_owner() {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Member),
    ]);
    let (s, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let hash = |n: u64| hash_of(&n.to_be_bytes());
    let set = |by: &Laptop, n: u64| {
        sign(
            by,
            raw(
                &o.org_id,
                RecordKind::Set,
                &by.pk,
                &by.pk,
                Some(&hash(n)),
                Some(100),
                n,
            ),
        )
    };
    let mut batch: Vec<FeatureRecord> = (100..=200).chain(1..100).map(|n| set(b, n)).collect();
    batch.push(set(c, 7));
    let out = s.sync.ingest(&b.pk, batch).unwrap();
    assert_eq!((out.accepted, out.rejected), (201, 0));
    assert!(out.changed);
    assert_eq!(s.record_count(), 2);
    assert_eq!(s.seen_count(), 199);
    assert_eq!(s.wanted(&b.pk), Some(hash(200)));
    assert_eq!(s.wanted(&c.pk), Some(hash(7)));
    // Only the winners' photos are queued.
    let mut queued: Vec<String> = s
        .sync
        .fetch_jobs()
        .unwrap()
        .into_iter()
        .map(|j| j.hash)
        .collect();
    queued.sort();
    let mut expected = vec![hash(200), hash(7)];
    expected.sort();
    assert_eq!(queued, expected);
    // The next batch is compared with the stored winner.
    let out = s.sync.ingest(&b.pk, vec![set(b, 201), set(b, 250), set(b, 150)]).unwrap();
    assert_eq!(out.accepted, 2);
    assert_eq!(s.wanted(&b.pk), Some(hash(250)));
    assert_eq!(s.record_count(), 2);
    assert_eq!(s.seen_count(), 201);
}

#[test]
fn a_decoder_crash_on_a_photo_is_not_repeated_after_a_restart() {
    let o = Office::new(&[("Sari", Who::Superadmin), ("Budi", Who::Member)]);
    let (s, b) = (&o.l[0], &o.l[1]);
    let h = b.set(1);
    o.sync_all();
    let job = s.sync.fetch_jobs().unwrap().remove(0);
    let tmp = s.tmp.path().join("crash.part");
    testing::copy_blob(&b.sync, &s.pk, &h, MAX_PHOTO_BYTES, &tmp).unwrap();
    let crashed = std::panic::catch_unwind(AssertUnwindSafe(|| {
        s.sync.fetch_done_with(&job, &tmp, |_: &[u8]| -> bool {
            // The mark is committed before the decoder runs.
            assert!(s.is_bad(&h));
            panic!("decoder crash")
        })
    }));
    assert!(crashed.is_err());
    // After a restart the hash is neither downloaded nor decoded again.
    let restarted = ProfileSync::new(s.state.clone(), Arc::new(Hooks::default())).unwrap();
    restarted.peer_connected(&b.pk);
    assert!(restarted.fetch_jobs().unwrap().is_empty());
    assert!(restarted.photos().unwrap().is_empty());
    // The mark survives the hash being dropped and named again.
    b.sync.clear_photo().unwrap();
    o.sync_all();
    assert!(s.is_bad(&h));
    b.set(1);
    o.sync_all();
    assert!(restarted.fetch_jobs().unwrap().is_empty());
}

#[test]
fn a_removed_photo_stays_hidden_when_someone_else_sets_the_same_bytes() {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Member),
    ]);
    let (s, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let h1 = b.set(1);
    o.sync_all();
    o.fetch_all();
    s.sync.admin_remove(&b.pk).unwrap();
    o.sync_all();
    // C publishes the removed photo as their own.
    assert_eq!(c.set(1), h1);
    o.sync_all();
    o.fetch_all();
    for l in &o.l {
        assert!(l.shown().is_empty(), "{}", l.name);
        assert!(l.sync.photo_data(&h1).is_err(), "{}", l.name);
        let peer = if l.pk == s.pk { &b.pk } else { &s.pk };
        assert!(l.sync.blob_path_for(peer, &h1).is_none(), "{}", l.name);
    }
    let mine = c.sync.my_photo().unwrap();
    assert_eq!(mine.hash, None);
    assert!(mine.removed_by_admin);
    assert!(!s.has_blob(&h1));
    assert!(c.has_blob(&h1), "the owner keeps their own latest photo");
    // Removing C's copy too changes nothing: the hash is already hidden.
    let before = s.record_count();
    s.sync.admin_remove(&c.pk).unwrap();
    assert_eq!(s.record_count(), before);
    // The original owner can still show another photo.
    let h2 = b.set(2);
    o.sync_all();
    o.fetch_all();
    for l in &o.l {
        assert_eq!(l.shown(), vec![(b.pk.clone(), h2.clone())], "{}", l.name);
    }
}

#[test]
fn sweep_deletes_leftover_downloads_and_photos_nobody_refers_to() {
    let o = Office::new(&[
        ("Sari", Who::Superadmin),
        ("Budi", Who::Member),
        ("Citra", Who::Member),
    ]);
    let (s, b, c) = (&o.l[0], &o.l[1], &o.l[2]);
    let h1 = b.set(1);
    let h2 = c.set(2);
    o.sync_all();
    o.fetch_all();
    assert!(b.has_blob(&h2));
    s.sync.admin_remove(&b.pk).unwrap();
    o.sync_all();
    // A photo nothing names, and downloads a crash left behind.
    let orphan = b.sync.blobs().put_bytes(&photo(9)).unwrap().hash;
    let tmp = b.tmp.path().join(TMP_DIR);
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::write(tmp.join("x-1.part"), b"half").unwrap();
    std::fs::write(tmp.join("note.txt"), b"other").unwrap();
    // A write looks only at the photos it changed: the orphan stays.
    let h3 = c.set(3);
    o.sync_all();
    assert!(!b.has_blob(&h2), "C's replaced photo is deleted");
    assert!(b.sync.blobs().contains(&orphan));
    o.fetch_all();
    b.sync.sweep().unwrap();
    assert!(!b.sync.blobs().contains(&orphan));
    assert!(b.has_blob(&h1), "own latest photo stays, removed or not");
    assert!(b.has_blob(&h3), "a photo someone shows stays");
    assert!(!tmp.join("x-1.part").exists());
    assert!(tmp.join("note.txt").exists());
    // Without an organization nothing is deleted.
    let lone = Laptop::new("Sendiri");
    let kept = lone.sync.blobs().put_bytes(&photo(4)).unwrap().hash;
    lone.sync.sweep().unwrap();
    assert!(lone.sync.blobs().contains(&kept));
}

#[test]
fn seq_at_the_limit_gives_a_clear_error_and_leaves_no_photo_behind() {
    let o = Office::new(&[("Sari", Who::Superadmin), ("Budi", Who::Member)]);
    let (s, b) = (&o.l[0], &o.l[1]);
    let top = sign(
        b,
        raw(
            &o.org_id,
            RecordKind::Clear,
            &b.pk,
            &b.pk,
            None,
            None,
            record::MAX_SEQ,
        ),
    );
    b.sync.ingest(&s.pk, vec![top]).unwrap();
    assert_eq!(b.latest_seq(), record::MAX_SEQ);
    let err = b.sync.set_photo(&photo(1)).unwrap_err();
    assert_eq!(err.to_string(), PHOTO_SEQ_LIMIT);
    assert!(
        !b.has_blob(&hash_of(&photo(1))),
        "bytes stored before the failure are deleted"
    );
    assert_eq!(b.sync.clear_photo().unwrap_err().to_string(), PHOTO_SEQ_LIMIT);
    assert_eq!(b.record_count(), 1);
}
