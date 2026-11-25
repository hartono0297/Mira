//! Causal rules on top of the fold: `deps` checks, and revocations that win
//! over ops made concurrently with them.
//!
//! The author picks its own lamport, so someone about to lose a right could
//! sign an op with a low lamport that sorts before the revocation. `deps`
//! records which ops the author had seen. A revocation R rejects every op
//! that sorts before R, used a right R takes away, and is not in R's causal
//! past (the closure of its `deps`). Concurrent honest ops are rejected too:
//! the accepted price of not trusting lamports.
//!
//! Which revocations count is settled before the final fold:
//! 1. Each revocation is judged on its own causal past, resolved the same
//!    way. One whose author had no right to make it there is ignored, so a
//!    fake revocation cannot reject honest ops.
//! 2. Two concurrent revocations conflict when one takes away a right the
//!    other used; the one taking it away wins. When each takes away the
//!    other's right (two superadmins removing each other), the author who
//!    became superadmin first wins, so the result does not depend on the
//!    lamports the authors chose. Cycles are broken the same way.
//! 3. Losers are rejected. Winners reject the concurrent ops that relied on
//!    what they take away. A winner the final fold still rejects drops out
//!    and everything is settled again without it.
//!
//! Every step depends only on the set of ops, so laptops holding the same
//! ops reach the same result.

use std::collections::{HashMap, HashSet};

use super::fold::{FoldResult, ManagerPath, OrgState, Outcome, Reason, TeamRole};
use super::op::{Body, InviteRole, MAX_DEPS, Scope, VerifiedOp};
use crate::org::Organization;

/// A right an op used, or that a revocation takes away.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Right {
    /// Being an active member. Taking it away takes every right of that key.
    Member(String),
    Superadmin(String),
    /// `(team, member)`.
    TeamAdmin(String, String),
    /// Taken away by `team_delete`: every admin right in that team.
    AllTeamAdmins(String),
    Invite(String),
    /// `(project, member)`: being an explicit member of a project, which the
    /// project's creator and superadmins need to manage its members.
    ProjectMember(String, String),
}

impl Right {
    /// Whether taking away `self` takes away `used`.
    fn covers(&self, used: &Right) -> bool {
        match (self, used) {
            (
                Right::Member(x),
                Right::Member(y)
                | Right::Superadmin(y)
                | Right::TeamAdmin(_, y)
                | Right::ProjectMember(_, y),
            ) => x == y,
            (Right::Superadmin(x), Right::Superadmin(y)) => x == y,
            (Right::TeamAdmin(t, x), Right::TeamAdmin(u, y)) => t == u && x == y,
            (Right::AllTeamAdmins(t), Right::TeamAdmin(u, _)) => t == u,
            (Right::Invite(i), Right::Invite(j)) => i == j,
            (Right::ProjectMember(p, x), Right::ProjectMember(q, y)) => p == q && x == y,
            _ => false,
        }
    }
}

/// The rights an op relies on: every right in `all`, and at least one of
/// the alternatives in `any` when there are some (an op allowed to a
/// superadmin or to a department admin, made by someone who is both, needs
/// only one of the two).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct Used {
    all: Vec<Right>,
    any: Vec<Vec<Right>>,
}

impl Used {
    /// Whether losing the rights `taken` makes the op invalid: a right in
    /// `all` is taken, or every alternative loses at least one right.
    fn lost(&self, taken: &[&Right]) -> bool {
        let hit = |u: &Right| taken.iter().any(|t| t.covers(u));
        self.all.iter().any(hit)
            || (!self.any.is_empty() && self.any.iter().all(|alt| alt.iter().any(hit)))
    }

    fn lost_to(&self, taken: &[Right]) -> bool {
        self.lost(&taken.iter().collect::<Vec<_>>())
    }
}

/// Ops that take a right away.
pub(crate) fn is_revocation(body: &Body) -> bool {
    matches!(
        body,
        Body::MemberRemove { .. }
            | Body::MemberSuspend { .. }
            | Body::SuperadminRemove { .. }
            | Body::TeamAdminUnset { .. }
            | Body::TeamMemberRemove { .. }
            | Body::TeamDelete { .. }
            | Body::InviteRevoke { .. }
            | Body::TeamMove { .. }
            | Body::ProjectMemberRemove { .. }
    )
}

