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
//!
//! A verdict never depends on which other chat records happen to be here
//! already (only on channels and membership): a reply target, the message a
//! delete names and the envelope an ack names are checked when the record is
//! applied or shown, so every laptop stores the same records whatever order
//! they arrive in. Groups are the exception (docs/plans/v03-c.md section 4):
//! a group op is judged on its own causal past, which its `deps` close, so
//! it waits (Defer) until those ops are here and then gets the same verdict
//! everywhere; group content waits for the op that added its author.

use rusqlite::OptionalExtension;
use time::OffsetDateTime;

use super::audience::{ConvInfo, Ctx, Scope, was_superadmin_at};
use super::groups::{self, GroupOp};
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
            _ => Err(reject(
                "removed",
                "pembuat sudah dikeluarkan dari organisasi",
            )),
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
        // A `reply_to` into another conversation is accepted and ignored
        // when shown (`read::reply_preview`): whether this laptop knows the
        // target must not decide what it stores.
        Body::Message { conv, .. } => {
            let Some(info) = ctx.conv(conv)? else {
                return Ok(Verdict::Defer);
            };
            if info.deleted {
                return Ok(Verdict::Accept);
            }
            if let Some(v) = super::division::announce_refusal(ctx, &info, author, rec.at) {
                return Ok(v);
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
            message_author,
            ..
        } => message_delete(ctx, rec, st, conv, message_author),
        Body::Envelope {
            to, cipher_files, ..
        } => envelope(ctx, rec, st, to, cipher_files, now),
        // Accepted from any member: an ack counts only when its author is
        // the envelope's recipient, checked when applied
        // (`envelope::apply_ack`), whether or not the envelope is known here.
        Body::EnvelopeAck { .. } => Ok(Verdict::Accept),
        Body::ChannelLock { conv, .. } => channel_lock(ctx, rec, st, conv),
        Body::GroupCreate { members, .. } => Ok(group_create(ctx, rec, members)),
        Body::GroupAdd { conv, members, .. } => group_op(ctx, rec, st, conv, members),
        Body::GroupRemove { conv, .. } | Body::GroupRename { conv, .. } => {
            group_op(ctx, rec, st, conv, &[])
        }
    }
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
    if info.is_group() {
        if is_guest(ctx, author) {
            return Ok(forbidden("tamu tidak bisa menulis di grup"));
        }
        // A member now, or at the record's time (removed members' earlier
        // messages stay). Otherwise the op that added the author may not be
        // here yet.
        let member = ctx
            .group(&info.conv)?
            .is_some_and(|g| g.member_at(author, at));
        return Ok(if member {
            Verdict::Accept
        } else {
            Verdict::Defer
        });
    }
    if st == Standing::Active && ctx.in_audience(info, author)? {
        return Ok(Verdict::Accept);
    }
    let guest = is_guest(ctx, author);
    Ok(match (&info.scope, st) {
        (Scope::Umum | Scope::Org, _) if guest => {
            forbidden("tamu tidak bisa menulis di channel kantor")
        }
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
        || ctx.dir.divisions.contains_key(channel)
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
    if let ChannelScope::Org = scope {
        // v0.3: Umum channels are for superadmins only. A channel made by
        // someone who was a superadmin at the time stays valid after they
        // lose the role (v0.2 channels, plan section 7).
        if (st == Standing::Active && ctx.dir.is_superadmin(author))
            || was_superadmin_at(ctx.conn, author, rec.at)?
        {
            return Ok(Verdict::Accept);
        }
        return Ok(forbidden("hanya superadmin yang bisa membuat channel umum"));
    }
    if st == Standing::RemovedBefore {
        return Ok(Verdict::Accept);
    }
    Ok(match scope {
        // PRD F-CHAT-01: members make channels in their team or project
        // (v0.2 records; v0.3 no longer offers it). Org is handled above.
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
    if let Some(v) = super::division::channel_admin_refusal(&info) {
        return Ok(v);
    }
    // v0.4: a project's chat lives as long as the project. Its conversation
    // id is fixed, so a deleted one could never come back. Restoring an
    // archive made by v0.3 is still taken.
    if info.is_project_chat()
        && matches!(
            rec.body(),
            Body::ChannelDelete { .. } | Body::ChannelArchive { archived: true, .. }
        )
    {
        return Ok(forbidden(
            "chat proyek ikut proyeknya dan tidak bisa diarsipkan atau dihapus",
        ));
    }
    admin_rights(ctx, &info, rec.author(), st)
}

fn admin_rights(ctx: &Ctx, info: &ConvInfo, author: &str, st: Standing) -> AppResult<Verdict> {
    if st == Standing::RemovedBefore {
        return Ok(forbidden(
            "hak admin pembuat yang sudah dikeluarkan tidak bisa diperiksa",
        ));
    }
    if ctx.is_admin(info, author)? {
        return Ok(Verdict::Accept);
    }
    if is_guest(ctx, author) || matches!(info.scope, Scope::Direct(..) | Scope::Group(_)) {
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
    // Judged by its claims only. Whether it removes the real message (same
    // conversation, author or admin) is decided when applied
    // (`delete_applies`), so every laptop stores the same records whether or
    // not it has the message yet.
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
    if matches!(info.scope, Scope::Direct(..) | Scope::Group(_)) {
        return Ok(false);
    }
    ctx.is_admin(info, deleter)
}

/// `channel_lock`: Umum channels other than `#umum`, by a superadmin now.
/// The lock itself is last-writer-wins like archive; messages that arrive in
/// a locked channel are still accepted (only the sender is held back), so
/// every laptop keeps the same records.
fn channel_lock(ctx: &Ctx, rec: &VerifiedRecord, st: Standing, conv: &str) -> AppResult<Verdict> {
    let Some(info) = ctx.conv(conv)? else {
        return Ok(Verdict::Defer);
    };
    if info.scope != Scope::Org {
        return Ok(forbidden(
            "hanya channel umum selain #umum yang bisa dijadikan hanya-baca",
        ));
    }
    if info.deleted {
        return Ok(Verdict::Accept);
    }
    // Judged by the role at the record's time, like Umum channels, so a
    // lock stays valid on every laptop after its author loses the role.
    if (st == Standing::Active && ctx.dir.is_superadmin(rec.author()))
        || was_superadmin_at(ctx.conn, rec.author(), rec.at)?
    {
        return Ok(Verdict::Accept);
    }
    Ok(forbidden(
        "hanya superadmin yang bisa mengubah channel menjadi hanya-baca",
    ))
}

/// `group_create`: an author who is not a guest, members who are known and
/// not guests (an unknown key may be a colleague whose join op is not here
/// yet).
fn group_create(ctx: &Ctx, rec: &VerifiedRecord, members: &[String]) -> Verdict {
    if is_guest(ctx, rec.author()) {
        return forbidden("tamu tidak bisa membuat grup");
    }
    group_targets(ctx, members)
}

fn group_targets(ctx: &Ctx, targets: &[String]) -> Verdict {
    for pk in targets {
        match ctx.dir.member(pk) {
            None => return Verdict::Defer,
            Some(m) if m.guest => {
                return reject("guest_not_allowed", "tamu tidak bisa dimasukkan ke grup");
            }
            Some(_) => {}
        }
    }
    Verdict::Accept
}

/// `group_add`, `group_remove`, `group_rename`: the group and every op the
/// record builds on must be here (Defer otherwise); then the author's right
/// is checked on that causal past, which is the same on every laptop.
fn group_op(
    ctx: &Ctx,
    rec: &VerifiedRecord,
    st: Standing,
    conv: &str,
    targets: &[String],
) -> AppResult<Verdict> {
    if is_guest(ctx, rec.author()) {
        return Ok(forbidden("tamu tidak bisa mengubah grup"));
    }
    let targets = group_targets(ctx, targets);
    if targets != Verdict::Accept {
        return Ok(targets);
    }
    let Some((_, op)) = GroupOp::from_record(rec) else {
        return Ok(reject("bad_format", "bukan op grup"));
    };
    let ops = ctx.group_ops(conv)?;
    if ops.len() >= groups::MAX_GROUP_OPS {
        return Ok(reject(
            "group_full",
            "grup ini sudah mencapai batas perubahan anggota",
        ));
    }
    let eligible = ctx.group_eligible();
    match groups::check_right(&ops, &op, &eligible) {
        Ok(()) => Ok(Verdict::Accept),
        Err("missing_deps" | "no_group") => Ok(Verdict::Defer),
        // A removed member's ops from before their removal are stored as
        // they are; the fold decides what they did. Refusing them here would
        // depend on today's organization, not on the group's history.
        Err(_) if st == Standing::RemovedBefore => Ok(Verdict::Accept),
        Err("not_group_owner") => Ok(reject(
            "not_group_owner",
            "hanya pemilik grup yang bisa mengeluarkan orang lain",
        )),
        Err(_) => Ok(reject("not_group_member", "pembuat bukan anggota grup ini")),
    }
}
