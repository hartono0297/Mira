//! Building the views of `view.rs` from the derived tables.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};

use super::audience::{ConvInfo, Ctx, Directory, Scope};
use super::fetch::{self, FetchKind};
use super::groups::{EventKind, GroupState};
use super::store::envelope::ACKED;
use super::view::{
    ChannelScopeView, ChatSection, ConversationEvent, ConversationKind, ConversationSummary,
    DeliveryState, FileState, FileView, GroupMemberView, GroupView, MessageStatus, MessageView,
    Person, ProjectChatMember, ProjectChatView, ReceiptView, ReplyPreview, ScopeKind,
    truncate_chars,
};
use crate::blobs::{BlobHash, BlobStore, should_auto_replicate};
use crate::error::{AppError, AppResult};
use crate::permissions::format::format_time;

/// Longest `lastPreview` and reply preview.
pub const PREVIEW_CHARS: usize = 80;
pub const DELETED_TEXT: &str = "Pesan dihapus";
pub const FILE_TEXT: &str = "Mengirim file";

pub fn person(dir: &Directory, pk: &str) -> Person {
    Person {
        public_key: pk.to_owned(),
        name: dir.name(pk),
    }
}

pub fn not_found_conv() -> AppError {
    AppError::NotFound("Percakapan ini tidak ditemukan atau sudah dihapus.".into())
}

/// The conversation if this laptop may read it: a channel or group it is in,
/// a chat pribadi it takes part in (kept readable after the other side
/// left), or a conversation it is no longer in but still holds (`former`:
/// read-only, the old messages are on this laptop anyway).
pub fn readable(ctx: &Ctx, conv: &str) -> AppResult<ConvInfo> {
    let info = ctx
        .conv(conv)?
        .filter(|i| !i.deleted)
        .ok_or_else(not_found_conv)?;
    let ok = match &info.scope {
        Scope::Direct(a, b) => a == ctx.me() || b == ctx.me(),
        _ => ctx.in_audience(&info, ctx.me())? || is_former(ctx, &info)?,
    };
    if ok {
        Ok(info)
    } else {
        Err(AppError::Forbidden(
            "Kamu bukan anggota percakapan ini.".into(),
        ))
    }
}

/// Other side of a chat pribadi.
pub fn dm_peer<'i>(info: &'i ConvInfo, me: &str) -> Option<&'i str> {
    match &info.scope {
        Scope::Direct(a, b) => Some(if a == me { b } else { a }),
        _ => None,
    }
}

/// Not in the conversation any more but still holding it: a channel with
/// messages here, or a group this laptop's person was in. Chat pribadi is
/// never former.
pub fn is_former(ctx: &Ctx, info: &ConvInfo) -> AppResult<bool> {
    if info.is_direct() || info.deleted || ctx.in_audience(info, ctx.me())? {
        return Ok(false);
    }
    if info.is_group() {
        return Ok(ctx
            .group(&info.conv)?
            .is_some_and(|g| g.ever_member(ctx.me())));
    }
    let held: bool = ctx.conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM chat_messages WHERE conv = ?1 AND placeholder = 0)",
        [&info.conv],
        |r| r.get(0),
    )?;
    Ok(held)
}

/// Why this laptop may not write in `info`, or `None` when it may.
pub fn post_blocked(ctx: &Ctx, info: &ConvInfo) -> AppResult<Option<String>> {
    let me = ctx.me();
    if info.deleted {
        return Ok(Some("Percakapan ini sudah dihapus.".into()));
    }
    if !ctx.in_audience(info, me)? {
        let text = match &info.scope {
            Scope::Project(_) => {
                "Anda sudah bukan anggota proyek ini. Pesan baru tidak dikirim lagi ke laptop Anda."
            }
            Scope::Group(_) => {
                "Anda sudah tidak ada di grup ini. Pesan baru tidak dikirim lagi ke laptop Anda."
            }
            Scope::Team(_) => {
                "Anda sudah tidak di departemen ini. Pesan baru tidak dikirim lagi ke laptop Anda."
            }
            Scope::Direct(..) => "Rekan ini sudah tidak bisa diajak chat pribadi.",
            Scope::Umum | Scope::Org => "Anda tidak bisa menulis di channel ini.",
        };
        return Ok(Some(text.into()));
    }
    if info.archived && info.is_project_chat() {
        return Ok(Some(
            "Chat proyek ini diarsipkan di versi lama Mira. Pengelola proyek bisa mengembalikannya dari menu di atas."
                .into(),
        ));
    }
    if info.archived {
        return Ok(Some(
            "Channel ini diarsipkan. Kembalikan dulu sebelum mengirim pesan.".into(),
        ));
    }
    if let Scope::Team(t) = &info.scope
        && ctx.dir.teams.get(t).is_some_and(|t| t.archived)
    {
        return Ok(Some(
            "Departemen ini diarsipkan, jadi channelnya hanya bisa dibaca.".into(),
        ));
    }
    if info.locked && !ctx.dir.is_superadmin(me) {
        return Ok(Some(
            "Hanya superadmin yang bisa menulis di channel ini.".into(),
        ));
    }
    Ok(None)
}

