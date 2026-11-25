//! v0.6 divisions (docs/plans/dept-divisi.md): groups inside a department
//! with heads and members, and the chat settings of department channels and
//! division chats. Holds their fold rules (called from `fold.rs`), the
//! version gate, the changes made on this laptop and the derived tables.

use std::collections::BTreeMap;

use rand_core::{OsRng, RngCore};
use rusqlite::{Connection, TransactionBehavior, params};
use serde::Serialize;
use time::OffsetDateTime;

use super::actions::{author_in, reason_error};
use super::fold::{ChannelState, OrgState, Outcome, Reason, TeamRole};
use super::format::{is_lower_hex, validate_team_name};
use super::join::{AdBlocker, ad_blockers_since, join_extras_allowed_since, parse_app_version};
use super::op::{Body, Scope};
use super::store::{load_state, not_in_org};
use crate::ad::OuMapping;
use crate::error::{AppError, AppResult};
use crate::identity::{self, Identity};

/// First Mira version that folds the division ops, the department admin
/// rules, division projects and OU rows with a division. Same `min` rule as
/// `JOIN_AD_SINCE`: while this build is numbered lower, its own version is
/// the threshold.
pub const DIVISION_SINCE: &str = "0.6.0";
/// Refusal of a division change while some laptop runs an older Mira.
pub const DIVISION_GATE_CLOSED: &str = "Perubahan divisi baru bisa disimpan setelah semua laptop kantor memakai Mira 0.6.0 atau lebih baru.";
/// Longest pinned note, in characters.
pub const PINNED_MAX_CHARS: usize = 500;
/// Most lines in a pinned note.
pub const PINNED_MAX_LINES: usize = 20;

/// One person recorded in a division.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DivisionMember {
    pub head: bool,
    pub added_at: String,
    pub added_by: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DivisionState {
    pub id: String,
    /// The department (team) the division belongs to.
    pub team: String,
    pub name: String,
    pub created_at: String,
    pub created_by: String,
    /// Archived divisions keep their people but take nobody new; their chat
    /// is read-only.
    pub archived: bool,
    pub archived_at: Option<String>,
    /// Its department was deleted.
    pub deleted: bool,
    /// As recorded by the fold. Who counts now (active, not a guest, still
    /// in the department) is `OrgState::division_role`.
    pub members: BTreeMap<String, DivisionMember>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DivisionRole {
    Head,
    Member,
}

impl DivisionRole {
    pub fn as_str(self) -> &'static str {
        match self {
            DivisionRole::Head => "head",
            DivisionRole::Member => "member",
        }
    }
}

/// Pinned note and announcement mode of one conversation (the latest
/// applied `chat_settings_set` wins).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatSettingsState {
    pub pinned: String,
    pub announce: bool,
    pub set_at: String,
    pub set_by: String,
}

/// A pinned note as it may appear in an op: at most 500 characters, no
/// leading or trailing whitespace, at most 20 lines, line breaks allowed
/// but no other control or invisible characters (tag characters and blank
/// Hangul fillers included). Empty clears the note.
pub fn is_valid_pinned_note(s: &str) -> bool {
    s.trim() == s
        && s.chars().count() <= PINNED_MAX_CHARS
        && s.split('\n').count() <= PINNED_MAX_LINES
        && s.split('\n')
            .all(|line| !identity::has_forbidden_chars(line))
        && !s.chars().any(is_blank_filler)
}

/// Characters that render as nothing but are not caught by
/// `has_forbidden_chars`: tag characters, the combining grapheme joiner and
/// the Hangul fillers.
fn is_blank_filler(c: char) -> bool {
    matches!(
        c,
        '\u{E0000}'..='\u{E007F}' | '\u{034F}' | '\u{115F}' | '\u{1160}' | '\u{3164}' | '\u{FFA0}'
    )
}

// ----- Version gate --------------------------------------------------------------

/// The version every member must have reported for the division gate.
pub fn division_threshold() -> (u32, u32, u32) {
    let since = parse_app_version(DIVISION_SINCE).unwrap_or((0, 6, 0));
    parse_app_version(crate::device::APP_VERSION).map_or(since, |own| own.min(since))
}

/// Whether division changes may be written now: every active member,
/// guests included, reported at least [`division_threshold`]. Not a fold
/// rule: older laptops would reject the ops, so this laptop does not write
/// them before.
pub fn division_gate_open(state: &OrgState) -> bool {
    join_extras_allowed_since(state, division_threshold())
}

