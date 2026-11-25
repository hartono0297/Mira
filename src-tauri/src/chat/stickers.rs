//! Office stickers, my own stickers and sticker messages (v0.6.0,
//! docs/plans/chat-sticker.md 2 to 4).
//!
//! Office stickers come from `sticker_set` records (superadmins only). Per
//! sticker the record with the greatest `(at, record_id)` gives every column
//! of `chat_office_stickers`; the earliest record gives `created_at` and
//! `created_record`, which decide who owns a `:nama:` shared by two active
//! stickers. The image travels like an attachment: queued for download when
//! the record arrives, held for the catalog (`fetch::OFFICE_STICKERS`) and
//! never dropped while a sticker that is not deleted uses it.
//!
//! My own stickers are local rows pointing at a blob; sending one attaches
//! that blob to my message (`ChatSync::send_stored`), so it spreads through
//! the attachment rules that already exist.
//!
//! A sticker message is an ordinary `message`: text `:nama:` and exactly one
//! file `<nama>.sticker.<png|webp|gif>` with the matching image mime, at most
//! 512 KB. Its image is shown as a sticker only after its bytes pass
//! `sticker_file::inspect` (cached per hash in `chat_sticker_checks`).

use std::collections::{BTreeMap, HashSet};
use std::io::Read;
use std::path::Path;

use data_encoding::BASE64;
use rusqlite::{Connection, OptionalExtension, params};
use time::OffsetDateTime;

use super::audience::{Ctx, was_superadmin_at};
use super::fetch::{self, FetchKind};
use super::judge::{self, Standing, Verdict};
use super::model::{self, Body, FileRef, StickerState, VerifiedRecord};
use super::read::{self, readable};
use super::service::require_member;
use super::sticker_file::{self, MAX_STICKER_BYTES, StickerFileError, StickerInfo};
use super::store::{self, Effects};
use super::sync::ChatSync;
use super::view::{
    FileState, FileView, MessageSticker, MessageView, MyStickerView, OfficeStickerState,
    OfficeStickerView, PickedSticker, StickerCatalog, StickerSource,
};
use crate::blobs::{BlobHash, BlobStore};
use crate::clock;
use crate::error::{AppError, AppResult};
use crate::permissions::format::{format_time, parse_time};

/// Shortest sticker name.
pub const MIN_NAME_CHARS: usize = 2;
/// Longest sticker name.
pub const MAX_NAME_CHARS: usize = 32;
/// Longest pack name.
pub const MAX_PACK_CHARS: usize = 30;
/// Most keywords per sticker.
pub const MAX_KEYWORDS: usize = 8;
/// Longest keyword.
pub const MAX_KEYWORD_CHARS: usize = 24;

const NAME_RULE: &str =
    "Nama sticker harus 2 sampai 32 karakter, hanya huruf kecil a-z, angka, dan garis bawah.";

fn invalid(msg: &str) -> AppError {
    AppError::InvalidInput(msg.to_owned())
}

fn file_error(e: StickerFileError) -> AppError {
    AppError::InvalidInput(e.message().to_owned())
}

fn not_here() -> AppError {
    AppError::NotFound(
        "Gambar sticker belum ada di laptop ini. Tunggu sampai selesai diunduh.".into(),
    )
}

fn failed_check() -> AppError {
    invalid("Gambar sticker ini tidak lolos pemeriksaan keamanan, jadi tidak bisa dipakai.")
}

// ---- Names, packs, keywords ----

/// `[a-z0-9_]{2,32}`.
pub fn is_sticker_name(name: &str) -> bool {
    (MIN_NAME_CHARS..=MAX_NAME_CHARS).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// A pack name tidied like a group name (`model::normalize_group_name`),
/// 1 to 30 characters.
pub fn normalize_pack(input: &str) -> Option<String> {
    model::normalize_group_name(input).filter(|p| p.chars().count() <= MAX_PACK_CHARS)
}

/// Zero-width, bidi and other invisible characters.
fn is_hidden_char(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2069}'
            | '\u{FEFF}'
            | '\u{E0001}'
            | '\u{E0020}'..='\u{E007F}'
    )
}

/// 1 to 24 characters, lower case, no spaces, control or invisible
/// characters.
fn is_keyword(k: &str) -> bool {
    let n = k.chars().count();
    (1..=MAX_KEYWORD_CHARS).contains(&n)
        && k.to_lowercase() == k
        && !k
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || is_hidden_char(c))
}

/// `<name>.sticker.<png|webp|gif>` for an image `mime`.
pub fn sticker_file_name(name: &str, mime: &str) -> Option<String> {
    sticker_file::ext_for_mime(mime).map(|ext| format!("{name}.sticker.{ext}"))
}

/// Field check for `Body::StickerSet` (called from `model`; `file` already
/// passed the generic file check).
pub fn validate_sticker_fields(
    pack: &str,
    name: &str,
    keywords: &[String],
    file: &FileRef,
) -> Result<(), String> {
    if !is_sticker_name(name) {
        return Err("nama sticker tidak sah".into());
    }
    if normalize_pack(pack).as_deref() != Some(pack) {
        return Err("paket sticker tidak sah".into());
    }
    if keywords.len() > MAX_KEYWORDS || !keywords.iter().all(|k| is_keyword(k)) {
        return Err("kata kunci sticker tidak sah".into());
    }
    let mut seen = HashSet::new();
    if !keywords.iter().all(|k| seen.insert(k.as_str())) {
        return Err("kata kunci sticker ganda".into());
    }
    if file.size > MAX_STICKER_BYTES {
        return Err("file sticker terlalu besar".into());
    }
    match sticker_file_name(name, &file.mime) {
        None => Err("jenis file sticker tidak sah".into()),
        Some(n) if n != file.name => Err("nama file sticker tidak sesuai nama sticker".into()),
        Some(_) => Ok(()),
    }
}

