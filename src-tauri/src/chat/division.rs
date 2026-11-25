//! v0.6 division chats and announcement mode (docs/plans/dept-divisi.md
//! section 6).
//!
//! Every division has a built-in chat `ch:<division id>`, read from the
//! derived tables `divisions` and `division_members`. Its audience is the
//! division's people who are active, not guests and still in its
//! department; its managers are the division's heads, the department's
//! admins and superadmins. Like a v0.4 project chat it lives as long as the
//! division: no archive or delete of its own, read-only while the division
//! (or its department) is archived.
//!
//! Announcement mode (`chat_settings`) applies to department channels (the
//! membership-log channel of a team) and division chats: a message dated at
//! or after the switch is refused unless its author manages the
//! conversation. Messages dated before stay accepted on every laptop.

use std::collections::HashMap;

use rusqlite::Connection;
use serde::Serialize;
use time::OffsetDateTime;

use super::audience::{ConvInfo, Ctx, Directory, Scope};
use super::judge::Verdict;
use super::model::{self, Rejection};
use super::view::{ChannelScopeView, ConversationKind, ConversationSummary, ScopeKind};
use crate::error::{AppError, AppResult};
use crate::permissions::format::parse_time;
use crate::ui_lang::UiLang;

/// A division as chat sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DivisionInfo {
    pub team: String,
    pub name: String,
    pub archived: bool,
    /// Its department was deleted.
    pub deleted: bool,
    /// Recorded people, key to "is head". Who counts now is
    /// [`Directory::in_division`].
    pub members: HashMap<String, bool>,
}

/// Ids added to the summary of a division chat (`divisionId`, `teamId`);
/// absent for every other conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DivisionConvIds {
    pub division_id: String,
    pub team_id: String,
}

pub(super) fn load_divisions(conn: &Connection) -> AppResult<HashMap<String, DivisionInfo>> {
    let mut out = HashMap::new();
    let mut stmt = conn.prepare("SELECT id, team_id, name, archived, deleted FROM divisions")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            DivisionInfo {
                team: r.get(1)?,
                name: r.get(2)?,
                archived: r.get::<_, i64>(3)? != 0,
                deleted: r.get::<_, i64>(4)? != 0,
                members: HashMap::new(),
            },
        ))
    })?;
    for row in rows {
        let (id, info) = row?;
        out.insert(id, info);
    }
    let mut stmt = conn.prepare("SELECT division_id, public_key, head FROM division_members")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)? != 0,
        ))
    })?;
    for row in rows {
        let (division, pk, head) = row?;
        if let Some(d) = out.get_mut(&division) {
            d.members.insert(pk, head);
        }
    }
    Ok(out)
}

/// Announcement mode as chat sees it.
#[derive(Debug, Clone, Default)]
pub struct Announce {
    /// `(team, division or "")` to the time it was switched on, for the
    /// conversations where it is on.
    pub since: HashMap<(String, String), OffsetDateTime>,
    /// Team to its department channel: its first membership-log channel by
    /// creation time, then id (`OrgState::department_channel`). Its other
    /// channels have no settings.
    pub main_channel: HashMap<String, String>,
}

pub(super) fn load_announce(conn: &Connection) -> AppResult<Announce> {
    let mut main: HashMap<String, (String, String)> = HashMap::new();
    let mut stmt =
        conn.prepare("SELECT team_id, created_at, id FROM channels WHERE team_id IS NOT NULL")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (team, created_at, id) = row?;
        let first = main
            .entry(team)
            .or_insert_with(|| (created_at.clone(), id.clone()));
        if (&created_at, &id) < (&first.0, &first.1) {
            *first = (created_at, id);
        }
    }
    let mut stmt =
        conn.prepare("SELECT team_id, division_id, set_at FROM chat_settings WHERE announce = 1")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut since = HashMap::new();
    for row in rows {
        let (team, division, set_at) = row?;
        if let Some(at) = parse_time(&set_at) {
            since.insert((team, division), at);
        }
    }
    Ok(Announce {
        since,
        main_channel: main.into_iter().map(|(team, (_, id))| (team, id)).collect(),
    })
}