pub fn can_post(ctx: &Ctx, info: &ConvInfo) -> AppResult<bool> {
    Ok(post_blocked(ctx, info)?.is_none())
}

pub fn section_of(info: &ConvInfo) -> ChatSection {
    match info.scope {
        Scope::Umum | Scope::Org => ChatSection::Umum,
        Scope::Team(_) => ChatSection::Departemen,
        Scope::Project(_) => ChatSection::Proyek,
        Scope::Group(_) => ChatSection::Grup,
        Scope::Direct(..) => ChatSection::Pribadi,
    }
}

/// Superadmin, Umum channel other than `#umum`.
pub fn can_lock(ctx: &Ctx, info: &ConvInfo) -> bool {
    info.scope == Scope::Org && !info.deleted && ctx.dir.is_superadmin(ctx.me())
}

pub fn can_admin_channel(ctx: &Ctx, info: &ConvInfo) -> AppResult<bool> {
    Ok(info.is_channel()
        && info.scope != Scope::Umum
        && !info.deleted
        && ctx.is_admin(info, ctx.me())?)
}

fn scope_view(info: &ConvInfo) -> Option<ChannelScopeView> {
    let (kind, id) = match &info.scope {
        Scope::Umum | Scope::Org => (ScopeKind::Org, None),
        Scope::Team(t) => (ScopeKind::Team, Some(t.clone())),
        Scope::Project(p) => (ScopeKind::Project, Some(p.clone())),
        Scope::Group(g) => (ScopeKind::Group, Some(g.clone())),
        Scope::Direct(..) => return None,
    };
    Some(ChannelScopeView {
        kind,
        id,
        name: info.scope_name.clone(),
    })
}

pub fn summary(ctx: &Ctx, info: &ConvInfo) -> AppResult<ConversationSummary> {
    let me = ctx.me();
    let conn = ctx.conn;
    let peer = dm_peer(info, me).map(|p| person(&ctx.dir, p));
    let (unread, mention_unread) = unread_counts(conn, &info.conv, me)?;
    let (last_at, last_preview) = last_message(ctx, &info.conv)?;
    let admin = can_admin_channel(ctx, info)?;
    let blocked = post_blocked(ctx, info)?;
    let former = is_former(ctx, info)?;
    let member_count = u32::try_from(ctx.audience(info)?.len()).unwrap_or(u32::MAX);
    Ok(ConversationSummary {
        id: info.conv.clone(),
        kind: if info.is_group() {
            ConversationKind::Group
        } else if info.is_project_chat() {
            ConversationKind::Project
        } else if info.is_channel() {
            ConversationKind::Channel
        } else {
            ConversationKind::Dm
        },
        section: section_of(info),
        locked: info.locked,
        former,
        member_count,
        name: match &peer {
            Some(p) => p.name.clone(),
            // The project's own name, not the `#channel` form.
            None if info.is_project_chat() => info.scope_name.clone(),
            None => info.name.clone(),
        },
        scope: scope_view(info),
        peer,
        is_umum: info.scope == Scope::Umum,
        archived: info.archived,
        muted: super::sync::is_muted(conn, &info.conv)?,
        unread,
        mention_unread,
        last_at,
        last_preview,
        can_post: blocked.is_none(),
        post_blocked_reason: blocked,
        // A project chat lives as long as its project (v0.4). Restoring an
        // archive made by v0.3 stays possible.
        can_archive: admin && (!info.is_project_chat() || info.archived),
        can_delete: admin && !info.is_project_chat(),
        can_lock: can_lock(ctx, info),
    })
}

