//! Board sync between laptops through the `FeatureSync` contract, with a real
//! membership log (signed ops synced between the laptops first).

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use rusqlite::params;
use tempfile::TempDir;
use time::Duration;

use super::*;
use crate::board::commands;
use crate::board::doc::{BoardDoc, ProjectMeta, Stamp, TaskData, TaskInit};
use crate::board::model::{ColumnId, NewTask, TaskPatch};
use crate::board::sign::{sign_change, signing_message};
use crate::board::store;
use crate::board::sync::{self, NoopSync};
use crate::board::testutil::org_ops;
use crate::clock;
use crate::error::AppResult;
use crate::identity::{self, MemoryKeyStore};
use crate::network::feature::testing::{pull, sync_all};
use crate::network::feature::{BlobFuture, FeatureHub, FeatureLink, check_incoming};
use crate::org;
use crate::permissions::{self as p, InviteRole};
use crate::state::{Core, MiraState};

/// One laptop: its own data folder, key and board feature.
struct Lap {
    _tmp: TempDir,
    state: MiraState,
    f: BoardFeature,
    pk: String,
}

impl Lap {
    fn new(name: &str) -> Lap {
        Lap::with_hook(name, Arc::new(NoopSync))
    }

    fn with_hook(name: &str, hook: Arc<dyn BoardSyncHook>) -> Lap {
        let tmp = tempfile::tempdir().unwrap();
        let state = MiraState::new(Ok(tmp.path().to_path_buf()), Box::new(MemoryKeyStore::new()));
        let pk = state
            .with_core(|c| {
                identity::save_display_name(&mut c.db, &mut c.identity, name)?;
                Ok(c.identity.public_key_hex().to_owned())
            })
            .unwrap();
        let f = BoardFeature::new(state.clone(), hook);
        Lap {
            _tmp: tmp,
            state,
            f,
            pk,
        }
    }

    fn founder(name: &str) -> Lap {
        let l = Lap::new(name);
        l.core(|c| org::create_organization(&mut c.db, &c.identity, "CV Maju Jaya").map(|_| ()));
        l
    }

    fn core<T>(&self, f: impl FnOnce(&mut Core) -> AppResult<T>) -> T {
        self.state.with_core(f).unwrap()
    }

    fn me(&self) -> (&str, &dyn FeatureSync) {
        (&self.pk, &self.f)
    }

    fn count(&self, sql: &str) -> i64 {
        self.core(|c| Ok(c.db.query_row(sql, [], |r| r.get(0))?))
    }

    fn pending(&self, reason: &str) -> i64 {
        self.core(|c| {
            Ok(c.db.query_row(
                "SELECT count(*) FROM board_pending WHERE reason = ?1",
                [reason],
                |r| r.get(0),
            )?)
        })
    }

