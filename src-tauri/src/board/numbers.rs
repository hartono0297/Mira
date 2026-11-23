//! Task numbers that collide after sync (docs/plans/sinkron-board.md,
//! "Konflik"). Project codes that collide are handled by
//! `store::refresh_codes`.
//!
//! Two laptops offline can both create `PA-12`. After merging, for each group
//! of live tasks with the same number (`sync::duplicate_numbers`) the first
//! task by `(created_at, id)` keeps the number. Every other task in the group
//! gets `max(next_number, highest number + 1)`, written by exactly one
//! laptop: the task's creator, or, when the creator may no longer write in
//! the project, the writer with the smallest public key. The renumbering is
//! one signed change with a `renumbered` activity entry (old code in
//! `detail`), so links and messages with the old code can be explained.
//!
//! When two laptops still renumber the same task concurrently (they disagree
//! about the membership), Automerge keeps one value on every laptop. When a
//! new number collides again, the same rule runs again on the next call.

use rusqlite::Connection;

use super::access::{ProjectRef, Rights};
use super::doc::{BoardDoc, Stamp};
use super::sign::SignedChange;
use super::store::{self, task_code};
use super::sync::duplicate_numbers;
use crate::clock;
use crate::error::AppResult;
use crate::identity::Identity;

/// After remote changes were applied to `project_id`: renumbers the
/// duplicate tasks this laptop is responsible for, as signed local changes
/// (already stored). The caller offers the returned changes to peers.
pub fn renumber_duplicates(
    conn: &mut Connection,
    identity: &Identity,
    project_id: &str,
) -> AppResult<Vec<SignedChange>> {
    let row = store::project(conn, project_id)?;
    let rights = Rights::load(conn)?;
    let me = identity.public_key_hex().to_owned();
    let project = ProjectRef {
        id: &row.id,
        team_id: row.team_id.as_deref(),
        created_by: &row.created_by,
    };
    let at = clock::now_rfc3339();
    let c = store::commit_local(conn, identity, project_id, |doc| {
        let ids = tasks_to_renumber(doc, &rights, project, &me)?;
        renumber(doc, &me, &at, &ids)
    })?;
    Ok(c.changes)
}

/// The duplicates `me` must renumber, in group order.
pub(crate) fn tasks_to_renumber(
    doc: &BoardDoc,
    rights: &Rights,
    project: ProjectRef<'_>,
    me: &str,
) -> AppResult<Vec<String>> {
    let fallback = rights.writers(project).into_iter().next();
    let mut out = Vec::new();
    for (_, ids) in duplicate_numbers(doc)? {
        for id in ids.into_iter().skip(1) {
            let Some(task) = doc.task(&id)? else { continue };
            let responsible = if rights.can_write(&task.created_by, project) {
                Some(task.created_by.as_str())
            } else {
                fallback.as_deref()
            };
            if responsible == Some(me) {
                out.push(id);
            }
        }
    }
    Ok(out)
}

/// Renumbers `ids` in one signed change, whoever is responsible, to force
/// two laptops to renumber the same task in tests.
#[cfg(test)]
pub(crate) fn renumber_tasks(
    conn: &mut Connection,
    identity: &Identity,
    project_id: &str,
    ids: &[String],
) -> AppResult<Vec<SignedChange>> {
    let me = identity.public_key_hex().to_owned();
    let at = clock::now_rfc3339();
    let c = store::commit_local(conn, identity, project_id, |doc| {
        renumber(doc, &me, &at, ids)
    })?;
    Ok(c.changes)
}

