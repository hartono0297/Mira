//! Reactions on messages (v0.5.1, docs/plans/chat-sticker.md 2 and 3).
//!
//! A `reaction` record turns one emoji of its author on one message on or
//! off. Per `(message, author, emoji)` the record with the greatest
//! `(at, id)` wins, so every laptop ends with the same chips whatever order
//! the records arrive in. Rows may wait for their message; reactions on a
//! deleted message are not shown. Reactions never notify and never count as
//! unread.

use rusqlite::{Connection, OptionalExtension, params};
use time::{Duration, OffsetDateTime};

use super::audience::{ConvInfo, Ctx};
use super::judge::{self, Standing, Verdict};
use super::model::{Body, VerifiedRecord};
use super::read::{self, readable};
use super::service::require_member;
use super::store::{self, Effects};
use super::sync::ChatSync;
use super::view::ReactionView;
use crate::clock;
use crate::error::{AppError, AppResult};
use crate::permissions::format::{format_time, parse_time};

/// Setting key of the emoji used most recently on this laptop (JSON array).
pub const RECENT_SETTING: &str = "chat.emoji_recent";
/// Longest recent-emoji list.
pub const MAX_RECENT: usize = 24;
/// Most Unicode characters in an emoji.
pub const MAX_EMOJI_CHARS: usize = 16;
/// Most bytes in an emoji.
pub const MAX_EMOJI_BYTES: usize = 64;
/// How far ahead of the clock a quick on/off/on may push a record's time so
/// that it still wins over the previous one of the same second.
const MAX_AHEAD: Duration = Duration::seconds(60);

const ZWJ: char = '\u{200D}';
const VS16: char = '\u{FE0F}';
const KEYCAP: char = '\u{20E3}';

fn bad_emoji() -> String {
    "emoji tidak sah".into()
}

/// Field check for `Body::Reaction::emoji` (called from `model`): a Unicode
/// emoji or an office emote `:nama:`.
pub fn validate_emoji(emoji: &str) -> Result<(), String> {
    if let Some(inner) = emoji.strip_prefix(':') {
        let name = inner.strip_suffix(':').ok_or_else(bad_emoji)?;
        return if is_emote_name(name) {
            Ok(())
        } else {
            Err(bad_emoji())
        };
    }
    let chars: Vec<char> = emoji.chars().collect();
    if chars.is_empty() || chars.len() > MAX_EMOJI_CHARS || emoji.len() > MAX_EMOJI_BYTES {
        return Err(bad_emoji());
    }
    for (i, &c) in chars.iter().enumerate() {
        if c.is_ascii() {
            // Only the base of a keycap: `1`, `#` or `*`, then VS16 and U+20E3.
            let keycap = (c.is_ascii_digit() || c == '#' || c == '*')
                && chars.get(i + 1) == Some(&VS16)
                && chars.get(i + 2) == Some(&KEYCAP);
            if !keycap {
                return Err(bad_emoji());
            }
            continue;
        }
        if c.is_whitespace() || c.is_control() || is_hidden(c) {
            return Err(bad_emoji());
        }
    }
    Ok(())
}