    fn rejections(&self) -> Vec<String> {
        self.core(|c| {
            let mut stmt = c.db.prepare("SELECT code FROM rejected_changes ORDER BY id")?;
            let rows = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    fn tasks(&self, pid: &str) -> Vec<TaskData> {
        self.core(|c| store::load_doc(&c.db, pid, &store::actor_of(&c.identity))?.tasks())
    }

    fn heads(&self, pid: &str) -> Vec<String> {
        self.core(|c| sync::heads(&c.db, pid))
    }

    fn has_project(&self, pid: &str) -> bool {
        self.core(|c| Ok(store::project(&c.db, pid).is_ok()))
    }

    fn change_count(&self, pid: &str) -> usize {
        self.core(|c| store::stored_changes(&c.db, pid)).len()
    }
}

/// Runs `f` with the cores of two laptops at once.
fn both<T>(a: &Lap, b: &Lap, f: impl FnOnce(&mut Core, &mut Core) -> T) -> T {
    a.state
        .with_core(|ca| b.state.with_core(|cb| Ok(f(ca, cb))))
        .unwrap()
}

fn join(inviter: &Lap, joiner: &Lap, team: &str, role: InviteRole, projects: Vec<String>) {
    both(inviter, joiner, |i, j| {
        org_ops::join(
            (&mut i.db, &i.identity),
            (&mut j.db, &j.identity),
            team,
            role,
            projects,
        )
    });
}

/// Membership ops between every pair until nothing new arrives.
fn sync_ops(laps: &[&Lap]) {
    for _ in 0..10 {
        let mut n = 0;
        for a in laps {
            for b in laps {
                if a.pk != b.pk {
                    n += both(a, b, |ca, cb| org_ops::sync(&ca.db, &mut cb.db, &b.pk, &a.pk));
                }
            }
        }
        if n == 0 {
            return;
        }
    }
    panic!("membership ops did not settle");
}

/// Sari (founder, superadmin), Budi (admin of team Desain) and Citra (member
/// of Desain). Sari joins Desain through an `add_team_member` op.
struct Office {
    sari: Lap,
    budi: Lap,
    citra: Lap,
    team: String,
}

impl Office {
    fn all(&self) -> [(&str, &dyn FeatureSync); 3] {
        [self.sari.me(), self.budi.me(), self.citra.me()]
    }
}

fn office() -> Office {
    let sari = Lap::founder("Sari");
    let budi = Lap::new("Budi");
    let citra = Lap::new("Citra");
    let team = sari.core(|c| Ok(org_ops::create_team(&mut c.db, &c.identity, "Desain")));
    join(&sari, &budi, &team, InviteRole::TeamAdmin, vec![]);
    join(&sari, &citra, &team, InviteRole::Member, vec![]);
    let sari_pk = sari.pk.clone();
    sari.core(|c| p::add_team_member(&mut c.db, &c.identity, &team, &sari_pk, org_ops::now()));
    sync_ops(&[&sari, &budi, &citra]);
    Office {
        sari,
        budi,
        citra,
        team,
    }
}

fn project(l: &Lap, team: &str, code: &str) -> String {
    commands::create_project(&l.state, &NoopSync, "Peluncuran produk", code, Some(team))
        .unwrap()
        .id
}

fn new_task(l: &Lap, pid: &str, title: &str, assignee: Option<&str>) -> String {
    let input = NewTask {
        title: title.into(),
        assignee: assignee.map(str::to_owned),
        ..NewTask::default()
    };
    commands::create_task(&l.state, &NoopSync, pid, input)
        .unwrap()
        .card
        .id
}

fn patch(l: &Lap, pid: &str, task: &str, p: TaskPatch) {
    commands::update_task(&l.state, &NoopSync, pid, task, p).unwrap();
}

/// What `from` offers `to`, fetched as the transport would.
fn records_from(from: &Lap, to: &Lap) -> Vec<FeatureRecord> {
    let ids = from.f.record_ids_for(&to.pk).unwrap();
    from.f.records_for(&to.pk, &ids).unwrap()
}

fn ingest(to: &Lap, from: &Lap, records: Vec<FeatureRecord>) -> FeatureIngest {
    let (ok, dropped) = check_incoming(records);
    assert_eq!(dropped, 0);
    to.f.ingest(&from.pk, ok).unwrap()
}

fn record(sc: &SignedChange) -> FeatureRecord {
    FeatureRecord::new(sc.record_body())
}

fn project_of(r: &FeatureRecord) -> String {
    SignedChange::from_record_body(&r.body).unwrap().project_id
}

/// `author` edits a copy of `source`'s document directly (no permission
/// check) and signs the change: what a modified app could send.
fn forge(
    author: &Lap,
    source: &Lap,
    pid: &str,
    edit: impl FnOnce(&mut BoardDoc, &str) -> AppResult<()>,
) -> SignedChange {
    let snapshot: Vec<u8> = source.core(|c| {
        Ok(c.db.query_row("SELECT doc FROM board_projects WHERE id = ?1", [pid], |r| r.get(0))?)
    });
    author.core(|c| {
        let mut doc = BoardDoc::load(&snapshot, &store::actor_of(&c.identity))?;
        let before = doc.heads();
        let me = c.identity.public_key_hex().to_owned();
        edit(&mut doc, &me)?;
        doc.commit(clock::now().unix_timestamp());
        let change = doc.changes_after(&before).pop().unwrap();
        Ok(sign_change(&c.identity, pid, &change))
    })
}

fn forge_task(author: &Lap, source: &Lap, pid: &str, title: &str) -> SignedChange {
    forge(author, source, pid, |doc, me| {
        let at = clock::now_rfc3339();
        doc.create_task(
            Stamp { actor: me, at: &at },
            TaskInit {
                title: title.into(),
                description: String::new(),
                column: None,
                assignee: None,
                due: None,
                priority: Default::default(),
                labels: vec![],
            },
        )
        .map(|_| ())
    })
}

/// Fills `l`'s pending table with `n` dummy rows from `from`, aged `at`.
fn fill_pending(l: &Lap, n: i64, from: &str, reason: &str, at: &str) {
    l.core(|c| {
        let tx = c.db.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO board_pending
                   (record_id, project_id, hash, author, body, reason, received_from, received_at)
                 VALUES (?1, ?2, ?1, ?1, 'x', ?3, ?4, ?5)",
            )?;
            let base: i64 = tx.query_row("SELECT count(*) FROM board_pending", [], |r| r.get(0))?;
            for i in base..base + n {
                stmt.execute(params![format!("{i:064x}"), "00".repeat(16), reason, from, at])?;
            }
        }
        tx.commit()?;
        Ok(())
    });
}

#[test]
fn three_laptops_editing_offline_converge() {
    let o = office();
    let pid = project(&o.budi, &o.team, "PL");
    let task = new_task(&o.budi, &pid, "Desain logo", Some(&o.citra.pk));
    sync_all(&o.all()).unwrap();
    assert_eq!(o.citra.tasks(&pid).len(), 1);
    assert_eq!(o.sari.tasks(&pid).len(), 1);

    // Offline on all three laptops at once.
    patch(&o.sari, &pid, &task, TaskPatch {
        title: Some("Logo baru".into()),
        ..TaskPatch::default()
    });
    patch(&o.citra, &pid, &task, TaskPatch {
        description: Some("Pakai warna bata".into()),
        ..TaskPatch::default()
    });
    commands::move_task(&o.budi.state, &NoopSync, &pid, &task, ColumnId::Doing, 0).unwrap();
    for (l, text) in [(&o.sari, "dari Sari"), (&o.budi, "dari Budi"), (&o.citra, "dari Citra")] {
        commands::add_comment(&l.state, &NoopSync, &pid, &task, text).unwrap();
    }

    sync_all(&o.all()).unwrap();
    let tasks = o.budi.tasks(&pid);
    assert_eq!(tasks, o.sari.tasks(&pid));
    assert_eq!(tasks, o.citra.tasks(&pid));
    assert_eq!(o.budi.heads(&pid), o.sari.heads(&pid));
    assert_eq!(o.budi.heads(&pid), o.citra.heads(&pid));
    let t = &tasks[0];
    assert_eq!(t.title, "Logo baru");
    assert_eq!(t.description, "Pakai warna bata");
    assert_eq!(t.column, ColumnId::Doing);
    assert_eq!(t.comments.len(), 3);

    // "Task saya" on Citra's laptop follows the edits made elsewhere.
    let mine = commands::my_tasks(&o.citra.state).unwrap();
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].task.title, "Logo baru");
    assert_eq!(mine[0].task.column_id, ColumnId::Doing);
    let index = o.sari.core(|c| store::index_rows(&c.db, &pid));
    assert_eq!(index[0].2, "Logo baru");
    assert_eq!(index[0].3, ColumnId::Doing);
    for l in [&o.sari, &o.budi, &o.citra] {
        assert_eq!(l.count("SELECT count(*) FROM board_pending"), 0);
        assert!(l.rejections().is_empty(), "{:?}", l.rejections());
    }
}