/// Active members (guests included) below [`division_threshold`], by name.
pub fn division_blockers(state: &OrgState) -> Vec<AdBlocker> {
    ad_blockers_since(state, division_threshold())
}

// ----- Queries ---------------------------------------------------------------------

impl OrgState {
    /// A division that is not deleted, in a live department.
    pub fn live_division(&self, id: &str) -> Option<&DivisionState> {
        self.divisions
            .get(id)
            .filter(|d| !d.deleted && self.live_team(&d.team).is_some())
    }

    /// Whether a recorded person counts in the division now.
    fn counts_in(&self, d: &DivisionState, pk: &str) -> bool {
        self.is_active_non_guest(pk) && self.team_role(&d.team, pk).is_some()
    }

    /// Role of `pk` in a live division, counting only people who are
    /// active, not guests and still in the division's department.
    pub fn division_role(&self, division: &str, pk: &str) -> Option<DivisionRole> {
        let d = self.live_division(division)?;
        let m = d.members.get(pk)?;
        self.counts_in(d, pk).then_some(if m.head {
            DivisionRole::Head
        } else {
            DivisionRole::Member
        })
    }

    /// People who count in the division, with their role, by key.
    pub fn division_people(&self, division: &str) -> Vec<(&str, DivisionRole)> {
        let Some(d) = self.live_division(division) else {
            return Vec::new();
        };
        d.members
            .keys()
            .filter_map(|pk| self.division_role(division, pk).map(|r| (pk.as_str(), r)))
            .collect()
    }

    /// Live divisions `pk` counts in, with the role there.
    pub fn divisions_of(&self, pk: &str) -> Vec<(&DivisionState, DivisionRole)> {
        self.divisions
            .values()
            .filter_map(|d| self.division_role(&d.id, pk).map(|r| (d, r)))
            .collect()
    }

    pub fn is_division_head(&self, division: &str, pk: &str) -> bool {
        self.division_role(division, pk) == Some(DivisionRole::Head)
    }

    /// Superadmin, or admin of the live department `team`.
    pub fn is_team_manager(&self, pk: &str, team: &str) -> bool {
        self.is_active_non_guest(pk)
            && self.live_team(team).is_some()
            && (self.is_superadmin(pk) || self.team_role(team, pk) == Some(TeamRole::Admin))
    }

    /// Rename, archive, appoint heads: a superadmin or an admin of the
    /// division's department.
    pub fn may_manage_division(&self, pk: &str, division: &str) -> bool {
        self.live_division(division)
            .is_some_and(|d| self.is_team_manager(pk, &d.team))
    }

    /// Add and remove members: a manager of the division or one of its
    /// heads.
    pub fn may_edit_division_members(&self, pk: &str, division: &str) -> bool {
        self.may_manage_division(pk, division) || self.is_division_head(division, pk)
    }

    /// Settings of the department channel (`division` none) or of a
    /// division chat; `None` while never set.
    pub fn chat_settings_for(
        &self,
        team: &str,
        division: Option<&str>,
    ) -> Option<&ChatSettingsState> {
        self.chat_settings
            .get(&(team.to_owned(), division.unwrap_or("").to_owned()))
    }

    /// Department channel: a superadmin or an admin of the department. A
    /// division chat (not archived): those, or a head of the division.
    pub fn may_edit_chat_settings(&self, pk: &str, team: &str, division: Option<&str>) -> bool {
        match division {
            None => self.is_team_manager(pk, team),
            Some(id) => {
                self.live_division(id)
                    .is_some_and(|d| d.team == team && !d.archived)
                    && self.may_edit_division_members(pk, id)
            }
        }
    }

    /// The department channel of `team`: its first channel (by creation
    /// time, then id). Its settings are those of `(team, None)`.
    pub fn department_channel(&self, team: &str) -> Option<&ChannelState> {
        self.channels
            .values()
            .filter(|c| c.team.as_deref() == Some(team))
            .min_by(|a, b| {
                a.created_at
                    .cmp(&b.created_at)
                    .then_with(|| a.id.cmp(&b.id))
            })
    }

    /// Active admins of a live department.
    pub fn team_admin_count(&self, team: &str) -> usize {
        self.live_team(team).map_or(0, |t| {
            t.members
                .iter()
                .filter(|(pk, m)| m.role == TeamRole::Admin && self.is_active(pk))
                .count()
        })
    }

