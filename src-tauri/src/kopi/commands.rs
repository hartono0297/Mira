//! Tauri commands of Kopi (docs/plans/kopi.md, 3.8). TypeScript side:
//! `src/api/kopi.ts`.
//!
//! Each command is a thin wrapper over a plain `*_with` function taking the
//! core, the current `OrgState`, the loaded Kopi data and the time, so
//! tests run without Tauri (`*_in` loads fresh data first). After a local
//! change the wrapper tells the network
//! (`FeatureHub::notify_changed("kopi")`) and the screens (`mira://feature`
//! with `{ "topic": "kopi" }`).
//!
//! Loading means every Kopi record, every board document this laptop can
//! read and the membership fold, all inside the core lock. [`KopiCache`]
//! (managed by `sync::register`) keeps the last result and reuses it while
//! the Kopi records, the boards and the membership log are unchanged
//! ([`cache_key`]).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use rand_core::{OsRng, RngCore};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime, UtcOffset};

use super::types::{
    FUTURE_SKEW_SECS, GIVE_DAILY_LIMIT, KopiState, PAIR_MONTHLY_LIMIT, Payload, REASON_MAX,
    StoredRecord, Target, WorkTask,
};
use super::view::{self, KopiBoard, KopiOverview, KopiProfile, Names};
use super::{record, rules, store, work};
use crate::board::store as board_store;
use crate::chat::read as chat_read;
use crate::clock;
use crate::error::{AppError, AppResult};
use crate::network::feature::FeatureHub;
use crate::permissions::format::parse_time;
use crate::permissions::{self, MemberKind, MemberStatus, OrgState};
use crate::state::{Core, MiraState};

/// Feature topic (same as `network::feature::TOPIC_KOPI`).
const TOPIC: &str = "kopi";
/// Event that makes the screens reload.
pub const FEATURE_EVENT: &str = "mira://feature";
/// Largest local offset accepted, in minutes (UTC-14 to UTC+14).
pub const OFFSET_MAX_MINUTES: i32 = 14 * 60;

/// `KopiGiveInput` of `src/api/kopi.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct GiveInput {
    pub to: String,
    pub target: Target,
    pub reason: String,
}

// ----- Loading -------------------------------------------------------------

/// Everything a command needs: the stored records, the fold, and the tasks
/// of the boards this laptop can read.
pub struct Loaded {
    records: Vec<StoredRecord>,
    state: KopiState,
    tasks: Vec<WorkTask>,
    readable: HashSet<String>,
}

pub fn load(core: &Core, org: &OrgState) -> AppResult<Loaded> {
    let records = store::load_all(&core.db)?;
    let (tasks, readable) = work::tasks_from_boards(&core.db, org)?;
    let events = work::qualify(&tasks);
    let state = rules::fold(&records, org, &events, &readable);
    Ok(Loaded {
        records,
        state,
        tasks,
        readable,
    })
}

/// The membership state and the loaded Kopi data of one moment.
pub struct Snapshot {
    org: OrgState,
    loaded: Loaded,
}

impl Snapshot {
    fn load(core: &Core) -> AppResult<Snapshot> {
        let org = permissions::require_state(&core.db)?;
        let loaded = load(core, &org)?;
        Ok(Snapshot { org, loaded })
    }
}

/// Last [`Snapshot`] with its [`cache_key`]. Managed state (see
/// `sync::register`); callers hold the core lock, so the key and the data
/// always belong together.
#[derive(Default)]
pub struct KopiCache {
    slot: Mutex<Option<(String, Arc<Snapshot>)>>,
    computed: AtomicUsize,
}

impl KopiCache {
    /// The cached snapshot while [`cache_key`] is unchanged, else a fresh
    /// one (which replaces it).
    pub fn snapshot(&self, core: &Core) -> AppResult<Arc<Snapshot>> {
        let key = cache_key(core)?;
        {
            let slot = self.slot.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some((k, snap)) = slot.as_ref()
                && *k == key
            {
                return Ok(snap.clone());
            }
        }
        let snap = Arc::new(Snapshot::load(core)?);
        self.computed.fetch_add(1, Ordering::Relaxed);
        *self.slot.lock().unwrap_or_else(PoisonError::into_inner) = Some((key, snap.clone()));
        Ok(snap)
    }

    /// How many snapshots were computed (not reused).
    pub fn computed(&self) -> usize {
        self.computed.load(Ordering::Relaxed)
    }
}