#[test]
fn records_arrive_in_reverse_and_in_small_pulls() {
    let o = office();
    let pid = project(&o.budi, &o.team, "PL");
    let a = new_task(&o.budi, &pid, "Satu", None);
    new_task(&o.budi, &pid, "Dua", None);
    patch(&o.budi, &pid, &a, TaskPatch {
        title: Some("Satu lagi".into()),
        ..TaskPatch::default()
    });
    let records = records_from(&o.budi, &o.citra);
    assert_eq!(records.len(), 4);
    // Stored order: the project's first change comes first.
    assert_eq!(project_of(&records[0]), pid);

    let mut reversed = records.clone();
    reversed.reverse();
    let mut chunks = reversed.chunks(2);
    let first = ingest(&o.citra, &o.budi, chunks.next().unwrap().to_vec());
    assert_eq!(first.accepted, 2, "stored as pending");
    assert!(!first.changed);
    assert_eq!(o.citra.pending("project"), 2);
    assert!(!o.citra.has_project(&pid));
    // Pending records are not asked for again.
    let ids: Vec<String> = records.iter().map(|r| r.id.clone()).collect();
    assert_eq!(o.citra.f.unknown_ids(&ids).unwrap(), ids[..2].to_vec());

    let second = ingest(&o.citra, &o.budi, chunks.next().unwrap().to_vec());
    assert!(second.changed);
    assert_eq!(o.citra.count("SELECT count(*) FROM board_pending"), 0);
    assert_eq!(o.citra.tasks(&pid), o.budi.tasks(&pid));
    assert_eq!(o.citra.heads(&pid), o.budi.heads(&pid));
    assert!(o.citra.f.unknown_ids(&ids).unwrap().is_empty());
}

#[test]
fn child_waits_for_its_parent_in_a_known_project() {
    let o = office();
    let pid = project(&o.budi, &o.team, "PL");
    sync_all(&o.all()).unwrap();
    let a = new_task(&o.budi, &pid, "Satu", None);
    patch(&o.budi, &pid, &a, TaskPatch {
        title: Some("Satu lagi".into()),
        ..TaskPatch::default()
    });
    let records = records_from(&o.budi, &o.citra);
    let ids: Vec<String> = records.iter().map(|r| r.id.clone()).collect();
    let new = o.citra.f.unknown_ids(&ids).unwrap();
    assert_eq!(new.len(), 2);
    let got = o.budi.f.records_for(&o.citra.pk, &new).unwrap();
    let child = ingest(&o.citra, &o.budi, vec![got[1].clone()]);
    assert_eq!(child.accepted, 1);
    assert!(!child.changed);
    assert_eq!(o.citra.pending("deps"), 1);
    let parent = ingest(&o.citra, &o.budi, vec![got[0].clone()]);
    assert_eq!(parent.accepted, 1);
    assert!(parent.changed);
    assert_eq!(o.citra.pending("deps"), 0);
    assert_eq!(o.citra.tasks(&pid)[0].title, "Satu lagi");
}

#[test]
fn new_project_imported_even_when_its_first_change_comes_last() {
    let o = office();
    let pid = project(&o.budi, &o.team, "PL");
    new_task(&o.budi, &pid, "Satu", None);
    new_task(&o.budi, &pid, "Dua", None);
    let records = records_from(&o.budi, &o.sari);
    let rest = ingest(&o.sari, &o.budi, records[1..].to_vec());
    assert_eq!(rest.accepted, 2);
    assert!(!rest.changed);
    assert_eq!(o.sari.pending("project"), 2);
    assert!(!o.sari.has_project(&pid));

    let first = ingest(&o.sari, &o.budi, records[..1].to_vec());
    assert_eq!(first.accepted, 1);
    assert!(first.changed);
    assert!(o.sari.has_project(&pid));
    assert_eq!(o.sari.tasks(&pid).len(), 2);
    assert_eq!(o.sari.count("SELECT count(*) FROM board_pending"), 0);

    // A plain pull of a fresh project works too.
    let other = project(&o.budi, &o.team, "PX");
    let (got, _) = pull(o.budi.me(), o.citra.me()).unwrap();
    assert!(got.changed);
    assert!(o.citra.has_project(&pid) && o.citra.has_project(&other));
}