/// A sticker name typed by the person (colons and case forgiven).
fn input_name(name: &str) -> AppResult<String> {
    let name = name.trim().trim_matches(':').to_lowercase();
    if is_sticker_name(&name) {
        Ok(name)
    } else {
        Err(invalid(NAME_RULE))
    }
}

fn input_pack(pack: &str) -> AppResult<String> {
    normalize_pack(pack).ok_or_else(|| invalid("Nama paket sticker harus 1 sampai 30 karakter."))
}

/// Keywords typed by the person: trimmed, lower case, empty and repeated
/// ones dropped.
fn input_keywords(keywords: &[String]) -> AppResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for k in keywords {
        let k = k.trim().to_lowercase();
        if k.is_empty() || out.contains(&k) {
            continue;
        }
        if !is_keyword(&k) {
            return Err(invalid(
                "Setiap kata kunci sticker harus 1 sampai 24 karakter tanpa spasi.",
            ));
        }
        out.push(k);
    }
    if out.len() > MAX_KEYWORDS {
        return Err(invalid("Satu sticker paling banyak punya 8 kata kunci."));
    }
    Ok(out)
}

/// Short name suggested from a picked file name: lower case, other
/// characters become `_`, at most 32 characters. Empty when nothing usable
/// is left.
fn suggest_name(path: &Path) -> String {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let stem = stem.strip_suffix(".sticker").unwrap_or(&stem);
    let mut out = String::new();
    for c in stem.chars() {
        let c = if c.is_ascii_lowercase() || c.is_ascii_digit() {
            c
        } else {
            '_'
        };
        if c == '_' && (out.is_empty() || out.ends_with('_')) {
            continue;
        }
        out.push(c);
    }
    let out: String = out.chars().take(MAX_NAME_CHARS).collect();
    let out = out.trim_end_matches('_').to_owned();
    if is_sticker_name(&out) {
        out
    } else {
        String::new()
    }
}

// ---- Sticker messages and image checks ----

/// The sticker name of a message with text `text` and one file, if it has
/// the sticker shape.
fn shape<'t>(text: &'t str, file_name: &str, mime: &str, size: u64) -> Option<&'t str> {
    let name = text.strip_prefix(':')?.strip_suffix(':')?;
    if !is_sticker_name(name) || size == 0 || size > MAX_STICKER_BYTES {
        return None;
    }
    (sticker_file_name(name, mime)? == file_name).then_some(name)
}

/// What checking a blob as a sticker image gave.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Checked {
    /// Not on this laptop (yet).
    Missing,
    /// Refused by `sticker_file::inspect`.
    Bad,
    /// Passed; the mime found in its bytes.
    Good(String),
}

fn remember(
    conn: &Connection,
    hash: &str,
    result: Result<&StickerInfo, StickerFileError>,
    now: &str,
) -> AppResult<()> {
    let info = result.ok();
    conn.execute(
        "INSERT OR REPLACE INTO chat_sticker_checks (hash, ok, mime, width, height, frames, checked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            hash,
            info.is_some(),
            info.map(|i| i.mime),
            info.map(|i| i.width),
            info.map(|i| i.height),
            info.map(|i| i.frames),
            now
        ],
    )?;
    Ok(())
}

/// Checks blob `hash` once and remembers the answer (failures too).
fn check_blob(conn: &Connection, blobs: &BlobStore, hash: &str) -> AppResult<Checked> {
    let Ok(blob) = BlobHash::parse(hash) else {
        return Ok(Checked::Bad);
    };
    if !blobs.contains(&blob) {
        return Ok(Checked::Missing);
    }
    let cached: Option<(bool, Option<String>)> = conn
        .query_row(
            "SELECT ok, mime FROM chat_sticker_checks WHERE hash = ?1",
            [hash],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((ok, mime)) = cached {
        return Ok(match (ok, mime) {
            (true, Some(m)) => Checked::Good(m),
            _ => Checked::Bad,
        });
    }
    let result = if blobs.size(&blob)? > MAX_STICKER_BYTES {
        Err(StickerFileError::TooLarge)
    } else {
        sticker_file::inspect(&blobs.read_all(&blob)?)
    };
    remember(conn, hash, result.as_ref().map_err(|e| *e), &format_time(clock::now()))?;
    Ok(match result {
        Ok(info) => Checked::Good(info.mime.to_owned()),
        Err(_) => Checked::Bad,
    })
}

/// The blob is here and its bytes are a sticker image of `mime`.
fn require_good(conn: &Connection, blobs: &BlobStore, hash: &str, mime: &str) -> AppResult<()> {
    match check_blob(conn, blobs, hash)? {
        Checked::Missing => Err(not_here()),
        Checked::Good(m) if m == mime => Ok(()),
        _ => Err(failed_check()),
    }
}

fn is_saved(conn: &Connection, hash: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM chat_my_stickers WHERE hash = ?1)",
        [hash],
        |r| r.get(0),
    )?)
}

/// The sticker a message carries, if its text and files have the sticker
/// shape. `None` too when its image is here but failed the checks: the
/// message is then shown with an ordinary attachment.
pub fn message_sticker(
    ctx: &Ctx,
    blobs: &BlobStore,
    text: &str,
    files: &[FileView],
) -> AppResult<Option<MessageSticker>> {
    let [f] = files else {
        return Ok(None);
    };
    let Some(name) = shape(text, &f.name, &f.mime, f.size) else {
        return Ok(None);
    };
    let ready = if f.state == FileState::Local {
        match check_blob(ctx.conn, blobs, &f.hash)? {
            Checked::Good(m) if m == f.mime => true,
            Checked::Missing => false,
            _ => return Ok(None),
        }
    } else {
        false
    };
    Ok(Some(MessageSticker {
        hash: f.hash.clone(),
        name: name.to_owned(),
        mime: f.mime.clone(),
        size: f.size,
        ready,
        saved: is_saved(ctx.conn, &f.hash)?,
    }))
}

