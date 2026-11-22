//! May the author make this record? (plan sections 2 and 4.)
//!
//! Three answers. `Accept`: store and apply. `Reject`: a rule that will not
//! change (a guest in chat pribadi, `#umum` archived, an author removed
//! before the record's time); logged. `Defer`: this laptop cannot judge yet
//! (unknown channel, author not yet in the team or project according to the
//! local membership log, unknown author); neither stored nor logged, the
//! record is offered again on the next sync.
//!
//! A removed author's records are judged as of their time: accepted when
//! `at` is before `removed_at`. The derived tables no longer say which teams
//! the author was in then, so content records (messages, receipts, channels,
//! envelopes) are accepted for any conversation their kind allows, while
//! admin records (archive, channel delete, deleting someone else's message)
//! are refused because the admin right cannot be checked any more.

use rusqlite::OptionalExtension;
use time::OffsetDateTime;

use super::audience::{ConvInfo, Ctx, Scope};
use super::model::{Body, ChannelScope, CipherFileRef, Rejection, VerifiedRecord, channel_conv};
use crate::blobs::AUTO_REPLICATE_MAX_BYTES;
use crate::error::AppResult;

/// Envelopes older than this are purged unopened (plan section 5).
pub const ENVELOPE_TTL: time::Duration = time::Duration::days(30);

/// Largest cipher file an envelope may point at.
pub fn max_cipher_bytes() -> u64 {
    super::seal::cipher_len(AUTO_REPLICATE_MAX_BYTES)
}

/// True when an envelope made at `at` is past [`ENVELOPE_TTL`].
pub fn envelope_expired(at: OffsetDateTime, now: OffsetDateTime) -> bool {
    at + ENVELOPE_TTL < now
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Accept,
    Defer,
    Reject(Rejection),
}

fn reject(code: &'static str, detail: &str) -> Verdict {
    Verdict::Reject(Rejection::new(code, detail))
}

fn forbidden(detail: &str) -> Verdict {
    reject("forbidden", detail)
}

/// Where the author stood at the record's time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Standing {
    Active,
    RemovedBefore,
}

fn standing(ctx: &Ctx, author: &str, at: OffsetDateTime) -> Result<Standing, Verdict> {
    match ctx.dir.member(author) {
        None => Err(Verdict::Defer),
        Some(m) if m.active => Ok(Standing::Active),
        Some(m) => match m.removed_at {
            Some(removed) if at < removed => Ok(Standing::RemovedBefore),
            _ => Err(reject("removed", "pembuat sudah dikeluarkan dari organisasi")),
        },
    }
}

fn is_guest(ctx: &Ctx, pk: &str) -> bool {
    ctx.dir.member(pk).is_some_and(|m| m.guest)
}