#[test]
fn records_stay_with_people_who_may_read_the_project() {
    let o = office();
    let pa = project(&o.budi, &o.team, "PA");
    let pb = project(&o.budi, &o.team, "PB");
    new_task(&o.budi, &pa, "Untuk klien", None);
    new_task(&o.budi, &pb, "Internal", None);

    // Dodi is in another team; the client is a guest of project PA only.
    let dodi = Lap::new("Dodi");
    let tamu = Lap::new("Klien");
    let keuangan = o.sari.core(|c| Ok(org_ops::create_team(&mut c.db, &c.identity, "Keuangan")));
    join(&o.sari, &dodi, &keuangan, InviteRole::Member, vec![]);
    join(&o.sari, &tamu, &o.team, InviteRole::Guest, vec![pa.clone()]);
    sync_ops(&[&o.sari, &o.budi, &o.citra, &dodi, &tamu]);

    let all_ids = o.budi.f.record_ids_for(&o.citra.pk).unwrap();
    assert_eq!(all_ids.len(), 4);
    assert!(o.budi.f.record_ids_for(&dodi.pk).unwrap().is_empty());
    assert!(o.budi.f.records_for(&dodi.pk, &all_ids).unwrap().is_empty());
    let (got, _) = pull(o.budi.me(), dodi.me()).unwrap();
    assert_eq!(got.accepted, 0);

    let guest_ids = o.budi.f.record_ids_for(&tamu.pk).unwrap();
    assert_eq!(guest_ids.len(), 2);
    let guest_records = o.budi.f.records_for(&tamu.pk, &all_ids).unwrap();
    assert_eq!(guest_records.len(), 2);
    assert!(guest_records.iter().all(|r| project_of(r) == pa));
    pull(o.budi.me(), tamu.me()).unwrap();
    assert!(tamu.has_project(&pa));
    assert!(!tamu.has_project(&pb));

    // A guest may not write: a change signed by the guest is not applied
    // and not kept. It is not refused for good either (the op making the
    // guest a member may still be on its way), so it is asked for again.
    let by_guest = record(&forge_task(&tamu, &tamu, &pa, "Dari tamu"));
    let got = ingest(&o.budi, &tamu, vec![by_guest.clone()]);
    assert_eq!(got, FeatureIngest::default());
    assert_eq!(o.budi.count("SELECT count(*) FROM board_pending"), 0);
    assert_eq!(o.budi.count("SELECT count(*) FROM board_rejected"), 0);
    assert!(o.budi.rejections().is_empty());
    assert_eq!(o.budi.f.unknown_ids(std::slice::from_ref(&by_guest.id)).unwrap(), vec![by_guest.id]);
    assert_eq!(o.budi.tasks(&pa).len(), 1);

    // Citra leaves the team: new changes are no longer offered to her.
    let citra_pk = o.citra.pk.clone();
    let team = o.team.clone();
    o.sari.core(|c| p::remove_team_member(&mut c.db, &c.identity, &team, &citra_pk, org_ops::now()));
    sync_ops(&[&o.sari, &o.budi]);
    new_task(&o.budi, &pa, "Sesudah Citra keluar", None);
    let latest = o.budi.core(|c| store::stored_changes(&c.db, &pa)).pop().unwrap();
    let offered = o.budi.f.record_ids_for(&o.citra.pk).unwrap();
    assert!(!offered.contains(&latest.record_id()));
    assert!(o.budi.f.records_for(&o.citra.pk, &[latest.record_id()]).unwrap().is_empty());
}

#[test]
fn forged_changes_are_refused_and_not_asked_again() {
    let o = office();
    let pid = project(&o.budi, &o.team, "PL");
    let task = new_task(&o.budi, &pid, "Logo", None);
    sync_all(&o.all()).unwrap();
    // Budi edits offline; that change is forged below.
    patch(&o.budi, &pid, &task, TaskPatch {
        title: Some("Logo final".into()),
        ..TaskPatch::default()
    });
    let real = o.budi.core(|c| store::stored_changes(&c.db, &pid)).pop().unwrap();

    let broken = FeatureRecord::new("{\"v\":1,\"rusak\"");
    let mut bad_sig = real.clone();
    let last = if bad_sig.sig.ends_with('0') { "1" } else { "0" };
    bad_sig.sig.replace_range(127.., last);
    // Citra signs Budi's change as herself: the actor is not the signer.
    let not_signer = o.citra.core(|c| {
        let mut sc = real.clone();
        sc.author = c.identity.public_key_hex().to_owned();
        sc.sig = hex::encode(c.identity.sign(&signing_message(&pid, &sc.bytes)).to_bytes());
        Ok(sc)
    });
    // Someone outside the organization edits a copy of the document.
    let eko = Lap::new("Eko");
    let outsider = forge_task(&eko, &o.budi, &pid, "Iklan gelap");

    let forged = vec![broken, record(&bad_sig), record(&not_signer), record(&outsider)];
    let ids: Vec<String> = forged.iter().map(|r| r.id.clone()).collect();
    let before = o.sari.change_count(&pid);
    let got = ingest(&o.sari, &o.budi, forged.clone());
    // The outsider's change is neither kept nor refused for good: this
    // laptop has never seen that key as a member, and the op admitting it
    // could still be on its way. It is simply asked for again later.
    assert_eq!(got, FeatureIngest {
        accepted: 0,
        rejected: 3,
        changed: false,
    });
    assert_eq!(o.sari.change_count(&pid), before);
    assert_eq!(o.sari.count("SELECT count(*) FROM board_rejected"), 3);
    assert_eq!(o.sari.count("SELECT count(*) FROM board_pending"), 0);
    let codes = o.sari.rejections();
    assert_eq!(codes.len(), 3, "{codes:?}");
    assert!(codes.contains(&"board_bad_format".to_owned()));
    assert_eq!(o.sari.f.unknown_ids(&ids).unwrap(), vec![ids[3].clone()]);

    // Offered again, or after a membership change: logged only once.
    let again = ingest(&o.sari, &o.budi, forged);
    assert_eq!(again, FeatureIngest::default());
    o.sari.core(|c| p::create_team(&mut c.db, &c.identity, "Gudang", org_ops::now()).map(|_| ()));
    o.sari.f.peer_connected(&o.budi.pk);
    assert_eq!(o.sari.rejections().len(), 3);

    // The real change still gets through.
    let (real_pull, _) = pull(o.budi.me(), o.sari.me()).unwrap();
    assert_eq!(real_pull.accepted, 1);
    assert_eq!(o.sari.tasks(&pid)[0].title, "Logo final");
}