const UNREAD_SQL: &str =
    "FROM chat_messages m WHERE m.conv = ?1 AND m.author != ?2 AND m.deleted = 0
     AND NOT EXISTS (SELECT 1 FROM chat_receipts r
                     WHERE r.message_id = m.id AND r.reader = ?2 AND r.state = 'read')";

fn unread_counts(conn: &Connection, conv: &str, me: &str) -> AppResult<(u32, u32)> {
    let unread: i64 = conn.query_row(
        &format!("SELECT count(*) {UNREAD_SQL}"),
        params![conv, me],
        |r| r.get(0),
    )?;
    let mentions: i64 = conn.query_row(
        &format!("SELECT count(*) {UNREAD_SQL} AND m.mentions LIKE ?3"),
        params![conv, me, format!("%\"{me}\"%")],
        |r| r.get(0),
    )?;
    Ok((to_u32(unread), to_u32(mentions)))
}

/// Ids of unread messages from others in `conv`, oldest first.
pub fn unread_ids(conn: &Connection, conv: &str, me: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(&format!("SELECT m.id {UNREAD_SQL} ORDER BY m.at, m.rowid"))?;
    let rows = stmt
        .query_map(params![conv, me], |r| r.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(rows)
}

fn to_u32(n: i64) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn last_message(ctx: &Ctx, conv: &str) -> AppResult<(Option<String>, Option<String>)> {
    let row: Option<(String, String, bool, String, i64)> = ctx
        .conn
        .query_row(
            "SELECT author, text, deleted, at,
                    (SELECT count(*) FROM chat_files f WHERE f.message_id = m.id)
             FROM chat_messages m WHERE conv = ?1 ORDER BY at DESC, rowid DESC LIMIT 1",
            [conv],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get::<_, i64>(2)? != 0,
                    r.get(3)?,
                    r.get(4)?,
                ))
            },
        )
        .optional()?;
    let Some((author, text, deleted, at, files)) = row else {
        return Ok((None, None));
    };
    let preview = if deleted {
        DELETED_TEXT.to_owned()
    } else {
        let content = if text.trim().is_empty() && files > 0 {
            FILE_TEXT.to_owned()
        } else {
            text.trim().to_owned()
        };
        truncate_chars(
            &format!("{}: {content}", ctx.dir.name(&author)),
            PREVIEW_CHARS,
        )
    };
    Ok((Some(at), Some(preview)))
}

/// One row of `chat_messages`.
#[derive(Debug, Clone)]
pub struct MessageRow {
    pub id: String,
    pub conv: String,
    pub author: String,
    pub at: String,
    pub text: String,
    pub reply_to: Option<String>,
    pub mentions: Vec<String>,
    pub deleted: bool,
}

const MESSAGE_COLS: &str = "id, conv, author, at, text, reply_to, mentions, deleted";

fn map_message(r: &rusqlite::Row) -> rusqlite::Result<MessageRow> {
    let mentions: String = r.get(6)?;
    Ok(MessageRow {
        id: r.get(0)?,
        conv: r.get(1)?,
        author: r.get(2)?,
        at: r.get(3)?,
        text: r.get(4)?,
        reply_to: r.get(5)?,
        mentions: serde_json::from_str(&mentions).unwrap_or_default(),
        deleted: r.get::<_, i64>(7)? != 0,
    })
}

pub fn message_row(conn: &Connection, id: &str) -> AppResult<Option<MessageRow>> {
    Ok(conn
        .query_row(
            &format!("SELECT {MESSAGE_COLS} FROM chat_messages WHERE id = ?1"),
            [id],
            map_message,
        )
        .optional()?)
}