/// Whether a sticker message I may read carries `hash`.
fn in_readable_sticker_message(ctx: &Ctx, hash: &str) -> AppResult<bool> {
    let mut stmt = ctx.conn.prepare(
        "SELECT m.conv, m.text, f.name, f.mime, f.size,
                (SELECT count(*) FROM chat_files g WHERE g.message_id = m.id)
         FROM chat_files f JOIN chat_messages m ON m.id = f.message_id
         WHERE f.hash = ?1 AND m.deleted = 0",
    )?;
    let rows = stmt
        .query_map([hash], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (conv, text, name, mime, size, files) in rows {
        let size = u64::try_from(size).unwrap_or(u64::MAX);
        if files == 1 && shape(&text, &name, &mime, size).is_some() && readable(ctx, &conv).is_ok()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

// ---- Blob bookkeeping ----

/// An office sticker that is not deleted uses blob `hash`.
pub(crate) fn office_uses(conn: &Connection, hash: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM chat_office_stickers WHERE hash = ?1 AND state != 'deleted')",
        [hash],
        |r| r.get(0),
    )?)
}

/// An office sticker that is not deleted or one of my own stickers keeps
/// blob `hash` (`fetch::release`).
pub(crate) fn holds_blob(conn: &Connection, hash: &str) -> AppResult<bool> {
    Ok(office_uses(conn, hash)? || is_saved(conn, hash)?)
}

/// Queues the image of an office sticker for download, held for the
/// catalog once it lands.
fn queue_image(
    conn: &Connection,
    hash: &str,
    size: u64,
    prefer: &[String],
    now: &str,
) -> AppResult<()> {
    fetch::queue(conn, hash, FetchKind::Plain, size, None, prefer, 0, now)?;
    fetch::queue_for_conv(conn, hash, fetch::OFFICE_STICKERS)
}

/// The catalog stops holding `hash`; drops the blob if nothing else needs it.
fn let_go(conn: &Connection, hash: &str, fx: &mut Effects) -> AppResult<()> {
    if office_uses(conn, hash)? {
        return Ok(());
    }
    fetch::forget_conv(conn, hash, fetch::OFFICE_STICKERS)?;
    if fetch::release(conn, hash)? {
        fx.drop_blobs.push(hash.to_owned());
    }
    Ok(())
}

// ---- Records ----

/// May the author make this `sticker_set` record? Superadmins only, judged
/// like `channel_lock`: a superadmin now, or at the record's time.
///
/// Known risk, kept on purpose so every laptop reaches the same verdict:
/// `at` is chosen by the author, so a former superadmin can backdate a
/// record to a time they still held the role. Such a record can add,
/// change, hide or delete office stickers, and a backdated new sticker wins
/// a `:nama:` clash (the owner is the smallest `(created_at,
/// created_record)`). Images still pass `sticker_file::inspect`, and the
/// catalog never serves a conversation's file (`fetch::land_fetch_convs`,
/// `sync::plain_allowed`).
pub(crate) fn judge(ctx: &Ctx, rec: &VerifiedRecord, st: Standing) -> AppResult<Verdict> {
    let author = rec.author();
    if (st == Standing::Active && ctx.dir.is_superadmin(author))
        || was_superadmin_at(ctx.conn, author, rec.at)?
    {
        return Ok(Verdict::Accept);
    }
    Ok(judge::forbidden(
        "hanya superadmin yang bisa mengatur sticker kantor",
    ))
}

/// One row of `chat_office_stickers`.
#[derive(Debug, Clone)]
struct OfficeRow {
    id: String,
    pack: String,
    name: String,
    keywords: Vec<String>,
    hash: String,
    size: u64,
    mime: String,
    state: StickerState,
    created_at: String,
    created_record: String,
    at: String,
    record_id: String,
}

const OFFICE_COLS: &str =
    "id, pack, name, keywords, hash, size, mime, state, created_at, created_record, at, record_id";

fn map_office(r: &rusqlite::Row) -> rusqlite::Result<OfficeRow> {
    let keywords: String = r.get(3)?;
    let state: String = r.get(7)?;
    Ok(OfficeRow {
        id: r.get(0)?,
        pack: r.get(1)?,
        name: r.get(2)?,
        keywords: serde_json::from_str(&keywords).unwrap_or_default(),
        hash: r.get(4)?,
        size: u64::try_from(r.get::<_, i64>(5)?).unwrap_or(0),
        mime: r.get(6)?,
        state: StickerState::parse(&state).unwrap_or(StickerState::Deleted),
        created_at: r.get(8)?,
        created_record: r.get(9)?,
        at: r.get(10)?,
        record_id: r.get(11)?,
    })
}

fn office_row(conn: &Connection, id: &str) -> AppResult<Option<OfficeRow>> {
    Ok(conn
        .query_row(
            &format!("SELECT {OFFICE_COLS} FROM chat_office_stickers WHERE id = ?1"),
            [id],
            map_office,
        )
        .optional()?)
}

/// Office stickers that are not deleted, by pack then name.
fn office_rows(conn: &Connection) -> AppResult<Vec<OfficeRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {OFFICE_COLS} FROM chat_office_stickers WHERE state != 'deleted'
         ORDER BY pack COLLATE NOCASE, pack, name, created_at, created_record"
    ))?;
    let rows = stmt
        .query_map([], map_office)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

impl OfficeRow {
    fn created(&self) -> (&str, &str) {
        (&self.created_at, &self.created_record)
    }

    /// An older active sticker owns the same name.
    fn name_taken(&self, all: &[OfficeRow]) -> bool {
        all.iter().any(|o| {
            o.id != self.id
                && o.name == self.name
                && o.state == StickerState::Active
                && o.created() < self.created()
        })
    }