#[test]
fn change_from_new_member_waits_for_the_membership_op() {
    let o = office();
    let pid = project(&o.budi, &o.team, "PL");
    sync_all(&o.all()).unwrap();
    // Eko is a member (team Keuangan) everyone knows about.
    let eko = Lap::new("Eko");
    let keuangan = o.sari.core(|c| Ok(org_ops::create_team(&mut c.db, &c.identity, "Keuangan")));
    join(&o.sari, &eko, &keuangan, InviteRole::Member, vec![]);
    sync_ops(&[&o.sari, &o.budi, &o.citra, &eko]);
    // Sari adds him to Desain; only Sari and Eko know so far.
    let (team, eko_pk) = (o.team.clone(), eko.pk.clone());
    o.sari.core(|c| p::add_team_member(&mut c.db, &c.identity, &team, &eko_pk, org_ops::now()));
    sync_ops(&[&o.sari, &eko]);
    pull(o.sari.me(), eko.me()).unwrap();
    assert!(eko.has_project(&pid));
    new_task(&eko, &pid, "Spanduk", None);

    // Budi has not heard that Eko joined Desain.
    let got = pull(eko.me(), o.budi.me()).unwrap().0;
    assert_eq!(got.rejected, 1);
    assert!(!got.changed);
    assert_eq!(o.budi.pending("rights"), 1);
    assert_eq!(o.budi.rejections(), vec!["board_forbidden".to_owned()]);
    assert!(o.budi.tasks(&pid).is_empty());

    // The op arrives: the held change is applied without receiving it again.
    sync_ops(&[&o.sari, &o.budi]);
    o.budi.f.peer_connected(&o.sari.pk);
    assert_eq!(o.budi.pending("rights"), 0);
    assert_eq!(o.budi.tasks(&pid)[0].title, "Spanduk");
    assert_eq!(o.budi.rejections().len(), 1);
}

#[test]
fn change_from_promoted_guest_waits_for_the_promotion_op() {
    let o = office();
    let pid = project(&o.budi, &o.team, "PL");
    let tamu = Lap::new("Klien");
    join(&o.sari, &tamu, &o.team, InviteRole::Guest, vec![pid.clone()]);
    sync_ops(&[&o.sari, &o.budi, &o.citra, &tamu]);
    pull(o.budi.me(), tamu.me()).unwrap();
    assert!(tamu.has_project(&pid));

    // Sari makes the guest a member of Desain; only Sari and the client
    // know so far.
    let team = o.team.clone();
    both(&o.sari, &tamu, |s, t| {
        org_ops::accept_more((&mut s.db, &s.identity), &t.identity, &team, InviteRole::Member, vec![])
    });
    sync_ops(&[&o.sari, &tamu]);
    new_task(&tamu, &pid, "Dari klien", None);

    // Budi still sees a guest: nothing is kept, refused or logged.
    let got = pull(tamu.me(), o.budi.me()).unwrap().0;
    assert_eq!(got, FeatureIngest::default());
    assert_eq!(o.budi.count("SELECT count(*) FROM board_pending"), 0);
    assert_eq!(o.budi.count("SELECT count(*) FROM board_rejected"), 0);
    assert!(o.budi.rejections().is_empty());
    assert!(o.budi.tasks(&pid).is_empty());

    // The op arrives: the change is asked for again and applied.
    sync_ops(&[&o.sari, &o.budi]);
    let got = pull(tamu.me(), o.budi.me()).unwrap().0;
    assert_eq!(got.accepted, 1);
    assert!(got.changed);
    assert_eq!(o.budi.tasks(&pid)[0].title, "Dari klien");
    assert_eq!(o.budi.heads(&pid), tamu.heads(&pid));
}