/// A page of messages, oldest first, and whether older ones exist.
pub fn message_page(
    conn: &Connection,
    conv: &str,
    before: Option<&str>,
    limit: u32,
) -> AppResult<(Vec<MessageRow>, bool)> {
    let limit = i64::from(limit.clamp(1, 500));
    let anchor: Option<(String, i64)> = match before {
        Some(id) => conn
            .query_row(
                "SELECT at, rowid FROM chat_messages WHERE id = ?1 AND conv = ?2",
                params![id, conv],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?,
        None => None,
    };
    let (at, rowid) = anchor.unwrap_or_else(|| ("9999".to_owned(), i64::MAX));
    let mut stmt = conn.prepare(&format!(
        "SELECT {MESSAGE_COLS} FROM chat_messages
         WHERE conv = ?1 AND (at, rowid) < (?2, ?3) ORDER BY at DESC, rowid DESC LIMIT ?4"
    ))?;
    let mut rows = stmt
        .query_map(params![conv, at, rowid, limit + 1], map_message)?
        .collect::<Result<Vec<_>, _>>()?;
    let has_more = rows.len() as i64 > limit;
    rows.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
    rows.reverse();
    Ok((rows, has_more))
}

pub fn file_state(
    conn: &Connection,
    blobs: &BlobStore,
    hash: &str,
    size: u64,
) -> AppResult<FileState> {
    if BlobHash::parse(hash).is_ok_and(|h| blobs.contains(&h)) {
        return Ok(FileState::Local);
    }
    let queued = match fetch::queue_state(conn, hash, FetchKind::Plain)? {
        Some(q) => Some(q),
        None => fetch::cipher_state_for_plain(conn, hash)?,
    };
    Ok(match queued {
        Some(q) if q.failed => FileState::Missing,
        Some(_) => FileState::Fetching,
        None if should_auto_replicate(size) => FileState::Missing,
        None => FileState::Remote,
    })
}

pub fn files_of(conn: &Connection, blobs: &BlobStore, message: &str) -> AppResult<Vec<FileView>> {
    let mut stmt = conn.prepare(
        "SELECT hash, size, name, mime FROM chat_files WHERE message_id = ?1 ORDER BY idx",
    )?;
    let rows = stmt
        .query_map([message], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(hash, size, name, mime)| {
            let size = u64::try_from(size).unwrap_or(0);
            Ok(FileView {
                state: file_state(conn, blobs, &hash, size)?,
                auto_download: should_auto_replicate(size),
                hash,
                name,
                size,
                mime,
            })
        })
        .collect()
}

/// Delivery state of `message` for each of `recipients`.
pub fn recipient_states(
    conn: &Connection,
    message: &str,
    recipients: &[String],
) -> AppResult<Vec<(String, DeliveryState)>> {
    let mut receipts: HashMap<String, DeliveryState> = HashMap::new();
    let mut stmt = conn.prepare("SELECT reader, state FROM chat_receipts WHERE message_id = ?1")?;
    for row in stmt.query_map([message], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (reader, state) = row?;
        let s = if state == "read" {
            DeliveryState::Read
        } else {
            DeliveryState::Delivered
        };
        let e = receipts.entry(reader).or_insert(s);
        *e = (*e).max(s);
    }
    let mut stmt = conn.prepare(
        "SELECT recipient, deposited, acked, ack_failed FROM chat_envelopes WHERE message_id = ?1",
    )?;
    for row in stmt.query_map([message], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
        ))
    })? {
        let (recipient, deposited, acked, ack_failed) = row?;
        // An ack for an envelope the recipient could not open says nothing
        // about the message arriving.
        let s = if acked == ACKED && ack_failed == 0 {
            DeliveryState::Delivered
        } else if deposited != 0 && acked == 0 {
            DeliveryState::Deposited
        } else {
            continue;
        };
        let e = receipts.entry(recipient).or_insert(s);
        *e = (*e).max(s);
    }
    Ok(recipients
        .iter()
        .map(|r| {
            (
                r.clone(),
                receipts.get(r).copied().unwrap_or(DeliveryState::Pending),
            )
        })
        .collect())
}

/// Combined status: the lowest state among recipients. With nobody else in
/// the conversation the message counts as delivered.
pub fn status(states: &[(String, DeliveryState)]) -> MessageStatus {
    let count =
        |min: DeliveryState| to_u32(states.iter().filter(|(_, s)| *s >= min).count() as i64);
    MessageStatus {
        state: states
            .iter()
            .map(|(_, s)| *s)
            .min()
            .unwrap_or(DeliveryState::Delivered),
        read: count(DeliveryState::Read),
        delivered: count(DeliveryState::Delivered),
        deposited: to_u32(
            states
                .iter()
                .filter(|(_, s)| *s == DeliveryState::Deposited)
                .count() as i64,
        ),
        total: to_u32(states.len() as i64),
    }
}

