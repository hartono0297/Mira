//! Deadline reminders (F-TASK-06): Windows notifications a day before and on
//! the due day for open tasks assigned to this laptop's user.
//!
//! See docs/plans/tahap-3-lokal.md, rows "Tanggal tenggat", "Pengingat" and
//! "Notifikasi". The pure part is [`due_reminders`]; [`run_once`] adds the
//! database and the notifier; [`spawn`] runs it at start and every 15 minutes.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration as StdDuration;

use rusqlite::{Connection, params};
use time::macros::format_description;
use time::{Date, Duration, UtcOffset};
use tokio::sync::Notify;

use crate::clock;
use crate::error::{AppError, AppResult};
use crate::settings;
use crate::state::MiraState;
use crate::ui_lang::UiLang;

/// Setting key for the day-before reminder (`off` disables it).
pub const SETTING_DAY_BEFORE: &str = "board.reminder.day_before";
/// Setting key for the due-day reminder (`off` disables it).
pub const SETTING_DUE_DAY: &str = "board.reminder.due_day";

/// A missed due-day reminder is still sent up to this many days late.
pub const CATCH_UP_DAYS: i64 = 3;
/// More reminders than this in one run become a single summary notification.
pub const SUMMARY_THRESHOLD: usize = 3;

const FIRST_RUN_DELAY: StdDuration = StdDuration::from_secs(5);
const RUN_INTERVAL: StdDuration = StdDuration::from_secs(15 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ReminderKind {
    DayBefore,
    DueDay,
}

impl ReminderKind {
    /// Value stored in `board_reminders_sent.kind`.
    pub fn as_str(self) -> &'static str {
        match self {
            ReminderKind::DayBefore => "day_before",
            ReminderKind::DueDay => "due_day",
        }
    }

    fn from_db(s: &str) -> Option<Self> {
        match s {
            "day_before" => Some(ReminderKind::DayBefore),
            "due_day" => Some(ReminderKind::DueDay),
            _ => None,
        }
    }
}

/// An open task with a due date, assigned to me.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReminderTask {
    pub project_id: String,
    pub task_id: String,
    pub code: String,
    pub title: String,
    pub project_name: String,
    pub due: Date,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reminder {
    pub task: ReminderTask,
    pub kind: ReminderKind,
}

impl Reminder {
    /// Notification title and body for this reminder alone.
    pub fn message(&self, today: Date, lang: UiLang) -> (String, String) {
        let code = &self.task.code;
        let title = match (self.kind, lang) {
            (ReminderKind::DayBefore, UiLang::Id) => format!("Tenggat besok: {code}"),
            (ReminderKind::DayBefore, UiLang::En) => format!("Due tomorrow: {code}"),
            (ReminderKind::DueDay, UiLang::Id) if self.task.due < today => {
                format!("Tenggat sudah lewat: {code}")
            }
            (ReminderKind::DueDay, UiLang::En) if self.task.due < today => {
                format!("Overdue: {code}")
            }
            (ReminderKind::DueDay, UiLang::Id) => format!("Tenggat hari ini: {code}"),
            (ReminderKind::DueDay, UiLang::En) => format!("Due today: {code}"),
        };
        let body = format!("{} · {}", self.task.title, self.task.project_name);
        (title, body)
    }
}

/// One notification for many reminders at once.
pub fn summary_message(reminders: &[Reminder], lang: UiLang) -> (String, String) {
    let n = reminders.len();
    let codes: Vec<&str> = reminders
        .iter()
        .take(SUMMARY_THRESHOLD)
        .map(|r| r.task.code.as_str())
        .collect();
    let mut body = codes.join(", ");
    let rest = n.saturating_sub(codes.len());
    if rest > 0 {
        body.push_str(&match lang {
            UiLang::Id => format!(" dan {rest} lainnya"),
            UiLang::En => format!(" and {rest} more"),
        });
    }
    let title = match lang {
        UiLang::Id => format!("{n} task perlu perhatian"),
        UiLang::En => format!("{n} tasks need attention"),
    };
    (title, body)
}

/// Per-laptop switches; both default to on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReminderSettings {
    pub day_before: bool,
    pub due_day: bool,
}

impl Default for ReminderSettings {
    fn default() -> Self {
        Self {
            day_before: true,
            due_day: true,
        }
    }
}