#[test]
fn change_made_before_removal_is_accepted_after_it() {
    let o = office();
    let pid = project(&o.budi, &o.team, "PL");
    let task = new_task(&o.budi, &pid, "Logo", None);
    sync_all(&o.all()).unwrap();
    patch(&o.citra, &pid, &task, TaskPatch {
        description: Some("Dibuat sebelum keluar".into()),
        ..TaskPatch::default()
    });
    // Sari receives it while Citra is still a member and comments on top.
    pull(o.citra.me(), o.sari.me()).unwrap();
    o.sari.core(|c| {
        let me = c.identity.public_key_hex().to_owned();
        store::commit_local(&mut c.db, &c.identity, &pid, |d| {
            d.add_comment(
                Stamp {
                    actor: &me,
                    at: &clock::now_rfc3339(),
                },
                &task,
                "oke",
            )
        })
        .map(|_| ())
    });
    // Sari removes Citra from the organization a little later; Budi learns
    // about it before Citra's change arrives.
    let citra_pk = o.citra.pk.clone();
    let later = org_ops::now() + Duration::seconds(120);
    o.sari.core(|c| p::remove_member(&mut c.db, &c.identity, &citra_pk, later));
    sync_ops(&[&o.sari, &o.budi]);

    // Alone, the change of someone who lost the right is held: nobody who
    // still has the right has built on it yet (as far as Budi knows).
    let got = pull(o.citra.me(), o.budi.me()).unwrap().0;
    assert!(!got.changed);
    assert_eq!(o.budi.pending("rights"), 1);
    assert_eq!(o.budi.tasks(&pid)[0].description, "");

    // Sari's comment, built on it, arrives: both are applied and the held
    // change is not downloaded again.
    let got = pull(o.sari.me(), o.budi.me()).unwrap().0;
    assert!(got.changed);
    assert_eq!(o.budi.pending("rights"), 0);
    assert_eq!(o.budi.tasks(&pid)[0].description, "Dibuat sebelum keluar");
    assert_eq!(o.budi.tasks(&pid)[0].comments.len(), 1);
}

#[test]
fn pending_table_is_bounded() {
    let o = office();
    let pid = project(&o.budi, &o.team, "PL");
    new_task(&o.budi, &pid, "Satu", None);
    // Spread over several senders so the per-sender quota is not what stops it.
    let fresh = clock::now_rfc3339();
    for n in 0..4 {
        let sender = format!("{n:02x}").repeat(32);
        fill_pending(&o.sari, MAX_PENDING_ROWS / 4, &sender, "deps", &fresh);
    }
    let records = records_from(&o.budi, &o.sari);
    let got = ingest(&o.sari, &o.budi, records[1..].to_vec());
    assert_eq!(got, FeatureIngest::default());
    assert_eq!(o.sari.count("SELECT count(*) FROM board_pending"), MAX_PENDING_ROWS);
    assert!(o.sari.rejections().is_empty());
    assert_eq!(o.sari.f.unknown_ids(&[records[1].id.clone()]).unwrap().len(), 1);
}

#[test]
fn pending_quota_per_sender() {
    let o = office();
    let pid = project(&o.budi, &o.team, "PL");
    new_task(&o.budi, &pid, "Satu", None);
    fill_pending(&o.sari, MAX_PENDING_PER_SENDER, &o.budi.pk, "deps", &clock::now_rfc3339());
    let records = records_from(&o.budi, &o.sari);
    let waiting = records[1..].to_vec();
    assert_eq!(ingest(&o.sari, &o.budi, waiting.clone()), FeatureIngest::default());
    // The same record from someone else still fits.
    let got = ingest(&o.sari, &o.citra, waiting);
    assert_eq!(got.accepted, 1);
    assert_eq!(o.sari.pending("project"), 1);
}

#[test]
fn old_waiting_rows_are_dropped() {
    let o = office();
    let ago = |days| clock::format_rfc3339(clock::now() - Duration::days(days));
    fill_pending(&o.sari, 2, &o.budi.pk, "deps", &ago(31));
    fill_pending(&o.sari, 1, &o.budi.pk, "project", &ago(31));
    fill_pending(&o.sari, 1, &o.budi.pk, "deps", &clock::now_rfc3339());
    // Held changes get longer, but not forever.
    fill_pending(&o.sari, 1, &o.budi.pk, "rights", &ago(31));
    fill_pending(&o.sari, 2, &o.budi.pk, "rights", &ago(91));
    // Directly: `ingest` would also retry the held dummy rows and drop them
    // as unreadable.
    o.sari.core(|c| drop_stale_pending(&c.db, clock::now()));
    assert_eq!(o.sari.pending("deps"), 1);
    assert_eq!(o.sari.pending("project"), 0);
    assert_eq!(o.sari.pending("rights"), 1);
}

#[test]
fn pending_bytes_quota_per_sender() {
    let o = office();
    let pid = project(&o.budi, &o.team, "PL");
    new_task(&o.budi, &pid, "Satu", None);
    // One huge row from Budi: few rows, but his byte quota is used up.
    let big = "x".repeat(usize::try_from(MAX_PENDING_BYTES_PER_SENDER).unwrap() - 100);
    o.sari.core(|c| {
        c.db.execute(
            "INSERT INTO board_pending
               (record_id, project_id, hash, author, body, reason, received_from, received_at)
             VALUES (?1, ?2, ?1, ?1, ?3, 'deps', ?4, ?5)",
            params!["ab".repeat(32), "00".repeat(16), big, o.budi.pk, clock::now_rfc3339()],
        )?;
        Ok(())
    });
    let records = records_from(&o.budi, &o.sari);
    let waiting = records[1..].to_vec();
    assert_eq!(ingest(&o.sari, &o.budi, waiting.clone()), FeatureIngest::default());
    assert_eq!(o.sari.pending("project"), 0);
    // The same record from someone else still fits.
    assert_eq!(ingest(&o.sari, &o.citra, waiting).accepted, 1);
    assert_eq!(o.sari.pending("project"), 1);
}

