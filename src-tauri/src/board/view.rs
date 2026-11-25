//! Builds the frontend types (`model.rs`) from stored rows and document data.

use rusqlite::{Connection, OptionalExtension};

use super::assignees::AssigneeDirectory;
use super::doc::{BoardDoc, TaskData};
use super::model::{
    Activity, BoardView, Column, ColumnId, Comment, MyTask, ProjectSummary, Subtask, TaskCard,
    TaskDetail, TimeEntry, TimeTotal,
};
use super::policy::{BoardAction, BoardPolicy};
use super::store::{self, ProjectRow, task_code};
use super::timing;
use crate::clock;
use crate::error::AppResult;

/// The viewer's project rights a card needs.
///
/// `can_write` is the `CreateTask` right (the same check as `EditTask`, so
/// it is also the card's `can_edit`) and `can_manage` the
/// `ManageProject` right. Both deny guests and require `Rights::can_write`,
/// and `ManageProject` adds `is_project_manager`, so `can_delete` gives the
/// same answer as `Rights::can_delete_task` (the `DeleteTask` right):
/// `can_write && (created_by == me || is_project_manager)`.
#[derive(Debug, Clone, Copy)]
struct CardRights {
    can_write: bool,
    can_manage: bool,
}

impl CardRights {
    fn can_delete(self, me: &str, t: &TaskData) -> bool {
        self.can_write && (t.created_by == me || self.can_manage)
    }
}

/// What every view needs: the database, the viewer and the two seams.
pub struct Ctx<'a> {
    pub conn: &'a Connection,
    /// Viewer public key (64 hex).
    pub me: &'a str,
    pub policy: &'a dyn BoardPolicy,
    pub dir: &'a dyn AssigneeDirectory,
}