    // ----- Effects of other ops -----

    /// Takes `pk` out of every division outside `keep_team` (all of them
    /// with `None`). Also for deactivating a member.
    pub(crate) fn leave_divisions(&mut self, pk: &str, keep_team: Option<&str>) {
        for d in self.divisions.values_mut() {
            if keep_team != Some(d.team.as_str()) {
                d.members.remove(pk);
            }
        }
    }

    /// Takes `pk` out of the divisions of `team`.
    pub(super) fn leave_team_divisions(&mut self, pk: &str, team: &str) {
        for d in self.divisions.values_mut().filter(|d| d.team == team) {
            d.members.remove(pk);
        }
    }

    /// `team_delete`: its divisions are deleted and emptied.
    pub(super) fn delete_team_divisions(&mut self, team: &str) {
        for d in self.divisions.values_mut().filter(|d| d.team == team) {
            d.deleted = true;
            d.members.clear();
        }
        self.chat_settings.retain(|(t, _), _| t != team);
    }

    /// Whether an id is taken by something every laptop knows: a team, a
    /// label, a division or `#umum`. Channel ids come from team-scoped ops
    /// that laptops outside the department never receive, so they do not
    /// count (a `channel_create` with a division's id is refused instead).
    fn org_id_used(&self, id: &str) -> bool {
        self.divisions.contains_key(id)
            || self.teams.contains_key(id)
            || self.labels.contains_key(id)
            || id == super::fold::umum_channel_id(&self.org.id)
    }

    /// `DepartmentArchived` when the division's department is archived.
    fn require_open_division_team(&self, team: &str) -> Outcome {
        match self.live_team(team) {
            Some(t) if t.archived => Err(Reason::DepartmentArchived),
            _ => Ok(()),
        }
    }

    /// `project_create` with a division: live, in the project's
    /// department, not archived, and the author heads it, is an admin of
    /// the department or a superadmin (plain members may not, as with
    /// department projects).
    pub(super) fn check_project_division(
        &self,
        author: &str,
        team: Option<&str>,
        division: &str,
    ) -> Outcome {
        let d = self
            .live_division(division)
            .filter(|d| Some(d.team.as_str()) == team)
            .ok_or(Reason::DivisionNotFound)?;
        if d.archived {
            return Err(Reason::DivisionArchived);
        }
        if self.is_division_head(division, author) || self.is_team_manager(author, &d.team) {
            Ok(())
        } else {
            Err(Reason::NotAuthorized)
        }
    }

    /// An OU row of `ad_settings_set` without its division when that is
    /// not a live division of the row's department (the row's department
    /// mapping stays).
    pub(super) fn ou_row_checked(&self, row: &OuMapping) -> OuMapping {
        let mut row = row.clone();
        let keep = row
            .division
            .as_deref()
            .is_some_and(|id| self.live_division(id).is_some_and(|d| d.team == row.team));
        if !keep {
            row.division = None;
        }
        row
    }

    // ----- Fold rules of the division ops -----

    fn division_mut(&mut self, id: &str) -> Result<&mut DivisionState, Reason> {
        self.divisions
            .get_mut(id)
            .filter(|d| !d.deleted)
            .ok_or(Reason::DivisionNotFound)
    }

    /// The live division, when `author` may manage it.
    fn managed_division(&self, author: &str, division: &str) -> Result<&DivisionState, Reason> {
        let d = self
            .live_division(division)
            .ok_or(Reason::DivisionNotFound)?;
        if !self.is_team_manager(author, &d.team) {
            return Err(Reason::NotAuthorized);
        }
        Ok(d)
    }

    pub(crate) fn apply_division_create(
        &mut self,
        author: &str,
        at: &str,
        division: &str,
        team: &str,
        name: &str,
    ) -> Outcome {
        self.require_open_team(team)?;
        if !self.is_team_manager(author, team) {
            return Err(Reason::NotAuthorized);
        }
        if self.org_id_used(division) {
            return Err(Reason::IdInUse);
        }
        self.used_ids.insert(division.to_owned());
        self.divisions.insert(
            division.to_owned(),
            DivisionState {
                id: division.to_owned(),
                team: team.to_owned(),
                name: name.to_owned(),
                created_at: at.to_owned(),
                created_by: author.to_owned(),
                archived: false,
                archived_at: None,
                deleted: false,
                members: BTreeMap::new(),
            },
        );
        Ok(())
    }

