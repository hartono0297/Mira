//! The calendar: live tasks with a due date in a date range, from every
//! project the viewer may view. See docs/plans/sidebar-kalender.md (2.1).
//!
//! The task index (`board_task_index`) picks the projects and tasks without
//! opening every document; each project with a match is then opened once to
//! build the cards with `Ctx::card`, as "Task saya" does.

use rusqlite::{Connection, params};
use tauri::State;
use time::Date;
use time::macros::format_description;

use super::assignees::LocalMembers;
use super::model::{MyTask, validate_due};
use super::policy::{BoardAction, LocalRolePolicy};
use super::store;
use super::view::Ctx;
use crate::error::{AppError, AppResult};
use crate::state::MiraState;

/// Longest range (in days, both ends counted) one request may ask for.
pub const MAX_RANGE_DAYS: i64 = 400;

/// Live tasks with a due date in [from, to] (inclusive, YYYY-MM-DD; None = unbounded)
/// from every project the viewer may view, sorted by (due, project code, number).
pub fn calendar(state: &MiraState, from: Option<&str>, to: Option<&str>) -> AppResult<Vec<MyTask>> {
    let (from, to) = check_range(from, to)?;
    state.with_core(|core| {
        let dir = LocalMembers::new(&core.identity);
        let ctx = Ctx {
            conn: &core.db,
            me: core.identity.public_key_hex(),
            policy: &LocalRolePolicy,
            dir: &dir,
        };
        tasks_in(
            &ctx,
            &store::actor_of(&core.identity),
            from.as_deref(),
            to.as_deref(),
        )
    })
}

#[tauri::command]
pub async fn board_calendar(
    state: State<'_, MiraState>,
    from: Option<String>,
    to: Option<String>,
) -> AppResult<Vec<MyTask>> {
    calendar(&state, from.as_deref(), to.as_deref())
}

/// Validates both ends; returns them trimmed.
fn check_range(
    from: Option<&str>,
    to: Option<&str>,
) -> AppResult<(Option<String>, Option<String>)> {
    let date = |s: Option<&str>, which: &str| -> AppResult<Option<String>> {
        s.map(|s| {
            validate_due(s).map_err(|_| {
                AppError::InvalidInput(format!(
                    "Tanggal {which} kalender tidak valid. Formatnya TTTT-BB-HH, misalnya 2026-11-28."
                ))
            })
        })
        .transpose()
    };
    let from = date(from, "awal")?;
    let to = date(to, "akhir")?;
    if let (Some(f), Some(t)) = (&from, &to) {
        if f > t {
            return Err(AppError::InvalidInput(
                "Tanggal awal kalender harus sama dengan atau sebelum tanggal akhir.".into(),
            ));
        }
        let fmt = format_description!("[year]-[month]-[day]");
        let (Ok(fd), Ok(td)) = (Date::parse(f, fmt), Date::parse(t, fmt)) else {
            return Err(AppError::InvalidInput("Tanggal kalender tidak valid.".into()));
        };
        if (td - fd).whole_days() + 1 > MAX_RANGE_DAYS {
            return Err(AppError::InvalidInput(format!(
                "Rentang kalender paling panjang {MAX_RANGE_DAYS} hari. Pilih rentang yang lebih pendek."
            )));
        }
    }
    Ok((from, to))
}