/// Changes whenever anything the fold reads changes: this laptop's key,
/// the Kopi records (stored, replaced or retired), the boards (a change or
/// a project added, removed or rewritten) and the membership log. Chat
/// messages are not part of it: `check_target` reads them live.
pub fn cache_key(core: &Core) -> AppResult<String> {
    Ok(format!(
        "{}|{}|{}|{}",
        me(core),
        store::records_marker(&core.db)?,
        store::board_marker(&core.db)?,
        store::org_marker(&core.db)?,
    ))
}

/// Names of the projects this laptop can read.
fn project_names(core: &Core, readable: &HashSet<String>) -> AppResult<HashMap<String, String>> {
    Ok(board_store::projects(&core.db)?
        .into_iter()
        .filter(|p| readable.contains(&p.id))
        .map(|p| (p.id, p.name))
        .collect())
}

fn me(core: &Core) -> String {
    core.identity.public_key_hex().to_owned()
}

// ----- Time ----------------------------------------------------------------

/// `now` at the laptop's offset (minutes east of UTC, -840..=840).
pub fn local_now(now: OffsetDateTime, offset_minutes: i32) -> AppResult<OffsetDateTime> {
    let bad = || {
        AppError::InvalidInput(
            "Zona waktu laptop tidak valid. Periksa pengaturan tanggal dan jam Windows.".into(),
        )
    };
    if !(-OFFSET_MAX_MINUTES..=OFFSET_MAX_MINUTES).contains(&offset_minutes) {
        return Err(bad());
    }
    let offset = UtcOffset::from_whole_seconds(offset_minutes * 60).map_err(|_| bad())?;
    Ok(now.to_offset(offset))
}

fn day_of(t: OffsetDateTime) -> String {
    let d = t.date();
    format!("{:04}-{:02}-{:02}", d.year(), u8::from(d.month()), d.day())
}

fn month_of(t: OffsetDateTime) -> String {
    let d = t.date();
    format!("{:04}-{:02}", d.year(), u8::from(d.month()))
}

fn rfc3339(t: OffsetDateTime) -> AppResult<String> {
    t.format(&Rfc3339)
        .map_err(|_| AppError::Internal("Waktu laptop tidak bisa ditulis.".into()))
}

/// `now`, or one second after the latest of `ats` when that is not earlier:
/// the newest record by `(at, id)` wins, so a change made within the same
/// second as the previous one must still come after it. Records of another
/// laptop were at most `FUTURE_SKEW_SECS` ahead when they arrived, so
/// following them stays acceptable to everyone.
fn after_latest<'a>(now: OffsetDateTime, ats: impl Iterator<Item = &'a str>) -> OffsetDateTime {
    match ats.filter_map(parse_time).max() {
        Some(latest) if latest >= now => latest + Duration::seconds(1),
        _ => now,
    }
}

/// `true` for this laptop's own record more than `FUTURE_SKEW_SECS` ahead
/// of `now` (written while the clock was ahead).
fn own_future(r: &StoredRecord, me: &str, now: OffsetDateTime) -> bool {
    let limit = now + Duration::seconds(FUTURE_SKEW_SECS);
    r.author == me && record::parse_at(record::payload_at(&r.payload)).is_some_and(|t| t > limit)
}

/// Moves this laptop's own `kind` records that are [`own_future`] to
/// `kopi_seen`. Otherwise the next change would have to come one second
/// after them, far in the future, and every other laptop would refuse it
/// until then. The caller leaves them out of [`after_latest`].
fn retire_future(core: &Core, records: &[StoredRecord], kind: &str, now: OffsetDateTime) -> AppResult<()> {
    let me = me(core);
    for r in records {
        if record::kind_name(&r.payload) == kind && own_future(r, &me, now) {
            store::retire(&core.db, &r.id)?;
        }
    }
    Ok(())
}

/// `YYYY-MM`, month 01 to 12.
fn valid_month(month: &str) -> bool {
    let b = month.as_bytes();
    b.len() == 7
        && b[4] == b'-'
        && b[..4].iter().chain(&b[5..]).all(u8::is_ascii_digit)
        && matches!(month[5..].parse::<u8>(), Ok(1..=12))
}

// ----- Checks --------------------------------------------------------------

fn require_giver(org: &OrgState, me: &str) -> AppResult<()> {
    match org.member(me) {
        Some(m) if m.status == MemberStatus::Active && m.kind == MemberKind::Member => Ok(()),
        Some(m) if m.status == MemberStatus::Active && m.kind == MemberKind::Guest => Err(
            AppError::Forbidden("Tamu bisa menerima Kopi, tetapi tidak bisa memberi.".into()),
        ),
        _ => Err(AppError::Forbidden(
            "Hanya anggota aktif organisasi yang bisa memberi Kopi.".into(),
        )),
    }
}

