//! Envelopes (titipan, plan section 5): storing, opening, acking, purging.
//!
//! Any member may hold an envelope; only its recipient can open it. The
//! recipient acks on every final outcome (message stored with its sealed
//! files, an envelope that cannot be opened, an invalid inner record, files
//! that could not be obtained), because the ack is what lets custodians drop
//! the envelope. An ack counts only when its author is the envelope's
//! recipient; one that arrives first waits in `chat_records` for its envelope.

use rusqlite::{OptionalExtension, params};
use time::OffsetDateTime;

use super::{Effects, apply, create, insert_record, is_known, purge_record};
use crate::blobs::{BlobHash, BlobStore};
use crate::chat::audience::Ctx;
use crate::chat::fetch::{self, FetchKind, PRIORITY_MINE};
use crate::chat::judge::{self, Verdict, envelope_expired};
use crate::chat::model::{Body, CipherFileRef, FileRef, Rejection, VerifiedRecord, parse_stored, verify_record};
use crate::chat::seal::{self, FileKey};
use crate::error::AppResult;
use crate::identity::Identity;
use crate::permissions::{self, format::parse_time};

/// `chat_envelopes.acked` values.
pub const LIVE: i64 = 0;
pub const ACKED: i64 = 1;
pub const EXPIRED: i64 = 2;

pub(super) fn apply_envelope(
    ctx: &Ctx,
    rec: &VerifiedRecord,
    from: Option<&str>,
    now: OffsetDateTime,
    fx: &mut Effects,
) -> AppResult<()> {
    let Body::Envelope { to, cipher_files, .. } = rec.body() else {
        return Ok(());
    };
    let conn = ctx.conn;
    let acked = has_valid_ack(ctx, &rec.id, to)?;
    let expired = envelope_expired(rec.at, now);
    let state = if acked {
        ACKED
    } else if expired {
        EXPIRED
    } else {
        LIVE
    };
    insert_record(conn, rec, state == LIVE, from, now)?;
    conn.execute(
        "INSERT OR IGNORE INTO chat_envelopes (id, author, recipient, at, cipher_files, acked)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            rec.id,
            rec.author(),
            to,
            crate::permissions::format::format_time(rec.at),
            serde_json::to_string(cipher_files).unwrap_or_else(|_| "[]".into()),
            state
        ],
    )?;
    if state == LIVE && to != ctx.me() && rec.author() != ctx.me() {
        // Custodian: keep the cipher files for the recipient.
        let prefer = prefer_list(&[from, Some(rec.author())]);
        queue_ciphers(ctx, cipher_files, None, &prefer, 0, fx)?;
    }
    Ok(())
}

fn prefer_list(keys: &[Option<&str>]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for k in keys.iter().flatten() {
        if !out.iter().any(|o| o == k) {
            out.push((*k).to_owned());
        }
    }
    out
}

fn queue_ciphers(
    ctx: &Ctx,
    files: &[CipherFileRef],
    plain_of: Option<&dyn Fn(&str) -> Option<String>>,
    prefer: &[String],
    priority: i64,
    fx: &mut Effects,
) -> AppResult<()> {
    let now = crate::permissions::format::format_time(crate::clock::now());
    for f in files {
        if f.size > judge::max_cipher_bytes() {
            continue;
        }
        let plain = plain_of.and_then(|p| p(&f.hash));
        fetch::queue(ctx.conn, &f.hash, FetchKind::Cipher, f.size, plain.as_deref(), prefer, priority, &now)?;
        fx.queued = true;
    }
    Ok(())
}

