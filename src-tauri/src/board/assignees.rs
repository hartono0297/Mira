//! Who a task can be assigned to, and the names shown for public keys.
//!
//! `AssigneeDirectory` is the seam; `LocalMembers` reads the `members` and
//! `team_members` tables kept by the Tahap 1 membership fold.

use rusqlite::{Connection, OptionalExtension};

use super::access::{ProjectRef, Rights};
use super::model::Person;
use super::store::ProjectRow;
use crate::error::AppResult;
use crate::identity::{self, Identity};

pub trait AssigneeDirectory {
    /// People a task in `project` can be assigned to.
    fn assignable(&self, conn: &Connection, project: &ProjectRow) -> AppResult<Vec<Person>>;
    /// Display name for any public key, also for former members.
    fn name_of(&self, conn: &Connection, public_key: &str) -> String;

    fn person(&self, conn: &Connection, public_key: &str) -> Person {
        Person {
            public_key: public_key.to_owned(),
            name: self.name_of(conn, public_key),
        }
    }
}

/// Everyone who may write in the project (`access::Rights::writers`): the
/// team's non-guest members plus members of other teams invited to the
/// project; for a project without team, every active non-guest member. This
/// laptop comes first when it may write.
#[derive(Debug, Clone)]
pub struct LocalMembers {
    me: String,
    my_name: Option<String>,
}

impl LocalMembers {
    pub fn new(identity: &Identity) -> Self {
        Self {
            me: identity.public_key_hex().to_owned(),
            my_name: identity.display_name().map(str::to_owned),
        }
    }
}

impl AssigneeDirectory for LocalMembers {
    fn assignable(&self, conn: &Connection, project: &ProjectRow) -> AppResult<Vec<Person>> {
        let rights = Rights::load(conn)?;
        let writers = rights.writers(ProjectRef {
            id: &project.id,
            team_id: project.team_id.as_deref(),
            created_by: &project.created_by,
        });
        let mut people: Vec<Person> = writers
            .iter()
            .filter(|pk| **pk != self.me)
            .map(|pk| self.person(conn, pk))
            .collect();
        people.sort_by(|a, b| {
            (a.name.to_lowercase(), &a.public_key).cmp(&(b.name.to_lowercase(), &b.public_key))
        });
        if writers.contains(&self.me) {
            people.insert(0, self.person(conn, &self.me));
        }
        Ok(people)
    }

    fn name_of(&self, conn: &Connection, public_key: &str) -> String {
        let stored: Option<String> = conn
            .query_row(
                "SELECT display_name FROM members WHERE public_key = ?1 ORDER BY added_at LIMIT 1",
                [public_key],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
            .filter(|n: &String| !n.trim().is_empty());
        if let Some(name) = stored {
            return name;
        }
        if public_key == self.me {
            return self
                .my_name
                .clone()
                .unwrap_or_else(|| "Laptop ini".to_owned());
        }
        let short = identity::fingerprint(public_key);
        format!("Laptop {}", short.split(' ').next().unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::testutil::{Laptop, add_member, add_team};

    fn pk(n: u8) -> String {
        format!("{n:02x}").repeat(32)
    }

    fn project(team: Option<String>) -> ProjectRow {
        ProjectRow {
            id: "0".repeat(32),
            code: "PA".into(),
            name: "P".into(),
            team_id: team,
            created_by: pk(9),
            created_at: "t".into(),
            updated_at: "t".into(),
        }
    }

    fn keys(people: &[Person]) -> Vec<String> {
        people.iter().map(|p| p.name.clone()).collect()
    }

    #[test]
    fn self_first_then_active_members_by_name() {
        let l = Laptop::founder("Sari");
        add_member(&l.conn, &pk(1), "budi", "member");
        add_member(&l.conn, &pk(2), "Ani", "member");
        add_member(&l.conn, &pk(3), "Tamu", "guest");
        add_member(&l.conn, &pk(4), "Lama", "removed");
        let dir = LocalMembers::new(&l.id);
        let people = dir.assignable(&l.conn, &project(None)).unwrap();
        assert_eq!(keys(&people), ["Sari", "Ani", "budi"]);
        assert_eq!(people[0].public_key, l.pk());
    }

    #[test]
    fn team_project_restricts_to_team() {
        let l = Laptop::founder("Sari");
        add_member(&l.conn, &pk(1), "Budi", "member");
        add_member(&l.conn, &pk(2), "Ani", "member");
        let team = add_team(&l.conn, "Desain", &[(&pk(1), "member")]);
        let empty = add_team(&l.conn, "Kosong", &[]);
        let dir = LocalMembers::new(&l.id);
        assert_eq!(
            keys(&dir.assignable(&l.conn, &project(Some(team))).unwrap()),
            ["Budi"],
            "the superadmin outside the team is not offered"
        );
        assert!(
            dir.assignable(&l.conn, &project(Some(empty)))
                .unwrap()
                .is_empty(),
            "team without members has nobody to assign"
        );
    }

    #[test]
    fn names_fall_back() {
        let l = Laptop::bare("Sari");
        let dir = LocalMembers::new(&l.id);
        assert_eq!(dir.name_of(&l.conn, &l.pk()), "Sari", "identity name");
        let no_name = LocalMembers {
            me: l.pk(),
            my_name: None,
        };
        assert_eq!(no_name.name_of(&l.conn, &l.pk()), "Laptop ini");
        assert_eq!(dir.name_of(&l.conn, &"ab".repeat(32)), "Laptop ABAB");
        let f = Laptop::founder("Rina");
        add_member(&f.conn, &pk(1), "Budi", "removed");
        assert_eq!(LocalMembers::new(&f.id).name_of(&f.conn, &pk(1)), "Budi");
    }
}