/// The alternatives when an op is allowed to a superadmin or to an admin
/// of `team`: each path the author has.
fn one_of(author: &str, superadmin: bool, admin: bool, team: &str) -> Vec<Vec<Right>> {
    let mut alts = Vec::new();
    if superadmin {
        alts.push(vec![Right::Superadmin(author.to_owned())]);
    }
    if admin {
        alts.push(vec![Right::TeamAdmin(team.to_owned(), author.to_owned())]);
    }
    alts
}

impl OrgState {
    /// Rights `op` relies on at this state: the author's membership, plus
    /// the superadmin, department admin or project rights it needs (as
    /// alternatives when several paths allow it). An accept also relies on
    /// the invite and on its creator's right to invite.
    fn rights_used(&self, op: &VerifiedOp) -> Used {
        let author = op.author();
        let mut used = vec![Right::Member(author.to_owned())];
        let sa = self.is_superadmin(author);
        let admin = |team: &str, pk: &str| self.team_role(team, pk) == Some(TeamRole::Admin);
        let sa_only = || vec![vec![Right::Superadmin(author.to_owned())]];
        let any = match &op.payload.body {
            Body::ProfileSet { .. } | Body::ChannelCreate { .. } | Body::DeviceSet { .. } => {
                Vec::new()
            }
            Body::MemberSuspend { member } => {
                let team = self
                    .suspend_admin_team(author, member)
                    .or_else(|| self.snapshot_admin_team(author, member));
                one_of(author, sa, team.is_some(), team.as_deref().unwrap_or(""))
            }
            // A reinstatement made concurrently with another suspension or
            // a removal of the same person loses to it.
            Body::MemberReinstate { member } => {
                used.push(Right::Member(member.clone()));
                let team = self.reinstate_admin_team(author, member);
                one_of(author, sa, team.is_some(), team.as_deref().unwrap_or(""))
            }
            Body::TeamCreate { .. }
            | Body::TeamDelete { .. }
            | Body::SuperadminAdd { .. }
            | Body::SuperadminRemove { .. }
            | Body::TeamAdminSet { .. }
            | Body::TeamAdminUnset { .. }
            | Body::MemberRemove { .. }
            | Body::TeamRename { .. }
            | Body::TeamArchive { .. }
            | Body::TeamMove { .. }
            | Body::LabelCreate { .. }
            | Body::LabelRename { .. }
            | Body::LabelArchive { .. }
            | Body::LabelAssign { .. }
            | Body::LabelUnassign { .. }
            | Body::AdSettingsSet { .. } => sa_only(),
            Body::TeamMemberAdd { team, .. } => one_of(author, sa, admin(team, author), team),
            Body::TeamMemberRemove { team, member } => {
                if member == author {
                    Vec::new()
                } else {
                    let by_admin = admin(team, author) && !admin(team, member);
                    one_of(author, sa, by_admin, team)
                }
            }
            Body::JoinApprove {
                request,
                request_sig,
            }
            | Body::JoinReject {
                request,
                request_sig,
            } => match self.join_request(request, request_sig) {
                Ok(req) => {
                    let team = &req.payload.team;
                    one_of(author, sa, admin(team, author), team)
                }
                Err(_) => Vec::new(),
            },
            Body::ProjectCreate { team, creator, .. } => {
                if creator == author {
                    Vec::new()
                } else {
                    match team {
                        Some(t) => one_of(author, sa, admin(t, author), t),
                        None => sa_only(),
                    }
                }
            }
            Body::ProjectMemberAdd { project, member } => {
                let mut alts = self.project_rights(project, author);
                if member == author && sa {
                    alts.push(vec![Right::Superadmin(author.to_owned())]);
                }
                alts
            }
            Body::ProjectMemberRemove { project, member } => {
                if member == author {
                    Vec::new()
                } else {
                    self.project_rights(project, author)
                }
            }
            Body::InviteCreate { team, role, .. } => {
                let by_admin = admin(team, author) && *role != InviteRole::TeamAdmin;
                one_of(author, sa, by_admin, team)
            }
            Body::InviteRevoke { invite } => match self.invites.get(invite) {
                Some(inv) if inv.created_by != author => {
                    one_of(author, sa, admin(&inv.team, author), &inv.team)
                }
                _ => Vec::new(),
            },
            Body::InviteAccept { invite, .. } => {
                used.push(Right::Invite(invite.clone()));
                match self.invites.get(invite) {
                    Some(inv) => {
                        let creator = &inv.created_by;
                        used.push(Right::Member(creator.clone()));
                        let by_admin =
                            admin(&inv.team, creator) && inv.role != InviteRole::TeamAdmin;
                        one_of(creator, self.is_superadmin(creator), by_admin, &inv.team)
                    }
                    None => Vec::new(),
                }
            }
        };
        Used { all: used, any }
    }

