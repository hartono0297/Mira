//! `ChatSync`: chat's side of the feature sync contract (`FeatureSync`,
//! `BlobSource`), plus the service methods the Tauri commands call
//! (`service.rs`, `files.rs`, `read.rs`).
//!
//! Scoping (plan section 4): a peer that is not an active member gets
//! nothing; conversation records go only to the conversation's current
//! audience; live envelopes and acks go to every active member, guests
//! included, because their content is sealed; purged rows are never offered.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use time::OffsetDateTime;

use super::audience::{Ctx, ProjectAudience};
use super::fetch::{self, FetchKind};
use super::hooks::{ChatHooks, MessageNotification};
use super::judge::{self, Verdict, envelope_expired};
use super::model::{Body, MAX_RECEIPT_MESSAGES, ReceiptState, verify_record};
use super::store::{self, Effects, envelope};
use super::view::{NotifyMode, truncate_chars};
use crate::blobs::{BlobHash, BlobStore, should_auto_replicate};
use crate::clock;
use crate::error::{AppError, AppResult};
use crate::identity::Identity;
use crate::network::feature::{BlobSource, FeatureIngest, FeatureRecord, FeatureSync, TOPIC_CHAT};
use crate::permissions::{
    self,
    format::{format_time, parse_time},
};
use crate::state::{Core, MiraState};

/// Most passes over the deferred records of one batch.
const MAX_INGEST_PASSES: usize = 8;

/// Setting key for notifications: `all` (default), `mentions`, `off`.
pub const NOTIFY_SETTING: &str = "chat.notify";
/// Longest text in a notification.
pub const NOTIFY_TEXT_CHARS: usize = 120;

pub struct ChatSync {
    pub(crate) state: MiraState,
    pub(crate) projects: Arc<dyn ProjectAudience>,
    pub(crate) hooks: Arc<dyn ChatHooks>,
    pub(crate) blobs: BlobStore,
}

impl ChatSync {
    pub fn new(
        state: MiraState,
        projects: Arc<dyn ProjectAudience>,
        hooks: Arc<dyn ChatHooks>,
    ) -> AppResult<Self> {
        let blobs = BlobStore::in_data_dir(state.data_dir()?)?;
        Ok(Self {
            state,
            projects,
            hooks,
            blobs,
        })
    }

    pub fn data_dir(&self) -> AppResult<PathBuf> {
        Ok(self.state.data_dir()?.to_path_buf())
    }

    /// After a committed change: remove released blobs and opened copies of
    /// files no message carries any more, then call the hooks (outside the
    /// core lock, since hooks may call back into chat).
    pub(crate) fn finish(&self, fx: Effects) {
        for h in &fx.drop_blobs {
            if let Ok(hash) = BlobHash::parse(h) {
                let _ = self.blobs.remove(&hash);
            }
        }
        if let Ok(dir) = self.state.data_dir() {
            for h in fx.drop_blobs.iter().chain(&fx.drop_open) {
                if BlobHash::parse(h).is_ok() {
                    let _ = std::fs::remove_dir_all(super::files::open_dir(dir, h));
                }
            }
        }
        if fx.created {
            self.hooks.notify_changed();
        }
        if fx.visible || fx.created {
            self.hooks.ui_changed();
        }
        for n in &fx.notifications {
            self.hooks.notify_message(n);
        }
        if fx.queued {
            self.hooks.wake_fetcher();
        }
    }

    /// Runs `f` in an immediate transaction with a loaded `Ctx`. Fails with
    /// `Forbidden` when there is no organization.
    pub(crate) fn with_ctx<T>(
        &self,
        f: impl FnOnce(&Ctx, &Identity, &mut Effects) -> AppResult<T>,
    ) -> AppResult<T> {
        let mut fx = Effects::default();
        let out = self.state.with_core(|core| {
            let Core { db, identity } = core;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let me = identity.public_key_hex().to_owned();
            let Some(ctx) = Ctx::load(&tx, &me, self.projects.as_ref())? else {
                return Err(no_org());
            };
            let out = f(&ctx, identity, &mut fx)?;
            drop(ctx);
            tx.commit()?;
            Ok(out)
        })?;
        self.finish(fx);
        Ok(out)
    }
}

pub(crate) fn no_org() -> AppError {
    AppError::Forbidden(
        "Chat baru bisa dipakai setelah laptop ini membuat atau bergabung dengan organisasi."
            .into(),
    )
}