fn reply_preview(ctx: &Ctx, row: &MessageRow) -> AppResult<Option<ReplyPreview>> {
    let Some(id) = &row.reply_to else {
        return Ok(None);
    };
    let target = message_row(ctx.conn, id)?;
    Ok(match target {
        // A reply into another conversation is ignored.
        Some(t) if t.conv != row.conv => None,
        Some(t) => Some(ReplyPreview {
            id: id.clone(),
            author: Some(person(&ctx.dir, &t.author)),
            preview: if t.deleted {
                DELETED_TEXT.to_owned()
            } else if t.text.trim().is_empty() {
                FILE_TEXT.to_owned()
            } else {
                truncate_chars(t.text.trim(), PREVIEW_CHARS)
            },
            deleted: t.deleted,
        }),
        None => Some(ReplyPreview {
            id: id.clone(),
            author: None,
            preview: "Pesan asli belum ada di laptop ini".to_owned(),
            deleted: false,
        }),
    })
}

/// Shared per-conversation facts for building many messages.
pub struct ConvFacts {
    pub recipients: Vec<String>,
    pub admin: bool,
    pub direct: bool,
}

pub fn conv_facts(ctx: &Ctx, info: &ConvInfo) -> AppResult<ConvFacts> {
    let me = ctx.me().to_owned();
    let recipients = ctx
        .audience(info)?
        .into_iter()
        .filter(|p| *p != me)
        .collect();
    Ok(ConvFacts {
        recipients,
        admin: ctx.is_admin(info, &me)?,
        direct: !info.is_channel(),
    })
}

/// "A", "A dan B", "A, B, dan C".
pub fn join_names(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [a] => a.clone(),
        [a, b] => format!("{a} dan {b}"),
        [rest @ .., last] => format!("{}, dan {last}", rest.join(", ")),
    }
}

/// Name in an event line: "Anda" for this laptop's person.
fn who(ctx: &Ctx, pk: &str) -> String {
    if pk == ctx.me() {
        "Anda".to_owned()
    } else {
        ctx.dir.name(pk)
    }
}

/// The group's events as lines for the conversation, oldest first.
pub fn group_events(ctx: &Ctx, g: &GroupState) -> Vec<ConversationEvent> {
    let mut out = Vec::new();
    for (i, e) in g.events.iter().enumerate() {
        let author = who(ctx, &e.author);
        let text = match &e.kind {
            EventKind::Created { members } => {
                let others: Vec<String> = members
                    .iter()
                    .filter(|m| **m != e.author)
                    .map(|m| who(ctx, m))
                    .collect();
                if others.is_empty() {
                    format!("{author} membuat grup ini.")
                } else {
                    format!(
                        "{author} membuat grup ini dan menambahkan {}.",
                        join_names(&others)
                    )
                }
            }
            EventKind::Added { members } => {
                let names: Vec<String> = members.iter().map(|m| who(ctx, m)).collect();
                format!("{author} menambahkan {}.", join_names(&names))
            }
            EventKind::Removed { member } => {
                format!("{author} mengeluarkan {}.", who(ctx, member))
            }
            EventKind::Left => format!("{author} keluar dari grup."),
            EventKind::Renamed { name } => {
                format!("{author} mengganti nama grup menjadi \"{name}\".")
            }
            EventKind::OwnerChanged { owner } => {
                format!("{} sekarang pemilik grup.", who(ctx, owner))
            }
        };
        out.push(ConversationEvent {
            id: format!("{}-{i}", e.op),
            at: format_time(e.at),
            text,
        });
    }
    out
}