fn require_enabled(state: &KopiState) -> AppResult<()> {
    if state.settings.enabled {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "Fitur Kopi sedang dimatikan oleh superadmin.".into(),
        ))
    }
}

fn require_superadmin(org: &OrgState, me: &str) -> AppResult<()> {
    if org.is_superadmin(me) {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "Hanya superadmin yang bisa mengubah pengaturan Kopi atau menyembunyikan pemberian."
                .into(),
        ))
    }
}

/// The reason as stored: trimmed, 1 to `REASON_MAX` characters, one line.
fn clean_reason(reason: &str) -> AppResult<String> {
    let reason = reason.trim();
    if reason.is_empty() {
        return Err(AppError::InvalidInput(
            "Tulis alasan memberi Kopi.".into(),
        ));
    }
    if reason.chars().count() > REASON_MAX {
        return Err(AppError::InvalidInput(format!(
            "Alasan paling banyak {REASON_MAX} karakter."
        )));
    }
    if reason.chars().any(char::is_control) {
        return Err(AppError::InvalidInput(
            "Alasan harus satu baris, tanpa baris baru atau tab.".into(),
        ));
    }
    Ok(reason.to_owned())
}

/// The target exists on this laptop and belongs to `to`.
fn check_target(core: &Core, loaded: &Loaded, target: &Target, to: &str) -> AppResult<()> {
    match target {
        Target::Message { id } => {
            let row = chat_read::message_row(&core.db, id)?.filter(|m| !m.deleted);
            let Some(row) = row else {
                return Err(AppError::NotFound(
                    "Pesan itu tidak ditemukan di laptop ini atau sudah dihapus.".into(),
                ));
            };
            if row.author != to {
                return Err(AppError::InvalidInput(
                    "Kopi untuk pesan hanya bisa diberikan ke penulis pesan itu.".into(),
                ));
            }
        }
        Target::Task { project, task } => {
            let found = loaded.tasks.iter().find(|t| {
                !t.deleted
                    && &t.project_id == project
                    && &t.task_id == task
                    && loaded.readable.contains(&t.project_id)
            });
            let Some(t) = found else {
                return Err(AppError::NotFound(
                    "Task itu tidak ditemukan di board yang bisa Anda buka.".into(),
                ));
            };
            if t.done_at.is_none() {
                return Err(AppError::InvalidInput(
                    "Kopi untuk task hanya bisa diberikan setelah task ada di Selesai.".into(),
                ));
            }
            if t.assignee.as_deref() != Some(to) {
                return Err(AppError::InvalidInput(
                    "Kopi untuk task hanya bisa diberikan ke penanggung jawabnya.".into(),
                ));
            }
        }
        Target::Profile { .. } => {}
    }
    Ok(())
}