fn str_err(e: AppError) -> String {
    e.to_string()
}

/// One offerable row.
struct Row {
    id: String,
    kind: String,
    conv: Option<String>,
    at: String,
    author: String,
    recipient: Option<String>,
    /// Local insertion order: keeps messages of the same second in the
    /// order they were made or received.
    seq: i64,
}

const OFFER_SQL: &str = "SELECT r.id, r.kind, r.conv, r.at, r.author, e.recipient, r.rowid
     FROM chat_records r LEFT JOIN chat_envelopes e ON e.id = r.id
     WHERE r.body IS NOT NULL";

fn map_row(r: &rusqlite::Row) -> rusqlite::Result<Row> {
    Ok(Row {
        id: r.get(0)?,
        kind: r.get(1)?,
        conv: r.get(2)?,
        at: r.get(3)?,
        author: r.get(4)?,
        recipient: r.get(5)?,
        seq: r.get(6)?,
    })
}

/// Whether `peer` may receive `row`. `peer` was checked as active.
fn may_offer(
    ctx: &Ctx,
    peer: &str,
    row: &Row,
    now: OffsetDateTime,
    seen: &mut HashMap<String, bool>,
    ops_seen: &mut HashMap<String, HashSet<String>>,
) -> AppResult<bool> {
    match row.kind.as_str() {
        "envelope" => Ok(row
            .recipient
            .as_deref()
            .is_some_and(|r| ctx.dir.is_active(r))
            && parse_time(&row.at).is_some_and(|t| !envelope_expired(t, now))),
        "envelope_ack" => Ok(true),
        // Group ops: current members get them all; someone who left or was
        // removed gets that op and what it builds on, so their laptop learns
        // they are out (plan section 5).
        "group_create" | "group_add" | "group_remove" | "group_rename" => {
            let Some(conv) = &row.conv else {
                return Ok(false);
            };
            let key = format!("ops:{conv}");
            if !ops_seen.contains_key(&key) {
                let set = match ctx.group(conv)? {
                    Some(g) if ctx.dir.is_full_member(peer) => g.deliverable_ops(peer),
                    _ => Default::default(),
                };
                ops_seen.insert(key.clone(), set);
            }
            Ok(ops_seen.get(&key).is_some_and(|s| s.contains(&row.id)))
        }
        _ => {
            let Some(conv) = &row.conv else {
                return Ok(false);
            };
            if let Some(hit) = seen.get(conv) {
                return Ok(*hit);
            }
            let ok = match ctx.conv(conv)? {
                Some(info) => ctx.in_audience(&info, peer)?,
                None => false,
            };
            seen.insert(conv.clone(), ok);
            Ok(ok)
        }
    }
}

fn sort_rows(rows: &mut [Row]) {
    rows.sort_by(|a, b| {
        let ka = (a.kind != "channel_create", &a.at, a.seq);
        let kb = (b.kind != "channel_create", &b.at, b.seq);
        ka.cmp(&kb)
    });
}

impl ChatSync {
    fn ids_for(&self, peer: &str) -> AppResult<Vec<String>> {
        self.state.with_core(|core| {
            let me = core.identity.public_key_hex().to_owned();
            let Some(ctx) = Ctx::load(&core.db, &me, self.projects.as_ref())? else {
                return Ok(Vec::new());
            };
            if !ctx.dir.is_active(peer) || peer == me {
                return Ok(Vec::new());
            }
            let mut stmt = core.db.prepare(OFFER_SQL)?;
            let mut rows = stmt
                .query_map([], map_row)?
                .collect::<Result<Vec<_>, _>>()?;
            sort_rows(&mut rows);
            let now = clock::now();
            let mut seen = HashMap::new();
            let mut ops_seen = HashMap::new();
            let mut out = Vec::new();
            for row in rows {
                if may_offer(&ctx, peer, &row, now, &mut seen, &mut ops_seen)? {
                    out.push(row.id);
                }
            }
            Ok(out)
        })
    }