    pub(crate) fn apply_division_rename(
        &mut self,
        author: &str,
        division: &str,
        name: &str,
    ) -> Outcome {
        if self.managed_division(author, division)?.name == name {
            return Err(Reason::NoChange);
        }
        self.division_mut(division)?.name = name.to_owned();
        Ok(())
    }

    pub(crate) fn apply_division_archive(
        &mut self,
        author: &str,
        at: &str,
        division: &str,
        archived: bool,
    ) -> Outcome {
        if self.managed_division(author, division)?.archived == archived {
            return Err(Reason::NoChange);
        }
        let d = self.division_mut(division)?;
        d.archived = archived;
        d.archived_at = archived.then(|| at.to_owned());
        Ok(())
    }

    pub(crate) fn apply_division_head_set(
        &mut self,
        author: &str,
        at: &str,
        division: &str,
        member: &str,
        head: bool,
    ) -> Outcome {
        let (team, archived, current) = {
            let d = self.managed_division(author, division)?;
            (
                d.team.clone(),
                d.archived,
                d.members.get(member).map(|m| m.head),
            )
        };
        if !head {
            if current != Some(true) {
                return Err(Reason::NotDivisionHead);
            }
            if let Some(m) = self.division_mut(division)?.members.get_mut(member) {
                m.head = false;
            }
            return Ok(());
        }
        if archived {
            return Err(Reason::DivisionArchived);
        }
        self.require_open_division_team(&team)?;
        self.require_active_non_guest_target(member)?;
        if self.team_role(&team, member).is_none() {
            return Err(Reason::TargetNotInDepartment);
        }
        if current == Some(true) {
            return Err(Reason::AlreadyDivisionHead);
        }
        // A new head joins the division at the same time.
        self.division_mut(division)?
            .members
            .entry(member.to_owned())
            .and_modify(|m| m.head = true)
            .or_insert_with(|| DivisionMember {
                head: true,
                added_at: at.to_owned(),
                added_by: author.to_owned(),
            });
        Ok(())
    }

    pub(crate) fn apply_division_member_add(
        &mut self,
        author: &str,
        at: &str,
        division: &str,
        member: &str,
    ) -> Outcome {
        let (team, archived, present) = {
            let d = self
                .live_division(division)
                .ok_or(Reason::DivisionNotFound)?;
            (d.team.clone(), d.archived, d.members.contains_key(member))
        };
        if !self.may_edit_division_members(author, division) {
            return Err(Reason::NotAuthorized);
        }
        if archived {
            return Err(Reason::DivisionArchived);
        }
        self.require_open_division_team(&team)?;
        self.require_active_non_guest_target(member)?;
        if self.team_role(&team, member).is_none() {
            return Err(Reason::TargetNotInDepartment);
        }
        if present {
            return Err(Reason::AlreadyInDivision);
        }
        self.division_mut(division)?.members.insert(
            member.to_owned(),
            DivisionMember {
                head: false,
                added_at: at.to_owned(),
                added_by: author.to_owned(),
            },
        );
        Ok(())
    }

    pub(crate) fn apply_division_member_remove(
        &mut self,
        author: &str,
        division: &str,
        member: &str,
    ) -> Outcome {
        let (archived, target_head) = {
            let d = self
                .live_division(division)
                .ok_or(Reason::DivisionNotFound)?;
            let m = d.members.get(member).ok_or(Reason::NotInDivision)?;
            (d.archived, m.head)
        };
        // A head removes members who are not heads; removing a head takes a
        // manager of the division (or the head themselves). In an archived
        // division only managers remove others; people may still leave.
        let manager = self.may_manage_division(author, division);
        let allowed = author == member
            || manager
            || (!target_head && self.is_division_head(division, author));
        if !allowed {
            return Err(Reason::NotAuthorized);
        }
        if archived && !manager && author != member {
            return Err(Reason::DivisionArchived);
        }
        self.division_mut(division)?.members.remove(member);
        Ok(())
    }