#[test]
fn waiting_changes_of_unknown_authors_are_not_kept() {
    let o = office();
    let pid = project(&o.budi, &o.team, "PL");
    new_task(&o.budi, &pid, "Satu", None);
    // Eko is not in the organization; Sari does not know the project yet.
    let eko = Lap::new("Eko");
    let by_eko = record(&forge_task(&eko, &o.budi, &pid, "Iklan gelap"));
    let got = ingest(&o.sari, &o.budi, vec![by_eko.clone()]);
    assert_eq!(got, FeatureIngest::default());
    assert_eq!(o.sari.count("SELECT count(*) FROM board_pending"), 0);
    assert!(o.sari.rejections().is_empty());
    assert_eq!(o.sari.f.unknown_ids(std::slice::from_ref(&by_eko.id)).unwrap(), vec![by_eko.id.clone()]);

    // A row kept earlier for such an author is dropped when it comes up
    // again; Budi's own waiting change is kept.
    let sc = SignedChange::from_record_body(&by_eko.body).unwrap();
    o.sari.core(|c| {
        c.db.execute(
            "INSERT INTO board_pending
               (record_id, project_id, hash, author, body, reason, received_from, received_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'deps', ?6, ?7)",
            params![by_eko.id, pid, sc.hash, sc.author, by_eko.body, o.citra.pk, clock::now_rfc3339()],
        )?;
        Ok(())
    });
    let records = records_from(&o.budi, &o.sari);
    let got = ingest(&o.sari, &o.budi, records[1..].to_vec());
    assert_eq!(got.accepted, 1);
    assert_eq!(o.sari.pending("project"), 1);
    assert_eq!(o.sari.count("SELECT count(*) FROM board_pending"), 1);
    assert_eq!(o.sari.f.unknown_ids(std::slice::from_ref(&by_eko.id)).unwrap(), vec![by_eko.id]);
}

#[test]
fn one_reply_holds_at_most_the_byte_budget() {
    let o = office();
    let pid = project(&o.budi, &o.team, "PL");
    // Rows shaped like large stored changes (about 200 KiB of body each).
    let author = o.budi.pk.clone();
    o.budi.core(|c| {
        for n in 0..50u8 {
            let sc = SignedChange {
                project_id: pid.clone(),
                hash: format!("{n:02x}").repeat(32),
                author: author.clone(),
                seq: u64::from(n) + 100,
                bytes: vec![n; 100 * 1024],
                sig: "0".repeat(128),
            };
            c.db.execute(
                "INSERT INTO board_changes
                   (hash, project_id, author, seq, bytes, sig, created_at, received_at, record_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 't', 't', ?7)",
                params![sc.hash, sc.project_id, sc.author, sc.seq as i64, sc.bytes, sc.sig, sc.record_id()],
            )?;
        }
        Ok(())
    });
    let ids = o.budi.f.record_ids_for(&o.citra.pk).unwrap();
    assert_eq!(ids.len(), 51);
    let size = |rs: &[FeatureRecord]| rs.iter().map(|r| r.body.len()).sum::<usize>();

    let mut asked = ids.clone();
    asked.reverse();
    let first = o.budi.f.records_for(&o.citra.pk, &asked).unwrap();
    assert!(!first.is_empty() && first.len() < ids.len(), "{}", first.len());
    assert!(size(&first) <= MAX_RECORDS_FOR_BYTES);
    // Stored order, from the start: the project's first change leads.
    let got: Vec<String> = first.iter().map(|r| r.id.clone()).collect();
    assert_eq!(got, ids[..first.len()].to_vec());

    // The next round asks for what is still missing and gets the rest.
    let rest = o.budi.f.records_for(&o.citra.pk, &ids[first.len()..]).unwrap();
    assert_eq!(first.len() + rest.len(), ids.len());
    assert!(size(&rest) <= MAX_RECORDS_FOR_BYTES);
}

fn bound(l: &Lap, pid: &str) -> Option<i64> {
    l.core(|c| Ok(c.db.query_row("SELECT bound FROM board_projects WHERE id = ?1", [pid], |r| r.get(0))?))
}

#[test]
fn bound_ids_are_checked_once_then_read_from_the_table() {
    let o = office();
    let pid = project(&o.budi, &o.team, "PL");
    new_task(&o.budi, &pid, "Satu", None);
    assert_eq!(bound(&o.budi, &pid), None);
    assert_eq!(o.budi.f.record_ids_for(&o.citra.pk).unwrap().len(), 2);
    assert_eq!(bound(&o.budi, &pid), Some(1));

    // Afterwards the stored value decides; the document is not read.
    o.budi.core(|c| Ok(c.db.execute("UPDATE board_projects SET bound = 0", [])?));
    assert!(o.budi.f.record_ids_for(&o.citra.pk).unwrap().is_empty());
    let all = o.budi.core(|c| store::stored_changes(&c.db, &pid));
    let ids: Vec<String> = all.iter().map(SignedChange::record_id).collect();
    assert!(o.budi.f.records_for(&o.citra.pk, &ids).unwrap().is_empty());
    o.budi.core(|c| Ok(c.db.execute("UPDATE board_projects SET bound = NULL", [])?));
    assert_eq!(o.budi.f.records_for(&o.citra.pk, &ids).unwrap().len(), 2);
    assert_eq!(bound(&o.budi, &pid), Some(1));

    // A project made before ids were bound (no nonce) is stored as 0.
    let old = "ef".repeat(16);
    let budi_pk = o.budi.pk.clone();
    o.budi.core(|c| {
        let meta = ProjectMeta {
            id: old.clone(),
            code: "LM".into(),
            name: "Proyek lama".into(),
            team_id: None,
        };
        let mut doc = BoardDoc::create(&store::actor_of(&c.identity), &meta)?;
        doc.commit(1);
        c.db.execute(
            "INSERT INTO board_projects (id, code, doc_code, name, team_id, created_by, created_at, doc, updated_at)
             VALUES (?1, 'LM', 'LM', 'Proyek lama', NULL, ?2, 't', ?3, 't')",
            params![old, budi_pk, doc.save()],
        )?;
        Ok(())
    });
    assert!(!o.budi.core(|c| store::is_syncable(&c.db, &old)));
    assert_eq!(bound(&o.budi, &old), Some(0));
    assert!(o.budi.core(|c| Ok(store::is_syncable(&c.db, &"00".repeat(16)).is_err())));
}