    /// Rights a revocation takes away at this state (empty for other ops).
    fn rights_taken(&self, op: &VerifiedOp) -> Vec<Right> {
        match &op.payload.body {
            Body::MemberRemove { member } | Body::MemberSuspend { member } => {
                vec![Right::Member(member.clone())]
            }
            Body::SuperadminRemove { member } => vec![Right::Superadmin(member.clone())],
            Body::TeamAdminUnset { team, member } => {
                vec![Right::TeamAdmin(team.clone(), member.clone())]
            }
            Body::TeamMemberRemove { team, member }
                if self.team_role(team, member) == Some(TeamRole::Admin) =>
            {
                vec![Right::TeamAdmin(team.clone(), member.clone())]
            }
            Body::TeamDelete { team } => vec![Right::AllTeamAdmins(team.clone())],
            Body::InviteRevoke { invite } => vec![Right::Invite(invite.clone())],
            // Moving a department admin out of the department ends that
            // admin right.
            Body::TeamMove { team, member } => self
                .teams_of(member)
                .into_iter()
                .filter(|(t, role)| &t.id != team && *role == TeamRole::Admin)
                .map(|(t, _)| Right::TeamAdmin(t.id.clone(), member.clone()))
                .collect(),
            Body::ProjectMemberRemove { project, member } => {
                vec![Right::ProjectMember(project.clone(), member.clone())]
            }
            _ => Vec::new(),
        }
    }

    /// One alternative per way `author` manages the project. A creator or
    /// superadmin manages only while a project member.
    fn project_rights(&self, project: &str, author: &str) -> Vec<Vec<Right>> {
        let member = || Right::ProjectMember(project.to_owned(), author.to_owned());
        self.project_manager_paths(project, author)
            .into_iter()
            .map(|path| match path {
                ManagerPath::Creator => vec![member()],
                ManagerPath::DepartmentAdmin(team) => {
                    vec![Right::TeamAdmin(team, author.to_owned())]
                }
                ManagerPath::Superadmin => vec![Right::Superadmin(author.to_owned()), member()],
            })
            .collect()
    }
}

/// Fixed-size set of op positions.
#[derive(Debug, Clone)]
struct Bits(Vec<u64>);

impl Bits {
    fn new(n: usize) -> Bits {
        Bits(vec![0; n.div_ceil(64)])
    }

    fn insert(&mut self, i: usize) -> bool {
        let (word, bit) = (i / 64, 1u64 << (i % 64));
        let new = self.0[word] & bit == 0;
        self.0[word] |= bit;
        new
    }

    fn contains(&self, i: usize) -> bool {
        self.0[i / 64] & (1u64 << (i % 64)) != 0
    }
}

/// Ops in fold order with their `deps` graph.
struct Log<'a> {
    ops: Vec<&'a VerifiedOp>,
    /// False when a present dep does not have a lower lamport.
    deps_ok: Vec<bool>,
    /// Causal past of revocations, accepts and reinstatements.
    past: Vec<Option<Bits>>,
    /// Position of each op id.
    index: HashMap<&'a str, usize>,
}