fn nonce() -> String {
    let mut b = [0u8; 8];
    OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

// ----- Plain functions -----------------------------------------------------

pub fn overview_in(
    core: &Core,
    org: &OrgState,
    offset_minutes: i32,
    now: OffsetDateTime,
) -> AppResult<KopiOverview> {
    overview_with(core, org, &load(core, org)?, offset_minutes, now)
}

pub fn overview_with(
    core: &Core,
    org: &OrgState,
    loaded: &Loaded,
    offset_minutes: i32,
    now: OffsetDateTime,
) -> AppResult<KopiOverview> {
    let today = day_of(local_now(now, offset_minutes)?);
    Ok(view::overview(&loaded.state, org, &me(core), &today))
}

pub fn profile_in(core: &Core, org: &OrgState, public_key: &str) -> AppResult<KopiProfile> {
    profile_with(core, org, &load(core, org)?, public_key)
}

pub fn profile_with(
    core: &Core,
    org: &OrgState,
    loaded: &Loaded,
    public_key: &str,
) -> AppResult<KopiProfile> {
    let pk = public_key.trim().to_ascii_lowercase();
    let me = me(core);
    if org.member(&pk).is_none() && pk != me {
        return Err(AppError::NotFound(
            "Orang itu tidak dikenal di organisasi ini.".into(),
        ));
    }
    let projects = project_names(core, &loaded.readable)?;
    let names = Names {
        org,
        me: &me,
        my_name: core.identity.display_name(),
        projects: &projects,
    };
    Ok(view::profile(&loaded.state, &names, &me, &pk))
}

pub fn give_in(
    core: &mut Core,
    org: &OrgState,
    input: &GiveInput,
    offset_minutes: i32,
    now: OffsetDateTime,
) -> AppResult<()> {
    let loaded = load(core, org)?;
    give_with(core, org, &loaded, input, offset_minutes, now)
}

pub fn give_with(
    core: &mut Core,
    org: &OrgState,
    loaded: &Loaded,
    input: &GiveInput,
    offset_minutes: i32,
    now: OffsetDateTime,
) -> AppResult<()> {
    let local = local_now(now, offset_minutes)?;
    let today = day_of(local);
    let me = me(core);
    require_giver(org, &me)?;
    require_enabled(&loaded.state)?;

    let to = input.to.trim().to_ascii_lowercase();
    if to == me {
        return Err(AppError::InvalidInput(
            "Kopi tidak bisa diberikan ke diri sendiri.".into(),
        ));
    }
    if !org.is_active(&to) {
        return Err(AppError::NotFound(
            "Penerima tidak dikenal atau sudah tidak aktif di organisasi.".into(),
        ));
    }
    let reason = clean_reason(&input.reason)?;
    // Kopi from a profile is for the giver's today, whatever day the screen
    // had in mind (it may have been open past midnight).
    let target = match &input.target {
        Target::Profile { .. } => Target::Profile { day: today.clone() },
        t => t.clone(),
    };
    check_target(core, loaded, &target, &to)?;
    if rules::given_keys(&loaded.state, &me).contains(&target.key(&to)) {
        return Err(AppError::InvalidInput(
            "Anda sudah memberi Kopi untuk ini.".into(),
        ));
    }
    if rules::given_pair_month(&loaded.state, &me, &to, &month_of(local)) >= PAIR_MONTHLY_LIMIT {
        return Err(AppError::InvalidInput(format!(
            "Anda sudah memberi {PAIR_MONTHLY_LIMIT} Kopi ke orang ini bulan ini. Coba lagi bulan depan."
        )));
    }
    if rules::given_on(&loaded.state, &me, &today) >= GIVE_DAILY_LIMIT {
        return Err(AppError::InvalidInput(format!(
            "Jatah Kopi Anda hari ini sudah habis ({GIVE_DAILY_LIMIT} per hari). Coba lagi besok."
        )));
    }

    let payload = Payload::Give {
        to,
        target,
        reason,
        at: rfc3339(local)?,
        nonce: nonce(),
    };
    record::validate_shape(&me, &payload)
        .map_err(|detail| AppError::InvalidInput(format!("Data Kopi tidak valid: {detail}.")))?;
    store::seal_and_store(core, &payload)?;
    Ok(())
}

pub fn hide_in(
    core: &mut Core,
    org: &OrgState,
    record_id: &str,
    hidden: bool,
    now: OffsetDateTime,
) -> AppResult<()> {
    let loaded = load(core, org)?;
    hide_with(core, org, &loaded, record_id, hidden, now)
}

pub fn hide_with(
    core: &mut Core,
    org: &OrgState,
    loaded: &Loaded,
    record_id: &str,
    hidden: bool,
    now: OffsetDateTime,
) -> AppResult<()> {
    let me = me(core);
    require_superadmin(org, &me)?;
    let record_id = record_id.trim().to_ascii_lowercase();
    if !loaded.state.gives.iter().any(|g| g.id == record_id) {
        return Err(AppError::NotFound(
            "Pemberian Kopi itu tidak ditemukan di laptop ini.".into(),
        ));
    }
    retire_future(core, &loaded.records, "hide", now)?;
    let kept = loaded.records.iter().filter(|r| !own_future(r, &me, now));
    let earlier = kept.filter_map(|r| match &r.payload {
        Payload::Hide { record, at, .. } if *record == record_id => Some(at.as_str()),
        _ => None,
    });
    let at = clock::format_rfc3339(after_latest(now, earlier));
    store::seal_and_store(
        core,
        &Payload::Hide {
            record: record_id,
            hidden,
            at,
        },
    )?;
    Ok(())
}

pub fn set_settings_in(
    core: &mut Core,
    org: &OrgState,
    enabled: bool,
    board: bool,
    now: OffsetDateTime,
) -> AppResult<()> {
    let me = me(core);
    require_superadmin(org, &me)?;
    let records = store::load_all(&core.db)?;
    retire_future(core, &records, "settings", now)?;
    let kept = records.iter().filter(|r| !own_future(r, &me, now));
    let earlier = kept.filter_map(|r| match &r.payload {
        Payload::Settings { at, .. } => Some(at.as_str()),
        _ => None,
    });
    let at = clock::format_rfc3339(after_latest(now, earlier));
    store::seal_and_store(core, &Payload::Settings { enabled, board, at })?;
    Ok(())
}

/// `month` is `YYYY-MM`; empty means this month at the laptop's offset.
pub fn board_in(
    core: &Core,
    org: &OrgState,
    month: &str,
    offset_minutes: i32,
    now: OffsetDateTime,
) -> AppResult<KopiBoard> {
    board_with(core, org, &load(core, org)?, month, offset_minutes, now)
}

pub fn board_with(
    core: &Core,
    org: &OrgState,
    loaded: &Loaded,
    month: &str,
    offset_minutes: i32,
    now: OffsetDateTime,
) -> AppResult<KopiBoard> {
    let month = match month.trim() {
        "" => month_of(local_now(now, offset_minutes)?),
        m if valid_month(m) => m.to_owned(),
        _ => {
            return Err(AppError::InvalidInput(
                "Bulan harus berformat TAHUN-BULAN, misalnya 2026-11.".into(),
            ));
        }
    };
    let projects = HashMap::new();
    let me = me(core);
    let names = Names {
        org,
        me: &me,
        my_name: core.identity.display_name(),
        projects: &projects,
    };
    Ok(view::board(&loaded.state, &names, &month))
}

// ----- Tauri ---------------------------------------------------------------

fn with_org<T>(
    state: &MiraState,
    f: impl FnOnce(&mut Core, &OrgState) -> AppResult<T>,
) -> AppResult<T> {
    state.with_core(|c| {
        let org = permissions::require_state(&c.db)?;
        f(c, &org)
    })
}

/// Runs `f` with the cached snapshot (a fresh one when the cache is not
/// managed).
fn with_snapshot<T>(
    app: &AppHandle,
    state: &MiraState,
    f: impl FnOnce(&mut Core, &OrgState, &Loaded) -> AppResult<T>,
) -> AppResult<T> {
    state.with_core(|c| {
        let snap = match app.try_state::<KopiCache>() {
            Some(cache) => cache.snapshot(c)?,
            None => Arc::new(Snapshot::load(c)?),
        };
        f(c, &snap.org, &snap.loaded)
    })
}

/// Tells the network and the screens that Kopi data changed.
fn changed(app: &AppHandle) {
    if let Some(hub) = app.try_state::<Arc<FeatureHub>>() {
        hub.notify_changed(TOPIC);
    }
    let _ = app.emit(FEATURE_EVENT, serde_json::json!({ "topic": TOPIC }));
}

#[tauri::command]
pub async fn kopi_overview(
    app: AppHandle,
    state: State<'_, MiraState>,
    offset_minutes: i32,
) -> AppResult<KopiOverview> {
    with_snapshot(&app, &state, |c, org, loaded| {
        overview_with(c, org, loaded, offset_minutes, clock::now())
    })
}

#[tauri::command]
pub async fn kopi_profile(
    app: AppHandle,
    state: State<'_, MiraState>,
    public_key: String,
) -> AppResult<KopiProfile> {
    with_snapshot(&app, &state, |c, org, loaded| {
        profile_with(c, org, loaded, &public_key)
    })
}

#[tauri::command]
pub async fn kopi_give(
    app: AppHandle,
    state: State<'_, MiraState>,
    input: GiveInput,
    offset_minutes: i32,
) -> AppResult<()> {
    with_snapshot(&app, &state, |c, org, loaded| {
        give_with(c, org, loaded, &input, offset_minutes, clock::now())
    })?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn kopi_hide(
    app: AppHandle,
    state: State<'_, MiraState>,
    record_id: String,
    hidden: bool,
) -> AppResult<()> {
    with_snapshot(&app, &state, |c, org, loaded| {
        hide_with(c, org, loaded, &record_id, hidden, clock::now())
    })?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn kopi_set_settings(
    app: AppHandle,
    state: State<'_, MiraState>,
    enabled: bool,
    board: bool,
) -> AppResult<()> {
    with_org(&state, |c, org| {
        set_settings_in(c, org, enabled, board, clock::now())
    })?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn kopi_board(
    app: AppHandle,
    state: State<'_, MiraState>,
    month: String,
    offset_minutes: i32,
) -> AppResult<KopiBoard> {
    with_snapshot(&app, &state, |c, org, loaded| {
        board_with(c, org, loaded, &month, offset_minutes, clock::now())
    })
}

#[cfg(test)]
mod tests;