    pub(crate) fn apply_chat_settings_set(
        &mut self,
        author: &str,
        at: &str,
        team: &str,
        division: Option<&str>,
        pinned: &str,
        announce: bool,
    ) -> Outcome {
        if self.live_team(team).is_none() {
            return Err(Reason::TeamNotFound);
        }
        if let Some(id) = division {
            let d = self
                .live_division(id)
                .filter(|d| d.team == team)
                .ok_or(Reason::DivisionNotFound)?;
            if d.archived {
                return Err(Reason::DivisionArchived);
            }
        }
        self.require_open_division_team(team)?;
        if !self.may_edit_chat_settings(author, team, division) {
            return Err(Reason::NotAuthorized);
        }
        let same = match self.chat_settings_for(team, division) {
            Some(c) => c.pinned == pinned && c.announce == announce,
            None => pinned.is_empty() && !announce,
        };
        if same {
            return Err(Reason::NoChange);
        }
        self.chat_settings.insert(
            (team.to_owned(), division.unwrap_or("").to_owned()),
            ChatSettingsState {
                pinned: pinned.to_owned(),
                announce,
                set_at: at.to_owned(),
                set_by: author.to_owned(),
            },
        );
        Ok(())
    }
}

// ----- Changes made on this laptop ---------------------------------------------------

fn random_hex16() -> String {
    let mut b = [0u8; 16];
    OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

fn check_id(id: &str, missing: Reason) -> AppResult<()> {
    if is_lower_hex(id, 32) {
        Ok(())
    } else {
        Err(reason_error(missing))
    }
}

fn check_key(pk: &str) -> AppResult<()> {
    if is_lower_hex(pk, 64) {
        Ok(())
    } else {
        Err(reason_error(Reason::TargetNotActive))
    }
}

fn validate_division_name(name: &str) -> AppResult<String> {
    validate_team_name(name).map_err(|_| {
        AppError::InvalidName(
            "Nama divisi harus 2 sampai 60 karakter, tanpa baris baru atau tab.".into(),
        )
    })
}

/// The pinned note as it will be signed: line breaks as `\n`, trimmed,
/// checked with messages the editor can act on.
pub fn clean_pinned_note(pinned: &str) -> AppResult<String> {
    let note = pinned.replace("\r\n", "\n").replace('\r', "\n");
    let note = note.trim();
    if note.chars().count() > PINNED_MAX_CHARS {
        return Err(AppError::InvalidInput(format!(
            "Catatan disematkan paling banyak {PINNED_MAX_CHARS} karakter."
        )));
    }
    if note.split('\n').count() > PINNED_MAX_LINES {
        return Err(AppError::InvalidInput(format!(
            "Catatan disematkan paling banyak {PINNED_MAX_LINES} baris."
        )));
    }
    if !is_valid_pinned_note(note) {
        return Err(AppError::InvalidInput(
            "Catatan disematkan berisi karakter yang tidak diizinkan, misalnya tab.".into(),
        ));
    }
    Ok(note.to_owned())
}

fn gate_error() -> AppError {
    AppError::InvalidInput(DIVISION_GATE_CLOSED.into())
}

/// Checks the gate, then authors `body` inside the caller's transaction.
fn author_gated_in(
    conn: &Connection,
    identity: &Identity,
    body: Body,
    now: OffsetDateTime,
) -> AppResult<()> {
    let state = load_state(conn)?.ok_or_else(not_in_org)?;
    if !division_gate_open(&state) {
        return Err(gate_error());
    }
    author_in(conn, identity, Scope::Org, body, now)?;
    Ok(())
}

fn author_gated(
    conn: &mut Connection,
    identity: &Identity,
    body: Body,
    now: OffsetDateTime,
) -> AppResult<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    author_gated_in(&tx, identity, body, now)?;
    tx.commit()?;
    Ok(())
}

/// Superadmin or department admin: new division in `team`; returns its id.
pub fn create_division(
    conn: &mut Connection,
    identity: &Identity,
    team: &str,
    name: &str,
    now: OffsetDateTime,
) -> AppResult<String> {
    check_id(team, Reason::TeamNotFound)?;
    let name = validate_division_name(name)?;
    let division = random_hex16();
    author_gated(
        conn,
        identity,
        Body::DivisionCreate {
            division: division.clone(),
            team: team.to_owned(),
            name,
        },
        now,
    )?;
    Ok(division)
}

pub fn rename_division(
    conn: &mut Connection,
    identity: &Identity,
    division: &str,
    name: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_id(division, Reason::DivisionNotFound)?;
    let name = validate_division_name(name)?;
    let body = Body::DivisionRename {
        division: division.to_owned(),
        name,
    };
    author_gated(conn, identity, body, now)
}