impl<'a> Log<'a> {
    fn new(ops: &'a [VerifiedOp]) -> Log<'a> {
        let mut sorted: Vec<&VerifiedOp> = ops.iter().collect();
        sorted.sort_by(|a, b| a.order_key().cmp(&b.order_key()));
        sorted.dedup_by(|a, b| a.id == b.id);
        let n = sorted.len();
        let index: HashMap<&'a str, usize> = sorted
            .iter()
            .copied()
            .enumerate()
            .map(|(i, op)| (op.id.as_str(), i))
            .collect();
        let mut deps_ok = Vec::with_capacity(n);
        let mut parents = Vec::with_capacity(n);
        for op in &sorted {
            let present: Vec<usize> = op
                .deps()
                .iter()
                .filter_map(|d| index.get(d.as_str()).copied())
                .collect();
            let ok = present.iter().all(|&j| sorted[j].lamport() < op.lamport());
            deps_ok.push(ok);
            // Deps of an op with bad deps are not followed: they could
            // point forward in the order.
            parents.push(if ok { present } else { Vec::new() });
        }
        let past = (0..n)
            .map(|i| {
                let body = &sorted[i].payload.body;
                let needed = is_revocation(body)
                    || matches!(
                        body,
                        Body::InviteAccept { .. } | Body::MemberReinstate { .. }
                    );
                (deps_ok[i] && needed).then(|| closure(&parents, i, n))
            })
            .collect();
        Log {
            ops: sorted,
            deps_ok,
            past,
            index,
        }
    }

    fn past(&self, i: usize) -> &Bits {
        self.past[i]
            .as_ref()
            .expect("past is kept for revocations, accepts and reinstatements")
    }
}

fn closure(parents: &[Vec<usize>], from: usize, n: usize) -> Bits {
    let mut bits = Bits::new(n);
    let mut stack = parents[from].clone();
    while let Some(i) = stack.pop() {
        if bits.insert(i) {
            stack.extend(&parents[i]);
        }
    }
    bits
}

/// A revocation that was valid in its causal past.
struct Revocation {
    /// Position in fold order.
    pos: usize,
    used: Used,
    taken: Vec<Right>,
    /// Seniority of the author in the revocation's past: 0 for the founder,
    /// else 1 + position of the op that made them superadmin; `u64::MAX`
    /// when not a superadmin.
    rank: u64,
    /// Indexes of the revocations that beat this one.
    beaten_by: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    Off,
    Open,
    Win,
    Lose,
}

/// Grounded resolution: a revocation wins when every revocation that beats
/// it loses, and loses when one of them wins. A cycle is broken by letting
/// the most senior open revocation win.
fn settle(revs: &[Revocation], active: &[bool]) -> Vec<Status> {
    let mut st: Vec<Status> = active
        .iter()
        .map(|&a| if a { Status::Open } else { Status::Off })
        .collect();
    loop {
        let mut progress = false;
        for k in 0..revs.len() {
            if st[k] != Status::Open {
                continue;
            }
            let mut attackers = revs[k]
                .beaten_by
                .iter()
                .map(|&a| st[a])
                .filter(|s| *s != Status::Off);
            if attackers.clone().any(|s| s == Status::Win) {
                st[k] = Status::Lose;
                progress = true;
            } else if attackers.all(|s| s == Status::Lose) {
                st[k] = Status::Win;
                progress = true;
            }
        }
        if progress {
            continue;
        }
        let pick = (0..revs.len())
            .filter(|&k| st[k] == Status::Open)
            .min_by_key(|&k| (revs[k].rank, revs[k].pos));
        let Some(k) = pick else {
            return st;
        };
        st[k] = Status::Win;
        for &a in &revs[k].beaten_by {
            if st[a] == Status::Open {
                st[a] = Status::Lose;
            }
        }
    }
}

/// Ops folded in order on top of the genesis state.
struct Pass<'a> {
    state: OrgState,
    /// Outcome per position; `None` for ops not folded.
    outcomes: Vec<Option<Outcome>>,
    /// Seniority of each superadmin (see `Revocation::rank`).
    ranks: HashMap<String, u64>,
    /// Position of the applied `invite_create` of each invite.
    created: HashMap<&'a str, usize>,
}