    fn view(&self, ready: bool, name_taken: bool) -> OfficeStickerView {
        OfficeStickerView {
            id: self.id.clone(),
            pack: self.pack.clone(),
            name: self.name.clone(),
            keywords: self.keywords.clone(),
            hash: self.hash.clone(),
            mime: self.mime.clone(),
            size: self.size,
            state: match self.state {
                StickerState::Active => OfficeStickerState::Active,
                StickerState::Hidden => OfficeStickerState::Hidden,
                StickerState::Deleted => OfficeStickerState::Deleted,
            },
            ready,
            name_taken,
        }
    }
}

/// Stores an accepted `sticker_set` record and updates
/// `chat_office_stickers`, queueing the image download.
pub fn apply(
    ctx: &Ctx,
    rec: &VerifiedRecord,
    from: Option<&str>,
    now: OffsetDateTime,
    fx: &mut Effects,
) -> AppResult<()> {
    let Body::StickerSet {
        sticker,
        pack,
        name,
        keywords,
        file,
        state,
    } = rec.body()
    else {
        return Ok(());
    };
    let conn = ctx.conn;
    store::insert_record(conn, rec, true, from, now)?;
    fx.visible = true;
    let at = format_time(rec.at);
    let key = (at.as_str(), rec.id.as_str());
    let keywords = serde_json::to_string(keywords).unwrap_or_else(|_| "[]".into());
    let size = i64::try_from(file.size).unwrap_or(i64::MAX);
    let before = office_row(conn, sticker)?;
    match &before {
        None => {
            conn.execute(
                "INSERT INTO chat_office_stickers
                   (id, pack, name, keywords, hash, size, mime, file_name, state,
                    created_at, created_record, at, record_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?10, ?11)",
                params![
                    sticker,
                    pack,
                    name,
                    keywords,
                    file.hash,
                    size,
                    file.mime,
                    file.name,
                    state.as_str(),
                    at,
                    rec.id
                ],
            )?;
        }
        Some(old) => {
            if key > (old.at.as_str(), old.record_id.as_str()) {
                conn.execute(
                    "UPDATE chat_office_stickers SET pack = ?2, name = ?3, keywords = ?4, hash = ?5,
                       size = ?6, mime = ?7, file_name = ?8, state = ?9, at = ?10, record_id = ?11
                     WHERE id = ?1",
                    params![
                        sticker,
                        pack,
                        name,
                        keywords,
                        file.hash,
                        size,
                        file.mime,
                        file.name,
                        state.as_str(),
                        at,
                        rec.id
                    ],
                )?;
            }
            if key < old.created() {
                conn.execute(
                    "UPDATE chat_office_stickers SET created_at = ?2, created_record = ?3 WHERE id = ?1",
                    params![sticker, at, rec.id],
                )?;
            }
        }
    }
    let Some(after) = office_row(conn, sticker)? else {
        return Ok(());
    };
    if let Some(old) = before
        && (old.hash != after.hash || after.state == StickerState::Deleted)
    {
        let_go(conn, &old.hash, fx)?;
    }
    // The image is fetched like a small attachment unless chat holds it
    // already (uploaded here, or fetched before) or wants it for a message.
    // A blob that is here but untracked (documents, signing) is dropped from
    // the queue by the fetcher and never served for the catalog.
    if after.state != StickerState::Deleted && may_queue_image(conn, &after.hash)? {
        let mut prefer = vec![rec.author().to_owned()];
        if let Some(p) = from.filter(|p| *p != rec.author()) {
            prefer.push(p.to_owned());
        }
        queue_image(conn, &after.hash, after.size, &prefer, &format_time(now))?;
        fx.queued = true;
    }
    Ok(())
}

/// Whether the catalog may queue the image `hash` for itself: chat does not
/// hold it yet, it is not queued already (maybe for a conversation), and no
/// message here carries it. Otherwise the conversation's own download
/// brings it, and it is never marked for the catalog
/// (`fetch::OFFICE_STICKERS` must not ride on a chat pribadi or group file).
fn may_queue_image(conn: &Connection, hash: &str) -> AppResult<bool> {
    let tracked: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM chat_blobs WHERE hash = ?1)",
        [hash],
        |r| r.get(0),
    )?;
    Ok(!tracked
        && fetch::queue_state(conn, hash, FetchKind::Plain)?.is_none()
        && !fetch::message_carries(conn, hash)?)
}

/// Setting with the last time the catalog queued a missing office image
/// again, per hash (JSON object), so a sticker whose image nobody has is not
/// retried every time the catalog opens.
const REQUEUE_SETTING: &str = "chat.sticker_requeue";
/// Shortest wait between two such tries.
const REQUEUE_EVERY: time::Duration = time::Duration::hours(1);

struct RequeueTries {
    at: BTreeMap<String, String>,
    changed: bool,
}

impl RequeueTries {
    /// Tries of the stickers in `rows` (others are forgotten).
    fn load(conn: &Connection, rows: &[OfficeRow]) -> AppResult<Self> {
        let mut at: BTreeMap<String, String> = crate::settings::get(conn, REQUEUE_SETTING)?
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default();
        let before = at.len();
        at.retain(|h, _| rows.iter().any(|r| r.hash == *h));
        let changed = at.len() != before;
        Ok(Self { at, changed })
    }

    fn due(&self, hash: &str, now: OffsetDateTime) -> bool {
        self.at
            .get(hash)
            .and_then(|t| parse_time(t))
            .is_none_or(|t| t > now || now - t >= REQUEUE_EVERY)
    }

    fn mark(&mut self, hash: &str, now: OffsetDateTime) {
        self.at.insert(hash.to_owned(), format_time(now));
        self.changed = true;
    }

    fn save(&self, conn: &Connection) -> AppResult<()> {
        if self.changed {
            let json = serde_json::to_string(&self.at).unwrap_or_else(|_| "{}".into());
            crate::settings::set(conn, REQUEUE_SETTING, &json)?;
        }
        Ok(())
    }
}