/// Office emote names, like sticker names: `[a-z0-9_]{2,32}`.
fn is_emote_name(name: &str) -> bool {
    (2..=32).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// Invisible or direction-changing characters an emoji may not carry.
/// ZWJ and the tag characters of subdivision flags are allowed.
fn is_hidden(c: char) -> bool {
    if c == ZWJ || ('\u{E0020}'..='\u{E007F}').contains(&c) {
        return false;
    }
    matches!(
        c,
        // Bidi embedding, override, isolate and marks.
        '\u{202A}'..='\u{202E}'
            | '\u{2066}'..='\u{2069}'
            | '\u{200E}'
            | '\u{200F}'
            | '\u{061C}'
            // Other format characters and invisible fillers.
            | '\u{00AD}'
            | '\u{034F}'
            | '\u{115F}'
            | '\u{1160}'
            | '\u{17B4}'
            | '\u{17B5}'
            | '\u{180B}'..='\u{180E}'
            | '\u{200B}'
            | '\u{200C}'
            | '\u{2060}'..='\u{2064}'
            | '\u{3164}'
            | '\u{FEFF}'
            | '\u{FFA0}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{E0001}'
    )
}

/// May the author make this reaction record? A member of the conversation
/// at the record's time, like a message (`judge::may_post`), so a locked
/// Umum channel takes reactions from everyone in it. Refused in a channel
/// that was archived at the record's time.
pub(crate) fn judge(ctx: &Ctx, rec: &VerifiedRecord, st: Standing) -> AppResult<Verdict> {
    let Body::Reaction { conv, .. } = rec.body() else {
        return Ok(judge::reject("bad_format", "bukan reaksi"));
    };
    let Some(info) = ctx.conv(conv)? else {
        return Ok(Verdict::Defer);
    };
    if info.deleted {
        // Stored purged by `store::apply`.
        return Ok(Verdict::Accept);
    }
    let verdict = judge::may_post(ctx, &info, rec.author(), rec.at, st)?;
    if verdict != Verdict::Accept {
        return Ok(verdict);
    }
    if archived_at(ctx, &info, rec.at)? {
        return Ok(judge::forbidden("channel ini diarsipkan"));
    }
    Ok(Verdict::Accept)
}

/// Whether `info` is archived and its archive (last writer) is not later
/// than `at`. A reaction made before the archive is still taken when it
/// arrives afterwards.
fn archived_at(ctx: &Ctx, info: &ConvInfo, at: OffsetDateTime) -> AppResult<bool> {
    if !info.archived {
        return Ok(false);
    }
    let since: Option<Option<String>> = ctx
        .conn
        .query_row(
            "SELECT archive_at FROM chat_channels WHERE conv = ?1",
            [&info.conv],
            |r| r.get(0),
        )
        .optional()?;
    Ok(since
        .flatten()
        .and_then(|s| parse_time(&s))
        .is_none_or(|since| since <= at))
}

/// Stores an accepted reaction record and updates `chat_reactions`.
pub fn apply(
    ctx: &Ctx,
    rec: &VerifiedRecord,
    from: Option<&str>,
    now: OffsetDateTime,
    fx: &mut Effects,
) -> AppResult<()> {
    let Body::Reaction {
        conv,
        message,
        emoji,
        on,
    } = rec.body()
    else {
        return Ok(());
    };
    store::insert_record(ctx.conn, rec, true, from, now)?;
    let changed = ctx.conn.execute(
        "INSERT INTO chat_reactions (message_id, author, emoji, conv, active, at, record_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (message_id, author, emoji) DO UPDATE SET
           conv = excluded.conv, active = excluded.active, at = excluded.at,
           record_id = excluded.record_id
         WHERE (excluded.at, excluded.record_id) > (chat_reactions.at, chat_reactions.record_id)",
        params![
            message,
            rec.author(),
            emoji,
            conv,
            on,
            format_time(rec.at),
            rec.id
        ],
    )?;
    if changed > 0 {
        fx.visible = true;
    }
    Ok(())
}

/// Reaction chips of one message, in order of their first active reaction
/// (then by emoji); people oldest first. Only reactions naming the message's
/// own conversation count. Authors removed later still count: their
/// reaction was valid when made.
pub fn reactions_for(ctx: &Ctx, message_id: &str) -> AppResult<Vec<ReactionView>> {
    let mut stmt = ctx.conn.prepare_cached(
        "SELECT r.emoji, r.author, r.at FROM chat_reactions r
         JOIN chat_messages m ON m.id = r.message_id AND m.conv = r.conv
         WHERE r.message_id = ?1 AND r.active = 1 AND m.deleted = 0
         ORDER BY r.at, r.author",
    )?;
    let rows = stmt
        .query_map([message_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let me = ctx.me();
    // (earliest reaction, chip); rows come oldest first.
    let mut chips: Vec<(String, ReactionView)> = Vec::new();
    for (emoji, author, at) in rows {
        if ctx.dir.member(&author).is_none() {
            continue;
        }
        let idx = match chips.iter().position(|(_, c)| c.emoji == emoji) {
            Some(idx) => idx,
            None => {
                chips.push((
                    at,
                    ReactionView {
                        emoji,
                        count: 0,
                        mine: false,
                        people: Vec::new(),
                    },
                ));
                chips.len() - 1
            }
        };
        let chip = &mut chips[idx].1;
        chip.count += 1;
        chip.mine |= author == me;
        chip.people.push(read::person(&ctx.dir, &author));
    }
    chips.sort_by(|a, b| (&a.0, &a.1.emoji).cmp(&(&b.0, &b.1.emoji)));
    Ok(chips.into_iter().map(|(_, c)| c).collect())
}

/// Why I may not react in `info` now, or `None`. Like posting
/// (`read::post_blocked`), except that a locked Umum channel is open to
/// reactions.
fn react_blocked(ctx: &Ctx, info: &ConvInfo) -> AppResult<Option<String>> {
    let unlocked = ConvInfo {
        locked: false,
        ..info.clone()
    };
    read::post_blocked(ctx, &unlocked)
}

/// Whether I may react in this conversation now.
pub fn can_react(ctx: &Ctx, info: &ConvInfo) -> AppResult<bool> {
    if ctx.dir.member(ctx.me()).is_none_or(|m| !m.active) {
        return Ok(false);
    }
    Ok(react_blocked(ctx, info)?.is_none())
}

/// Emoji used most recently on this laptop, newest first (at most 24).
pub fn recent_emoji(conn: &Connection) -> AppResult<Vec<String>> {
    let Some(raw) = crate::settings::get(conn, RECENT_SETTING)? else {
        return Ok(Vec::new());
    };
    let list: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
    let mut out: Vec<String> = Vec::new();
    for e in list {
        if validate_emoji(&e).is_ok() && !out.contains(&e) {
            out.push(e);
        }
        if out.len() == MAX_RECENT {
            break;
        }
    }
    Ok(out)
}

fn remember_emoji(conn: &Connection, emoji: &str) -> AppResult<()> {
    let mut list = recent_emoji(conn)?;
    list.retain(|e| e != emoji);
    list.insert(0, emoji.to_owned());
    list.truncate(MAX_RECENT);
    let json = serde_json::to_string(&list).map_err(|e| AppError::Internal(e.to_string()))?;
    crate::settings::set(conn, RECENT_SETTING, &json)
}

fn check_emoji(emoji: &str) -> AppResult<()> {
    validate_emoji(emoji).map_err(|_| AppError::InvalidInput("Emoji tidak sah.".into()))
}

impl ChatSync {
    /// Turns my reaction `emoji` on `message_id` on or off. Nothing is
    /// signed when it already is that way.
    pub fn react(&self, conv: &str, message_id: &str, emoji: &str, on: bool) -> AppResult<()> {
        self.with_ctx(|ctx, identity, fx| {
            require_member(ctx)?;
            check_emoji(emoji)?;
            let info = readable(ctx, conv)?;
            read::message_row(ctx.conn, message_id)?
                .filter(|m| m.conv == conv && !m.deleted)
                .ok_or_else(|| {
                    AppError::NotFound("Pesan tidak ditemukan atau sudah dihapus.".into())
                })?;
            if let Some(reason) = react_blocked(ctx, &info)? {
                return Err(AppError::Forbidden(reason));
            }
            let current: Option<(bool, String)> = ctx
                .conn
                .query_row(
                    "SELECT active, at FROM chat_reactions
                     WHERE message_id = ?1 AND author = ?2 AND emoji = ?3",
                    params![message_id, ctx.me(), emoji],
                    |r| Ok((r.get::<_, i64>(0)? != 0, r.get(1)?)),
                )
                .optional()?;
            let active = current.as_ref().is_some_and(|(a, _)| *a);
            if active != on {
                let now = clock::now();
                // Win over my previous record even within the same second.
                let at = match current.and_then(|(_, at)| parse_time(&at)) {
                    Some(prev) if prev >= now => prev + Duration::seconds(1),
                    _ => now,
                };
                if at > now + MAX_AHEAD {
                    return Err(AppError::InvalidInput(
                        "Reaksi ini baru saja diubah. Coba lagi sebentar lagi.".into(),
                    ));
                }
                let body = Body::Reaction {
                    conv: conv.to_owned(),
                    message: message_id.to_owned(),
                    emoji: emoji.to_owned(),
                    on,
                };
                store::create(ctx, identity, body, at, fx)?;
            }
            if on {
                remember_emoji(ctx.conn, emoji)?;
            }
            Ok(())
        })
    }

    /// Remembers that I used `emoji` (recent list of this laptop).
    pub fn emoji_used(&self, emoji: &str) -> AppResult<()> {
        check_emoji(emoji)?;
        self.with_ctx(|ctx, _, _| remember_emoji(ctx.conn, emoji))
    }
}