impl<'a> Pass<'a> {
    fn new(org: &Organization, n: usize) -> Pass<'a> {
        Pass {
            state: OrgState::genesis(org),
            outcomes: vec![None; n],
            ranks: HashMap::from([(org.founder_public_key.clone(), 0u64)]),
            created: HashMap::new(),
        }
    }

    /// Folds the op at `i`. `decided` is its result as a settled
    /// revocation; `winners` are the revocations that won.
    fn step(&mut self, log: &Log<'a>, i: usize, decided: Option<bool>, winners: &[&Revocation]) {
        let op = log.ops[i];
        let outcome = self.judge(log, i, decided, winners);
        if outcome.is_ok() {
            match &op.payload.body {
                Body::SuperadminAdd { member } => {
                    self.ranks.insert(member.clone(), i as u64 + 1);
                }
                Body::InviteCreate { invite, .. } => {
                    self.created.entry(invite.as_str()).or_insert(i);
                }
                _ => {}
            }
        }
        self.outcomes[i] = Some(outcome);
    }

    /// Outcome of the op at `i`, applying it when valid.
    fn judge(
        &mut self,
        log: &Log<'a>,
        i: usize,
        decided: Option<bool>,
        winners: &[&Revocation],
    ) -> Outcome {
        let op = log.ops[i];
        if !log.deps_ok[i] {
            return Err(Reason::BadDeps);
        }
        // An accept must have seen the invite it redeems, so it cannot be
        // backdated before the invite to take a single-use slot early.
        if let Body::InviteAccept { invite, .. } = &op.payload.body
            && let Some(&c) = self.created.get(invite.as_str())
            && !log.past(i).contains(c)
        {
            return Err(Reason::BadDeps);
        }
        // A reinstatement answers the suspensions its author saw. One that
        // did not see every suspension in force (some made by another
        // laptop concurrently) does not lift them.
        if let Body::MemberReinstate { member } = &op.payload.body
            && let Some(m) = self.state.member(member)
            && m.suspension_op
                .iter()
                .chain(&m.joint_suspensions)
                .filter_map(|s| log.index.get(s.as_str()))
                .any(|&j| !log.past(i).contains(j))
        {
            return Err(Reason::ConcurrentWithRevocation);
        }
        match decided {
            Some(false) => return Err(Reason::ConcurrentWithRevocation),
            Some(true) => {}
            // Team ops are never listed in `deps` of org ops, so their
            // causal order to a revocation is unknown.
            None if op.payload.scope == Scope::Org && winners.iter().any(|r| r.pos > i) => {
                let used = self.state.rights_used(op);
                // Everything the revocations concurrent with this op take
                // away, together: an op allowed through two rights is
                // rejected when both are revoked, even by two separate ops.
                let taken: Vec<&Right> = winners
                    .iter()
                    .filter(|r| {
                        r.pos > i
                            && log.ops[r.pos].author() != op.author()
                            && !log.past(r.pos).contains(i)
                    })
                    .flat_map(|r| r.taken.iter())
                    .collect();
                let revoked = used.lost(&taken);
                if revoked {
                    return Err(Reason::ConcurrentWithRevocation);
                }
            }
            None => {}
        }
        self.state.apply(op)
    }
}