    fn records(&self, peer: &str, ids: &[String]) -> AppResult<Vec<FeatureRecord>> {
        let mut deposited = false;
        let out = self.state.with_core(|core| {
            let me = core.identity.public_key_hex().to_owned();
            let Some(ctx) = Ctx::load(&core.db, &me, self.projects.as_ref())? else {
                return Ok(Vec::new());
            };
            if !ctx.dir.is_active(peer) || peer == me {
                return Ok(Vec::new());
            }
            let sql = format!("{OFFER_SQL} AND r.id = ?1");
            let mut stmt = core.db.prepare(&sql)?;
            let mut rows = Vec::new();
            for id in ids {
                if let Some(row) = stmt.query_map([id], map_row)?.next() {
                    rows.push(row?);
                }
            }
            sort_rows(&mut rows);
            let now = clock::now();
            let mut seen = HashMap::new();
            let mut ops_seen = HashMap::new();
            let mut out = Vec::new();
            for row in rows {
                if !may_offer(&ctx, peer, &row, now, &mut seen, &mut ops_seen)? {
                    continue;
                }
                let body: String = core.db.query_row(
                    "SELECT body FROM chat_records WHERE id = ?1",
                    [&row.id],
                    |r| r.get(0),
                )?;
                // "Dititipkan" means handed to a custodian. Whether that
                // laptop actually stored it is not knowable from here; an
                // ack or a delivered receipt later replaces the state.
                if row.kind == "envelope"
                    && row.author == me
                    && row.recipient.as_deref() != Some(peer)
                {
                    deposited |= core.db.execute(
                        "UPDATE chat_envelopes SET deposited = 1 WHERE id = ?1 AND deposited = 0",
                        [&row.id],
                    )? > 0;
                }
                out.push(FeatureRecord { id: row.id, body });
            }
            Ok(out)
        })?;
        if deposited {
            self.hooks.ui_changed();
        }
        Ok(out)
    }

    fn ingest_records(&self, from: &str, records: Vec<FeatureRecord>) -> AppResult<FeatureIngest> {
        let mut fx = Effects::default();
        let result = self.state.with_core(|core| {
            let Core { db, identity } = core;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let me = identity.public_key_hex().to_owned();
            let Some(ctx) = Ctx::load(&tx, &me, self.projects.as_ref())? else {
                return Ok(FeatureIngest::default());
            };
            let out = ingest_batch(&ctx, identity, &self.blobs, from, records, &mut fx)?;
            drop(ctx);
            tx.commit()?;
            Ok(out)
        })?;
        self.finish(fx);
        Ok(result)
    }
}

fn log(
    conn: &Connection,
    from: &str,
    code: &str,
    detail: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    permissions::log_rejection(conn, Some(from), None, &format!("chat_{code}"), detail, now)
}

fn ingest_batch(
    ctx: &Ctx,
    identity: &Identity,
    blobs: &BlobStore,
    from: &str,
    records: Vec<FeatureRecord>,
    fx: &mut Effects,
) -> AppResult<FeatureIngest> {
    let now = clock::now();
    let mut out = FeatureIngest::default();
    let mut verified = Vec::new();
    for r in records {
        if store::is_known(ctx.conn, &r.id)? {
            continue;
        }
        match verify_record(&r.body, &ctx.dir.org_id, now) {
            Ok(v) => verified.push(v),
            Err(rej) => {
                log(ctx.conn, from, rej.code, &rej.detail, now)?;
                out.rejected += 1;
            }
        }
    }
    // Stable: records of the same rank and second keep the sender's order.
    verified.sort_by_key(|v| (v.body().apply_rank(), v.at));
    // Deferred records get another pass while the batch makes progress: a
    // group op may come after an op it builds on (clocks differ), and a
    // message after the op that added its author.
    let mut pending: Vec<&super::model::VerifiedRecord> = verified.iter().collect();
    for _ in 0..MAX_INGEST_PASSES {
        let mut deferred = Vec::new();
        let mut progress = false;
        for v in pending {
            match judge::judge(ctx, v, now)? {
                Verdict::Accept => {
                    store::apply(ctx, v, Some(from), now, fx)?;
                    out.accepted += 1;
                    progress = true;
                }
                Verdict::Defer => deferred.push(v),
                Verdict::Reject(rej) => {
                    log(ctx.conn, from, rej.code, &rej.detail, now)?;
                    out.rejected += 1;
                }
            }
        }
        if !progress || deferred.is_empty() {
            break;
        }
        pending = deferred;
    }
    after_batch(ctx, identity, blobs, Some(from), now, fx)?;
    out.changed = fx.visible;
    Ok(out)
}