impl Directory {
    /// A division that is not deleted, in a live department.
    pub fn division(&self, id: &str) -> Option<&DivisionInfo> {
        self.divisions
            .get(id)
            .filter(|d| !d.deleted && self.team(&d.team).is_some())
    }

    /// Counts in the division now: recorded, active, not a guest and still
    /// in the division's department.
    pub fn in_division(&self, id: &str, pk: &str) -> bool {
        self.division(id).is_some_and(|d| {
            d.members.contains_key(pk) && self.is_full_member(pk) && self.in_team(&d.team, pk)
        })
    }

    pub fn is_division_head(&self, id: &str, pk: &str) -> bool {
        self.in_division(id, pk)
            && self
                .division(id)
                .is_some_and(|d| d.members.get(pk).copied().unwrap_or(false))
    }

    /// Everyone who counts in the division now.
    pub fn division_people(&self, id: &str) -> Vec<String> {
        self.division(id).map_or_else(Vec::new, |d| {
            d.members
                .keys()
                .filter(|pk| self.in_division(id, pk))
                .cloned()
                .collect()
        })
    }

    /// A superadmin, or an admin of the live department `team` (both active
    /// and not guests), as `OrgState::is_team_manager`.
    pub fn is_team_manager(&self, team: &str, pk: &str) -> bool {
        self.is_full_member(pk)
            && self.team(team).is_some()
            && (self.is_superadmin(pk) || self.is_team_admin(team, pk))
    }

    /// Manages a division chat: a head of the division, an admin of its
    /// department or a superadmin.
    pub fn is_division_manager(&self, id: &str, pk: &str) -> bool {
        self.division(id)
            .is_some_and(|d| self.is_team_manager(&d.team, pk) || self.is_division_head(id, pk))
    }

    /// Chats of the divisions that are not deleted.
    pub fn division_convs(&self) -> Vec<String> {
        self.divisions
            .keys()
            .filter(|id| self.division(id).is_some())
            .map(|id| model::channel_conv(id))
            .collect()
    }

    /// `(team, division or "")` of the settings of a department channel or a
    /// division chat; `None` for every other conversation.
    fn settings_key(&self, info: &ConvInfo) -> Option<(String, String)> {
        match &info.scope {
            Scope::Division(id) => self.divisions.get(id).map(|d| (d.team.clone(), id.clone())),
            Scope::Team(team)
                if !info.created
                    && self
                        .announce
                        .main_channel
                        .get(team)
                        .is_some_and(|id| model::channel_conv(id) == info.conv) =>
            {
                Some((team.clone(), String::new()))
            }
            _ => None,
        }
    }

    /// When announcement mode was switched on in `info`, if it is on.
    pub fn announce_since(&self, info: &ConvInfo) -> Option<OffsetDateTime> {
        self.announce.since.get(&self.settings_key(info)?).copied()
    }

    /// May write while announcement mode is on: a manager of the
    /// department (channel) or of the division (chat).
    pub fn is_conv_manager(&self, info: &ConvInfo, pk: &str) -> bool {
        match &info.scope {
            Scope::Team(team) => self.is_team_manager(team, pk),
            Scope::Division(id) => self.is_division_manager(id, pk),
            _ => false,
        }
    }
}

impl ConvInfo {
    /// The built-in chat of a division (v0.6).
    pub fn is_division_chat(&self) -> bool {
        matches!(self.scope, Scope::Division(_))
    }
}

impl Ctx<'_> {
    /// The chat of division `id` (`None` when this laptop does not know the
    /// division). A deleted division or department leaves a deleted
    /// conversation: its records are kept and never shown or offered.
    pub(super) fn division_conv(&self, conv: &str, id: &str) -> Option<ConvInfo> {
        let d = self.dir.divisions.get(id)?;
        let team = self.dir.team(&d.team);
        Some(ConvInfo {
            conv: conv.to_owned(),
            scope: Scope::Division(id.to_owned()),
            name: d.name.clone(),
            scope_name: team.map_or_else(|| "Departemen".to_owned(), |t| t.name.clone()),
            created: false,
            archived: d.archived,
            deleted: d.deleted || team.is_none(),
            locked: false,
        })
    }
}

