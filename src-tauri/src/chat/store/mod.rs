//! Storing records and applying them to the derived tables.
//!
//! Every function here runs inside the caller's transaction and assumes the
//! record was verified (`model::verify_record`) and judged (`judge::judge`).
//! Applying is idempotent: `chat_records` is checked first by the callers and
//! inserts use `OR IGNORE`.
//!
//! Purging keeps the `chat_records` row with `body` NULL: the id stays known,
//! so the record is neither accepted nor offered again.

pub mod envelope;

use rusqlite::{Connection, OptionalExtension, params};
use time::OffsetDateTime;

use super::audience::{ConvInfo, Ctx};
use super::fetch::{self, FetchKind};
use super::hooks::MessageNotification;
use super::judge;
use super::model::{Body, ChannelScope, FileRef, ReceiptState, VerifiedRecord, parse_stored};
use crate::error::AppResult;
use crate::identity::Identity;
use crate::permissions::format::{format_time, parse_time};

/// A message from someone else stored in this call.
#[derive(Debug, Clone)]
pub struct NewMessage {
    pub id: String,
    pub conv: String,
    pub author: String,
    pub text: String,
    pub mentions: Vec<String>,
    pub files: Vec<FileRef>,
    /// Came out of an envelope: its small files arrive as cipher files.
    pub via_envelope: bool,
}

/// What applying records did, acted on after the transaction commits.
#[derive(Debug, Default)]
pub struct Effects {
    pub new_messages: Vec<NewMessage>,
    /// Something the chat screen shows changed.
    pub visible: bool,
    /// This laptop signed new records (offer them to peers).
    pub created: bool,
    /// The download queue got work.
    pub queued: bool,
    /// Blobs chat created that nothing references any more.
    pub drop_blobs: Vec<String>,
    /// Files no message carries any more: their opened copies under
    /// `<data_dir>/chat-files/<hash>/` are removed.
    pub drop_open: Vec<String>,
    pub notifications: Vec<MessageNotification>,
}

pub fn is_known(conn: &Connection, id: &str) -> AppResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM chat_records WHERE id = ?1",
        [id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// Of `ids`, those not in `chat_records` (purged rows count as known).
pub fn unknown_ids(conn: &Connection, ids: &[String]) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare_cached("SELECT count(*) FROM chat_records WHERE id = ?1")?;
    let mut out = Vec::new();
    for id in ids {
        let n: i64 = stmt.query_row([id], |r| r.get(0))?;
        if n == 0 {
            out.push(id.clone());
        }
    }
    Ok(out)
}

fn target_of(body: &Body) -> Option<&str> {
    match body {
        Body::MessageDelete { message, .. } => Some(message),
        Body::EnvelopeAck { envelope, .. } => Some(envelope),
        _ => None,
    }
}

/// Inserts the record row; `keep_body` false stores it purged.
pub(crate) fn insert_record(
    conn: &Connection,
    rec: &VerifiedRecord,
    keep_body: bool,
    from: Option<&str>,
    now: OffsetDateTime,
) -> AppResult<()> {
    let body = rec.body();
    conn.execute(
        "INSERT OR IGNORE INTO chat_records
           (id, kind, conv, author, at, target, body, received_at, received_from)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            rec.id,
            body.kind(),
            body.conv(),
            rec.author(),
            format_time(rec.at),
            target_of(body),
            keep_body.then_some(rec.body_json.as_str()),
            format_time(now),
            from,
        ],
    )?;
    Ok(())
}

/// Removes a stored body, keeping the row as a marker.
pub(crate) fn purge_record(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("UPDATE chat_records SET body = NULL WHERE id = ?1", [id])?;
    Ok(())
}

/// Signs `body` as this laptop, applies it and marks that peers should be told.
pub fn create(
    ctx: &Ctx,
    identity: &Identity,
    body: Body,
    now: OffsetDateTime,
    fx: &mut Effects,
) -> AppResult<VerifiedRecord> {
    let rec = super::model::sign_record(identity, &ctx.dir.org_id, now, body);
    apply(ctx, &rec, None, now, fx)?;
    fx.created = true;
    fx.visible = true;
    Ok(rec)
}