pub fn set_division_archived(
    conn: &mut Connection,
    identity: &Identity,
    division: &str,
    archived: bool,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_id(division, Reason::DivisionNotFound)?;
    let body = Body::DivisionArchive {
        division: division.to_owned(),
        archived,
    };
    author_gated(conn, identity, body, now)
}

/// Appoints (`head` true) or relieves a head of the division.
pub fn set_division_head(
    conn: &mut Connection,
    identity: &Identity,
    division: &str,
    member: &str,
    head: bool,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_id(division, Reason::DivisionNotFound)?;
    check_key(member)?;
    let body = Body::DivisionHeadSet {
        division: division.to_owned(),
        member: member.to_owned(),
        head,
    };
    author_gated(conn, identity, body, now)
}

pub fn add_division_member(
    conn: &mut Connection,
    identity: &Identity,
    division: &str,
    member: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    add_division_member_in(&tx, identity, division, member, now)?;
    tx.commit()?;
    Ok(())
}

/// `add_division_member` inside the caller's transaction (approving a join
/// request with an AD claim adds the new member to the mapped division).
pub(crate) fn add_division_member_in(
    conn: &Connection,
    identity: &Identity,
    division: &str,
    member: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_id(division, Reason::DivisionNotFound)?;
    check_key(member)?;
    let body = Body::DivisionMemberAdd {
        division: division.to_owned(),
        member: member.to_owned(),
    };
    author_gated_in(conn, identity, body, now)
}

/// Removes a member (also "leave the division" when `member` is this
/// laptop).
pub fn remove_division_member(
    conn: &mut Connection,
    identity: &Identity,
    division: &str,
    member: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_id(division, Reason::DivisionNotFound)?;
    check_key(member)?;
    let body = Body::DivisionMemberRemove {
        division: division.to_owned(),
        member: member.to_owned(),
    };
    author_gated(conn, identity, body, now)
}

/// Promotes or demotes a department admin. A superadmin may do it whatever
/// the gate (older Mira already takes that); a department admin only once
/// every laptop folds the v0.6 rule.
pub fn set_dept_admin(
    conn: &mut Connection,
    identity: &Identity,
    team: &str,
    member: &str,
    admin: bool,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_id(team, Reason::TeamNotFound)?;
    check_key(member)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let state = load_state(&tx)?.ok_or_else(not_in_org)?;
    if !state.is_superadmin(identity.public_key_hex()) && !division_gate_open(&state) {
        return Err(gate_error());
    }
    let (team, member) = (team.to_owned(), member.to_owned());
    let body = if admin {
        Body::TeamAdminSet { team, member }
    } else {
        Body::TeamAdminUnset { team, member }
    };
    author_in(&tx, identity, Scope::Org, body, now)?;
    tx.commit()?;
    Ok(())
}

/// Saves the pinned note and announcement mode of the department channel
/// (`division` none) or of a division chat. Saving what the log already
/// holds writes nothing.
pub fn set_chat_settings(
    conn: &mut Connection,
    identity: &Identity,
    team: &str,
    division: Option<&str>,
    pinned: &str,
    announce: bool,
    now: OffsetDateTime,
) -> AppResult<()> {
    check_id(team, Reason::TeamNotFound)?;
    if let Some(id) = division {
        check_id(id, Reason::DivisionNotFound)?;
    }
    let pinned = clean_pinned_note(pinned)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let state = load_state(&tx)?.ok_or_else(not_in_org)?;
    if !division_gate_open(&state) {
        return Err(gate_error());
    }
    let same = match state.chat_settings_for(team, division) {
        Some(c) => c.pinned == pinned && c.announce == announce,
        None => pinned.is_empty() && !announce,
    };
    if same && state.may_edit_chat_settings(identity.public_key_hex(), team, division) {
        return Ok(());
    }
    let body = Body::ChatSettingsSet {
        team: team.to_owned(),
        division: division.map(str::to_owned),
        pinned,
        announce,
    };
    author_in(&tx, identity, Scope::Org, body, now)?;
    tx.commit()?;
    Ok(())
}