pub fn judge(ctx: &Ctx, rec: &VerifiedRecord, now: OffsetDateTime) -> AppResult<Verdict> {
    let author = rec.author();
    let st = match standing(ctx, author, rec.at) {
        Ok(s) => s,
        Err(v) => return Ok(v),
    };
    match rec.body() {
        Body::ChannelCreate { channel, scope, .. } => channel_create(ctx, rec, st, channel, scope),
        Body::ChannelArchive { conv, .. } | Body::ChannelDelete { conv } => {
            channel_admin(ctx, rec, st, conv)
        }
        Body::Message { conv, reply_to, .. } => {
            let Some(info) = ctx.conv(conv)? else {
                return Ok(Verdict::Defer);
            };
            if info.deleted {
                return Ok(Verdict::Accept);
            }
            if let Some(reply) = reply_to
                && reply_in_other_conv(ctx, reply, conv)?
            {
                return Ok(forbidden("balasan menunjuk pesan di percakapan lain"));
            }
            may_post(ctx, &info, author, rec.at, st)
        }
        Body::Receipt { conv, .. } => {
            let Some(info) = ctx.conv(conv)? else {
                return Ok(Verdict::Defer);
            };
            if info.deleted {
                return Ok(Verdict::Accept);
            }
            may_post(ctx, &info, author, rec.at, st)
        }
        Body::MessageDelete {
            conv,
            message,
            message_author,
            ..
        } => message_delete(ctx, rec, st, conv, message, message_author),
        Body::Envelope { to, cipher_files, .. } => envelope(ctx, rec, st, to, cipher_files, now),
        Body::EnvelopeAck { envelope } => {
            let recipient: Option<String> = ctx
                .conn
                .query_row(
                    "SELECT recipient FROM chat_envelopes WHERE id = ?1",
                    [envelope],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(match recipient {
                Some(r) if r != author => forbidden("tanda terima titipan bukan dari penerimanya"),
                _ => Verdict::Accept,
            })
        }
    }
}

fn reply_in_other_conv(ctx: &Ctx, reply: &str, conv: &str) -> AppResult<bool> {
    let stored: Option<String> = ctx
        .conn
        .query_row(
            "SELECT conv FROM chat_messages WHERE id = ?1 AND placeholder = 0",
            [reply],
            |r| r.get(0),
        )
        .optional()?;
    Ok(stored.is_some_and(|c| c != conv))
}

/// Envelope rights: author and recipient are active members who share a
/// conversation (a pair allowed in chat pribadi, or a common channel). Guests
/// may be custodians; that is a matter of who receives envelopes, not here.
fn envelope(
    ctx: &Ctx,
    rec: &VerifiedRecord,
    st: Standing,
    to: &str,
    cipher_files: &[CipherFileRef],
    now: OffsetDateTime,
) -> AppResult<Verdict> {
    if cipher_files.iter().any(|f| f.size > max_cipher_bytes()) {
        return Ok(reject("bad_format", "file titipan terlalu besar"));
    }
    if st != Standing::Active {
        return Ok(forbidden("pembuat titipan sudah dikeluarkan"));
    }
    match ctx.dir.member(to) {
        None => return Ok(Verdict::Defer),
        Some(m) if !m.active => return Ok(forbidden("penerima titipan sudah dikeluarkan")),
        Some(_) => {}
    }
    if envelope_expired(rec.at, now) {
        // Stored as purged so it is known and never offered.
        return Ok(Verdict::Accept);
    }
    if ctx.share_conversation(rec.author(), to)? {
        Ok(Verdict::Accept)
    } else {
        Ok(Verdict::Defer)
    }
}

/// Message and receipt rights: a member of the conversation.
fn may_post(
    ctx: &Ctx,
    info: &ConvInfo,
    author: &str,
    at: OffsetDateTime,
    st: Standing,
) -> AppResult<Verdict> {
    if let Scope::Direct(a, b) = &info.scope {
        return Ok(direct_rights(ctx, a, b, author, at));
    }
    if st == Standing::Active && ctx.in_audience(info, author)? {
        return Ok(Verdict::Accept);
    }
    let guest = is_guest(ctx, author);
    Ok(match (&info.scope, st) {
        (Scope::Umum | Scope::Org, _) if guest => forbidden("tamu tidak bisa menulis di channel kantor"),
        (_, Standing::RemovedBefore) => Verdict::Accept,
        (Scope::Umum | Scope::Org, Standing::Active) => Verdict::Accept,
        // Team or project membership may not have reached this laptop yet.
        _ => Verdict::Defer,
    })
}

fn direct_rights(ctx: &Ctx, a: &str, b: &str, author: &str, at: OffsetDateTime) -> Verdict {
    let other = if author == a {
        b
    } else if author == b {
        a
    } else {
        return forbidden("pembuat bukan peserta chat pribadi ini");
    };
    if is_guest(ctx, author) {
        return forbidden("tamu tidak bisa memakai chat pribadi");
    }
    match ctx.dir.member(other) {
        None => Verdict::Defer,
        Some(m) if m.guest => forbidden("tamu tidak bisa diajak chat pribadi"),
        Some(m) if m.active => Verdict::Accept,
        Some(m) if m.removed_at.is_some_and(|r| at < r) => Verdict::Accept,
        Some(_) => forbidden("rekan chat pribadi sudah dikeluarkan"),
    }
}

fn channel_create(
    ctx: &Ctx,
    rec: &VerifiedRecord,
    st: Standing,
    channel: &str,
    scope: &ChannelScope,
) -> AppResult<Verdict> {
    let author = rec.author();
    let conv = channel_conv(channel);
    if channel == ctx.dir.umum
        || ctx.dir.log_channels.contains_key(channel)
        || ctx.projects.project(ctx.conn, channel)?.is_some()
    {
        return Ok(reject("channel_exists", "id channel sudah dipakai"));
    }
    let existing: Option<Option<String>> = ctx
        .conn
        .query_row(
            "SELECT scope_kind FROM chat_channels WHERE conv = ?1",
            [&conv],
            |r| r.get(0),
        )
        .optional()?;
    if matches!(existing, Some(Some(_))) {
        return Ok(reject("channel_exists", "id channel sudah dipakai"));
    }
    if is_guest(ctx, author) {
        return Ok(forbidden("tamu tidak bisa membuat channel"));
    }
    if st == Standing::RemovedBefore {
        return Ok(match scope {
            ChannelScope::Org => forbidden("hak superadmin pembuat yang sudah dikeluarkan tidak bisa diperiksa"),
            _ => Verdict::Accept,
        });
    }
    Ok(match scope {
        // PRD F-CHAT-01: members make channels in their team or project;
        // office-wide channels are for superadmins.
        ChannelScope::Org if ctx.dir.is_superadmin(author) => Verdict::Accept,
        ChannelScope::Team { id } if ctx.dir.in_team(id, author) => Verdict::Accept,
        ChannelScope::Project { id } if ctx.projects.is_member(ctx.conn, id, author)? => {
            Verdict::Accept
        }
        _ => Verdict::Defer,
    })
}

fn channel_admin(ctx: &Ctx, rec: &VerifiedRecord, st: Standing, conv: &str) -> AppResult<Verdict> {
    let Some(info) = ctx.conv(conv)? else {
        return Ok(Verdict::Defer);
    };
    if info.scope == Scope::Umum {
        return Ok(forbidden("#umum tidak bisa diarsipkan atau dihapus"));
    }
    admin_rights(ctx, &info, rec.author(), st)
}

fn admin_rights(ctx: &Ctx, info: &ConvInfo, author: &str, st: Standing) -> AppResult<Verdict> {
    if st == Standing::RemovedBefore {
        return Ok(forbidden("hak admin pembuat yang sudah dikeluarkan tidak bisa diperiksa"));
    }
    if ctx.is_admin(info, author)? {
        return Ok(Verdict::Accept);
    }
    if is_guest(ctx, author) || matches!(info.scope, Scope::Direct(..)) {
        return Ok(forbidden("bukan admin percakapan ini"));
    }
    // An admin grant may not have reached this laptop yet.
    Ok(Verdict::Defer)
}

fn message_delete(
    ctx: &Ctx,
    rec: &VerifiedRecord,
    st: Standing,
    conv: &str,
    message: &str,
    claimed_author: &str,
) -> AppResult<Verdict> {
    let Some(info) = ctx.conv(conv)? else {
        return Ok(Verdict::Defer);
    };
    if info.deleted {
        return Ok(Verdict::Accept);
    }
    let author = rec.author();
    let post = may_post(ctx, &info, author, rec.at, st)?;
    if post != Verdict::Accept {
        return Ok(post);
    }
    let stored: Option<(String, String)> = ctx
        .conn
        .query_row(
            "SELECT author, conv FROM chat_messages WHERE id = ?1 AND placeholder = 0",
            [message],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((real_author, real_conv)) = &stored {
        if real_conv != conv {
            return Ok(forbidden("pesan tidak ada di percakapan itu"));
        }
        if real_author != claimed_author {
            return Ok(forbidden("pembuat pesan yang disebut tidak cocok"));
        }
    }
    if author == claimed_author {
        return Ok(Verdict::Accept);
    }
    admin_rights(ctx, &info, author, st)
}

/// Whether a stored `message_delete` by `deleter` removes a message by
/// `message_author` (used when the message arrives after the delete).
pub fn delete_applies(
    ctx: &Ctx,
    info: &ConvInfo,
    delete_conv: &str,
    deleter: &str,
    message_author: &str,
) -> AppResult<bool> {
    if delete_conv != info.conv {
        return Ok(false);
    }
    if deleter == message_author {
        return Ok(true);
    }
    if matches!(info.scope, Scope::Direct(..)) {
        return Ok(false);
    }
    ctx.is_admin(info, deleter)
}