/// Members, owner and what this laptop's person may do in group `info`.
pub fn group_view(ctx: &Ctx, info: &ConvInfo) -> AppResult<GroupView> {
    let g = ctx.group(&info.conv)?.ok_or_else(not_found_conv)?;
    let me = ctx.me().to_owned();
    let eligible = ctx.group_eligible_now();
    let owner = g.effective_owner(&eligible).map(str::to_owned);
    let in_group = ctx.in_audience(info, &me)?;
    let mut members = Vec::new();
    for m in g.members.iter().filter(|m| ctx.dir.is_full_member(&m.pk)) {
        let is_owner = owner.as_deref() == Some(m.pk.as_str());
        members.push(GroupMemberView {
            person: person(&ctx.dir, &m.pk),
            owner: is_owner,
            me: m.pk == me,
            added_by: (m.pk != g.creator || m.added_by != g.creator)
                .then(|| person(&ctx.dir, &m.added_by)),
            can_remove: in_group && owner.as_deref() == Some(me.as_str()) && m.pk != me,
        });
    }
    let candidates: Vec<String> = if in_group {
        ctx.dir
            .full_members()
            .into_iter()
            .filter(|pk| *pk != me && !g.is_member(pk))
            .collect()
    } else {
        Vec::new()
    };
    Ok(GroupView {
        conv: info.conv.clone(),
        name: g.name.clone(),
        owner: owner.as_deref().map(|o| person(&ctx.dir, o)),
        created_by: person(&ctx.dir, &g.creator),
        created_at: format_time(g.created_at),
        members,
        candidates: people(&ctx.dir, &candidates),
        can_add: in_group,
        can_rename: in_group,
        can_leave: in_group,
        former: !in_group,
    })
}

pub fn message_view(
    ctx: &Ctx,
    blobs: &BlobStore,
    facts: &ConvFacts,
    row: &MessageRow,
) -> AppResult<MessageView> {
    let mine = row.author == ctx.me();
    let status = if mine && !row.deleted {
        Some(status(&recipient_states(
            ctx.conn,
            &row.id,
            &facts.recipients,
        )?))
    } else {
        None
    };
    Ok(MessageView {
        id: row.id.clone(),
        conv: row.conv.clone(),
        author: person(&ctx.dir, &row.author),
        at: row.at.clone(),
        text: if row.deleted {
            String::new()
        } else {
            row.text.clone()
        },
        mentions: row.mentions.iter().map(|m| person(&ctx.dir, m)).collect(),
        reply_to: if row.deleted {
            None
        } else {
            reply_preview(ctx, row)?
        },
        files: if row.deleted {
            Vec::new()
        } else {
            files_of(ctx.conn, blobs, &row.id)?
        },
        deleted: row.deleted,
        mine,
        status,
        can_delete: !row.deleted && (mine || (!facts.direct && facts.admin)),
    })
}

/// The members of a project chat: the project's members now (the board is
/// the source of truth), sorted by name.
pub fn project_chat_view(ctx: &Ctx, info: &ConvInfo) -> AppResult<ProjectChatView> {
    let Scope::Project(project) = &info.scope else {
        return Err(AppError::Internal("Percakapan ini bukan chat proyek.".into()));
    };
    let me = ctx.me();
    let mut members = Vec::new();
    for pk in ctx.audience(info)? {
        members.push(ProjectChatMember {
            person: person(&ctx.dir, &pk),
            me: pk == me,
            manager: ctx.projects.is_manager(ctx.conn, project, &pk)?,
        });
    }
    members.sort_by(|a, b| {
        a.person
            .name
            .cmp(&b.person.name)
            .then_with(|| a.person.public_key.cmp(&b.person.public_key))
    });
    Ok(ProjectChatView {
        conv: info.conv.clone(),
        project_id: project.clone(),
        name: info.scope_name.clone(),
        members,
        can_manage: ctx.projects.is_manager(ctx.conn, project, me)?,
        former: !ctx.in_audience(info, me)?,
    })
}

pub fn receipts_for(ctx: &Ctx, info: &ConvInfo, row: &MessageRow) -> AppResult<Vec<ReceiptView>> {
    let recipients: Vec<String> = ctx
        .audience(info)?
        .into_iter()
        .filter(|p| *p != row.author)
        .collect();
    let mut out: Vec<ReceiptView> = recipient_states(ctx.conn, &row.id, &recipients)?
        .into_iter()
        .map(|(pk, state)| ReceiptView {
            person: person(&ctx.dir, &pk),
            state,
        })
        .collect();
    out.sort_by(|a, b| a.person.name.cmp(&b.person.name));
    Ok(out)
}

pub fn people(dir: &Directory, keys: &[String]) -> Vec<Person> {
    let mut out: Vec<Person> = keys.iter().map(|k| person(dir, k)).collect();
    out.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| a.public_key.cmp(&b.public_key))
    });
    out
}