/// Work that follows new records: expire and open envelopes, delivered
/// receipts, automatic downloads, notifications.
pub(crate) fn after_batch(
    ctx: &Ctx,
    identity: &Identity,
    blobs: &BlobStore,
    from: Option<&str>,
    now: OffsetDateTime,
    fx: &mut Effects,
) -> AppResult<()> {
    envelope::expire(ctx, now, fx)?;
    envelope::open_pending(ctx, identity, blobs, from, now, fx)?;
    delivered_receipts(ctx, identity, now, fx)?;
    auto_downloads(ctx, blobs, from, now, fx)?;
    notifications(ctx, fx)?;
    Ok(())
}

fn delivered_receipts(
    ctx: &Ctx,
    identity: &Identity,
    now: OffsetDateTime,
    fx: &mut Effects,
) -> AppResult<()> {
    let mut per_conv: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for m in &fx.new_messages {
        let ids = per_conv.entry(m.conv.clone()).or_default();
        if !ids.contains(&m.id) {
            ids.push(m.id.clone());
        }
    }
    for (conv, ids) in per_conv {
        for chunk in ids.chunks(MAX_RECEIPT_MESSAGES) {
            let body = Body::Receipt {
                conv: conv.clone(),
                state: ReceiptState::Delivered,
                messages: chunk.to_vec(),
            };
            store::create(ctx, identity, body, now, fx)?;
        }
    }
    Ok(())
}

fn auto_downloads(
    ctx: &Ctx,
    blobs: &BlobStore,
    from: Option<&str>,
    now: OffsetDateTime,
    fx: &mut Effects,
) -> AppResult<()> {
    let now_s = format_time(now);
    let mut queued = false;
    for m in &fx.new_messages {
        for f in &m.files {
            let Ok(hash) = BlobHash::parse(&f.hash) else {
                continue;
            };
            if blobs.contains(&hash) {
                // Already here (another message, documents): not fetched for
                // this conversation, so it is not served to it either.
                fetch::track(ctx.conn, &f.hash, FetchKind::Plain, true, &now_s)?;
                continue;
            }
            if m.via_envelope || !should_auto_replicate(f.size) {
                continue;
            }
            let mut prefer = vec![m.author.clone()];
            if let Some(p) = from.filter(|p| *p != m.author) {
                prefer.push(p.to_owned());
            }
            fetch::queue(
                ctx.conn,
                &f.hash,
                FetchKind::Plain,
                f.size,
                None,
                &prefer,
                0,
                &now_s,
            )?;
            fetch::queue_for_conv(ctx.conn, &f.hash, &m.conv)?;
            queued = true;
        }
    }
    fx.queued |= queued;
    Ok(())
}

fn notifications(ctx: &Ctx, fx: &mut Effects) -> AppResult<()> {
    if fx.new_messages.is_empty() {
        return Ok(());
    }
    let mode = crate::settings::get(ctx.conn, NOTIFY_SETTING)?
        .map_or(NotifyMode::All, |m| NotifyMode::parse(&m));
    if mode == NotifyMode::Off {
        return Ok(());
    }
    // One notification per conversation: its latest new message that the
    // mode lets through (in "mentions" mode, the latest that mentions me).
    let me = ctx.me().to_owned();
    let mut latest: BTreeMap<String, usize> = BTreeMap::new();
    for (i, m) in fx.new_messages.iter().enumerate() {
        if mode == NotifyMode::Mentions {
            let direct = ctx.conv(&m.conv)?.is_some_and(|c| c.is_direct());
            if !direct && !m.mentions.contains(&me) {
                continue;
            }
        }
        latest.insert(m.conv.clone(), i);
    }
    let mut out = Vec::new();
    for (conv, i) in latest {
        let m = &fx.new_messages[i];
        if is_muted(ctx.conn, &conv)? {
            continue;
        }
        let Some(info) = ctx.conv(&conv)? else {
            continue;
        };
        let sender = ctx.dir.name(&m.author);
        let title = if info.is_channel() {
            format!("{sender} di #{}", info.name)
        } else if info.is_group() {
            format!("{sender} di {}", info.name)
        } else {
            sender
        };
        out.push(MessageNotification {
            conv,
            title,
            body: notification_body(&m.text, m.files.len()),
        });
    }
    fx.notifications.extend(out);
    Ok(())
}