impl<'a> Log<'a> {
    /// Folds the ops in `within` (all when `None`), with the revocations
    /// among them settled.
    fn resolve(&self, org: &Organization, revs: &[Revocation], within: Option<&Bits>) -> Pass<'a> {
        let mut active: Vec<bool> = revs
            .iter()
            .map(|r| within.is_none_or(|w| w.contains(r.pos)))
            .collect();
        loop {
            let status = settle(revs, &active);
            let pass = self.pass(org, revs, &status, within);
            let mut dropped = false;
            for (k, r) in revs.iter().enumerate() {
                if status[k] == Status::Win && !matches!(pass.outcomes[r.pos], Some(Ok(()))) {
                    active[k] = false;
                    dropped = true;
                }
            }
            if !dropped {
                return pass;
            }
        }
    }

    fn pass(
        &self,
        org: &Organization,
        revs: &[Revocation],
        status: &[Status],
        within: Option<&Bits>,
    ) -> Pass<'a> {
        let n = self.ops.len();
        let mut decided: Vec<Option<bool>> = vec![None; n];
        let mut winners: Vec<&Revocation> = Vec::new();
        for (r, s) in revs.iter().zip(status) {
            match s {
                Status::Win => {
                    decided[r.pos] = Some(true);
                    winners.push(r);
                }
                Status::Lose => decided[r.pos] = Some(false),
                Status::Off | Status::Open => {}
            }
        }
        let mut pass = Pass::new(org, n);
        for (i, d) in decided.into_iter().enumerate() {
            if within.is_none_or(|w| w.contains(i)) {
                pass.step(self, i, d, &winners);
            }
        }
        pass
    }

    /// Whether the causal past of `i` holds every earlier org op (bad ones
    /// aside): then it equals the whole prefix for what matters here, since
    /// team ops do not change rights.
    fn sees_prefix(&self, i: usize, org_ops: &Bits) -> bool {
        let past = self.past(i);
        let (full, rest) = (i / 64, i % 64);
        let word_ok = |w: usize, mask: u64| org_ops.0[w] & mask & !past.0[w] == 0;
        (0..full).all(|w| word_ok(w, u64::MAX)) && (rest == 0 || word_ok(full, (1u64 << rest) - 1))
    }
}

/// The fold with causal rules (see the module docs).
pub(crate) fn fold_ops(org: &Organization, ops: &[VerifiedOp]) -> FoldResult {
    let log = Log::new(ops);
    let n = log.ops.len();
    // Org ops with good deps: those a revocation must have seen for its
    // past to be the whole prefix.
    let mut org_ops = Bits::new(n);
    for i in 0..n {
        if log.deps_ok[i] && log.ops[i].payload.scope == Scope::Org {
            org_ops.insert(i);
        }
    }
    let mut revs: Vec<Revocation> = Vec::new();
    // The prefix folded so far, when no revocation in it was concurrent
    // with an earlier op (the usual case): later revocations that saw the
    // whole prefix are judged on it without folding again.
    let mut prefix: Option<(usize, Pass)> = Some((0, Pass::new(org, n)));
    for i in 0..n {
        let op = log.ops[i];
        if !log.deps_ok[i] || !is_revocation(&op.payload.body) {
            continue;
        }
        let past = log.past(i);
        let mut run = if log.sees_prefix(i, &org_ops) {
            let (from, mut p) = match prefix.take() {
                Some(state) => state,
                None => {
                    let mut upto = Bits::new(n);
                    for j in 0..i {
                        upto.insert(j);
                    }
                    (i, log.resolve(org, &revs, Some(&upto)))
                }
            };
            for j in from..i {
                p.step(&log, j, None, &[]);
            }
            p
        } else {
            prefix = None;
            log.resolve(org, &revs, Some(past))
        };
        let used = run.state.rights_used(op);
        let taken = run.state.rights_taken(op);
        let rank = if run.state.is_superadmin(op.author()) {
            run.ranks.get(op.author()).copied().unwrap_or(u64::MAX)
        } else {
            u64::MAX
        };
        // Tests check the shortcut against a full resolve (small logs only).
        #[cfg(test)]
        if n < 300 {
            check_against_full(&log, org, &revs, i, &run.state, &used, &taken, rank);
        }
        let result = run.state.apply(op);
        let valid = result.is_ok();
        if prefix.is_none() && log.sees_prefix(i, &org_ops) {
            run.outcomes[i] = Some(result);
            prefix = Some((i + 1, run));
        }
        if !valid {
            continue;
        }
        let me = revs.len();
        let mut rev = Revocation {
            pos: i,
            used,
            taken,
            rank,
            beaten_by: Vec::new(),
        };
        for (k, other) in revs.iter_mut().enumerate() {
            if past.contains(other.pos) || log.ops[other.pos].author() == op.author() {
                continue;
            }
            let beats_other = other.used.lost_to(&rev.taken);
            let beaten = rev.used.lost_to(&other.taken);
            match (beats_other, beaten) {
                (true, true) if rev.rank < other.rank => other.beaten_by.push(me),
                (true, true) if other.rank < rev.rank => rev.beaten_by.push(k),
                (true, true) => {
                    other.beaten_by.push(me);
                    rev.beaten_by.push(k);
                }
                (true, false) => other.beaten_by.push(me),
                (false, true) => rev.beaten_by.push(k),
                (false, false) => {}
            }
        }
        revs.push(rev);
    }
    // When every revocation since the last full resolve saw the whole
    // prefix, folding the rest of the ops gives the full resolution.
    let run = match prefix {
        Some((from, mut p)) => {
            for j in from..n {
                p.step(&log, j, None, &[]);
            }
            #[cfg(test)]
            if n < 300 {
                let full = log.resolve(org, &revs, None);
                assert_eq!(full.outcomes, p.outcomes, "shortcut differs from full fold");
                assert_eq!(full.state, p.state, "shortcut differs from full fold");
            }
            p
        }
        None => log.resolve(org, &revs, None),
    };
    let outcomes = log
        .ops
        .iter()
        .zip(run.outcomes)
        .map(|(op, o)| (op.id.clone(), o.expect("every op is folded")))
        .collect();
    FoldResult {
        state: run.state,
        outcomes,
    }
}