impl ReminderSettings {
    pub fn load(conn: &Connection) -> AppResult<Self> {
        let enabled = |key| -> AppResult<bool> {
            Ok(settings::get(conn, key)?.is_none_or(|v| v.trim() != "off"))
        };
        Ok(Self {
            day_before: enabled(SETTING_DAY_BEFORE)?,
            due_day: enabled(SETTING_DUE_DAY)?,
        })
    }

    fn allows(self, kind: ReminderKind) -> bool {
        match kind {
            ReminderKind::DayBefore => self.day_before,
            ReminderKind::DueDay => self.due_day,
        }
    }
}

/// Reminders that should go out today, in the order of `tasks`.
///
/// `DayBefore` when the task is due tomorrow. `DueDay` when it is due today,
/// or was due up to [`CATCH_UP_DAYS`] ago (the laptop was off that day).
pub fn due_reminders(
    tasks: &[ReminderTask],
    today: Date,
    settings: ReminderSettings,
    already_sent: impl Fn(&ReminderTask, ReminderKind) -> bool,
) -> Vec<Reminder> {
    tasks
        .iter()
        .filter_map(|task| {
            let days_left = (task.due - today).whole_days();
            let kind = match days_left {
                1 => ReminderKind::DayBefore,
                d if (-CATCH_UP_DAYS..=0).contains(&d) => ReminderKind::DueDay,
                _ => return None,
            };
            (settings.allows(kind) && !already_sent(task, kind)).then(|| Reminder {
                task: task.clone(),
                kind,
            })
        })
        .collect()
}

/// Where the open tasks come from.
pub trait ReminderSource {
    fn open_tasks(&self, conn: &Connection, me: &str) -> AppResult<Vec<ReminderTask>>;
}

/// Reads `board_task_index` (derived from the project documents).
pub struct SqlReminderSource;

impl ReminderSource for SqlReminderSource {
    fn open_tasks(&self, conn: &Connection, me: &str) -> AppResult<Vec<ReminderTask>> {
        let mut stmt = conn.prepare(
            "SELECT t.project_id, t.task_id, t.code, t.title, p.name, t.due
             FROM board_task_index t JOIN board_projects p ON p.id = t.project_id
             WHERE t.assignee = ?1 AND t.deleted = 0 AND t.column_id != 'done'
               AND t.due IS NOT NULL
             ORDER BY t.due, t.code",
        )?;
        let rows = stmt.query_map([me], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?;
        // Only projects this laptop may still see (not after leaving the project).
        let visible: std::collections::HashSet<String> =
            crate::board::access::projects_accessible_by(conn, me)?
                .into_iter()
                .map(|a| a.project_id)
                .collect();
        let mut tasks = Vec::new();
        for row in rows {
            let (project_id, task_id, code, title, project_name, due) = row?;
            if !visible.contains(&project_id) {
                continue;
            }
            let Some(due) = parse_date(&due) else {
                continue;
            };
            tasks.push(ReminderTask {
                project_id,
                task_id,
                code,
                title,
                project_name,
                due,
            });
        }
        Ok(tasks)
    }
}

fn parse_date(s: &str) -> Option<Date> {
    Date::parse(s.trim(), format_description!("[year]-[month]-[day]")).ok()
}

fn format_date(d: Date) -> String {
    format!("{:04}-{:02}-{:02}", d.year(), u8::from(d.month()), d.day())
}

/// Whether this reminder was already sent for this due date.
pub fn was_sent(conn: &Connection, task: &ReminderTask, kind: ReminderKind) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM board_reminders_sent
         WHERE project_id = ?1 AND task_id = ?2 AND kind = ?3 AND due = ?4)",
        params![
            task.project_id,
            task.task_id,
            kind.as_str(),
            format_date(task.due)
        ],
        |r| r.get(0),
    )?)
}

/// Records the reminder as sent. Keyed by due date, so a new date reminds again.
pub fn mark_sent(conn: &Connection, task: &ReminderTask, kind: ReminderKind) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO board_reminders_sent (project_id, task_id, kind, due, sent_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            task.project_id,
            task.task_id,
            kind.as_str(),
            format_date(task.due),
            clock::now_rfc3339()
        ],
    )?;
    Ok(())
}

type SentKey = (String, String, ReminderKind, Date);