/// `(project_id, task_id)` of the live tasks due in [from, to], by project.
/// Dates are fixed-width YYYY-MM-DD, so string order is date order.
fn due_in(
    conn: &Connection,
    from: Option<&str>,
    to: Option<&str>,
) -> AppResult<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT project_id, task_id FROM board_task_index
         WHERE due IS NOT NULL AND deleted = 0
           AND (?1 IS NULL OR due >= ?1) AND (?2 IS NULL OR due <= ?2)
         ORDER BY project_id, task_id",
    )?;
    let rows = stmt
        .query_map(params![from, to], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// The calendar for the viewer of `ctx`; `from` and `to` already validated.
fn tasks_in(
    ctx: &Ctx<'_>,
    actor: &[u8],
    from: Option<&str>,
    to: Option<&str>,
) -> AppResult<Vec<MyTask>> {
    let refs = due_in(ctx.conn, from, to)?;
    let allows = |action: BoardAction| ctx.policy.allows(ctx.conn, ctx.me, &action);
    let mut out: Vec<(MyTask, i64)> = Vec::new();
    let mut i = 0;
    while i < refs.len() {
        let project_id = refs[i].0.clone();
        let ids: Vec<&str> = refs[i..]
            .iter()
            .take_while(|r| r.0 == project_id)
            .map(|r| r.1.as_str())
            .collect();
        i += ids.len();
        if !ctx.can_view(&project_id) {
            continue;
        }
        let project = store::project(ctx.conn, &project_id)?;
        let doc = store::load_doc(ctx.conn, &project_id, actor)?;
        // The same rights as the board's cards (`CardRights` in view.rs):
        // `CreateTask` is the `EditTask` check, and `DeleteTask` is
        // `can_write && (creator || ManageProject)`.
        let can_write = allows(BoardAction::CreateTask {
            project_id: project.id.clone(),
        });
        let can_manage = allows(BoardAction::ManageProject {
            project_id: project.id.clone(),
        });
        for t in doc.tasks()? {
            if t.deleted || !ids.contains(&t.id.as_str()) {
                continue;
            }
            // The index and the document are written in one transaction;
            // the document is checked again all the same.
            let Some(due) = t.due.as_deref() else { continue };
            if from.is_some_and(|f| due < f) || to.is_some_and(|e| due > e) {
                continue;
            }
            let can_delete = can_write && (t.created_by == ctx.me || can_manage);
            out.push((
                MyTask {
                    project_id: project.id.clone(),
                    project_code: project.code.clone(),
                    project_name: project.name.clone(),
                    task: ctx.card(&project, &t, can_write, can_delete),
                },
                t.number,
            ));
        }
    }
    out.sort_by(|(a, an), (b, bn)| {
        (&a.task.due, &a.project_code, an).cmp(&(&b.task.due, &b.project_code, bn))
    });
    Ok(out.into_iter().map(|(t, _)| t).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::doc::{Stamp, TaskChanges, TaskInit};
    use crate::board::model::Priority;
    use crate::board::store::ProjectRow;
    use crate::board::testutil::{Laptop, add_member, register_project};
    use crate::clock;

    /// Sari (founder) with member Budi, member Citra and guest Tamu.
    /// WEB: Sari, Budi, Tamu. INT: Sari, Citra.
    struct Office {
        l: Laptop,
        sari: String,
        budi: String,
        citra: String,
        guest: String,
        web: ProjectRow,
        int: ProjectRow,
    }

    fn office() -> Office {
        let mut l = Laptop::founder("Sari");
        let sari = l.pk();
        let pk = |n: u8| format!("{n:02x}").repeat(32);
        let (budi, citra, guest) = (pk(2), pk(3), pk(4));
        add_member(&l.conn, &budi, "Budi", "member");
        add_member(&l.conn, &citra, "Citra", "member");
        add_member(&l.conn, &guest, "Tamu", "guest");
        let web = store::create_project_local(&mut l.conn, &l.id, "Situs Web", "WEB", None)
            .unwrap()
            .value;
        register_project(&l.conn, &web.id, None, &sari, &[&sari, &budi, &guest]);
        let int = store::create_project_local(&mut l.conn, &l.id, "Internal", "INT", None)
            .unwrap()
            .value;
        register_project(&l.conn, &int.id, None, &sari, &[&sari, &citra]);
        Office {
            l,
            sari,
            budi,
            citra,
            guest,
            web,
            int,
        }
    }

    impl Office {
        fn add(&mut self, project: &ProjectRow, title: &str, due: Option<&str>) -> String {
            let at = clock::now_rfc3339();
            let stamp = Stamp {
                actor: &self.sari,
                at: &at,
            };
            let init = TaskInit {
                title: title.into(),
                description: String::new(),
                column: None,
                assignee: None,
                due: due.map(str::to_owned),
                priority: Priority::None,
                labels: Vec::new(),
            };
            store::commit_local(&mut self.l.conn, &self.l.id, &project.id, |d| {
                d.create_task(stamp, init)
            })
            .unwrap()
            .value
        }

        fn edit(&mut self, project: &ProjectRow, task: &str, changes: TaskChanges) {
            let at = clock::now_rfc3339();
            let stamp = Stamp {
                actor: &self.sari,
                at: &at,
            };
            store::commit_local(&mut self.l.conn, &self.l.id, &project.id, |d| {
                d.update_task(stamp, task, &changes, &|pk: &str| pk.to_owned())
            })
            .unwrap();
        }

        fn delete(&mut self, project: &ProjectRow, task: &str) {
            let at = clock::now_rfc3339();
            let stamp = Stamp {
                actor: &self.sari,
                at: &at,
            };
            store::commit_local(&mut self.l.conn, &self.l.id, &project.id, |d| {
                d.delete_task(stamp, task)
            })
            .unwrap();
        }

        fn view(&self, me: &str, from: Option<&str>, to: Option<&str>) -> Vec<MyTask> {
            let dir = LocalMembers::new(&self.l.id);
            let ctx = Ctx {
                conn: &self.l.conn,
                me,
                policy: &LocalRolePolicy,
                dir: &dir,
            };
            let (from, to) = check_range(from, to).unwrap();
            tasks_in(
                &ctx,
                &store::actor_of(&self.l.id),
                from.as_deref(),
                to.as_deref(),
            )
            .unwrap()
        }

        fn codes(&self, me: &str, from: Option<&str>, to: Option<&str>) -> Vec<String> {
            self.view(me, from, to)
                .into_iter()
                .map(|t| t.task.code)
                .collect()
        }
    }

    #[test]
    fn range_is_inclusive_on_both_ends() {
        let mut o = office();
        let web = o.web.clone();
        o.add(&web, "Sebelum", Some("2026-11-09"));
        o.add(&web, "Awal", Some("2026-11-10"));
        o.add(&web, "Tengah", Some("2026-11-15"));
        o.add(&web, "Akhir", Some("2026-11-20"));
        o.add(&web, "Sesudah", Some("2026-11-21"));
        let sari = o.sari.clone();
        assert_eq!(
            o.codes(&sari, Some("2026-11-10"), Some("2026-11-20")),
            ["WEB-2", "WEB-3", "WEB-4"]
        );
        assert_eq!(
            o.codes(&sari, Some("2026-11-15"), Some("2026-11-15")),
            ["WEB-3"]
        );
    }

    #[test]
    fn tasks_without_due_and_deleted_tasks_are_left_out() {
        let mut o = office();
        let web = o.web.clone();
        o.add(&web, "Tanpa tenggat", None);
        o.add(&web, "Ada tenggat", Some("2026-11-12"));
        let gone = o.add(&web, "Dihapus", Some("2026-11-12"));
        o.delete(&web, &gone);
        let sari = o.sari.clone();
        assert_eq!(o.codes(&sari, None, None), ["WEB-2"]);
    }

    #[test]
    fn open_ends_are_unbounded() {
        let mut o = office();
        let web = o.web.clone();
        o.add(&web, "Lama", Some("2020-01-01"));
        o.add(&web, "Sekarang", Some("2026-11-24"));
        o.add(&web, "Nanti", Some("2030-12-31"));
        let sari = o.sari.clone();
        assert_eq!(o.codes(&sari, None, None), ["WEB-1", "WEB-2", "WEB-3"]);
        assert_eq!(o.codes(&sari, None, Some("2026-11-24")), ["WEB-1", "WEB-2"]);
        assert_eq!(o.codes(&sari, Some("2026-11-24"), None), ["WEB-2", "WEB-3"]);
    }

    #[test]
    fn sorted_by_due_then_project_code_then_number() {
        let mut o = office();
        let (web, int) = (o.web.clone(), o.int.clone());
        o.add(&web, "a", Some("2026-11-12")); // WEB-1
        o.add(&web, "b", Some("2026-11-11")); // WEB-2
        o.add(&int, "c", Some("2026-11-12")); // INT-1
        o.add(&web, "d", Some("2026-11-12")); // WEB-3
        o.add(&int, "e", Some("2026-11-11")); // INT-2
        o.add(&int, "f", Some("2026-11-10")); // INT-3
        let sari = o.sari.clone();
        assert_eq!(
            o.codes(&sari, Some("2026-11-01"), Some("2026-11-30")),
            ["INT-3", "INT-2", "WEB-2", "INT-1", "WEB-1", "WEB-3"]
        );
        let all = o.view(&sari, None, None);
        let json = serde_json::to_value(&all[0]).unwrap();
        assert_eq!(json["projectId"], int.id);
        assert_eq!(json["projectCode"], "INT");
        assert_eq!(json["projectName"], "Internal");
        assert_eq!(json["task"]["code"], "INT-3");
        assert_eq!(json["task"]["due"], "2026-11-10");
        assert_eq!(json["task"]["canEdit"], true);
        assert_eq!(json["task"]["canDelete"], true);
    }

    #[test]
    fn projects_the_viewer_does_not_belong_to_are_left_out() {
        let mut o = office();
        let (web, int) = (o.web.clone(), o.int.clone());
        o.add(&web, "Situs", Some("2026-11-12"));
        o.add(&int, "Rapat", Some("2026-11-12"));
        let (budi, citra) = (o.budi.clone(), o.citra.clone());
        assert_eq!(o.codes(&budi, None, None), ["WEB-1"]);
        assert_eq!(o.codes(&citra, None, None), ["INT-1"]);
        assert!(o.codes(&"0e".repeat(32), None, None).is_empty(), "stranger");
    }

    #[test]
    fn a_guest_sees_only_the_invited_project_and_cannot_edit() {
        let mut o = office();
        let (web, int) = (o.web.clone(), o.int.clone());
        o.add(&web, "Situs", Some("2026-11-12"));
        o.add(&int, "Rapat", Some("2026-11-12"));
        let guest = o.guest.clone();
        let seen = o.view(&guest, None, None);
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].task.code, "WEB-1");
        assert!(!seen[0].task.can_edit);
        assert!(!seen[0].task.can_delete);
    }

    #[test]
    fn a_member_with_write_rights_can_edit() {
        let mut o = office();
        let web = o.web.clone();
        o.add(&web, "Situs", Some("2026-11-12"));
        let budi = o.budi.clone();
        let seen = o.view(&budi, None, None);
        assert_eq!(seen.len(), 1);
        assert!(seen[0].task.can_edit);
        assert!(!seen[0].task.can_delete, "not the creator nor a manager");
    }

    #[test]
    fn a_changed_due_date_moves_the_task() {
        let mut o = office();
        let web = o.web.clone();
        let id = o.add(&web, "Situs", Some("2026-11-12"));
        let sari = o.sari.clone();
        let nov = (Some("2026-11-01"), Some("2026-11-30"));
        let dec = (Some("2026-12-01"), Some("2026-12-31"));
        assert_eq!(o.codes(&sari, nov.0, nov.1), ["WEB-1"]);
        o.edit(
            &web,
            &id,
            TaskChanges {
                due: Some(Some("2026-12-05".into())),
                ..Default::default()
            },
        );
        assert!(o.codes(&sari, nov.0, nov.1).is_empty());
        let moved = o.view(&sari, dec.0, dec.1);
        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].task.due.as_deref(), Some("2026-12-05"));
        o.edit(
            &web,
            &id,
            TaskChanges {
                due: Some(None),
                ..Default::default()
            },
        );
        assert!(o.codes(&sari, None, None).is_empty(), "due cleared");
    }

    #[test]
    fn bad_ranges_are_refused() {
        for (from, to) in [
            (Some("2026-02-30"), None),
            (None, Some("26-11-01")),
            (Some("kemarin"), Some("2026-11-01")),
            (Some(""), None),
            (Some("2026-11-02"), Some("2026-11-01")),
            // 401 days, both ends counted.
            (Some("2026-01-01"), Some("2027-02-05")),
            (Some("2020-01-01"), Some("2030-01-01")),
        ] {
            let err = check_range(from, to).unwrap_err();
            assert_eq!(err.code(), "invalid_input", "{from:?} {to:?}");
            let msg = err.to_string();
            assert!(!msg.contains('\u{2014}'), "no em dash: {msg}");
        }
        // Exactly 400 days, one day, open ends and surrounding spaces are fine.
        for (from, to) in [
            (Some("2026-01-01"), Some("2027-02-04")),
            (Some("2026-11-24"), Some("2026-11-24")),
            (None, None),
            (Some("2000-01-01"), None),
            (None, Some("2099-12-31")),
        ] {
            check_range(from, to).unwrap_or_else(|e| panic!("{from:?} {to:?}: {e}"));
        }
        assert_eq!(
            check_range(Some(" 2026-11-01 "), None).unwrap().0.as_deref(),
            Some("2026-11-01")
        );
    }

    #[test]
    fn the_command_reads_the_local_laptop() {
        let tmp = tempfile::tempdir().unwrap();
        let state = MiraState::new(
            Ok(tmp.path().to_path_buf()),
            Box::new(crate::identity::MemoryKeyStore::new()),
        );
        crate::commands::display_name(&state, "Sari").unwrap();
        crate::commands::organization(&state, "CV Maju Jaya").unwrap();
        assert!(calendar(&state, None, None).unwrap().is_empty());
        assert_eq!(
            calendar(&state, Some("2026-11-02"), Some("2026-11-01"))
                .unwrap_err()
                .code(),
            "invalid_input"
        );
    }
}