fn has_valid_ack(ctx: &Ctx, envelope: &str, recipient: &str) -> AppResult<bool> {
    let n: i64 = ctx.conn.query_row(
        "SELECT count(*) FROM chat_records WHERE target = ?1 AND kind = 'envelope_ack' AND author = ?2",
        params![envelope, recipient],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

pub(super) fn apply_ack(ctx: &Ctx, author: &str, envelope: &str, fx: &mut Effects) -> AppResult<()> {
    let row: Option<(String, i64)> = ctx
        .conn
        .query_row(
            "SELECT recipient, acked FROM chat_envelopes WHERE id = ?1",
            [envelope],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((recipient, LIVE)) = row
        && recipient == author
    {
        purge(ctx, envelope, ACKED, fx)?;
    }
    Ok(())
}

/// Drops an envelope's content and cipher files nobody else needs.
pub fn purge(ctx: &Ctx, envelope: &str, state: i64, fx: &mut Effects) -> AppResult<()> {
    let conn = ctx.conn;
    let ciphers: String = conn.query_row(
        "SELECT cipher_files FROM chat_envelopes WHERE id = ?1",
        [envelope],
        |r| r.get(0),
    )?;
    purge_record(conn, envelope)?;
    conn.execute(
        "UPDATE chat_envelopes SET acked = ?2, file_keys = NULL WHERE id = ?1",
        params![envelope, state],
    )?;
    let ciphers: Vec<CipherFileRef> = serde_json::from_str(&ciphers).unwrap_or_default();
    for c in ciphers {
        let pattern = format!("%\"{}\"%", c.hash);
        let live: i64 = conn.query_row(
            "SELECT count(*) FROM chat_envelopes WHERE acked = 0 AND cipher_files LIKE ?1",
            [&pattern],
            |r| r.get(0),
        )?;
        if live > 0 {
            continue;
        }
        fetch::unqueue(conn, &c.hash, FetchKind::Cipher)?;
        if fetch::release(conn, &c.hash)? {
            fx.drop_blobs.push(c.hash);
        }
    }
    fx.visible = true;
    Ok(())
}

/// Purges live envelopes past their lifetime or whose recipient is no longer
/// an active member.
pub fn expire(ctx: &Ctx, now: OffsetDateTime, fx: &mut Effects) -> AppResult<()> {
    let mut stmt = ctx
        .conn
        .prepare("SELECT id, recipient, at FROM chat_envelopes WHERE acked = 0")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    for (id, recipient, at) in rows {
        let old = parse_time(&at).is_none_or(|t| envelope_expired(t, now));
        if old || !ctx.dir.is_active(&recipient) {
            purge(ctx, &id, EXPIRED, fx)?;
        }
    }
    Ok(())
}

enum Opened {
    Done { message: String, keys: Vec<FileKey> },
    Later,
    Broken(Rejection),
}

/// Opens every live envelope addressed to this laptop that is not opened
/// yet, then acks the ones whose message and sealed files are complete.
pub fn open_pending(
    ctx: &Ctx,
    identity: &Identity,
    blobs: &BlobStore,
    from: Option<&str>,
    now: OffsetDateTime,
    fx: &mut Effects,
) -> AppResult<()> {
    let mut stmt = ctx.conn.prepare(
        "SELECT e.id, e.author, r.body FROM chat_envelopes e JOIN chat_records r ON r.id = e.id
         WHERE e.recipient = ?1 AND e.opened = 0 AND e.acked = 0 AND r.body IS NOT NULL
         ORDER BY e.at, e.id",
    )?;
    let rows = stmt
        .query_map([ctx.me()], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    for (id, author, body) in rows {
        match open_one(ctx, identity, &author, &body, from, now, fx)? {
            Opened::Done { message, keys } => {
                ctx.conn.execute(
                    "UPDATE chat_envelopes SET opened = 1, message_id = ?2, file_keys = ?3 WHERE id = ?1",
                    params![id, message, serde_json::to_string(&keys).unwrap_or_else(|_| "[]".into())],
                )?;
            }
            Opened::Later => {}
            Opened::Broken(rej) => {
                permissions::log_rejection(ctx.conn, from, None, &format!("chat_{}", rej.code), &rej.detail, now)?;
                ctx.conn.execute(
                    "UPDATE chat_envelopes SET opened = 1, open_error = ?2, file_keys = '[]' WHERE id = ?1",
                    params![id, rej.detail],
                )?;
            }
        }
    }
    complete(ctx, identity, blobs, now, fx)
}

fn open_one(
    ctx: &Ctx,
    identity: &Identity,
    env_author: &str,
    body: &str,
    from: Option<&str>,
    now: OffsetDateTime,
    fx: &mut Effects,
) -> AppResult<Opened> {
    let Ok(stored) = parse_stored(body) else {
        return Ok(Opened::Broken(Rejection::new("bad_envelope", "titipan rusak")));
    };
    let Body::Envelope { sealed, cipher_files, .. } = stored.body() else {
        return Ok(Opened::Broken(Rejection::new("bad_envelope", "bukan titipan")));
    };
    let content = match seal::open_sealed(identity, sealed) {
        Ok(c) => c,
        Err(e) => return Ok(Opened::Broken(Rejection::new("bad_envelope", e))),
    };
    let inner = match verify_record(&content.record, &ctx.dir.org_id, now) {
        Ok(r) => r,
        Err(r) if r.code == "future" => return Ok(Opened::Later),
        Err(r) => return Ok(Opened::Broken(r)),
    };
    let Body::Message { files, .. } = inner.body() else {
        return Ok(Opened::Broken(Rejection::new("envelope_mismatch", "isi titipan bukan pesan")));
    };
    if inner.author() != env_author {
        return Ok(Opened::Broken(Rejection::new(
            "envelope_mismatch",
            "pembuat pesan berbeda dengan pembuat titipan",
        )));
    }
    let keys = usable_keys(&content.files, files, cipher_files);
    if !is_known(ctx.conn, &inner.id)? {
        match judge::judge(ctx, &inner, now)? {
            Verdict::Accept => {
                let before = fx.new_messages.len();
                apply(ctx, &inner, from, now, fx)?;
                for m in &mut fx.new_messages[before..] {
                    m.via_envelope = true;
                }
            }
            Verdict::Defer => return Ok(Opened::Later),
            Verdict::Reject(r) => return Ok(Opened::Broken(r)),
        }
    }
    Ok(Opened::Done {
        message: inner.id.clone(),
        keys,
    })
}

/// Keys whose plain hash is a small file of the message and whose cipher
/// file is listed in the envelope.
fn usable_keys(keys: &[FileKey], files: &[FileRef], ciphers: &[CipherFileRef]) -> Vec<FileKey> {
    keys.iter()
        .filter(|k| files.iter().any(|f| f.hash == k.hash))
        .filter(|k| ciphers.iter().any(|c| c.hash == k.cipher))
        .filter(|k| seal::parse_file_key(&k.key).is_ok())
        .cloned()
        .collect()
}

/// For opened, unacked envelopes to this laptop: decrypt cipher files that
/// are present, queue the missing ones, ack when nothing is left.
pub fn complete(
    ctx: &Ctx,
    identity: &Identity,
    blobs: &BlobStore,
    now: OffsetDateTime,
    fx: &mut Effects,
) -> AppResult<()> {
    let mut stmt = ctx.conn.prepare(
        "SELECT e.id, e.author, e.cipher_files,
                CASE WHEN m.deleted = 0 THEN e.file_keys ELSE NULL END
         FROM chat_envelopes e LEFT JOIN chat_messages m ON m.id = e.message_id
         WHERE e.recipient = ?1 AND e.opened = 1 AND e.acked = 0",
    )?;
    let rows = stmt
        .query_map([ctx.me()], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    // A deleted (or purged) message needs none of its files.
    for (id, author, ciphers, keys) in rows {
        let keys: Vec<FileKey> = keys.and_then(|k| serde_json::from_str(&k).ok()).unwrap_or_default();
        let ciphers: Vec<CipherFileRef> = serde_json::from_str(&ciphers).unwrap_or_default();
        let mut pending = Vec::new();
        for k in &keys {
            match plain_ready(ctx, blobs, k, now)? {
                Ready::Yes => {}
                Ready::GiveUp => drop_key(ctx, &id, &k.cipher)?,
                Ready::No => pending.extend(ciphers.iter().filter(|c| c.hash == k.cipher).cloned()),
            }
        }
        if pending.is_empty() {
            create(ctx, identity, Body::EnvelopeAck { envelope: id }, now, fx)?;
        } else {
            let prefer = prefer_list(&[Some(author.as_str())]);
            let plain_of = |cipher: &str| keys.iter().find(|k| k.cipher == cipher).map(|k| k.hash.clone());
            queue_ciphers(ctx, &pending, Some(&plain_of), &prefer, PRIORITY_MINE, fx)?;
        }
    }
    Ok(())
}

enum Ready {
    Yes,
    No,
    GiveUp,
}

fn plain_ready(ctx: &Ctx, blobs: &BlobStore, k: &FileKey, now: OffsetDateTime) -> AppResult<Ready> {
    let now_s = crate::permissions::format::format_time(now);
    let (Ok(plain), Ok(cipher)) = (BlobHash::parse(&k.hash), BlobHash::parse(&k.cipher)) else {
        return Ok(Ready::GiveUp);
    };
    if blobs.contains(&plain) {
        fetch::track(ctx.conn, &k.hash, FetchKind::Plain, true, &now_s)?;
        return Ok(Ready::Yes);
    }
    if !blobs.contains(&cipher) {
        return Ok(Ready::No);
    }
    let Ok(key) = seal::parse_file_key(&k.key) else {
        return Ok(Ready::GiveUp);
    };
    let bytes = blobs.read_all(&cipher)?;
    match seal::decrypt_file(&key, &bytes) {
        Ok(p) if BlobHash::of_bytes(&p) == plain => {
            fetch::put_tracked_bytes(ctx.conn, blobs, &p, FetchKind::Plain, &now_s)?;
            fx_unqueue_plain(ctx, &k.hash)?;
            Ok(Ready::Yes)
        }
        _ => {
            permissions::log_rejection(
                ctx.conn,
                None,
                None,
                "chat_bad_cipher_file",
                "file titipan tidak bisa dibuka atau isinya tidak cocok",
                now,
            )?;
            Ok(Ready::GiveUp)
        }
    }
}

fn fx_unqueue_plain(ctx: &Ctx, hash: &str) -> AppResult<()> {
    fetch::unqueue(ctx.conn, hash, FetchKind::Plain)
}

/// Gives up on one sealed file of an envelope (it could not be obtained).
pub fn drop_key(ctx: &Ctx, envelope: &str, cipher: &str) -> AppResult<()> {
    let keys: Option<String> = ctx
        .conn
        .query_row("SELECT file_keys FROM chat_envelopes WHERE id = ?1", [envelope], |r| r.get(0))
        .optional()?
        .flatten();
    let mut keys: Vec<FileKey> = keys.and_then(|k| serde_json::from_str(&k).ok()).unwrap_or_default();
    keys.retain(|k| k.cipher != cipher);
    ctx.conn.execute(
        "UPDATE chat_envelopes SET file_keys = ?2 WHERE id = ?1",
        params![envelope, serde_json::to_string(&keys).unwrap_or_else(|_| "[]".into())],
    )?;
    Ok(())
}

/// A cipher download was dropped for good: every envelope of mine that
/// waited for it gives up on that file (and is acked by `complete`).
pub fn give_up_cipher(ctx: &Ctx, cipher: &str) -> AppResult<()> {
    let pattern = format!("%\"{cipher}\"%");
    let mut stmt = ctx.conn.prepare(
        "SELECT id FROM chat_envelopes WHERE recipient = ?1 AND opened = 1 AND acked = 0 AND file_keys LIKE ?2",
    )?;
    let ids = stmt
        .query_map(params![ctx.me(), pattern], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for id in ids {
        drop_key(ctx, &id, cipher)?;
    }
    Ok(())
}