/// Sent log entries that can still matter (due date from `since` on).
fn sent_since(conn: &Connection, since: Date) -> AppResult<HashSet<SentKey>> {
    let mut stmt = conn.prepare(
        "SELECT project_id, task_id, kind, due FROM board_reminders_sent WHERE due >= ?1",
    )?;
    let rows = stmt.query_map([format_date(since)], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    let mut sent = HashSet::new();
    for row in rows {
        let (project_id, task_id, kind, due) = row?;
        if let (Some(kind), Some(due)) = (ReminderKind::from_db(&kind), parse_date(&due)) {
            sent.insert((project_id, task_id, kind, due));
        }
    }
    Ok(sent)
}

/// Shows a desktop notification.
pub trait Notifier: Send + Sync {
    fn notify(&self, title: &str, body: &str) -> Result<(), String>;
}

/// Sends through `tauri-plugin-notification` (the plugin must be initialized).
///
/// On Windows the plugin's `show()` hands the toast to the system and always
/// returns `Ok`, even when Windows does not display it (focus assist, app
/// notifications turned off). So with this notifier the "failed notification
/// stays unsent and is retried" path of [`run_once`] does not trigger in
/// practice; it still covers notifiers that can report failure.
pub struct TauriNotifier<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> TauriNotifier<R> {
    pub fn new(app: tauri::AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: tauri::Runtime> Notifier for TauriNotifier<R> {
    fn notify(&self, title: &str, body: &str) -> Result<(), String> {
        use tauri_plugin_notification::NotificationExt;
        self.app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| e.to_string())
    }
}

/// One check: compute, notify, then mark sent. Returns how many reminders went
/// out. A failed notification stays unsent so the next run retries it.
pub fn run_once(
    conn: &Connection,
    me: &str,
    today: Date,
    notifier: &dyn Notifier,
    source: &dyn ReminderSource,
) -> AppResult<usize> {
    let settings = ReminderSettings::load(conn)?;
    if !settings.day_before && !settings.due_day {
        return Ok(0);
    }
    let tasks = source.open_tasks(conn, me)?;
    let since = today
        .checked_sub(Duration::days(CATCH_UP_DAYS))
        .unwrap_or(Date::MIN);
    let sent = sent_since(conn, since)?;
    let reminders = due_reminders(&tasks, today, settings, |task, kind| {
        sent.contains(&(
            task.project_id.clone(),
            task.task_id.clone(),
            kind,
            task.due,
        ))
    });
    if reminders.is_empty() {
        return Ok(0);
    }

    let lang = UiLang::load(conn);
    if reminders.len() > SUMMARY_THRESHOLD {
        let (title, body) = summary_message(&reminders, lang);
        notifier.notify(&title, &body).map_err(notify_error)?;
        for r in &reminders {
            mark_sent(conn, &r.task, r.kind)?;
        }
        return Ok(reminders.len());
    }

    let mut delivered = 0;
    let mut first_error = None;
    for r in &reminders {
        let (title, body) = r.message(today, lang);
        match notifier.notify(&title, &body) {
            Ok(()) => {
                mark_sent(conn, &r.task, r.kind)?;
                delivered += 1;
            }
            Err(e) => {
                first_error.get_or_insert(e);
            }
        }
    }
    match first_error {
        Some(e) => Err(notify_error(e)),
        None => Ok(delivered),
    }
}

fn notify_error(detail: String) -> AppError {
    AppError::Internal(format!(
        "Notifikasi pengingat tenggat tidak bisa ditampilkan. Detail: {detail}"
    ))
}

/// Today's date in the system time zone (UTC if it cannot be read).
pub fn local_today() -> Date {
    let now = clock::now();
    match UtcOffset::current_local_offset() {
        Ok(offset) => now.to_offset(offset).date(),
        Err(_) => now.date(),
    }
}

/// Wakes the reminder loop for an immediate check, e.g. after a board change.
#[derive(Clone, Default)]
pub struct ReminderTrigger(Arc<Notify>);

impl ReminderTrigger {
    pub fn check_now(&self) {
        self.0.notify_one();
    }
}

/// A local change can set a due date for today or tomorrow, so the loop checks
/// right away instead of waiting up to 15 minutes. When board sync arrives,
/// `BoardRuntime` needs a hook that fans out to this and to the network.
impl crate::board::sync::BoardSyncHook for ReminderTrigger {
    fn on_local_change(&self, _project_id: &str, _change: &crate::board::sign::SignedChange) {
        self.check_now();
    }
}

/// Starts the loop: first check after about 5 seconds, then every 15 minutes
/// or whenever the returned trigger fires.
pub fn spawn(state: MiraState, notifier: Arc<dyn Notifier>) -> ReminderTrigger {
    let trigger = ReminderTrigger::default();
    let wake = Arc::clone(&trigger.0);
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(FIRST_RUN_DELAY) => {}
            _ = wake.notified() => {}
        }
        loop {
            let state = state.clone();
            let notifier = Arc::clone(&notifier);
            let result =
                tauri::async_runtime::spawn_blocking(move || check(&state, notifier.as_ref()))
                    .await;
            match result {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => eprintln!("Mira: pengingat tenggat gagal: {e}"),
                Err(e) => eprintln!("Mira: pengingat tenggat berhenti di tengah jalan: {e}"),
            }
            tokio::select! {
                _ = tokio::time::sleep(RUN_INTERVAL) => {}
                _ = wake.notified() => {}
            }
        }
    });
    trigger
}