impl Ctx<'_> {
    fn allows(&self, action: BoardAction) -> bool {
        self.policy.allows(self.conn, self.me, &action)
    }

    pub fn summary(&self, row: &ProjectRow) -> AppResult<ProjectSummary> {
        let (open, total) = store::counts(self.conn, &row.id)?;
        let (division_id, division_name) = self.division_of(&row.id)?;
        Ok(ProjectSummary {
            id: row.id.clone(),
            code: row.code.clone(),
            name: row.name.clone(),
            team_id: row.team_id.clone(),
            team_name: match &row.team_id {
                Some(t) => self
                    .conn
                    .query_row("SELECT name FROM teams WHERE id = ?1", [t], |r| r.get(0))
                    .ok(),
                None => None,
            },
            open_count: open,
            task_count: total,
            can_manage: self.allows(BoardAction::ManageProject {
                project_id: row.id.clone(),
            }),
            division_id,
            division_name,
        })
    }

    /// Division id and name of a registered division project.
    fn division_of(&self, project_id: &str) -> AppResult<(Option<String>, Option<String>)> {
        let found = self
            .conn
            .query_row(
                "SELECT p.division_id, d.name FROM projects p
                 LEFT JOIN divisions d ON d.id = p.division_id
                 WHERE p.id = ?1 AND p.division_id IS NOT NULL",
                [project_id],
                |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        Ok(found.unwrap_or((None, None)))
    }

    /// The rights a card needs, once per project instead of once per task
    /// (`allows` loads the rights from the database on every call).
    fn card_rights(&self, project: &ProjectRow) -> CardRights {
        CardRights {
            can_write: self.allows(BoardAction::CreateTask {
                project_id: project.id.clone(),
            }),
            can_manage: self.allows(BoardAction::ManageProject {
                project_id: project.id.clone(),
            }),
        }
    }

    /// `can_edit` is the viewer's `EditTask` right on `t` and `can_delete`
    /// the `DeleteTask` right.
    pub fn card(
        &self,
        project: &ProjectRow,
        t: &TaskData,
        can_edit: bool,
        can_delete: bool,
    ) -> TaskCard {
        let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
        let live = t.subtasks.iter().filter(|s| !s.deleted);
        TaskCard {
            id: t.id.clone(),
            code: task_code(&project.code, t.number),
            title: t.title.clone(),
            column_id: t.column,
            assignee: t
                .assignee
                .as_deref()
                .map(|pk| self.dir.person(self.conn, pk)),
            due: t.due.clone(),
            priority: t.priority,
            labels: t.labels.clone(),
            comment_count: count(t.comments.len()),
            merged: false,
            subtask_done: count(live.clone().filter(|s| s.done).count()),
            subtask_total: count(live.count()),
            tracked_secs: timing::tracked_secs(&t.time),
            timers_running_since: timing::running_since(&t.time),
            can_edit,
            can_delete,
            my_timer_running: t.time.iter().any(|e| e.by == self.me && e.is_running()),
            my_timer_paused: my_timer_paused(t, self.me),
        }
    }

    pub fn board(&self, project: &ProjectRow, doc: &BoardDoc) -> AppResult<BoardView> {
        let tasks = doc.tasks()?;
        let summary = self.summary(project)?;
        let rights = CardRights {
            can_write: self.allows(BoardAction::CreateTask {
                project_id: project.id.clone(),
            }),
            can_manage: summary.can_manage,
        };
        let columns = ColumnId::ALL
            .iter()
            .map(|&c| Column {
                id: c,
                name: c.name().to_owned(),
                // `tasks()` is sorted by (rank, id) already.
                tasks: tasks
                    .iter()
                    .filter(|t| !t.deleted && t.column == c)
                    .map(|t| self.card(project, t, rights.can_write, rights.can_delete(self.me, t)))
                    .collect(),
            })
            .collect();
        Ok(BoardView {
            project: summary,
            columns,
            assignees: self.dir.assignable(self.conn, project)?,
            me: self.me.to_owned(),
            can_create: rights.can_write,
        })
    }

    pub fn detail(&self, project: &ProjectRow, t: &TaskData) -> TaskDetail {
        let person = |pk: &str| self.dir.person(self.conn, pk);
        let mut time_entries: Vec<TimeEntry> = t
            .time
            .iter()
            .filter(|e| !e.deleted)
            .map(|e| TimeEntry {
                id: e.id.clone(),
                person: person(&e.by),
                start: e.start.clone(),
                end: e.end.clone(),
                manual: e.manual,
                note: e.note.clone(),
                secs: timing::entry_secs(&e.start, e.end.as_deref()),
                mine: e.by == self.me,
            })
            .collect();
        // `t.time` is sorted by (start, id); newest first here.
        time_entries.reverse();
        let mut time_totals: Vec<TimeTotal> = timing::totals_by_person(&t.time)
            .into_iter()
            .map(|p| TimeTotal {
                person: person(&p.by),
                secs: p.secs,
                running_since: p.running_since,
            })
            .collect();
        time_totals.sort_by(|a, b| {
            (a.person.name.to_lowercase(), &a.person.public_key)
                .cmp(&(b.person.name.to_lowercase(), &b.person.public_key))
        });
        let can_delete = self.allows(BoardAction::DeleteTask {
            project_id: project.id.clone(),
            task_id: t.id.clone(),
            created_by: t.created_by.clone(),
        });
        let can_edit = self.allows(BoardAction::EditTask {
            project_id: project.id.clone(),
            task_id: t.id.clone(),
        });
        TaskDetail {
            card: self.card(project, t, can_edit, can_delete),
            project_id: project.id.clone(),
            description: t.description.clone(),
            created_by: self.dir.person(self.conn, &t.created_by),
            created_at: t.created_at.clone(),
            updated_at: t.updated_at.clone(),
            comments: t
                .comments
                .iter()
                .map(|c| Comment {
                    id: c.id.clone(),
                    author: self.dir.person(self.conn, &c.author),
                    at: c.at.clone(),
                    body: c.body.clone(),
                })
                .collect(),
            activity: t
                .activity
                .iter()
                .map(|a| Activity {
                    at: a.at.clone(),
                    actor: self.dir.person(self.conn, &a.actor),
                    kind: a.kind.clone(),
                    detail: a.detail.clone(),
                })
                .collect(),
            can_comment: self.allows(BoardAction::Comment {
                project_id: project.id.clone(),
                task_id: t.id.clone(),
            }),
            subtasks: t
                .subtasks
                .iter()
                .filter(|s| !s.deleted)
                .map(|s| Subtask {
                    id: s.id.clone(),
                    title: s.title.clone(),
                    done: s.done,
                    assignee: s.assignee.as_deref().map(person),
                    done_by: s.done_by.as_deref().map(person),
                    done_at: s.done_at.clone(),
                    created_by: person(&s.created_by),
                })
                .collect(),
            time_entries,
            time_totals,
            my_running_entry: t
                .time
                .iter()
                .find(|e| e.by == self.me && e.is_running())
                .map(|e| e.id.clone()),
            status_time: timing::status_time(&t.created_at, &t.activity, t.column, clock::now()),
        }
    }

    /// Whether the viewer may see the project at all.
    pub fn can_view(&self, project_id: &str) -> bool {
        self.allows(BoardAction::ViewProject {
            project_id: project_id.to_owned(),
        })
    }

    /// Live tasks assigned to the viewer across projects, by due date (none
    /// last), then project code and task number.
    pub fn my_tasks(&self, actor: &[u8]) -> AppResult<Vec<MyTask>> {
        let refs = store::assigned_to(self.conn, self.me)?;
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
            let project = store::project(self.conn, &project_id)?;
            if !self.can_view(&project_id) {
                continue;
            }
            let doc = store::load_doc(self.conn, &project_id, actor)?;
            let rights = self.card_rights(&project);
            for t in doc.tasks()? {
                if t.deleted || !ids.contains(&t.id.as_str()) {
                    continue;
                }
                out.push((
                    MyTask {
                        project_id: project.id.clone(),
                        project_code: project.code.clone(),
                        project_name: project.name.clone(),
                        task: self.card(
                            &project,
                            &t,
                            rights.can_write,
                            rights.can_delete(self.me, &t),
                        ),
                    },
                    t.number,
                ));
            }
        }
        out.sort_by(|(a, an), (b, bn)| {
            let due = |t: &MyTask| (t.task.due.is_none(), t.task.due.clone());
            (due(a), &a.project_code, an).cmp(&(due(b), &b.project_code, bn))
        });
        Ok(out.into_iter().map(|(t, _)| t).collect())
    }
}