/// Test check: a revocation judged on the prefix gives what a full resolve
/// of its causal past gives.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn check_against_full(
    log: &Log,
    org: &Organization,
    revs: &[Revocation],
    i: usize,
    state: &OrgState,
    used: &Used,
    taken: &[Right],
    rank: u64,
) {
    let op = log.ops[i];
    let mut full = log.resolve(org, revs, Some(log.past(i)));
    assert_eq!(&full.state.rights_used(op), used);
    assert_eq!(full.state.rights_taken(op), taken);
    assert_eq!(full.state.is_superadmin(op.author()), rank != u64::MAX);
    let valid = state.clone().apply(op).is_ok();
    assert_eq!(full.state.apply(op).is_ok(), valid, "shortcut differs");
}

/// `deps` for the next op made on this laptop: org ops whose whole causal
/// past is stored here and that no other such op lists, the latest
/// `MAX_DEPS` in fold order, sorted by id.
///
/// Team ops are left out because laptops outside the team never receive
/// them. Ops with a missing ancestor are left out so that nobody can make
/// this laptop vouch for an op it has not seen (an op listing a withheld
/// op, revealed only after a revocation).
pub fn heads(ops: &[VerifiedOp]) -> Vec<String> {
    heads_of(ops)
}

/// `heads` of any collection of ops.
pub(crate) fn heads_of<'a>(ops: impl IntoIterator<Item = &'a VerifiedOp>) -> Vec<String> {
    let mut sorted: Vec<&VerifiedOp> = ops.into_iter().collect();
    sorted.sort_by(|a, b| a.order_key().cmp(&b.order_key()));
    sorted.dedup_by(|a, b| a.id == b.id);
    let index: HashMap<&str, usize> = sorted
        .iter()
        .enumerate()
        .map(|(i, op)| (op.id.as_str(), i))
        .collect();
    let mut complete = vec![false; sorted.len()];
    for (i, op) in sorted.iter().enumerate() {
        complete[i] = op.deps().iter().all(|d| {
            index
                .get(d.as_str())
                .is_some_and(|&j| sorted[j].lamport() < op.lamport() && complete[j])
        });
    }
    let known: Vec<&VerifiedOp> = sorted
        .iter()
        .zip(&complete)
        .filter(|(op, c)| **c && op.payload.scope == Scope::Org)
        .map(|(op, _)| *op)
        .collect();
    let listed: HashSet<&str> = known
        .iter()
        .flat_map(|op| op.deps().iter().map(String::as_str))
        .collect();
    let mut heads: Vec<String> = known
        .iter()
        .filter(|op| !listed.contains(op.id.as_str()))
        .map(|op| op.id.clone())
        .collect();
    if heads.len() > MAX_DEPS {
        heads.drain(..heads.len() - MAX_DEPS);
    }
    heads.sort();
    heads
}