fn renumber(doc: &mut BoardDoc, me: &str, at: &str, ids: &[String]) -> AppResult<()> {
    // The code in the document, the same on every laptop (the code shown here
    // may be `PA2` when another project also uses `PA`).
    let code = doc.project().code;
    for id in ids {
        let Some(task) = doc.task(id)?.filter(|t| !t.deleted) else {
            continue;
        };
        let number = doc.fresh_number()?;
        doc.renumber_task(
            Stamp { actor: me, at },
            id,
            number,
            &task_code(&code, task.number),
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;
    use crate::board::doc::{TaskData, TaskInit, kind};
    use crate::board::policy::LocalRolePolicy;
    use crate::board::store::{actor_of, commit_local, create_project_local};
    use crate::board::sync::{self, ApplyReport};
    use crate::board::testutil::{Laptop, add_member, register_project};

    fn at(minute: u32) -> String {
        format!("2026-11-22T01:{minute:02}:00Z")
    }

    /// Creates a task whose `created_at` is `created_at`.
    fn add(l: &mut Laptop, project: &str, title: &str, created_at: &str) -> String {
        let me = l.pk();
        commit_local(&mut l.conn, &l.id, project, |d| {
            d.create_task(
                Stamp {
                    actor: &me,
                    at: created_at,
                },
                TaskInit {
                    title: title.into(),
                    ..Default::default()
                },
            )
        })
        .unwrap()
        .value
    }

    /// Sends `from` everything `to` lacks, as a transport would.
    fn send(from: &Laptop, to: &mut Laptop, project: &str) -> ApplyReport {
        let have = if store::project(&to.conn, project).is_ok() {
            sync::heads(&to.conn, project).unwrap()
        } else {
            Vec::new()
        };
        let changes = sync::changes_since(&from.conn, project, &have).unwrap();
        let from_pk = from.pk();
        sync::import_project(
            &mut to.conn,
            &LocalRolePolicy,
            project,
            Some(&from_pk),
            changes,
        )
        .unwrap()
    }

    /// Every laptop sends to every other laptop.
    fn exchange(ls: &mut [Laptop], project: &str) {
        for from in 0..ls.len() {
            for to in 0..ls.len() {
                if from == to {
                    continue;
                }
                let (src, dst) = if from < to {
                    let (l, r) = ls.split_at_mut(to);
                    (&l[from], &mut r[0])
                } else {
                    let (l, r) = ls.split_at_mut(from);
                    (&r[0], &mut l[to])
                };
                let r = send(src, dst, project);
                assert_eq!((r.rejected, r.held), (0, 0), "{r:?}");
            }
        }
    }

    fn live(l: &Laptop, project: &str) -> Vec<TaskData> {
        let mut ts = store::load_doc(&l.conn, project, &actor_of(&l.id))
            .unwrap()
            .tasks()
            .unwrap();
        ts.retain(|t| !t.deleted);
        ts.sort_by(|a, b| a.id.cmp(&b.id));
        ts
    }

    /// `(task id, number)` of live tasks, by id.
    fn numbers(l: &Laptop, project: &str) -> Vec<(String, i64)> {
        live(l, project)
            .into_iter()
            .map(|t| (t.id, t.number))
            .collect()
    }

    fn unique(n: &[(String, i64)]) -> bool {
        n.iter().map(|(_, x)| x).collect::<BTreeSet<_>>().len() == n.len()
    }

    /// `(task id, code)` from the task index, live tasks only.
    fn index_codes(l: &Laptop, project: &str) -> Vec<(String, String)> {
        store::index_rows(&l.conn, project)
            .unwrap()
            .into_iter()
            .filter(|r| !r.6)
            .map(|r| (r.0, r.1))
            .collect()
    }

    /// Every laptop renumbers, then all exchange; returns how many laptops
    /// wrote a change.
    fn round(ls: &mut [Laptop], project: &str) -> usize {
        let mut writers = 0;
        for l in ls.iter_mut() {
            if !renumber_duplicates(&mut l.conn, &l.id, project)
                .unwrap()
                .is_empty()
            {
                writers += 1;
            }
        }
        exchange(ls, project);
        writers
    }

    fn assert_converged(ls: &[Laptop], project: &str) {
        let first = numbers(&ls[0], project);
        assert!(unique(&first), "{first:?}");
        for l in &ls[1..] {
            assert_eq!(numbers(l, project), first);
            assert_eq!(index_codes(l, project), index_codes(&ls[0], project));
        }
    }

    /// Founder plus `names.len()` members; every laptop knows every other.
    fn office(names: &[&str]) -> Vec<Laptop> {
        let a = Laptop::founder("Sari");
        let mut ls = vec![];
        for n in names {
            ls.push(Laptop::joined(&a, n));
        }
        for i in 0..ls.len() {
            for j in 0..ls.len() {
                if i != j {
                    add_member(&ls[i].conn, &ls[j].pk(), names[j], "member");
                }
            }
        }
        ls.insert(0, a);
        ls
    }

    /// A project made by the founder with every laptop as a member,
    /// registered on every laptop (the fixtures write the membership tables
    /// directly, so no op is authored).
    fn project(ls: &mut [Laptop]) -> String {
        let a = &mut ls[0];
        let p = create_project_local(&mut a.conn, &a.id, "Alfa", "PA", None)
            .unwrap()
            .value
            .id;
        let creator = ls[0].pk();
        let everyone: Vec<String> = ls.iter().map(Laptop::pk).collect();
        let everyone: Vec<&str> = everyone.iter().map(String::as_str).collect();
        for l in ls.iter() {
            register_project(&l.conn, &p, None, &creator, &everyone);
        }
        exchange(ls, &p);
        p
    }

    #[test]
    fn two_offline_laptops_end_with_the_same_unique_numbers() {
        let mut ls = office(&["Budi"]);
        let p = project(&mut ls);
        // Offline: both laptops create PA-1 and PA-2; A's are older.
        let a1 = add(&mut ls[0], &p, "a1", &at(1));
        let a2 = add(&mut ls[0], &p, "a2", &at(2));
        let b1 = add(&mut ls[1], &p, "b1", &at(3));
        let b2 = add(&mut ls[1], &p, "b2", &at(4));
        exchange(&mut ls, &p);
        let n = numbers(&ls[0], &p);
        assert!(!unique(&n));

        // Only B, the creator of the younger tasks, writes.
        let (a, b) = ls.split_at_mut(1);
        assert!(
            renumber_duplicates(&mut a[0].conn, &a[0].id, &p)
                .unwrap()
                .is_empty()
        );
        let changes = renumber_duplicates(&mut b[0].conn, &b[0].id, &p).unwrap();
        assert_eq!(changes.len(), 1, "one signed change for both tasks");
        exchange(&mut ls, &p);
        assert_converged(&ls, &p);

        let by_id: std::collections::HashMap<String, i64> =
            numbers(&ls[0], &p).into_iter().collect();
        assert_eq!((by_id[&a1], by_id[&a2]), (1, 2));
        assert_eq!((by_id[&b1], by_id[&b2]), (3, 4));
        let codes: std::collections::HashMap<String, String> =
            index_codes(&ls[0], &p).into_iter().collect();
        assert_eq!(codes[&b1], "PA-3");
        assert_eq!(codes[&b2], "PA-4");
        let t = live(&ls[0], &p).into_iter().find(|t| t.id == b1).unwrap();
        let last = t.activity.last().unwrap();
        assert_eq!(last.kind, kind::RENUMBERED);
        assert_eq!(last.detail, "PA-1");
        assert_eq!(last.actor, ls[1].pk());
        // The next task on either laptop continues after the new numbers.
        let c = add(&mut ls[0], &p, "c", &at(5));
        let by_id: std::collections::HashMap<String, i64> =
            numbers(&ls[0], &p).into_iter().collect();
        assert_eq!(by_id[&c], 5);
        // Nothing left to do.
        assert_eq!(round(&mut ls, &p), 0);
    }

    #[test]
    fn three_laptops_with_a_group_of_three_converge() {
        let mut ls = office(&["Budi", "Cici"]);
        let p = project(&mut ls);
        for (i, l) in ls.iter_mut().enumerate() {
            add(l, &p, "satu", &at(i as u32 + 1));
        }
        exchange(&mut ls, &p);
        assert_eq!(
            numbers(&ls[0], &p).iter().filter(|(_, n)| *n == 1).count(),
            3
        );

        // B and C both pick 2 in the first round; the next round fixes it.
        let mut rounds = 0;
        while !unique(&numbers(&ls[0], &p)) {
            round(&mut ls, &p);
            rounds += 1;
            assert!(rounds <= 3, "did not converge");
        }
        assert_eq!(rounds, 2);
        assert_converged(&ls, &p);
        let mut got: Vec<i64> = numbers(&ls[0], &p).into_iter().map(|(_, n)| n).collect();
        got.sort();
        assert_eq!(got, [1, 2, 3]);
        assert_eq!(round(&mut ls, &p), 0);
    }

    #[test]
    fn removed_creator_is_replaced_by_the_smallest_writer() {
        let mut ls = office(&["Budi", "Cici"]);
        let p = project(&mut ls);
        add(&mut ls[0], &p, "a", &at(1));
        let b1 = add(&mut ls[1], &p, "b", &at(2));
        exchange(&mut ls, &p);
        let budi = ls[1].pk();
        for l in &ls {
            add_member(&l.conn, &budi, "Budi", "removed");
        }
        let smallest = ls[0].pk().min(ls[2].pk());
        let mut wrote = Vec::new();
        for l in ls.iter_mut() {
            if !renumber_duplicates(&mut l.conn, &l.id, &p)
                .unwrap()
                .is_empty()
            {
                wrote.push(l.pk());
            }
        }
        assert_eq!(wrote, std::slice::from_ref(&smallest));
        let (a, rest) = ls.split_at_mut(1);
        let c = &mut rest[1];
        let r = send(&a[0], c, &p);
        assert_eq!((r.rejected, r.held), (0, 0));
        send(c, &mut a[0], &p);
        let na = numbers(&a[0], &p);
        assert!(unique(&na));
        assert_eq!(na, numbers(c, &p));
        let t = live(&a[0], &p).into_iter().find(|t| t.id == b1).unwrap();
        assert_eq!(t.number, 2);
        assert_eq!(t.activity.last().unwrap().actor, smallest);
    }

    #[test]
    fn concurrent_renumbering_of_one_task_still_converges() {
        let mut ls = office(&["Budi"]);
        let p = project(&mut ls);
        add(&mut ls[0], &p, "a", &at(1));
        let b1 = add(&mut ls[1], &p, "b", &at(2));
        exchange(&mut ls, &p);

        // Both laptops renumber b1 offline, to different numbers: A to 2,
        // B (after creating another task, number 2) to 3.
        let (a, b) = ls.split_at_mut(1);
        let (a, b) = (&mut a[0], &mut b[0]);
        renumber_tasks(&mut a.conn, &a.id, &p, std::slice::from_ref(&b1)).unwrap();
        add(b, &p, "b2", &at(3));
        renumber_tasks(&mut b.conn, &b.id, &p, std::slice::from_ref(&b1)).unwrap();
        exchange(&mut ls, &p);
        // Automerge keeps one value for b1 on both laptops.
        let pick = |l: &Laptop| {
            numbers(l, &p)
                .into_iter()
                .find(|(id, _)| *id == b1)
                .unwrap()
                .1
        };
        let n = pick(&ls[0]);
        assert!(n == 2 || n == 3, "{n}");
        assert_eq!(pick(&ls[1]), n);
        let t = live(&ls[0], &p).into_iter().find(|t| t.id == b1).unwrap();
        let renumbered = t
            .activity
            .iter()
            .filter(|e| e.kind == kind::RENUMBERED)
            .count();
        assert_eq!(renumbered, 2, "both entries are kept");

        // When b1 landed on 2 it collides with b2 again; the rule fixes it.
        let mut rounds = 0;
        while !unique(&numbers(&ls[0], &p)) {
            round(&mut ls, &p);
            rounds += 1;
            assert!(rounds <= 3, "did not converge");
        }
        assert_converged(&ls, &p);
        assert_eq!(round(&mut ls, &p), 0);
    }
}