/// Whether chat may use blob `hash` as a sticker image here: chat put it in
/// the store itself (fetched or uploaded), or this laptop's person picked
/// these bytes (an own message attachment, an own or office sticker upload).
/// A blob that was already here for documents or signing (a signature
/// image, say) is never offered or sent as a sticker.
fn sticker_usable(conn: &Connection, hash: &str) -> AppResult<bool> {
    let preexisting: Option<bool> = conn
        .query_row(
            "SELECT preexisting != 0 FROM chat_blobs WHERE hash = ?1 AND kind = 'plain'",
            [hash],
            |r| r.get(0),
        )
        .optional()?;
    Ok(match preexisting {
        None => false,
        Some(false) => true,
        Some(true) => fetch::blob_convs(conn, hash)?.iter().any(|c| c.own),
    })
}

fn require_usable(conn: &Connection, hash: &str) -> AppResult<()> {
    if sticker_usable(conn, hash)? {
        Ok(())
    } else {
        Err(invalid(
            "Gambar ini sama persis dengan file lain di laptop ini, jadi tidak bisa dipakai sebagai sticker.",
        ))
    }
}

/// Now, or one second after the sticker's latest record when the clock is
/// behind it, so a local change always wins last-writer-wins.
fn after_last(row: &OfficeRow) -> OffsetDateTime {
    let now = clock::now();
    match parse_time(&row.at) {
        Some(t) if t >= now => t + time::Duration::seconds(1),
        _ => now,
    }
}

// ---- My own stickers ----

#[derive(Debug, Clone)]
struct MyRow {
    id: String,
    name: String,
    keywords: Vec<String>,
    hash: String,
    size: u64,
    mime: String,
    added_at: String,
}

const MY_COLS: &str = "id, name, keywords, hash, size, mime, added_at";

fn map_mine(r: &rusqlite::Row) -> rusqlite::Result<MyRow> {
    let keywords: String = r.get(2)?;
    Ok(MyRow {
        id: r.get(0)?,
        name: r.get(1)?,
        keywords: serde_json::from_str(&keywords).unwrap_or_default(),
        hash: r.get(3)?,
        size: u64::try_from(r.get::<_, i64>(4)?).unwrap_or(0),
        mime: r.get(5)?,
        added_at: r.get(6)?,
    })
}

impl MyRow {
    fn view(&self) -> MyStickerView {
        MyStickerView {
            id: self.id.clone(),
            name: self.name.clone(),
            keywords: self.keywords.clone(),
            hash: self.hash.clone(),
            mime: self.mime.clone(),
            size: self.size,
            added_at: self.added_at.clone(),
        }
    }
}

fn my_row_where(conn: &Connection, column: &str, value: &str) -> AppResult<Option<MyRow>> {
    Ok(conn
        .query_row(
            &format!("SELECT {MY_COLS} FROM chat_my_stickers WHERE {column} = ?1"),
            [value],
            map_mine,
        )
        .optional()?)
}

fn insert_mine(conn: &Connection, row: &MyRow) -> AppResult<()> {
    conn.execute(
        "INSERT INTO chat_my_stickers (id, name, keywords, hash, size, mime, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            row.id,
            row.name,
            serde_json::to_string(&row.keywords).unwrap_or_else(|_| "[]".into()),
            row.hash,
            i64::try_from(row.size).unwrap_or(i64::MAX),
            row.mime,
            row.added_at
        ],
    )?;
    Ok(())
}

// ---- Picked files ----

/// Reads a picked sticker file, refusing one over 512 KB before reading it
/// all, and checks its bytes.
fn read_picked(path: &Path) -> AppResult<(Vec<u8>, StickerInfo)> {
    let unreadable =
        || invalid("Gambar sticker tidak bisa dibaca. Pastikan filenya masih ada.");
    let meta = std::fs::metadata(path).map_err(|_| unreadable())?;
    if !meta.is_file() {
        return Err(invalid("Yang dipilih bukan file."));
    }
    if meta.len() > MAX_STICKER_BYTES {
        return Err(file_error(StickerFileError::TooLarge));
    }
    let file = std::fs::File::open(path).map_err(|_| unreadable())?;
    let mut bytes = Vec::new();
    file.take(MAX_STICKER_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unreadable())?;
    let info = sticker_file::inspect(&bytes).map_err(file_error)?;
    Ok((bytes, info))
}

fn require_superadmin(ctx: &Ctx) -> AppResult<()> {
    let me = ctx.me();
    if ctx.dir.is_full_member(me) && ctx.dir.is_superadmin(me) {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "Hanya superadmin yang bisa mengelola sticker kantor.".into(),
        ))
    }
}

/// No other office sticker that is not deleted is called `name`.
fn ensure_name_free(conn: &Connection, name: &str, except: Option<&str>) -> AppResult<()> {
    let used: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM chat_office_stickers
                        WHERE name = ?1 AND state != 'deleted' AND id != ?2)",
        params![name, except.unwrap_or("")],
        |r| r.get(0),
    )?;
    if used {
        return Err(invalid(&format!(
            "Nama :{name}: sudah dipakai sticker kantor lain. Pilih nama lain."
        )));
    }
    Ok(())
}