/// `message` in announcement mode: refused when dated at or after the
/// switch and its author does not manage the conversation.
pub(super) fn announce_refusal(
    ctx: &Ctx,
    info: &ConvInfo,
    author: &str,
    at: OffsetDateTime,
) -> Option<Verdict> {
    let since = ctx.dir.announce_since(info)?;
    if at < since || ctx.dir.is_conv_manager(info, author) {
        return None;
    }
    Some(Verdict::Reject(Rejection::new(
        "announce_only",
        "mode pengumuman: hanya pengelola yang bisa menulis",
    )))
}

/// `channel_archive` and `channel_delete` never apply to a division chat:
/// it follows its division.
pub(super) fn channel_admin_refusal(info: &ConvInfo) -> Option<Verdict> {
    info.is_division_chat().then(|| {
        Verdict::Reject(Rejection::new(
            "forbidden",
            "chat divisi ikut divisinya dan tidak bisa diarsipkan atau dihapus",
        ))
    })
}

/// Local refusal of archiving (`deleting` false) or deleting a division chat.
pub(super) fn refuse_channel_admin(info: &ConvInfo, deleting: bool) -> AppResult<()> {
    if !info.is_division_chat() {
        return Ok(());
    }
    Err(AppError::InvalidInput(
        if deleting {
            "Chat divisi ikut divisinya dan tidak bisa dihapus."
        } else {
            "Chat divisi ikut divisinya dan tidak bisa diarsipkan."
        }
        .into(),
    ))
}

/// Why this laptop may not write in a division chat or a department
/// channel for a division or announcement reason, or `None` (the other
/// reasons, like an archived channel, are checked by `read::post_blocked`).
pub(super) fn post_blocked(ctx: &Ctx, info: &ConvInfo, lang: UiLang) -> Option<&'static str> {
    match &info.scope {
        Scope::Division(id) => {
            if info.archived {
                return Some(lang.pick(
                    "Divisi ini diarsipkan, jadi chatnya hanya bisa dibaca.",
                    "This division is archived, so its chat is read-only.",
                ));
            }
            let team = ctx
                .dir
                .divisions
                .get(id)
                .and_then(|d| ctx.dir.team(&d.team));
            if team.is_some_and(|t| t.archived) {
                return Some(lang.pick(
                    "Departemen ini diarsipkan, jadi chat divisinya hanya bisa dibaca.",
                    "This department is archived, so its division chats are read-only.",
                ));
            }
        }
        // An archived channel or department has its own reason.
        Scope::Team(team) if !info.archived && !ctx.dir.team(team).is_some_and(|t| t.archived) => {}
        _ => return None,
    }
    if ctx.dir.announce_since(info).is_some() && !ctx.dir.is_conv_manager(info, ctx.me()) {
        return Some(lang.pick(
            "Mode pengumuman: hanya pengelola yang bisa menulis.",
            "Announcement mode: only managers can post.",
        ));
    }
    None
}

/// Notification title of a division chat: "Budi di Mobile".
pub(super) fn notification_title(info: &ConvInfo, sender: &str, at: &str) -> Option<String> {
    info.is_division_chat()
        .then(|| format!("{sender} {at} {}", info.name))
}

/// A division chat's summary: kind `division`, the department as scope,
/// its ids, and no archive, delete or lock of its own.
pub(super) fn decorate(
    ctx: &Ctx,
    info: &ConvInfo,
    mut s: ConversationSummary,
) -> AppResult<ConversationSummary> {
    let Scope::Division(id) = &info.scope else {
        return Ok(s);
    };
    let team = ctx
        .dir
        .divisions
        .get(id)
        .map(|d| d.team.clone())
        .unwrap_or_default();
    s.kind = ConversationKind::Division;
    s.scope = Some(ChannelScopeView {
        kind: ScopeKind::Team,
        id: Some(team.clone()),
        name: info.scope_name.clone(),
    });
    s.division = Some(DivisionConvIds {
        division_id: id.clone(),
        team_id: team,
    });
    s.can_archive = false;
    s.can_delete = false;
    s.can_lock = false;
    Ok(s)
}
