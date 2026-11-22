//! Test laptops: each has its own data folder, key, database and `ChatSync`
//! with `RecordingHooks`. Organization, member, team, guest and project rows
//! are written directly on every laptop (chat only reads the derived tables).

use std::path::PathBuf;
use std::sync::Arc;

use rusqlite::{Connection, params};

use super::audience::BoardTeamAudience;
use super::hooks::RecordingHooks;
use super::sync::ChatSync;
use super::fetch::FetchJob;
use crate::identity::{self, MemoryKeyStore};
use crate::network::feature::{FeatureIngest, FeatureSync, testing};
use crate::org;
use crate::state::MiraState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Who {
    Superadmin,
    Member,
    Guest,
}

pub struct Laptop {
    tmp: tempfile::TempDir,
    pub state: MiraState,
    pub chat: ChatSync,
    pub hooks: Arc<RecordingHooks>,
    pub pk: String,
    pub name: String,
}

impl Laptop {
    fn new(name: &str) -> Laptop {
        let tmp = tempfile::tempdir().unwrap();
        let state = MiraState::new(Ok(tmp.path().to_path_buf()), Box::new(MemoryKeyStore::new()));
        let pk = state
            .with_core(|c| {
                identity::save_display_name(&mut c.db, &mut c.identity, name)?;
                Ok(c.identity.public_key_hex().to_owned())
            })
            .unwrap();
        let hooks = Arc::new(RecordingHooks::default());
        let chat = ChatSync::new(state.clone(), Arc::new(BoardTeamAudience), hooks.clone()).unwrap();
        Laptop {
            tmp,
            state,
            chat,
            hooks,
            pk,
            name: name.to_owned(),
        }
    }

    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> T) -> T {
        self.state.with_core(|c| Ok(f(&c.db))).unwrap()
    }

    pub fn data_dir(&self) -> PathBuf {
        self.tmp.path().to_path_buf()
    }

    pub fn sync(&self) -> (&str, &dyn FeatureSync) {
        (self.pk.as_str(), &self.chat as &dyn FeatureSync)
    }

    pub fn chat_ingest(&self, from: &str, records: Vec<crate::network::feature::FeatureRecord>) -> FeatureIngest {
        self.chat.ingest(from, records).unwrap()
    }

    pub fn count(&self, sql: &str) -> i64 {
        self.with_conn(|c| c.query_row(sql, [], |r| r.get(0)).unwrap())
    }

    pub fn rejected_codes(&self) -> Vec<String> {
        self.with_conn(|c| {
            let mut stmt = c.prepare("SELECT code FROM rejected_changes ORDER BY id").unwrap();
            stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
        })
    }
}

pub struct Office {
    pub org_id: String,
    pub l: Vec<Laptop>,
}

impl Office {
    /// The first person founds the organization; everyone knows everyone.
    pub fn new(people: &[(&str, Who)]) -> Office {
        let l: Vec<Laptop> = people.iter().map(|(n, _)| Laptop::new(n)).collect();
        let founder = &l[0];
        let org = founder
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

    pub fn each(&self, f: impl Fn(&Connection)) {
        for laptop in &self.l {
            laptop.with_conn(&f);
        }
    }

    pub fn set_member(&self, pk: &str, name: &str, who: Who) {
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

    /// Marks `pk` removed at `at` on every laptop (team rows dropped, like the fold).
    pub fn remove_member(&self, pk: &str, at: &str) {
        self.each(|c| {
            c.execute(
                "UPDATE members SET status = 'removed', is_superadmin = 0, removed_at = ?2 WHERE public_key = ?1",
                params![pk, at],
            )
            .unwrap();
            c.execute("DELETE FROM team_members WHERE public_key = ?1", [pk]).unwrap();
            c.execute("DELETE FROM guest_access WHERE public_key = ?1", [pk]).unwrap();
        });
    }

    /// Team with `(public key, is admin)` members, plus its channel in the
    /// membership `channels` table. Returns `(team id, channel conv)`.
    pub fn add_team(&self, name: &str, members: &[(&str, bool)]) -> (String, String) {
        let id = super::model::random_hex32();
        let channel = super::model::random_hex32();
        self.each(|c| {
            c.execute(
                "INSERT INTO teams (id, name, created_at, created_by) VALUES (?1, ?2, 't', 'x')",
                params![id, name],
            )
            .unwrap();
            for (pk, admin) in members {
                c.execute(
                    "INSERT INTO team_members (team_id, public_key, role, added_at) VALUES (?1, ?2, ?3, 't')",
                    params![id, pk, if *admin { "admin" } else { "member" }],
                )
                .unwrap();
            }
            c.execute(
                "INSERT INTO channels (id, team_id, name, created_at) VALUES (?1, ?2, ?3, 't')",
                params![channel, id, name.to_lowercase().replace(' ', "-")],
            )
            .unwrap();
        });
        (id, super::model::channel_conv(&channel))
    }

    /// Board project row; returns its id (its channel is `ch:<id>`).
    pub fn add_project(&self, name: &str, team: Option<&str>, creator: &str) -> String {
        let id = super::model::random_hex32();
        let code = format!("P{}", &id[..6]);
        self.each(|c| {
            c.execute(
                "INSERT INTO board_projects (id, code, name, team_id, created_by, created_at, doc, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 't', x'', 't')",
                params![id, code, name, team, creator],
            )
            .unwrap();
        });
        id
    }

    pub fn grant_guest(&self, guest: &str, team: &str, project: &str) {
        self.each(|c| {
            c.execute(
                "INSERT INTO guest_access (public_key, team_id, project_id) VALUES (?1, ?2, ?3)",
                params![guest, team, project],
            )
            .unwrap();
        });
    }

    pub fn umum(&self) -> String {
        super::model::channel_conv(&crate::permissions::umum_channel_id(&self.org_id))
    }
}

pub fn pull(from: &Laptop, to: &Laptop) -> FeatureIngest {
    testing::pull(from.sync(), to.sync()).unwrap().0
}

pub fn sync(laptops: &[&Laptop]) {
    let list: Vec<(&str, &dyn FeatureSync)> = laptops.iter().map(|l| l.sync()).collect();
    testing::sync_all(&list).unwrap();
}

/// Runs `to`'s download queue against `sources`, the way the fetcher loop
/// would. Returns how many downloads finished.
pub fn run_fetches(to: &Laptop, sources: &[&Laptop]) -> usize {
    let mut done = 0;
    let jobs: Vec<FetchJob> = to.chat.fetch_jobs().unwrap();
    for (i, job) in jobs.iter().enumerate() {
        let dest = to.data_dir().join(format!("download-{i}.tmp"));
        let got = sources
            .iter()
            .find(|s| testing::copy_blob(&s.chat, &to.pk, &job.hash, job.size, &dest).is_ok());
        if got.is_some() {
            to.chat.fetch_done(job, &dest).unwrap();
            done += 1;
        } else {
            to.chat.fetch_failed(job, "tidak ada laptop yang punya").unwrap();
        }
    }
    done
}

/// Every file under a folder, read whole (to look for leaked plaintext).
pub fn all_bytes_under(dir: &std::path::Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d).unwrap().flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(bytes) = std::fs::read(&p) {
                out.push((p, bytes));
            }
        }
    }
    out
}