/// OU rows naming a division (`set_ad_settings`): only once the gate is
/// open, and each division must be live in the row's department.
pub(crate) fn check_ou_map_divisions(state: &OrgState, ou_map: &[OuMapping]) -> AppResult<()> {
    if !ou_map.iter().any(|r| r.division.is_some()) {
        return Ok(());
    }
    if !division_gate_open(state) {
        return Err(gate_error());
    }
    for row in ou_map {
        let Some(id) = row.division.as_deref() else {
            continue;
        };
        if !state.live_division(id).is_some_and(|d| d.team == row.team) {
            return Err(AppError::NotFound(format!(
                "Divisi untuk OU \"{}\" tidak ditemukan di departemen itu.",
                row.ou
            )));
        }
    }
    Ok(())
}

// ----- AD onboarding -------------------------------------------------------------------

/// The division a member approved with AD data joins: the OUs of `dn` from
/// innermost outward, the first whose OU row names a live, unarchived
/// division of `team`.
pub(crate) fn ad_division_for(state: &OrgState, team: &str, dn: Option<&str>) -> Option<String> {
    let ous = dn.map(crate::ad::dn::ous).unwrap_or_default();
    ous.iter().find_map(|ou| {
        state
            .ad
            .ou_map
            .iter()
            .filter(|row| row.team == team && crate::ad::dept::same_text(&row.ou, ou))
            .find_map(|row| row.division.as_deref())
            .filter(|id| {
                state
                    .live_division(id)
                    .is_some_and(|d| d.team == team && !d.archived)
            })
            .map(str::to_owned)
    })
}

/// Right after `join_approve` of `request_id`, in the same transaction:
/// adds the new member to the division its AD claim maps to, while the
/// division gate is open. Best effort: a failure is logged and the
/// approval stands.
pub(crate) fn join_ad_division_in(
    conn: &Connection,
    identity: &Identity,
    request_id: &str,
    now: OffsetDateTime,
) {
    if let Err(err) = add_ad_division_member(conn, identity, request_id, now) {
        eprintln!(
            "Mira: anggota baru belum bisa dimasukkan ke divisi dari AD [{}]: {err}",
            err.code()
        );
    }
}

fn add_ad_division_member(
    conn: &Connection,
    identity: &Identity,
    request_id: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    let Some(req) = super::join_store::stored_request(conn, request_id)? else {
        return Ok(());
    };
    let Ok(p) = super::join::parse_request_payload(&req.payload) else {
        return Ok(());
    };
    let Some(ad) = &p.ad else {
        return Ok(());
    };
    let state = load_state(conn)?.ok_or_else(not_in_org)?;
    if !division_gate_open(&state) {
        return Ok(());
    }
    let Some(division) = ad_division_for(&state, &p.team, ad.dn.as_deref()) else {
        return Ok(());
    };
    if state.division_role(&division, &p.member).is_some() {
        return Ok(());
    }
    add_division_member_in(conn, identity, &division, &p.member, now)
}

// ----- Derived tables ------------------------------------------------------------------

/// Rewrites `divisions`, `division_members`, `chat_settings` and
/// `projects.division_id` (called at the end of `store::write_derived`,
/// after `projects` was rewritten).
pub(crate) fn write_derived_divisions(conn: &Connection, state: &OrgState) -> AppResult<()> {
    conn.execute_batch(
        "DELETE FROM division_members; DELETE FROM divisions; DELETE FROM chat_settings;",
    )?;
    let mut d_stmt = conn.prepare(
        "INSERT INTO divisions (id, team_id, name, created_at, created_by, archived, deleted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    let mut m_stmt = conn.prepare(
        "INSERT INTO division_members (division_id, public_key, head, added_at, added_by)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for d in state.divisions.values() {
        d_stmt.execute(params![
            d.id,
            d.team,
            d.name,
            d.created_at,
            d.created_by,
            d.archived,
            d.deleted
        ])?;
        for (pk, m) in &d.members {
            m_stmt.execute(params![d.id, pk, m.head, m.added_at, m.added_by])?;
        }
    }
    let mut c_stmt = conn.prepare(
        "INSERT INTO chat_settings (team_id, division_id, pinned, announce, set_at, set_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for ((team, division), c) in &state.chat_settings {
        c_stmt.execute(params![
            team, division, c.pinned, c.announce, c.set_at, c.set_by
        ])?;
    }
    let mut p_stmt = conn.prepare("UPDATE projects SET division_id = ?2 WHERE id = ?1")?;
    for p in state.projects.values() {
        if let Some(division) = &p.division {
            p_stmt.execute(params![p.id, division])?;
        }
    }
    Ok(())
}