impl ChatSync {
    /// The catalog for the pickers. Everyone gets the active office stickers
    /// that own their name; superadmins get every sticker that is not
    /// deleted (hidden ones and name clashes too). An office image that is
    /// missing and not queued is queued again.
    pub fn stickers(&self) -> AppResult<StickerCatalog> {
        self.with_ctx(|ctx, _, fx| {
            require_member(ctx)?;
            let manage = require_superadmin(ctx).is_ok();
            let rows = office_rows(ctx.conn)?;
            let now = clock::now();
            let mut tries = RequeueTries::load(ctx.conn, &rows)?;
            let mut office = Vec::new();
            for r in &rows {
                let present = BlobHash::parse(&r.hash).is_ok_and(|h| self.blobs.contains(&h));
                let ready = present && sticker_usable(ctx.conn, &r.hash)?;
                if !present && may_queue_image(ctx.conn, &r.hash)? && tries.due(&r.hash, now) {
                    let author: Option<String> = ctx
                        .conn
                        .query_row(
                            "SELECT author FROM chat_records WHERE id = ?1",
                            [&r.record_id],
                            |row| row.get(0),
                        )
                        .optional()?;
                    let prefer: Vec<String> = author.into_iter().collect();
                    queue_image(ctx.conn, &r.hash, r.size, &prefer, &format_time(now))?;
                    tries.mark(&r.hash, now);
                    fx.queued = true;
                }
                let taken = r.name_taken(&rows);
                if !manage && (r.state != StickerState::Active || taken) {
                    continue;
                }
                office.push(r.view(ready, taken));
            }
            tries.save(ctx.conn)?;
            let mut stmt = ctx.conn.prepare(&format!(
                "SELECT {MY_COLS} FROM chat_my_stickers ORDER BY added_at DESC, rowid DESC"
            ))?;
            let mine = stmt
                .query_map([], map_mine)?
                .map(|r| r.map(|m| m.view()))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(StickerCatalog {
                office,
                mine,
                can_manage: manage,
                recent_emoji: super::reactions::recent_emoji(ctx.conn)?,
            })
        })
    }