/// `TaskCard::my_timer_paused`: `me` has at least one stopped timer segment
/// (not manual, not deleted) on the task and none running.
pub fn my_timer_paused(t: &TaskData, me: &str) -> bool {
    let mine = || t.time.iter().filter(|e| e.by == me && !e.deleted);
    mine().any(|e| e.end.is_some() && !e.manual) && !mine().any(|e| e.end.is_none())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::doc::TimeData;

    fn entry(by: &str, end: Option<&str>, manual: bool, deleted: bool) -> TimeData {
        TimeData {
            id: format!("{by}{end:?}{manual}{deleted}"),
            by: by.into(),
            start: "2026-11-23T08:00:00Z".into(),
            end: end.map(str::to_owned),
            manual,
            note: String::new(),
            deleted,
        }
    }

    fn task(time: Vec<TimeData>) -> TaskData {
        TaskData {
            id: "t".into(),
            number: 1,
            title: "x".into(),
            description: String::new(),
            column: ColumnId::Doing,
            rank: "m".into(),
            assignee: None,
            due: None,
            priority: Default::default(),
            labels: Vec::new(),
            created_by: "aa".into(),
            created_at: "t0".into(),
            updated_at: "t0".into(),
            deleted: false,
            comments: Vec::new(),
            activity: Vec::new(),
            subtasks: Vec::new(),
            time,
        }
    }

    #[test]
    fn paused_means_a_stopped_timer_segment_and_none_running() {
        let end = Some("2026-11-23T09:00:00Z");
        let cases = [
            (vec![], false),
            (vec![entry("aa", end, false, false)], true),
            (vec![entry("aa", end, false, false), entry("aa", None, false, false)], false),
            (vec![entry("aa", end, true, false)], false),
            (vec![entry("aa", end, false, true)], false),
            (vec![entry("bb", end, false, false)], false),
            // A deleted running segment does not count as running.
            (vec![entry("aa", end, false, false), entry("aa", None, false, true)], true),
            (vec![entry("aa", end, true, false), entry("aa", end, false, false)], true),
        ];
        for (i, (time, want)) in cases.into_iter().enumerate() {
            assert_eq!(my_timer_paused(&task(time), "aa"), want, "kasus {i}");
        }
    }
}