/// Applies one accepted record.
pub fn apply(
    ctx: &Ctx,
    rec: &VerifiedRecord,
    from: Option<&str>,
    now: OffsetDateTime,
    fx: &mut Effects,
) -> AppResult<()> {
    let conn = ctx.conn;
    if let Some(conv) = rec.body().conv()
        && !matches!(
            rec.body(),
            Body::ChannelCreate { .. } | Body::ChannelDelete { .. }
        )
        && ctx.conv(&conv)?.is_some_and(|c| c.deleted)
    {
        // Content for a deleted channel: known, never shown or offered.
        return insert_record(conn, rec, false, from, now);
    }
    match rec.body() {
        Body::ChannelCreate {
            channel,
            name,
            scope,
        } => {
            insert_record(conn, rec, true, from, now)?;
            channel_create(ctx, rec, channel, name, scope)?;
            fx.visible = true;
        }
        Body::ChannelArchive { conv, archived } => {
            insert_record(conn, rec, true, from, now)?;
            channel_archive(ctx, rec, conv, *archived)?;
            fx.visible = true;
        }
        Body::ChannelDelete { conv } => {
            insert_record(conn, rec, true, from, now)?;
            channel_delete(ctx, conv, fx)?;
            fx.visible = true;
        }
        Body::Message { .. } => message(ctx, rec, from, now, fx)?,
        Body::MessageDelete { .. } => message_delete(ctx, rec, from, now, fx)?,
        Body::Receipt {
            conv,
            state,
            messages,
        } => {
            insert_record(conn, rec, true, from, now)?;
            receipt(conn, rec, conv, *state, messages)?;
            fx.visible = true;
        }
        Body::Envelope { .. } => envelope::apply_envelope(ctx, rec, from, now, fx)?,
        Body::EnvelopeAck { envelope, failed } => {
            insert_record(conn, rec, true, from, now)?;
            envelope::apply_ack(ctx, rec.author(), envelope, *failed, fx)?;
        }
        // Derived on read from `chat_records` (`audience::Ctx::group`,
        // `Ctx::locked`): storing the record is the whole effect.
        Body::ChannelLock { conv, .. } => {
            insert_record(conn, rec, true, from, now)?;
            ctx.forget(conv);
            fx.visible = true;
        }
        Body::GroupCreate { .. }
        | Body::GroupAdd { .. }
        | Body::GroupRemove { .. }
        | Body::GroupRename { .. } => {
            insert_record(conn, rec, true, from, now)?;
            if let Some(conv) = rec.body().conv() {
                ctx.forget(&conv);
            }
            fx.visible = true;
        }
        Body::Reaction { .. } => super::reactions::apply(ctx, rec, from, now, fx)?,
        Body::StickerSet { .. } => super::stickers::apply(ctx, rec, from, now, fx)?,
    }
    Ok(())
}

fn channel_create(
    ctx: &Ctx,
    rec: &VerifiedRecord,
    channel: &str,
    name: &str,
    scope: &ChannelScope,
) -> AppResult<()> {
    let conv = super::model::channel_conv(channel);
    let (kind, id) = match scope {
        ChannelScope::Org => ("org", None),
        ChannelScope::Team { id } => ("team", Some(id.as_str())),
        ChannelScope::Project { id } => ("project", Some(id.as_str())),
    };
    ctx.conn.execute(
        "INSERT INTO chat_channels (conv, name, scope_kind, scope_id, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (conv) DO UPDATE SET name = excluded.name, scope_kind = excluded.scope_kind,
           scope_id = excluded.scope_id, created_by = excluded.created_by,
           created_at = excluded.created_at",
        params![conv, name, kind, id, rec.author(), format_time(rec.at)],
    )?;
    ctx.forget(&conv);
    Ok(())
}

/// Last writer wins on `(at, id)`, so every laptop ends in the same state
/// whatever order the records arrive in.
fn channel_archive(ctx: &Ctx, rec: &VerifiedRecord, conv: &str, archived: bool) -> AppResult<()> {
    ctx.conn.execute(
        "INSERT INTO chat_channels (conv, archived, archive_at, archive_id) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (conv) DO UPDATE SET archived = excluded.archived,
           archive_at = excluded.archive_at, archive_id = excluded.archive_id
         WHERE chat_channels.archive_at IS NULL
            OR (excluded.archive_at, excluded.archive_id)
               > (chat_channels.archive_at, chat_channels.archive_id)",
        params![conv, archived, format_time(rec.at), rec.id],
    )?;
    ctx.forget(conv);
    Ok(())
}