#[test]
fn refusals_of_waiting_changes_name_the_peer_that_sent_them() {
    let o = office();
    let pid = project(&o.budi, &o.team, "PL");
    new_task(&o.budi, &pid, "Satu", None);
    pull(o.budi.me(), o.citra.me()).unwrap();
    // Citra (a member) sends Sari a change that rewrites the project's
    // nonce. Sari does not know the project yet, so it waits.
    let bad = record(&forge(&o.citra, &o.citra, &pid, |doc, _| doc.set_project_nonce(&"cd".repeat(16))));
    assert_eq!(ingest(&o.sari, &o.citra, vec![bad]).accepted, 1);
    assert_eq!(o.sari.pending("project"), 1);

    // Budi, honest, sends the project; Citra's change is refused then.
    let got = ingest(&o.sari, &o.budi, records_from(&o.budi, &o.sari));
    assert!(got.changed);
    assert_eq!(o.sari.count("SELECT count(*) FROM board_pending"), 0);
    let logged: Vec<(Option<String>, String)> = o.sari.core(|c| {
        let mut stmt = c.db.prepare("SELECT peer, code FROM rejected_changes ORDER BY id")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        Ok(rows)
    });
    assert_eq!(logged, vec![(Some(o.citra.pk.clone()), "board_not_allowed".to_owned())]);
    // Applied changes record who sent them.
    let from: Vec<Option<String>> = o.sari.core(|c| {
        let mut stmt = c.db.prepare("SELECT received_from FROM board_changes WHERE project_id = ?1")?;
        let rows = stmt.query_map([&pid], |r| r.get(0))?.collect::<Result<_, _>>()?;
        Ok(rows)
    });
    assert_eq!(from, vec![Some(o.budi.pk.clone()); 2]);
}

#[test]
fn old_rows_get_their_record_id_before_offering() {
    let o = office();
    let pid = project(&o.budi, &o.team, "PL");
    new_task(&o.budi, &pid, "Satu", None);
    let before = o.budi.f.record_ids_for(&o.citra.pk).unwrap();
    o.budi.core(|c| Ok(c.db.execute("UPDATE board_changes SET record_id = NULL", [])?));
    assert_eq!(o.budi.f.record_ids_for(&o.citra.pk).unwrap(), before);
    assert_eq!(o.budi.count("SELECT count(*) FROM board_changes WHERE record_id IS NULL"), 0);
}

#[derive(Default)]
struct CountLink(AtomicUsize);

impl FeatureLink for CountLink {
    fn notify_changed(&self, topic: &str) {
        if topic == TOPIC_BOARD {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    fn fetch_blob(&self, _: String, _: u64, _: Vec<String>, _: std::path::PathBuf) -> BlobFuture {
        Box::pin(async { Err("tidak ada".to_owned()) })
    }
    fn connected_peers(&self) -> Vec<String> {
        Vec::new()
    }
}

#[derive(Default)]
struct CountHook(AtomicUsize);

impl BoardSyncHook for CountHook {
    fn on_local_change(&self, _: &str, _: &SignedChange) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[test]
fn local_and_received_changes_notify_the_hub_and_reminders() {
    let hub = Arc::new(FeatureHub::default());
    let link = Arc::new(CountLink::default());
    hub.set_link(link.clone());
    let reminders = Arc::new(CountHook::default());
    let notifier = BoardSyncNotifier::new(reminders.clone(), hub.clone());

    let o = office();
    commands::create_project(&o.budi.state, &notifier, "Peluncuran", "PL", Some(&o.team)).unwrap();
    assert_eq!(link.0.load(Ordering::SeqCst), 1);
    assert_eq!(reminders.0.load(Ordering::SeqCst), 1);

    // Received changes are announced too (reminders and forwarding).
    let citra_reminders = Arc::new(CountHook::default());
    let receiver = BoardFeature::new(
        o.citra.state.clone(),
        Arc::new(BoardSyncNotifier::new(citra_reminders.clone(), Arc::downgrade(&hub))),
    );
    let got = pull(o.budi.me(), (&o.citra.pk, &receiver)).unwrap().0;
    assert!(got.changed);
    assert!(link.0.load(Ordering::SeqCst) >= 2);
    assert!(citra_reminders.0.load(Ordering::SeqCst) >= 1);

    // Without a hub (dropped) only the reminders run.
    let lone = Arc::new(CountHook::default());
    let orphan = BoardSyncNotifier::new(lone.clone(), std::sync::Weak::<FeatureHub>::new());
    orphan.on_local_change("x", &SignedChange {
        project_id: String::new(),
        hash: String::new(),
        author: String::new(),
        seq: 0,
        bytes: vec![],
        sig: String::new(),
    });
    assert_eq!(lone.0.load(Ordering::SeqCst), 1);
}
