//! Tests only: several "laptops" (each its own data folder, database, key and
//! `MiraState`) in one organization, with the membership log synced between
//! them the way the network does it. Used by the document and signing sync
//! tests together with `network::feature::testing`.
//!
//! `Lab::new(&["Sari", "Budi", "Citra"])`: laptop 0 founds "CV Maju Jaya"
//! (superadmin) and creates team "Tim Proyek"; the others join it through an
//! invite code as team members. `add_guest`, `add_member_elsewhere` and
//! `remove` change the membership and sync it to every laptop still active.

use std::path::Path;

use time::OffsetDateTime;

use crate::blobs::BlobStore;
use crate::identity::{self, MemoryKeyStore};
use crate::org;
use crate::permissions::{self as p, InviteRole, Validity};
use crate::state::{Core, MiraState};

pub struct Laptop {
    pub tmp: tempfile::TempDir,
    pub state: MiraState,
    pub pk: String,
    pub name: String,
}

impl Laptop {
    pub fn new(name: &str) -> Laptop {
        let tmp = tempfile::tempdir().unwrap();
        let state = MiraState::new(
            Ok(tmp.path().to_path_buf()),
            Box::new(MemoryKeyStore::new()),
        );
        let pk = state
            .with_core(|core| {
                identity::save_display_name(&mut core.db, &mut core.identity, name)?;
                Ok(core.identity.public_key_hex().to_owned())
            })
            .unwrap();
        Laptop {
            tmp,
            state,
            pk,
            name: name.to_owned(),
        }
    }

    pub fn data_dir(&self) -> &Path {
        self.tmp.path()
    }

    pub fn blobs(&self) -> BlobStore {
        BlobStore::in_data_dir(self.data_dir()).unwrap()
    }

    /// Runs `f` with this laptop's core; panics on error.
    pub fn with<T>(&self, f: impl FnOnce(&mut Core) -> T) -> T {
        self.state.with_core(|core| Ok(f(core))).unwrap()
    }

    pub fn org_state(&self) -> p::OrgState {
        self.with(|c| p::load_state(&c.db).unwrap().unwrap())
    }
}

pub struct Lab {
    pub laptops: Vec<Laptop>,
    /// "Tim Proyek", which every laptop made by `new` joins.
    pub team: String,
}

fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

impl Lab {
    pub fn new(names: &[&str]) -> Lab {
        assert!(!names.is_empty());
        let founder = Laptop::new(names[0]);
        let team = founder.with(|c| {
            org::create_organization(&mut c.db, &c.identity, "CV Maju Jaya").unwrap();
            p::create_team(&mut c.db, &c.identity, "Tim Proyek", now())
                .unwrap()
                .id
        });
        let mut lab = Lab {
            laptops: vec![founder],
            team,
        };
        for name in &names[1..] {
            let team = lab.team.clone();
            lab.join(name, &team, InviteRole::Member, Vec::new());
        }
        lab
    }

    pub fn pk(&self, i: usize) -> String {
        self.laptops[i].pk.clone()
    }

    /// A new laptop joins through an invite made by laptop 0. Returns its index.
    pub fn join(
        &mut self,
        name: &str,
        team: &str,
        role: InviteRole,
        projects: Vec<String>,
    ) -> usize {
        let joiner = Laptop::new(name);
        let code = self.laptops[0].with(|c| {
            p::create_invite(
                &mut c.db,
                &c.identity,
                team,
                role,
                projects,
                Validity::H24,
                now(),
            )
            .unwrap()
            .1
        });
        let code = p::normalize_code(&code).unwrap();
        let host = &self.laptops[0];
        let (org_id, invite) = host
            .with(|c| p::join_lookup(&c.db, code.tag(), now()))
            .map_err(|e| e.to_app_error())
            .unwrap();
        let proof =
            joiner.with(|c| p::build_join_proof(&code, &org_id, &invite, &c.identity).unwrap());
        let accepted = host
            .with(|c| p::join_accept(&mut c.db, &c.identity, &joiner.pk, &invite, &proof, now()))
            .map_err(|e| e.to_app_error())
            .unwrap();
        joiner.with(|c| {
            p::install_joined_org(
                &mut c.db,
                &c.identity,
                accepted.org,
                accepted.ops,
                &code,
                now(),
            )
            .unwrap()
        });
        self.laptops.push(joiner);
        self.sync_membership();
        self.laptops.len() - 1
    }