pub(crate) fn notification_body(text: &str, files: usize) -> String {
    let text = text.trim();
    if !text.is_empty() {
        return truncate_chars(text, NOTIFY_TEXT_CHARS);
    }
    match files {
        0 | 1 => "Mengirim file".to_owned(),
        n => format!("Mengirim {n} file"),
    }
}

pub(crate) fn is_muted(conn: &Connection, conv: &str) -> AppResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM chat_conv_settings WHERE conv = ?1 AND muted = 1",
        params![conv],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

impl FeatureSync for ChatSync {
    fn topic(&self) -> &'static str {
        TOPIC_CHAT
    }

    fn record_ids_for(&self, peer: &str) -> Result<Vec<String>, String> {
        self.ids_for(peer).map_err(str_err)
    }

    fn unknown_ids(&self, ids: &[String]) -> Result<Vec<String>, String> {
        self.state
            .with_core(|core| store::unknown_ids(&core.db, ids))
            .map_err(str_err)
    }

    fn records_for(&self, peer: &str, ids: &[String]) -> Result<Vec<FeatureRecord>, String> {
        self.records(peer, ids).map_err(str_err)
    }

    fn ingest(&self, from: &str, records: Vec<FeatureRecord>) -> Result<FeatureIngest, String> {
        self.ingest_records(from, records).map_err(str_err)
    }

    fn peer_connected(&self, _peer: &str) {
        // The new peer may hold what failed before: try every job now.
        let _ = self.state.with_core(|core| fetch::reset_backoff(&core.db));
        self.hooks.wake_fetcher();
    }
}

impl ChatSync {
    /// Chat serves only blobs it holds on purpose (see schema.rs, fetch.rs):
    /// - a cipher file it created (`preexisting = 0`) that an unacked
    ///   envelope lists, to any active member;
    /// - a plain file to a member of a conversation it holds the file for
    ///   (attached by this laptop, fetched or decrypted for a message there)
    ///   while a message there still carries it. A blob that was in the store
    ///   before chat touched it (documents, signing) is served only where this
    ///   laptop attached it to its own message.
    ///
    /// A message naming a hash is never enough on its own.
    fn blob_allowed(&self, peer: &str, hash: &str) -> AppResult<Option<PathBuf>> {
        let Ok(parsed) = BlobHash::parse(hash) else {
            return Ok(None);
        };
        if !self.blobs.contains(&parsed) {
            return Ok(None);
        }
        let allowed = self.state.with_core(|core| {
            let tracked: Option<(String, bool)> = core
                .db
                .query_row(
                    "SELECT kind, preexisting != 0 FROM chat_blobs WHERE hash = ?1",
                    [hash],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let Some((kind, preexisting)) = tracked else {
                return Ok(false);
            };
            let me = core.identity.public_key_hex().to_owned();
            let Some(ctx) = Ctx::load(&core.db, &me, self.projects.as_ref())? else {
                return Ok(false);
            };
            if !ctx.dir.is_active(peer) || peer == me {
                return Ok(false);
            }
            if kind == FetchKind::Cipher.as_str() {
                return Ok(!preexisting && fetch::live_envelope_lists(&core.db, hash)?);
            }
            plain_allowed(&ctx, peer, hash, preexisting)
        })?;
        Ok(allowed.then(|| self.blobs.path_of(&parsed)))
    }
}

fn plain_allowed(ctx: &Ctx, peer: &str, hash: &str, preexisting: bool) -> AppResult<bool> {
    for held in fetch::blob_convs(ctx.conn, hash)? {
        if preexisting && !held.own {
            continue;
        }
        // A message there must still carry the file (for a preexisting blob,
        // this laptop's own message).
        let live: bool = ctx.conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM chat_files f JOIN chat_messages m ON m.id = f.message_id
                            WHERE f.hash = ?1 AND m.conv = ?2 AND m.deleted = 0
                              AND (?3 = 0 OR m.author = ?4))",
            params![hash, held.conv, preexisting, ctx.me()],
            |r| r.get(0),
        )?;
        if !live {
            continue;
        }
        if let Some(info) = ctx.conv(&held.conv)?
            && !info.deleted
            && ctx.in_audience(&info, peer)?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

impl BlobSource for ChatSync {
    fn blob_path_for(&self, peer: &str, hash: &str) -> Option<PathBuf> {
        self.blob_allowed(peer, hash).ok().flatten()
    }
}