    /// `data:` URL of a checked sticker image I may see: an office sticker
    /// that is active or hidden, one of my own, or the file of a sticker
    /// message in a conversation I may read.
    pub fn sticker_image(&self, hash: &str) -> AppResult<String> {
        let blob = BlobHash::parse(hash)?;
        self.with_ctx(|ctx, _, _| {
            require_member(ctx)?;
            let office: bool = ctx.conn.query_row(
                "SELECT EXISTS (SELECT 1 FROM chat_office_stickers
                                WHERE hash = ?1 AND state IN ('active', 'hidden'))",
                [hash],
                |r| r.get(0),
            )?;
            // An office sticker naming a blob that is here for documents or
            // signing does not make it a sticker image.
            let allowed = (office && sticker_usable(ctx.conn, hash)?)
                || is_saved(ctx.conn, hash)?
                || in_readable_sticker_message(ctx, hash)?;
            if !allowed {
                return Err(AppError::Forbidden(
                    "Gambar ini bukan sticker yang bisa kamu lihat.".into(),
                ));
            }
            if !self.blobs.contains(&blob) {
                return Err(AppError::NotFound("Sticker belum tersedia.".into()));
            }
            if self.blobs.size(&blob)? > MAX_STICKER_BYTES {
                return Err(file_error(StickerFileError::TooLarge));
            }
            let bytes = self.blobs.read_all(&blob)?;
            let result = sticker_file::inspect(&bytes);
            remember(
                ctx.conn,
                hash,
                result.as_ref().map_err(|e| *e),
                &format_time(clock::now()),
            )?;
            let info = result.map_err(file_error)?;
            Ok(format!("data:{};base64,{}", info.mime, BASE64.encode(&bytes)))
        })
    }

    /// Checks a file picked in Mira's sticker dialog.
    pub fn inspect_picked(&self, path: &Path) -> AppResult<PickedSticker> {
        let (bytes, info) = read_picked(path)?;
        Ok(PickedSticker {
            path: path.display().to_string(),
            name: suggest_name(path),
            size: bytes.len() as u64,
            mime: info.mime.to_owned(),
            width: info.width,
            height: info.height,
            frames: info.frames,
        })
    }

    /// Adds a picked image to my own collection. The same image twice is
    /// refused with the name it already has.
    pub fn my_sticker_add(
        &self,
        path: &Path,
        name: &str,
        keywords: &[String],
    ) -> AppResult<MyStickerView> {
        let name = input_name(name)?;
        let keywords = input_keywords(keywords)?;
        let (bytes, info) = read_picked(path)?;
        self.with_ctx(|ctx, _, fx| {
            require_member(ctx)?;
            let hash = BlobHash::of_bytes(&bytes).to_string();
            if let Some(old) = my_row_where(ctx.conn, "hash", &hash)? {
                return Err(invalid(&format!(
                    "Gambar ini sudah ada di koleksi sticker-mu sebagai :{}:.",
                    old.name
                )));
            }
            let now = format_time(clock::now());
            let stored =
                fetch::put_tracked_bytes(ctx.conn, &self.blobs, &bytes, FetchKind::Plain, &now)?;
            // Picked by this laptop's person: usable even when the same
            // bytes were already here for documents or signing.
            fetch::add_blob_conv(ctx.conn, &hash, fetch::MY_STICKERS, true)?;
            remember(ctx.conn, &hash, Ok(&info), &now)?;
            let row = MyRow {
                id: model::random_hex32(),
                name,
                keywords,
                hash,
                size: stored.size,
                mime: info.mime.to_owned(),
                added_at: now,
            };
            insert_mine(ctx.conn, &row)?;
            fx.visible = true;
            Ok(row.view())
        })
    }

    /// Saves the sticker of a message I may read to my own collection, named
    /// after its `:nama:`. Saving one that is already there returns it.
    pub fn my_sticker_save(&self, message_id: &str) -> AppResult<MyStickerView> {
        self.with_ctx(|ctx, _, fx| {
            require_member(ctx)?;
            let row = read::message_row(ctx.conn, message_id)?
                .filter(|m| !m.deleted)
                .ok_or_else(|| {
                    AppError::NotFound("Pesan tidak ditemukan atau sudah dihapus.".into())
                })?;
            readable(ctx, &row.conv)?;
            let files = read::files_of(ctx.conn, &self.blobs, &row.id)?;
            let not_sticker = || invalid("Pesan ini bukan pesan sticker.");
            let [f] = files.as_slice() else {
                return Err(not_sticker());
            };
            let name = shape(&row.text, &f.name, &f.mime, f.size)
                .ok_or_else(not_sticker)?
                .to_owned();
            if let Some(old) = my_row_where(ctx.conn, "hash", &f.hash)? {
                return Ok(old.view());
            }
            require_good(ctx.conn, &self.blobs, &f.hash, &f.mime)?;
            require_usable(ctx.conn, &f.hash)?;
            let now = format_time(clock::now());
            // Fetched by chat already; an untracked blob stays preexisting.
            fetch::track(ctx.conn, &f.hash, FetchKind::Plain, true, &now)?;
            let mine = MyRow {
                id: model::random_hex32(),
                name,
                keywords: Vec::new(),
                hash: f.hash.clone(),
                size: f.size,
                mime: f.mime.clone(),
                added_at: now,
            };
            insert_mine(ctx.conn, &mine)?;
            fx.visible = true;
            Ok(mine.view())
        })
    }

    /// Removes one of my stickers. Its blob goes too when chat created it and
    /// no message, office sticker or anything else still needs it.
    pub fn my_sticker_remove(&self, id: &str) -> AppResult<()> {
        self.with_ctx(|ctx, _, fx| {
            let row = my_row_where(ctx.conn, "id", id)?.ok_or_else(|| {
                AppError::NotFound("Sticker tidak ditemukan di koleksimu.".into())
            })?;
            ctx.conn
                .execute("DELETE FROM chat_my_stickers WHERE id = ?1", [id])?;
            fetch::forget_conv(ctx.conn, &row.hash, fetch::MY_STICKERS)?;
            if fetch::release(ctx.conn, &row.hash)? {
                fx.drop_blobs.push(row.hash);
            }
            fx.visible = true;
            Ok(())
        })
    }

    /// Superadmin: a new office sticker from a picked image.
    pub fn office_sticker_add(
        &self,
        path: &Path,
        pack: &str,
        name: &str,
        keywords: &[String],
    ) -> AppResult<OfficeStickerView> {
        let pack = input_pack(pack)?;
        let name = input_name(name)?;
        let keywords = input_keywords(keywords)?;
        let (bytes, info) = read_picked(path)?;
        self.with_ctx(|ctx, identity, fx| {
            require_member(ctx)?;
            require_superadmin(ctx)?;
            ensure_name_free(ctx.conn, &name, None)?;
            let now = clock::now();
            let now_s = format_time(now);
            let stored =
                fetch::put_tracked_bytes(ctx.conn, &self.blobs, &bytes, FetchKind::Plain, &now_s)?;
            let hash = stored.hash.to_string();
            fetch::add_blob_conv(ctx.conn, &hash, fetch::OFFICE_STICKERS, true)?;
            remember(ctx.conn, &hash, Ok(&info), &now_s)?;
            let id = model::random_hex32();
            let file = FileRef {
                name: format!("{name}.sticker.{}", info.ext),
                hash,
                size: stored.size,
                mime: info.mime.to_owned(),
            };
            let body = Body::StickerSet {
                sticker: id.clone(),
                pack,
                name,
                keywords,
                file,
                state: StickerState::Active,
            };
            store::create(ctx, identity, body, now, fx)?;
            let row = office_row(ctx.conn, &id)?
                .ok_or_else(|| AppError::Internal("Sticker kantor baru tidak tersimpan.".into()))?;
            Ok(row.view(true, false))
        })
    }

    /// Superadmin: renames, regroups, hides, shows or deletes an office
    /// sticker with a new record carrying the same image.
    pub fn office_sticker_update(
        &self,
        id: &str,
        pack: &str,
        name: &str,
        keywords: &[String],
        state: OfficeStickerState,
    ) -> AppResult<()> {
        let pack = input_pack(pack)?;
        let name = input_name(name)?;
        let keywords = input_keywords(keywords)?;
        let state = match state {
            OfficeStickerState::Active => StickerState::Active,
            OfficeStickerState::Hidden => StickerState::Hidden,
            OfficeStickerState::Deleted => StickerState::Deleted,
        };
        self.with_ctx(|ctx, identity, fx| {
            require_member(ctx)?;
            require_superadmin(ctx)?;
            let row = office_row(ctx.conn, id)?
                .filter(|r| r.state != StickerState::Deleted)
                .ok_or_else(|| AppError::NotFound("Sticker kantor tidak ditemukan.".into()))?;
            if row.pack == pack && row.name == name && row.keywords == keywords && row.state == state
            {
                return Ok(());
            }
            if state != StickerState::Deleted {
                ensure_name_free(ctx.conn, &name, Some(id))?;
            }
            let file = FileRef {
                name: sticker_file_name(&name, &row.mime).ok_or_else(failed_check)?,
                hash: row.hash.clone(),
                size: row.size,
                mime: row.mime.clone(),
            };
            let body = Body::StickerSet {
                sticker: id.to_owned(),
                pack,
                name,
                keywords,
                file,
                state,
            };
            store::create(ctx, identity, body, after_last(&row), fx)?;
            Ok(())
        })
    }

    /// Sends an office sticker (active, image here) or one of mine as its own
    /// message: text `:nama:` and the image attached from the blob store.
    pub fn send_sticker(
        &self,
        conv: &str,
        source: StickerSource,
        reply_to: Option<String>,
    ) -> AppResult<MessageView> {
        self.send_stored(conv, reply_to, |ctx, blobs| {
            let (name, hash, size, mime) = match &source {
                StickerSource::Office { id } => {
                    let row = office_row(ctx.conn, id)?
                        .filter(|r| r.state == StickerState::Active)
                        .ok_or_else(|| {
                            AppError::NotFound(
                                "Sticker kantor tidak ditemukan atau sedang disembunyikan.".into(),
                            )
                        })?;
                    (row.name, row.hash, row.size, row.mime)
                }
                StickerSource::Mine { id } => {
                    let row = my_row_where(ctx.conn, "id", id)?.ok_or_else(|| {
                        AppError::NotFound("Sticker tidak ditemukan di koleksimu.".into())
                    })?;
                    (row.name, row.hash, row.size, row.mime)
                }
            };
            require_good(ctx.conn, blobs, &hash, &mime)?;
            require_usable(ctx.conn, &hash)?;
            let file = FileRef {
                name: sticker_file_name(&name, &mime).ok_or_else(failed_check)?,
                hash,
                size,
                mime,
            };
            Ok((format!(":{name}:"), vec![file]))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, mime: &str, size: u64) -> FileRef {
        FileRef {
            hash: "a".repeat(64),
            size,
            name: name.to_owned(),
            mime: mime.to_owned(),
        }
    }

    #[test]
    fn sticker_names() {
        for ok in ["ok", "kucing_lucu", "a1", &"z".repeat(32)] {
            assert!(is_sticker_name(ok), "{ok}");
        }
        for bad in ["a", "", "Kucing", "kucing lucu", "kucing-lucu", "kücing", &"z".repeat(33)] {
            assert!(!is_sticker_name(bad), "{bad}");
        }
    }

    #[test]
    fn sticker_fields() {
        let png = file("kucing.sticker.png", "image/png", 1000);
        let kw = |k: &[&str]| k.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert!(validate_sticker_fields("Kantor", "kucing", &kw(&["lucu", "hewan"]), &png).is_ok());
        assert!(validate_sticker_fields("Kantor", "kucing", &[], &png).is_ok());
        // Pack tidied like a group name, 1 to 30 characters.
        assert!(validate_sticker_fields(" Kantor", "kucing", &[], &png).is_err());
        assert!(validate_sticker_fields("Kantor  Baru", "kucing", &[], &png).is_err());
        assert!(validate_sticker_fields("", "kucing", &[], &png).is_err());
        assert!(validate_sticker_fields(&"p".repeat(31), "kucing", &[], &png).is_err());
        assert!(validate_sticker_fields(&"p".repeat(30), "kucing", &[], &png).is_ok());
        // Keywords.
        assert!(validate_sticker_fields("K", "kucing", &kw(&["Lucu"]), &png).is_err());
        assert!(validate_sticker_fields("K", "kucing", &kw(&["lu cu"]), &png).is_err());
        assert!(validate_sticker_fields("K", "kucing", &kw(&[""]), &png).is_err());
        assert!(validate_sticker_fields("K", "kucing", &kw(&["a", "a"]), &png).is_err());
        assert!(validate_sticker_fields("K", "kucing", &kw(&["a\u{200B}"]), &png).is_err());
        assert!(validate_sticker_fields("K", "kucing", &["k".repeat(25)], &png).is_err());
        let nine: Vec<String> = (0..9).map(|i| format!("k{i}")).collect();
        assert!(validate_sticker_fields("K", "kucing", &nine, &png).is_err());
        assert!(validate_sticker_fields("K", "kucing", &nine[..8], &png).is_ok());
        // File: image mime, name after the sticker, at most 512 KB.
        let cases = [
            (file("kucing.sticker.gif", "image/gif", 10), true),
            (file("kucing.sticker.webp", "image/webp", 10), true),
            (file("kucing.sticker.png", "image/gif", 10), false),
            (file("kucing.png", "image/png", 10), false),
            (file("anjing.sticker.png", "image/png", 10), false),
            (file("kucing.sticker.svg", "image/svg+xml", 10), false),
            (file("kucing.sticker.jpg", "image/jpeg", 10), false),
            (file("kucing.sticker.png", "image/png", MAX_STICKER_BYTES), true),
            (file("kucing.sticker.png", "image/png", MAX_STICKER_BYTES + 1), false),
        ];
        for (f, ok) in cases {
            assert_eq!(validate_sticker_fields("K", "kucing", &[], &f).is_ok(), ok, "{f:?}");
        }
    }

    #[test]
    fn typed_input_is_tidied() {
        assert_eq!(input_name(" :Kucing: ").unwrap(), "kucing");
        assert!(input_name("kucing lucu").is_err());
        assert_eq!(input_pack("  Kantor   Baru ").unwrap(), "Kantor Baru");
        assert!(input_pack("   ").is_err());
        let kw = input_keywords(&[" Lucu ".into(), "lucu".into(), "".into(), "hewan".into()]).unwrap();
        assert_eq!(kw, vec!["lucu", "hewan"]);
        assert!(input_keywords(&["dua kata".into()]).is_err());
        let nine: Vec<String> = (0..9).map(|i| format!("k{i}")).collect();
        assert!(input_keywords(&nine).is_err());
    }

    #[test]
    fn names_suggested_from_file_names() {
        let s = |p: &str| suggest_name(Path::new(p));
        assert_eq!(s("C:/x/Kucing Lucu.png"), "kucing_lucu");
        assert_eq!(s("/x/kucing.sticker.webp"), "kucing");
        assert_eq!(s("/x/__Hore!!__.gif"), "hore");
        assert_eq!(s("/x/my.cat.png"), "my_cat");
        assert_eq!(s(&format!("/x/{}.png", "a".repeat(40))), "a".repeat(32));
        assert_eq!(s("/x/x.png"), "");
        assert_eq!(s("/x/ü.png"), "");
    }

    #[test]
    fn sticker_message_shape() {
        assert_eq!(shape(":kucing:", "kucing.sticker.png", "image/png", 10), Some("kucing"));
        assert_eq!(shape("kucing", "kucing.sticker.png", "image/png", 10), None);
        assert_eq!(shape(":kucing: hai", "kucing.sticker.png", "image/png", 10), None);
        assert_eq!(shape(":kucing:", "kucing.png", "image/png", 10), None);
        assert_eq!(shape(":kucing:", "kucing.sticker.png", "image/webp", 10), None);
        assert_eq!(shape(":kucing:", "kucing.sticker.png", "image/png", 0), None);
        assert_eq!(
            shape(":kucing:", "kucing.sticker.png", "image/png", MAX_STICKER_BYTES + 1),
            None
        );
    }
}
