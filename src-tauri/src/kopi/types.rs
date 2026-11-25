//! Shared types and constants of the Kopi feature (docs/plans/kopi.md,
//! "Kontrak Rust"). Every other file in `kopi/` builds on these; change them
//! only together with the plan.

use serde::{Deserialize, Serialize};

/// Signing domain of Kopi records (`documents::envelope`).
pub const DOMAIN: &str = "mira-kopi-v1";

/// Longest reason, in characters, after trimming.
pub const REASON_MAX: usize = 120;
/// Kopi one giver may give per local day (the day of the signed `at`).
pub const GIVE_DAILY_LIMIT: usize = 3;
/// Kopi from work one person may earn per day (UTC day of `done_at`).
pub const WORK_DAILY_LIMIT: usize = 3;
/// A task the assignee made and finished within this many seconds of
/// creating it earns nothing.
pub const QUICK_SELF_TASK_SECS: i64 = 3600;
/// A record whose `at` is further than this in the future is refused at
/// ingest (it is asked for again later).
pub const FUTURE_SKEW_SECS: i64 = 600;
/// Most items in one work snapshot (newest kept).
pub const WORK_SNAPSHOT_MAX: usize = 1500;
/// Longest chat message id accepted in a target.
pub const TARGET_ID_MAX: usize = 128;
/// Gives signed before this instant never count (the feature did not exist
/// then; a give with an earlier `at` was backdated by a changed clock).
pub const KOPI_EPOCH: &str = "2026-11-24T00:00:00Z";
/// Kopi one giver may give to the same recipient per local calendar month
/// (the month of the signed `at`).
pub const PAIR_MONTHLY_LIMIT: usize = 4;
/// A due date further than this many days after the day it was set (UTC)
/// earns no Kopi for finishing on time.
pub const ON_TIME_HORIZON_DAYS: i64 = 14;
/// Gives one author may have stored per local day; more are refused at
/// ingest (retried later). Twice the daily limit leaves room for duplicates
/// that the fold drops anyway.
pub const GIVE_STORED_DAILY_MAX: usize = 2 * GIVE_DAILY_LIMIT;
/// `hide` plus `settings` records one superadmin may have stored per UTC
/// day; more are refused at ingest (retried later).
pub const ADMIN_STORED_DAILY_MAX: usize = 200;

/// Payload of a Kopi record, the `p` of the signed envelope. The author
/// (`a`) is the giver, the superadmin, or the person whose work it lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Payload {
    /// Kopi from a colleague. Author = giver (a member, never a guest).
    Give {
        to: String,
        target: Target,
        reason: String,
        /// RFC 3339 with the giver's local offset, e.g.
        /// `2026-11-24T14:05:00+07:00`. Its date is the giver's day.
        at: String,
        /// 16 lowercase hex, so two gives with the same text stay apart.
        nonce: String,
    },
    /// Superadmin hides (or shows again) one give. The latest by
    /// `(at, record id)` from a current superadmin wins.
    Hide {
        record: String,
        hidden: bool,
        at: String,
    },
    /// Superadmin office settings. The latest by `(at, record id)` from a
    /// current superadmin wins. Default: both on.
    Settings { enabled: bool, board: bool, at: String },
    /// The author's own Kopi from work, as computed on their laptop. Only
    /// used by laptops that cannot read the item's project; the latest by
    /// `(at, record id)` per author replaces older snapshots.
    Work { at: String, items: Vec<WorkItem> },
}

/// What a give is for.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Target {
    /// A chat message by `to`.
    Message { id: String },
    /// A finished task whose assignee is `to`.
    Task { project: String, task: String },
    /// From the profile; `day` is the giver's local `YYYY-MM-DD`.
    Profile { day: String },
}

impl Target {
    /// One giver gives at most once per key: `message:<id>`,
    /// `task:<project>:<task>`, `profile:<to>:<day>`.
    pub fn key(&self, to: &str) -> String {
        match self {
            Target::Message { id } => format!("message:{id}"),
            Target::Task { project, task } => format!("task:{project}:{task}"),
            Target::Profile { day } => format!("profile:{to}:{day}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkWhy {
    /// Someone else assigned the task, the assignee finished it.
    Assigned,
    /// Finished on or before the due date (set before finishing).
    OnTime,
}

/// One item of a work snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkItem {
    /// Project id.
    pub p: String,
    /// Task id.
    pub t: String,
    /// RFC 3339 of the last move into Selesai.
    pub done: String,
    pub why: WorkWhy,
}

/// A record that passed `record::open` and the ingest checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRecord {
    pub id: String,
    pub author: String,
    pub payload: Payload,
}

/// Input of the work rules, one per task on a board this laptop can read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkTask {
    pub project_id: String,
    pub task_id: String,
    pub title: String,
    pub assignee: Option<String>,
    /// Actor of the latest `assignee` activity; the creator when none.
    pub assigned_by: String,
    pub created_by: String,
    pub created_at: String,
    /// Time of the last move into Selesai, `Some` only when the task is in
    /// Selesai now.
    pub done_at: Option<String>,
    /// Actor of that last move into Selesai. Kopi from work only goes to an
    /// assignee who moved the task there themself.
    pub done_by: Option<String>,
    /// `YYYY-MM-DD` when set.
    pub due: Option<String>,
    /// When the current due date was set (latest `due` activity, or
    /// `created_at` when it was set at creation).
    pub due_set_at: Option<String>,
    pub deleted: bool,
    /// People who may work in the project (see `work::project_people`).
    pub project_people: usize,
    /// The assignee is one of those people.
    pub assignee_in_project: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkSource {
    /// Computed from a board this laptop holds.
    Board,
    /// From the recipient's signed snapshot (project not readable here).
    Claim,
}

/// One Kopi from work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkEvent {
    pub project_id: String,
    pub task_id: String,
    /// Task title when known locally (board source), else `None`.
    pub title: Option<String>,
    pub recipient: String,
    pub done_at: String,
    pub why: WorkWhy,
    pub source: WorkSource,
}

/// A give that counts (passed every rule and the daily limit). Hidden gives
/// are kept here with `hidden = true`: they still use the giver's quota but
/// add nothing to totals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GiveEntry {
    pub id: String,
    pub from: String,
    pub to: String,
    pub target: Target,
    pub reason: String,
    pub at: String,
    /// Giver's local `YYYY-MM-DD` (date part of `at`).
    pub day: String,
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    pub board: bool,
    pub changed_by: Option<String>,
    pub changed_at: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: true,
            board: true,
            changed_by: None,
            changed_at: None,
        }
    }
}

/// Result of `rules::fold`: the same on every laptop holding the same
/// records, org state and boards.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct KopiState {
    pub settings: Settings,
    pub gives: Vec<GiveEntry>,
    pub work: Vec<WorkEvent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    AnakBaru,
    Andalan,
    Senior,
    Legenda,
}