    /// A guest of `self.team` for the given project ids (32 hex each).
    pub fn add_guest(&mut self, name: &str, projects: &[&str]) -> usize {
        let team = self.team.clone();
        let projects = projects.iter().map(|s| s.to_string()).collect();
        self.join(name, &team, InviteRole::Guest, projects)
    }

    /// A member of a second team "Tim Lain", not of `self.team`.
    pub fn add_member_elsewhere(&mut self, name: &str) -> usize {
        let other = self.laptops[0].with(|c| {
            p::create_team(&mut c.db, &c.identity, "Tim Lain", now())
                .unwrap()
                .id
        });
        self.join(name, &other, InviteRole::Member, Vec::new())
    }

    /// Laptop 0 removes laptop `who` from the organization.
    pub fn remove(&mut self, who: usize) {
        let pk = self.pk(who);
        self.laptops[0].with(|c| p::remove_member(&mut c.db, &c.identity, &pk, now()).unwrap());
        self.sync_membership();
    }

    /// Membership ops between every pair until nothing new arrives.
    pub fn sync_membership(&self) {
        for _ in 0..=self.laptops.len() + 1 {
            let mut new = 0;
            for a in &self.laptops {
                for b in &self.laptops {
                    if a.pk == b.pk {
                        continue;
                    }
                    let ops = a.with(|c| {
                        let state = p::load_state(&c.db).unwrap().unwrap();
                        let ids = p::op_ids_for(&c.db, &state, &b.pk).unwrap();
                        let missing = b.with(|cb| p::missing_op_ids(&cb.db, &ids).unwrap());
                        p::ops_for(&c.db, &state, &b.pk, &missing).unwrap()
                    });
                    if ops.is_empty() {
                        continue;
                    }
                    new += b.with(|c| {
                        p::ingest(&mut c.db, Some(&a.pk), ops, now())
                            .unwrap()
                            .new_ops
                    });
                }
            }
            if new == 0 {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::documents::scope::{InviteGuestProjects, may_view, may_write};
    use crate::documents::store::DocScope;

    #[test]
    fn lab_builds_one_org_with_guest_and_removal() {
        let project = "ab".repeat(16);
        let mut lab = Lab::new(&["Sari", "Budi", "Citra"]);
        let guest = lab.add_guest("Tamu", &[&project]);
        let outsider = lab.add_member_elsewhere("Dewi");
        for l in &lab.laptops {
            let s = l.org_state();
            assert_eq!(s.members.len(), 5, "{} sees everyone", l.name);
        }
        let s = lab.laptops[1].org_state();
        let team_scope = DocScope {
            team_id: Some(lab.team.clone()),
            project_id: None,
        };
        let project_scope = DocScope {
            team_id: Some(lab.team.clone()),
            project_id: Some(project.clone()),
        };
        let other_project = DocScope {
            team_id: Some(lab.team.clone()),
            project_id: Some("cd".repeat(16)),
        };
        let general = DocScope::default();
        lab.laptops[1].with(|c| {
            let g = InviteGuestProjects;
            let db = &c.db;
            assert!(may_view(db, &s, &g, &lab.pk(2), &team_scope).unwrap());
            assert!(!may_view(db, &s, &g, &lab.pk(outsider), &team_scope).unwrap());
            assert!(
                may_view(db, &s, &g, &lab.pk(0), &team_scope).unwrap(),
                "superadmin"
            );
            assert!(may_view(db, &s, &g, &lab.pk(outsider), &general).unwrap());
            assert!(!may_view(db, &s, &g, &lab.pk(guest), &general).unwrap());
            assert!(!may_view(db, &s, &g, &lab.pk(guest), &team_scope).unwrap());
            assert!(may_view(db, &s, &g, &lab.pk(guest), &project_scope).unwrap());
            assert!(!may_view(db, &s, &g, &lab.pk(guest), &other_project).unwrap());
            assert!(!may_write(db, &s, &g, &lab.pk(guest), &project_scope).unwrap());
            assert!(may_write(db, &s, &g, &lab.pk(2), &project_scope).unwrap());
        });

        lab.remove(2);
        let s = lab.laptops[1].org_state();
        assert!(!s.is_active(&lab.pk(2)));
        lab.laptops[1].with(|c| {
            assert!(!may_view(&c.db, &s, &InviteGuestProjects, &lab.pk(2), &general).unwrap());
        });
    }
}