/// One loop iteration; does nothing before an organization exists.
fn check(state: &MiraState, notifier: &dyn Notifier) -> AppResult<usize> {
    state.with_core(|core| {
        if !board_ready(&core.db)? {
            return Ok(0);
        }
        let me = core.identity.public_key_hex().to_owned();
        run_once(&core.db, &me, local_today(), notifier, &SqlReminderSource)
    })
}

fn board_ready(conn: &Connection) -> AppResult<bool> {
    let has_table: bool = conn.query_row(
        "SELECT count(*) = 2 FROM sqlite_master
         WHERE type = 'table' AND name IN ('board_task_index', 'board_reminders_sent')",
        [],
        |r| r.get(0),
    )?;
    Ok(has_table && crate::org::load_organization(conn)?.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use time::macros::date;

    const TODAY: Date = date!(2026 - 11 - 22);
    const ME: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OTHER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const PROJECT: &str = "0123456789abcdef0123456789abcdef";

    fn task(n: u32, due: Date) -> ReminderTask {
        ReminderTask {
            project_id: PROJECT.into(),
            task_id: format!("t{n}"),
            code: format!("PA-{n}"),
            title: format!("Task {n}"),
            project_name: "Proyek A".into(),
            due,
        }
    }

    fn days(n: i64) -> Date {
        TODAY + Duration::days(n)
    }

    fn kinds(tasks: &[ReminderTask], settings: ReminderSettings) -> Vec<(String, ReminderKind)> {
        due_reminders(tasks, TODAY, settings, |_, _| false)
            .into_iter()
            .map(|r| (r.task.code, r.kind))
            .collect()
    }

    #[derive(Default)]
    struct FakeNotifier {
        calls: Mutex<Vec<(String, String)>>,
        fail: bool,
    }

    impl FakeNotifier {
        fn failing() -> Self {
            Self {
                fail: true,
                ..Self::default()
            }
        }
        fn calls(&self) -> Vec<(String, String)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Notifier for FakeNotifier {
        fn notify(&self, title: &str, body: &str) -> Result<(), String> {
            if self.fail {
                return Err("toast diblokir".into());
            }
            self.calls
                .lock()
                .unwrap()
                .push((title.to_owned(), body.to_owned()));
            Ok(())
        }
    }

    struct Db {
        _tmp: tempfile::TempDir,
        conn: Connection,
    }

    fn db() -> Db {
        let tmp = tempfile::tempdir().unwrap();
        let conn = crate::db::open(tmp.path()).unwrap();
        conn.execute(
            "INSERT INTO board_projects (id, code, name, team_id, created_by, created_at, doc, updated_at)
             VALUES (?1, 'PA', 'Proyek A', NULL, ?2, '2026-11-01T00:00:00Z', x'', '2026-11-01T00:00:00Z')",
            params![PROJECT, ME],
        )
        .unwrap();
        // ME is an active member and a member of the project, so may see it.
        let org = "0f".repeat(16);
        conn.execute(
            "INSERT INTO organizations (id, name, founder_public_key, created_at, genesis_signature)
             VALUES (?1, 'Kantor', ?2, 't', ?3)",
            params![org, ME, "00".repeat(64)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO members (organization_id, public_key, display_name, role, added_at, status, is_superadmin, kind)
             VALUES (?1, ?2, 'Saya', 'member', 't', 'active', 0, 'member')",
            params![org, ME],
        )
        .unwrap();
        crate::board::testutil::register_project(&conn, PROJECT, None, ME, &[ME]);
        Db { _tmp: tmp, conn }
    }

    fn insert_task(
        conn: &Connection,
        n: u32,
        column: &str,
        assignee: &str,
        due: Option<&str>,
        deleted: bool,
    ) {
        conn.execute(
            "INSERT INTO board_task_index (project_id, task_id, code, title, column_id, assignee, due, deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                PROJECT,
                format!("t{n}"),
                format!("PA-{n}"),
                format!("Task {n}"),
                column,
                assignee,
                due,
                deleted as i64
            ],
        )
        .unwrap();
    }

    fn run(conn: &Connection, notifier: &FakeNotifier) -> AppResult<usize> {
        run_once(conn, ME, TODAY, notifier, &SqlReminderSource)
    }

    #[test]
    fn kind_strings_match_schema() {
        assert_eq!(ReminderKind::DayBefore.as_str(), "day_before");
        assert_eq!(ReminderKind::DueDay.as_str(), "due_day");
        for k in [ReminderKind::DayBefore, ReminderKind::DueDay] {
            assert_eq!(ReminderKind::from_db(k.as_str()), Some(k));
        }
    }

    #[test]
    fn due_tomorrow_gives_day_before() {
        let got = kinds(&[task(1, days(1))], ReminderSettings::default());
        assert_eq!(got, vec![("PA-1".into(), ReminderKind::DayBefore)]);
    }

    #[test]
    fn due_today_gives_due_day_never_day_before() {
        let got = kinds(&[task(1, TODAY)], ReminderSettings::default());
        assert_eq!(got, vec![("PA-1".into(), ReminderKind::DueDay)]);
    }

    #[test]
    fn past_due_within_three_days_catches_up() {
        let tasks = [task(1, days(-1)), task(2, days(-3))];
        let got = kinds(&tasks, ReminderSettings::default());
        assert_eq!(
            got,
            vec![
                ("PA-1".into(), ReminderKind::DueDay),
                ("PA-2".into(), ReminderKind::DueDay)
            ]
        );
    }

    #[test]
    fn far_past_and_far_future_are_ignored() {
        let tasks = [task(1, days(-4)), task(2, days(-30)), task(3, days(2))];
        assert!(kinds(&tasks, ReminderSettings::default()).is_empty());
    }

    #[test]
    fn already_sent_is_skipped() {
        let tasks = [task(1, days(1)), task(2, TODAY)];
        let got = due_reminders(&tasks, TODAY, ReminderSettings::default(), |t, k| {
            t.code == "PA-1" && k == ReminderKind::DayBefore
        });
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].task.code, "PA-2");
    }

    #[test]
    fn disabled_kinds_are_skipped() {
        let tasks = [task(1, days(1)), task(2, TODAY)];
        let only_due = ReminderSettings {
            day_before: false,
            due_day: true,
        };
        assert_eq!(
            kinds(&tasks, only_due),
            vec![("PA-2".into(), ReminderKind::DueDay)]
        );
        let only_before = ReminderSettings {
            day_before: true,
            due_day: false,
        };
        assert_eq!(
            kinds(&tasks, only_before),
            vec![("PA-1".into(), ReminderKind::DayBefore)]
        );
    }

    #[test]
    fn messages_are_plain_indonesian() {
        let msg = |due, kind| {
            Reminder {
                task: task(7, due),
                kind,
            }
            .message(TODAY, UiLang::Id)
        };
        assert_eq!(
            msg(days(1), ReminderKind::DayBefore),
            ("Tenggat besok: PA-7".into(), "Task 7 · Proyek A".into())
        );
        assert_eq!(msg(TODAY, ReminderKind::DueDay).0, "Tenggat hari ini: PA-7");
        assert_eq!(
            msg(days(-2), ReminderKind::DueDay).0,
            "Tenggat sudah lewat: PA-7"
        );
    }

    #[test]
    fn summary_lists_three_codes_then_the_rest() {
        let reminders: Vec<Reminder> = (1..=5)
            .map(|n| Reminder {
                task: task(n, TODAY),
                kind: ReminderKind::DueDay,
            })
            .collect();
        let (title, body) = summary_message(&reminders, UiLang::Id);
        assert_eq!(title, "5 task perlu perhatian");
        assert_eq!(body, "PA-1, PA-2, PA-3 dan 2 lainnya");
        let (title, body) = summary_message(&reminders, UiLang::En);
        assert_eq!(title, "5 tasks need attention");
        assert_eq!(body, "PA-1, PA-2, PA-3 and 2 more");
    }

    #[test]
    fn messages_in_english() {
        let msg = |due, kind| {
            Reminder {
                task: task(7, due),
                kind,
            }
            .message(TODAY, UiLang::En)
        };
        assert_eq!(
            msg(days(1), ReminderKind::DayBefore),
            ("Due tomorrow: PA-7".into(), "Task 7 · Proyek A".into())
        );
        assert_eq!(msg(TODAY, ReminderKind::DueDay).0, "Due today: PA-7");
        assert_eq!(msg(days(-2), ReminderKind::DueDay).0, "Overdue: PA-7");
    }

    #[test]
    fn run_once_follows_the_language_setting() {
        let d = db();
        insert_task(&d.conn, 1, "todo", ME, Some("2026-11-23"), false);
        settings::set(&d.conn, crate::ui_lang::SETTING_LANGUAGE, "en").unwrap();
        let n = FakeNotifier::default();
        assert_eq!(run(&d.conn, &n).unwrap(), 1);
        assert_eq!(
            n.calls(),
            vec![("Due tomorrow: PA-1".into(), "Task 1 · Proyek A".into())]
        );
    }

    #[test]
    fn settings_default_on_and_off_disables() {
        let d = db();
        assert_eq!(
            ReminderSettings::load(&d.conn).unwrap(),
            ReminderSettings::default()
        );
        settings::set(&d.conn, SETTING_DAY_BEFORE, "off").unwrap();
        settings::set(&d.conn, SETTING_DUE_DAY, "on").unwrap();
        let s = ReminderSettings::load(&d.conn).unwrap();
        assert!(!s.day_before && s.due_day);
        settings::set(&d.conn, SETTING_DUE_DAY, "off").unwrap();
        assert!(!ReminderSettings::load(&d.conn).unwrap().due_day);
    }

    #[test]
    fn sql_source_excludes_done_deleted_others_and_bad_dates() {
        let d = db();
        insert_task(&d.conn, 1, "todo", ME, Some("2026-11-23"), false);
        insert_task(&d.conn, 2, "doing", ME, Some("2026-11-22"), false);
        insert_task(&d.conn, 3, "done", ME, Some("2026-11-22"), false);
        insert_task(&d.conn, 4, "todo", ME, Some("2026-11-22"), true);
        insert_task(&d.conn, 5, "todo", OTHER, Some("2026-11-22"), false);
        insert_task(&d.conn, 6, "todo", ME, None, false);
        insert_task(&d.conn, 7, "todo", ME, Some("besok"), false);
        let tasks = SqlReminderSource.open_tasks(&d.conn, ME).unwrap();
        let codes: Vec<&str> = tasks.iter().map(|t| t.code.as_str()).collect();
        assert_eq!(codes, ["PA-2", "PA-1"]);
        assert_eq!(tasks[0].project_name, "Proyek A");
        assert_eq!(tasks[0].due, TODAY);
    }

    #[test]
    fn run_once_notifies_and_does_not_repeat() {
        let d = db();
        insert_task(&d.conn, 1, "todo", ME, Some("2026-11-23"), false);
        insert_task(&d.conn, 2, "todo", ME, Some("2026-11-20"), false);
        let n = FakeNotifier::default();
        assert_eq!(run(&d.conn, &n).unwrap(), 2);
        assert_eq!(
            n.calls(),
            vec![
                (
                    "Tenggat sudah lewat: PA-2".into(),
                    "Task 2 · Proyek A".into()
                ),
                ("Tenggat besok: PA-1".into(), "Task 1 · Proyek A".into()),
            ]
        );
        assert!(was_sent(&d.conn, &task(1, days(1)), ReminderKind::DayBefore).unwrap());
        assert_eq!(run(&d.conn, &n).unwrap(), 0);
        assert_eq!(n.calls().len(), 2);
    }

    #[test]
    fn changed_due_date_reminds_again() {
        let d = db();
        insert_task(&d.conn, 1, "todo", ME, Some("2026-11-22"), false);
        let n = FakeNotifier::default();
        assert_eq!(run(&d.conn, &n).unwrap(), 1);
        assert_eq!(run(&d.conn, &n).unwrap(), 0);
        d.conn
            .execute(
                "UPDATE board_task_index SET due = '2026-11-21' WHERE task_id = 't1'",
                [],
            )
            .unwrap();
        assert_eq!(run(&d.conn, &n).unwrap(), 1);
        assert_eq!(n.calls()[1].0, "Tenggat sudah lewat: PA-1");
        assert!(!was_sent(&d.conn, &task(1, days(1)), ReminderKind::DueDay).unwrap());
    }

    #[test]
    fn settings_off_sends_nothing() {
        let d = db();
        insert_task(&d.conn, 1, "todo", ME, Some("2026-11-23"), false);
        insert_task(&d.conn, 2, "todo", ME, Some("2026-11-22"), false);
        settings::set(&d.conn, SETTING_DAY_BEFORE, "off").unwrap();
        settings::set(&d.conn, SETTING_DUE_DAY, "off").unwrap();
        let n = FakeNotifier::default();
        assert_eq!(run(&d.conn, &n).unwrap(), 0);
        assert!(n.calls().is_empty());
        assert!(!was_sent(&d.conn, &task(2, TODAY), ReminderKind::DueDay).unwrap());
    }

    #[test]
    fn more_than_three_become_one_summary_and_all_are_marked() {
        let d = db();
        for i in 1..=5 {
            insert_task(&d.conn, i, "todo", ME, Some("2026-11-22"), false);
        }
        let n = FakeNotifier::default();
        assert_eq!(run(&d.conn, &n).unwrap(), 5);
        assert_eq!(
            n.calls(),
            vec![(
                "5 task perlu perhatian".into(),
                "PA-1, PA-2, PA-3 dan 2 lainnya".into()
            )]
        );
        for i in 1..=5 {
            assert!(was_sent(&d.conn, &task(i, TODAY), ReminderKind::DueDay).unwrap());
        }
    }

    #[test]
    fn failed_notify_leaves_unsent_and_retries() {
        let d = db();
        insert_task(&d.conn, 1, "todo", ME, Some("2026-11-22"), false);
        let err = run(&d.conn, &FakeNotifier::failing()).unwrap_err();
        assert!(err.to_string().contains("toast diblokir"), "{err}");
        assert!(!was_sent(&d.conn, &task(1, TODAY), ReminderKind::DueDay).unwrap());
        let n = FakeNotifier::default();
        assert_eq!(run(&d.conn, &n).unwrap(), 1);
        assert!(was_sent(&d.conn, &task(1, TODAY), ReminderKind::DueDay).unwrap());
    }

    #[test]
    fn failed_summary_leaves_all_unsent() {
        let d = db();
        for i in 1..=4 {
            insert_task(&d.conn, i, "todo", ME, Some("2026-11-23"), false);
        }
        assert!(run(&d.conn, &FakeNotifier::failing()).is_err());
        for i in 1..=4 {
            assert!(!was_sent(&d.conn, &task(i, days(1)), ReminderKind::DayBefore).unwrap());
        }
    }

    #[test]
    fn board_ready_needs_an_organization() {
        let d = db();
        assert!(board_ready(&d.conn).unwrap());
        d.conn.execute("DELETE FROM members", []).unwrap();
        d.conn.execute("DELETE FROM organizations", []).unwrap();
        assert!(!board_ready(&d.conn).unwrap());
    }

    #[test]
    fn check_skips_quietly_without_organization() {
        let tmp = tempfile::tempdir().unwrap();
        let state = MiraState::new(
            Ok(tmp.path().to_path_buf()),
            Box::new(crate::identity::MemoryKeyStore::new()),
        );
        let n = FakeNotifier::default();
        assert_eq!(check(&state, &n).unwrap(), 0);
        assert!(n.calls().is_empty());
    }

    #[test]
    fn local_today_is_near_utc_today() {
        let utc = clock::now().date();
        assert!((local_today() - utc).whole_days().abs() <= 1);
    }

    #[test]
    fn trigger_stores_a_wakeup() {
        let trigger = ReminderTrigger::default();
        trigger.check_now();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        rt.block_on(async {
            tokio::time::timeout(StdDuration::from_secs(1), trigger.0.notified())
                .await
                .expect("wakeup is stored");
        });
    }
}