fn channel_delete(ctx: &Ctx, conv: &str, fx: &mut Effects) -> AppResult<()> {
    let conn = ctx.conn;
    conn.execute(
        "INSERT INTO chat_channels (conv, deleted) VALUES (?1, 1)
         ON CONFLICT (conv) DO UPDATE SET deleted = 1",
        [conv],
    )?;
    let hashes = file_hashes(
        conn,
        "SELECT f.hash FROM chat_files f JOIN chat_messages m ON m.id = f.message_id WHERE m.conv = ?1",
        conv,
    )?;
    conn.execute(
        "UPDATE chat_records SET body = NULL
         WHERE conv = ?1 AND kind NOT IN ('channel_create', 'channel_delete')",
        [conv],
    )?;
    conn.execute("DELETE FROM chat_messages WHERE conv = ?1", [conv])?;
    conn.execute("DELETE FROM chat_receipts WHERE conv = ?1", [conv])?;
    conn.execute("DELETE FROM chat_reactions WHERE conv = ?1", [conv])?;
    release_files(conn, conv, &hashes, fx)?;
    ctx.forget(conv);
    Ok(())
}

fn file_hashes(conn: &Connection, sql: &str, arg: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map([arg], |r| r.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(rows)
}

/// After messages of `conv` lost their files: forgets that a file is held for
/// `conv` when no message there carries it, and drops downloads, opened
/// copies and chat-created blobs no message needs any more.
fn release_files(
    conn: &Connection,
    conv: &str,
    hashes: &[String],
    fx: &mut Effects,
) -> AppResult<()> {
    for h in hashes {
        let in_conv: i64 = conn.query_row(
            "SELECT count(*) FROM chat_files f JOIN chat_messages m ON m.id = f.message_id
             WHERE f.hash = ?1 AND m.conv = ?2 AND m.deleted = 0",
            params![h, conv],
            |r| r.get(0),
        )?;
        if in_conv == 0 {
            fetch::forget_conv(conn, h, conv)?;
        }
        let still: i64 = conn.query_row(
            "SELECT count(*) FROM chat_files WHERE hash = ?1",
            [h],
            |r| r.get(0),
        )?;
        if still > 0 {
            continue;
        }
        fx.drop_open.push(h.clone());
        fetch::unqueue(conn, h, FetchKind::Plain)?;
        if fetch::release(conn, h)? {
            fx.drop_blobs.push(h.clone());
        }
    }
    Ok(())
}

/// Stored deletes for `message` that remove a message by `author` in `info`.
fn valid_delete_exists(ctx: &Ctx, info: &ConvInfo, message: &str, author: &str) -> AppResult<bool> {
    let mut stmt = ctx.conn.prepare(
        "SELECT body FROM chat_records WHERE target = ?1 AND kind = 'message_delete' AND body IS NOT NULL",
    )?;
    let bodies = stmt
        .query_map([message], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for body in bodies {
        let Ok(d) = parse_stored(&body) else { continue };
        let Body::MessageDelete { conv, .. } = d.body() else {
            continue;
        };
        if judge::delete_applies(ctx, info, conv, d.author(), author)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn message(
    ctx: &Ctx,
    rec: &VerifiedRecord,
    from: Option<&str>,
    now: OffsetDateTime,
    fx: &mut Effects,
) -> AppResult<()> {
    let Body::Message {
        conv,
        text,
        reply_to,
        mentions,
        files,
    } = rec.body()
    else {
        return Ok(());
    };
    let conn = ctx.conn;
    let Some(info) = ctx.conv(conv)? else {
        return insert_record(conn, rec, false, from, now);
    };
    let at = format_time(rec.at);
    conn.execute("DELETE FROM chat_messages WHERE id = ?1", [&rec.id])?;
    fx.visible = true;
    if valid_delete_exists(ctx, &info, &rec.id, rec.author())? {
        insert_record(conn, rec, false, from, now)?;
        conn.execute(
            "INSERT INTO chat_messages (id, conv, author, at, deleted) VALUES (?1, ?2, ?3, ?4, 1)",
            params![rec.id, conv, rec.author(), at],
        )?;
        return Ok(());
    }
    insert_record(conn, rec, true, from, now)?;
    conn.execute(
        "INSERT INTO chat_messages (id, conv, author, at, text, reply_to, mentions)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            rec.id,
            conv,
            rec.author(),
            at,
            text,
            reply_to,
            serde_json::to_string(mentions).unwrap_or_else(|_| "[]".into())
        ],
    )?;
    let mut stmt = conn.prepare_cached(
        "INSERT INTO chat_files (message_id, idx, hash, size, name, mime) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for (i, f) in files.iter().enumerate() {
        stmt.execute(params![
            rec.id,
            i64::try_from(i).unwrap_or(0),
            f.hash,
            i64::try_from(f.size).unwrap_or(i64::MAX),
            f.name,
            f.mime
        ])?;
    }
    if rec.author() != ctx.me() {
        fx.new_messages.push(NewMessage {
            id: rec.id.clone(),
            conv: conv.clone(),
            author: rec.author().to_owned(),
            text: text.clone(),
            mentions: mentions.clone(),
            files: files.clone(),
            via_envelope: false,
        });
    }
    Ok(())
}

fn message_delete(
    ctx: &Ctx,
    rec: &VerifiedRecord,
    from: Option<&str>,
    now: OffsetDateTime,
    fx: &mut Effects,
) -> AppResult<()> {
    let Body::MessageDelete {
        conv,
        message,
        message_author,
        message_at,
    } = rec.body()
    else {
        return Ok(());
    };
    let conn = ctx.conn;
    insert_record(conn, rec, true, from, now)?;
    fx.visible = true;
    let row: Option<(bool, String, String)> = conn
        .query_row(
            "SELECT placeholder, author, conv FROM chat_messages WHERE id = ?1",
            [message],
            |r| Ok((r.get::<_, i64>(0)? != 0, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    match row {
        // Checked against the real message the same way as a message that
        // arrives after its delete (`valid_delete_exists`): a delete naming
        // another conversation, or by someone who may not delete the real
        // author's message, is stored and does nothing.
        Some((false, real_author, real_conv)) => {
            let applies = match ctx.conv(&real_conv)? {
                Some(info) => judge::delete_applies(ctx, &info, conv, rec.author(), &real_author)?,
                None => false,
            };
            if !applies {
                return Ok(());
            }
            let hashes = file_hashes(
                conn,
                "SELECT hash FROM chat_files WHERE message_id = ?1",
                message,
            )?;
            conn.execute(
                "UPDATE chat_messages SET deleted = 1, text = '', mentions = '[]', reply_to = NULL
                 WHERE id = ?1",
                [message],
            )?;
            conn.execute("DELETE FROM chat_files WHERE message_id = ?1", [message])?;
            purge_record(conn, message)?;
            release_files(conn, &real_conv, &hashes, fx)?;
        }
        Some((true, ..)) => {}
        None => {
            // Shown as "Pesan dihapus" until the message itself arrives and
            // the delete is checked against its real author.
            let at = parse_time(message_at).map_or_else(|| message_at.clone(), format_time);
            conn.execute(
                "INSERT INTO chat_messages (id, conv, author, at, deleted, placeholder)
                 VALUES (?1, ?2, ?3, ?4, 1, 1)",
                params![message, conv, message_author, at],
            )?;
        }
    }
    Ok(())
}

fn receipt(
    conn: &Connection,
    rec: &VerifiedRecord,
    conv: &str,
    state: ReceiptState,
    messages: &[String],
) -> AppResult<()> {
    let mut stmt = conn.prepare_cached(
        "INSERT OR IGNORE INTO chat_receipts (message_id, reader, state, conv, at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    let at = format_time(rec.at);
    for m in messages {
        stmt.execute(params![m, rec.author(), state.as_str(), conv, at])?;
    }
    Ok(())
}
