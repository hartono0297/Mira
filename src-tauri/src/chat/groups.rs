//! Group membership fold (docs/plans/v03-c.md, section 3). Pure: no
//! database, no clock. `audience.rs` loads the ops of one group from
//! `chat_records` and folds them here.
//!
//! The ops of a group form a graph: every op after `group_create` names the
//! heads its author knew in `deps`. Folding walks that graph in topological
//! order (ties by `(at, id)`), so every laptop with the same ops reaches the
//! same state whatever order they arrived in.
//!
//! Rights while folding: adding and renaming need a member, removing someone
//! else needs the effective owner, leaving (removing yourself) needs a
//! member. An op by X is ignored when an applied removal of X is concurrent
//! with it (neither is an ancestor of the other), so a removed member cannot
//! act through ops dated or based before their removal.

use std::collections::{BTreeSet, HashMap, HashSet};

use time::OffsetDateTime;

use super::model::{Body, Conv, MAX_GROUP_DEPS, VerifiedRecord, group_conv, parse_conv};

/// Slack around membership intervals when judging a message's time, for
/// laptop clocks that disagree.
pub const MEMBER_SLACK: time::Duration = time::Duration::minutes(10);
/// Most rounds of the concurrent-revocation fixpoint.
pub const MAX_FOLD_ROUNDS: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupOpKind {
    Create {
        name: String,
        members: Vec<String>,
    },
    Add {
        members: Vec<String>,
    },
    /// `member == author` is leaving.
    Remove {
        member: String,
    },
    Rename {
        name: String,
    },
}

/// One stored group op.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupOp {
    /// Record id (64 hex).
    pub id: String,
    pub author: String,
    pub at: OffsetDateTime,
    /// Empty for `Create`.
    pub deps: Vec<String>,
    pub kind: GroupOpKind,
}

impl GroupOp {
    /// The op in a verified record, with its conversation; `None` for other
    /// kinds.
    pub fn from_record(rec: &VerifiedRecord) -> Option<(String, GroupOp)> {
        let (conv, deps, kind) = match rec.body() {
            Body::GroupCreate {
                group,
                name,
                members,
            } => (
                group_conv(group),
                Vec::new(),
                GroupOpKind::Create {
                    name: name.clone(),
                    members: members.clone(),
                },
            ),
            Body::GroupAdd {
                conv,
                members,
                deps,
            } => (
                conv.clone(),
                deps.clone(),
                GroupOpKind::Add {
                    members: members.clone(),
                },
            ),
            Body::GroupRemove { conv, member, deps } => (
                conv.clone(),
                deps.clone(),
                GroupOpKind::Remove {
                    member: member.clone(),
                },
            ),
            Body::GroupRename { conv, name, deps } => (
                conv.clone(),
                deps.clone(),
                GroupOpKind::Rename { name: name.clone() },
            ),
            _ => return None,
        };
        Some((
            conv,
            GroupOp {
                id: rec.id.clone(),
                author: rec.author().to_owned(),
                at: rec.at,
                deps,
                kind,
            },
        ))
    }
}

/// A current member.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub pk: String,
    /// Who added them (the creator for themself and the first members).
    pub added_by: String,
    pub added_at: OffsetDateTime,
    /// Join order in the fold, lower is earlier ("paling lama di grup").
    pub seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventKind {
    /// The creator and the other first members (eligible ones only).
    Created {
        members: Vec<String>,
    },
    /// Who actually joined (eligible and not already members).
    Added {
        members: Vec<String>,
    },
    /// Someone removed by the owner.
    Removed {
        member: String,
    },
    /// The author left.
    Left,
    Renamed {
        name: String,
    },
    /// Ownership passed on (after the stored owner left or was removed).
    /// `author` of the event is the author of that leave or removal.
    OwnerChanged {
        owner: String,
    },
}

/// Something that happened in the group, for the conversation view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupEvent {
    pub op: String,
    pub at: OffsetDateTime,
    pub author: String,
    pub kind: EventKind,
}

/// The folded state of one group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupState {
    /// 32 hex.
    pub id: String,
    pub conv: String,
    pub creator: String,
    pub created_at: OffsetDateTime,
    pub name: String,
    /// The stored owner: the creator, then whoever ownership passed to.
    pub owner: Option<String>,
    /// Current members in join order.
    pub members: Vec<Member>,
    /// Applied ops in fold order.
    pub events: Vec<GroupEvent>,
    /// Membership intervals per key: (joined at, left at).
    pub intervals: HashMap<String, Vec<(OffsetDateTime, Option<OffsetDateTime>)>>,
    /// Id of the last applied removal (or leave) of each key.
    pub last_revocation: HashMap<String, String>,
    /// Every op of the group, by id (applied or not).
    pub ops: HashMap<String, GroupOp>,
    /// Ids of ops applied by the fold.
    pub applied: HashSet<String>,
}

impl GroupState {
    pub fn is_member(&self, pk: &str) -> bool {
        self.members.iter().any(|m| m.pk == pk)
    }

    /// Was ever a member (creator included).
    pub fn ever_member(&self, pk: &str) -> bool {
        self.intervals.contains_key(pk)
    }

    /// A member now, or a member at `at` give or take [`MEMBER_SLACK`].
    pub fn member_at(&self, pk: &str, at: OffsetDateTime) -> bool {
        if self.is_member(pk) {
            return true;
        }
        self.intervals.get(pk).is_some_and(|spans| {
            spans.iter().any(|(start, end)| {
                *start - MEMBER_SLACK <= at && end.is_none_or(|end| at <= end + MEMBER_SLACK)
            })
        })
    }

    /// The stored owner when they are a member and `eligible`; otherwise the
    /// eligible member who joined first. `None` when no member is eligible.
    pub fn effective_owner(&self, eligible: &dyn Fn(&str) -> bool) -> Option<&str> {
        if let Some(owner) = &self.owner
            && self.is_member(owner)
            && eligible(owner)
        {
            return Some(owner);
        }
        self.members
            .iter()
            .filter(|m| eligible(&m.pk))
            .min_by_key(|m| m.seq)
            .map(|m| m.pk.as_str())
    }

    /// Ops no other op names in `deps` (what a new op names), sorted, at
    /// most `MAX_GROUP_DEPS` (the latest by `(at, id)` when more).
    pub fn heads(&self) -> Vec<String> {
        let named: HashSet<&str> = self
            .ops
            .values()
            .flat_map(deps_of)
            .map(String::as_str)
            .collect();
        let mut heads: Vec<&GroupOp> = self
            .ops
            .values()
            .filter(|op| !named.contains(op.id.as_str()))
            .collect();
        if heads.len() > MAX_GROUP_DEPS {
            heads.sort_by(|a, b| (b.at, &b.id).cmp(&(a.at, &a.id)));
            heads.truncate(MAX_GROUP_DEPS);
        }
        let mut ids: Vec<String> = heads.into_iter().map(|op| op.id.clone()).collect();
        ids.sort();
        ids
    }

    /// Ids of the ops `peer` may receive: every op for a current member; for
    /// someone whose last membership ended by a removal or leave, that op and
    /// its ancestors; nothing otherwise.
    pub fn deliverable_ops(&self, peer: &str) -> HashSet<String> {
        if self.is_member(peer) {
            return self.ops.keys().cloned().collect();
        }
        let Some(revocation) = self.last_revocation.get(peer) else {
            return HashSet::new();
        };
        let Some(op) = self.ops.get(revocation) else {
            return HashSet::new();
        };
        // The removal was applied, so its ancestors are all here.
        let (past, _) = ancestors(|id| self.ops.get(id), deps_of(op));
        past.into_iter()
            .map(str::to_owned)
            .chain([revocation.clone()])
            .collect()
    }

    /// Adds `pk` with the next join number.
    fn join(&mut self, pk: &str, by: &str, at: OffsetDateTime, seq: &mut u64) {
        self.members.push(Member {
            pk: pk.to_owned(),
            added_by: by.to_owned(),
            added_at: at,
            seq: *seq,
        });
        *seq += 1;
        self.intervals
            .entry(pk.to_owned())
            .or_default()
            .push((at, None));
    }

    /// Takes `pk` out, closes their interval and remembers the op, so the
    /// removed laptop can still be told it is out.
    fn part(&mut self, pk: &str, op: &GroupOp) {
        self.members.retain(|m| m.pk != pk);
        if let Some(open) = self
            .intervals
            .get_mut(pk)
            .and_then(|spans| spans.last_mut())
            .filter(|(_, end)| end.is_none())
        {
            open.1 = Some(op.at);
        }
        self.last_revocation.insert(pk.to_owned(), op.id.clone());
    }

    /// After the stored owner is gone: the eligible member who joined first,
    /// else (nobody eligible) the member who joined first, so a member who is
    /// eligible again later still finds an owner on record. `None` only when
    /// the group is empty.
    fn pass_ownership(&mut self, eligible: &dyn Fn(&str) -> bool) -> Option<String> {
        let next = self
            .members
            .iter()
            .filter(|m| eligible(&m.pk))
            .min_by_key(|m| m.seq)
            .or_else(|| self.members.iter().min_by_key(|m| m.seq))
            .map(|m| m.pk.clone());
        self.owner = next.clone();
        next
    }

    fn event(&mut self, op: &GroupOp, kind: EventKind) {
        self.events.push(GroupEvent {
            op: op.id.clone(),
            at: op.at,
            author: op.author.clone(),
            kind,
        });
    }
}

/// The deps an op is ordered after. A `Create` is the root, whatever it says.
fn deps_of(op: &GroupOp) -> &[String] {
    match op.kind {
        GroupOpKind::Create { .. } => &[],
        _ => &op.deps,
    }
}

/// Every op reachable through `deps`, and whether one of them is missing.
fn ancestors<'a>(
    get: impl Fn(&str) -> Option<&'a GroupOp>,
    deps: &'a [String],
) -> (HashSet<&'a str>, bool) {
    let mut seen = HashSet::new();
    let mut missing = false;
    let mut stack: Vec<&str> = deps.iter().map(String::as_str).collect();
    while let Some(id) = stack.pop() {
        if !seen.insert(id) {
            continue;
        }
        match get(id) {
            Some(op) => stack.extend(deps_of(op).iter().map(String::as_str)),
            None => missing = true,
        }
    }
    (seen, missing)
}

/// The ops a fold walks, in topological order, with their ancestors.
struct Graph<'a> {
    order: Vec<&'a GroupOp>,
    /// `anc[i]`: indexes in `order` of every ancestor of `order[i]`.
    anc: Vec<HashSet<usize>>,
}

impl Graph<'_> {
    /// Kahn's algorithm from the earliest `Create`, ready ops taken by
    /// `(at, id)`. Ops that never become ready (a dep missing, another
    /// `Create`, a cycle) are left out.
    fn build(all: &HashMap<String, GroupOp>) -> Option<Graph<'_>> {
        let create = all
            .values()
            .filter(|op| matches!(op.kind, GroupOpKind::Create { .. }))
            .min_by(|a, b| (a.at, &a.id).cmp(&(b.at, &b.id)))?;
        let mut waiting: HashMap<&str, usize> = HashMap::new();
        let mut dependents: HashMap<&str, Vec<&GroupOp>> = HashMap::new();
        for op in all.values() {
            let deps: BTreeSet<&str> = deps_of(op).iter().map(String::as_str).collect();
            if deps.is_empty() {
                continue;
            }
            waiting.insert(&op.id, deps.len());
            for dep in deps {
                dependents.entry(dep).or_default().push(op);
            }
        }
        let mut ready = BTreeSet::from([(create.at, create.id.as_str())]);
        let mut index: HashMap<&str, usize> = HashMap::new();
        let mut order = Vec::new();
        let mut anc: Vec<HashSet<usize>> = Vec::new();
        while let Some((_, id)) = ready.pop_first() {
            let op = &all[id];
            let mut past = HashSet::new();
            for dep in deps_of(op) {
                let j = index[dep.as_str()];
                past.insert(j);
                past.extend(anc[j].iter().copied());
            }
            index.insert(id, order.len());
            order.push(op);
            anc.push(past);
            for next in dependents.get(id).into_iter().flatten() {
                let left = waiting.get_mut(next.id.as_str()).expect("counted above");
                *left -= 1;
                if *left == 0 {
                    ready.insert((next.at, next.id.as_str()));
                }
            }
        }
        Some(Graph { order, anc })
    }

    /// Neither is an ancestor of the other.
    fn concurrent(&self, a: usize, b: usize) -> bool {
        a != b && !self.anc[a].contains(&b) && !self.anc[b].contains(&a)
    }
}

/// An applied removal or leave: (who went, index in `Graph::order`).
type Revocation = (String, usize);

/// One pass over the graph, ignoring every op whose author has a revocation
/// in `revoked` concurrent with it. Returns the state and the revocations
/// this pass applied.
fn fold_round(
    graph: &Graph<'_>,
    eligible: &dyn Fn(&str) -> bool,
    revoked: &[Revocation],
) -> (GroupState, Vec<Revocation>) {
    let create = graph.order[0];
    let GroupOpKind::Create { name, members } = &create.kind else {
        unreachable!("the graph starts at a create");
    };
    let mut state = GroupState {
        id: String::new(),
        conv: String::new(),
        creator: create.author.clone(),
        created_at: create.at,
        name: name.clone(),
        owner: Some(create.author.clone()),
        members: Vec::new(),
        events: Vec::new(),
        intervals: HashMap::new(),
        last_revocation: HashMap::new(),
        ops: HashMap::new(),
        applied: HashSet::from([create.id.clone()]),
    };
    let mut seq = 0;
    state.join(&create.author, &create.author, create.at, &mut seq);
    // Joining does not depend on `eligible`: the judge refuses guests and
    // unknown keys, and someone removed from the organization later keeps
    // their place in the history (the audience leaves them out), so the ops
    // they made while active stay valid.
    for pk in members {
        if !state.is_member(pk) {
            state.join(pk, &create.author, create.at, &mut seq);
        }
    }
    let first = state.members.iter().map(|m| m.pk.clone()).collect();
    state.event(create, EventKind::Created { members: first });

    let mut applied_revocations = Vec::new();
    for (i, &op) in graph.order.iter().enumerate().skip(1) {
        let author = op.author.as_str();
        if revoked
            .iter()
            .any(|(pk, r)| pk == author && graph.concurrent(i, *r))
        {
            continue;
        }
        if !state.is_member(author) {
            continue;
        }
        match &op.kind {
            // A second create never reaches the graph.
            GroupOpKind::Create { .. } => continue,
            GroupOpKind::Add { members } => {
                let mut joined = Vec::new();
                for pk in members {
                    if !state.is_member(pk) {
                        state.join(pk, author, op.at, &mut seq);
                        joined.push(pk.clone());
                    }
                }
                if !joined.is_empty() {
                    state.event(op, EventKind::Added { members: joined });
                }
            }
            GroupOpKind::Remove { member } => {
                let leaving = member == author;
                if !leaving && state.effective_owner(eligible) != Some(author) {
                    continue;
                }
                if !state.is_member(member) {
                    continue;
                }
                state.part(member, op);
                applied_revocations.push((member.clone(), i));
                let kind = if leaving {
                    EventKind::Left
                } else {
                    EventKind::Removed {
                        member: member.clone(),
                    }
                };
                state.event(op, kind);
                if state.owner.as_deref() == Some(member.as_str())
                    && let Some(owner) = state.pass_ownership(eligible)
                {
                    state.event(op, EventKind::OwnerChanged { owner });
                }
            }
            GroupOpKind::Rename { name } => {
                if *name != state.name {
                    state.name = name.clone();
                    state.event(op, EventKind::Renamed { name: name.clone() });
                }
            }
        }
        state.applied.insert(op.id.clone());
    }
    (state, applied_revocations)
}

/// Folds every op of one group. `None` when `ops` has no `Create` (a second
/// `Create` is ignored). Ops whose `deps` are not all in `ops` are ignored
/// (the judge never stores them).
///
/// A [`GroupOp`] does not carry its conversation, so `id` and `conv` of the
/// result are empty here; [`fold_conv`] fills them.
pub fn fold(ops: &[GroupOp], eligible: &dyn Fn(&str) -> bool) -> Option<GroupState> {
    let mut all: HashMap<String, GroupOp> = HashMap::new();
    for op in ops {
        all.entry(op.id.clone()).or_insert_with(|| op.clone());
    }
    let graph = Graph::build(&all)?;
    // Whether a removal applies depends on revocations of its own author, so
    // fold again with the revocations the last pass applied until they stop
    // changing.
    let mut revoked = Vec::new();
    let (mut state, mut found) = fold_round(&graph, eligible, &revoked);
    for _ in 1..MAX_FOLD_ROUNDS {
        if found == revoked {
            break;
        }
        revoked = found;
        (state, found) = fold_round(&graph, eligible, &revoked);
    }
    state.ops = all;
    Some(state)
}

/// [`fold`] for the ops of the group conversation `conv` (`gr:<id>`), with
/// `id` and `conv` filled in. `None` also when `conv` is not a group.
pub fn fold_conv(
    conv: &str,
    ops: &[GroupOp],
    eligible: &dyn Fn(&str) -> bool,
) -> Option<GroupState> {
    let Some(Conv::Group(id)) = parse_conv(conv) else {
        return None;
    };
    let mut state = fold(ops, eligible)?;
    state.id = id;
    state.conv = conv.to_owned();
    Some(state)
}

/// Why `op`'s author may not make it on top of its own causal past: folds
/// only the ancestors of `op` (all of them must be in `ops`; `Err("missing_deps")`
/// otherwise) and checks the author's right there. Codes:
/// `not_group_member`, `not_group_owner`, `missing_deps`, `no_group`.
/// A `Create` is always allowed here.
pub fn check_right(
    ops: &[GroupOp],
    op: &GroupOp,
    eligible: &dyn Fn(&str) -> bool,
) -> Result<(), &'static str> {
    if matches!(op.kind, GroupOpKind::Create { .. }) {
        return Ok(());
    }
    let by_id: HashMap<&str, &GroupOp> = ops.iter().map(|o| (o.id.as_str(), o)).collect();
    let (past, missing) = ancestors(|id| by_id.get(id).copied(), &op.deps);
    if missing {
        return Err("missing_deps");
    }
    let past: Vec<GroupOp> = past.into_iter().map(|id| by_id[id].clone()).collect();
    // Every applied removal in the past is an ancestor of `op`, so the
    // concurrent-revocation rule has nothing more to say here.
    let state = fold(&past, eligible).ok_or("no_group")?;
    if !state.is_member(&op.author) {
        return Err("not_group_member");
    }
    if let GroupOpKind::Remove { member } = &op.kind
        && *member != op.author
        && state.effective_owner(eligible) != Some(op.author.as_str())
    {
        return Err("not_group_owner");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::format::parse_time;
    use proptest::prelude::*;

    fn k(c: char) -> String {
        c.to_string().repeat(64)
    }

    fn id(n: u64) -> String {
        format!("{n:064x}")
    }

    fn t(min: i64) -> OffsetDateTime {
        parse_time("2026-11-22T08:00:00Z").unwrap() + time::Duration::minutes(min)
    }

    /// `e` is not eligible (a guest or an inactive member).
    fn eligible(pk: &str) -> bool {
        pk != k('e')
    }

    fn op(n: u64, author: char, min: i64, deps: &[u64], kind: GroupOpKind) -> GroupOp {
        GroupOp {
            id: id(n),
            author: k(author),
            at: t(min),
            deps: deps.iter().map(|d| id(*d)).collect(),
            kind,
        }
    }

    fn create(n: u64, author: char, min: i64, members: &[char]) -> GroupOp {
        let kind = GroupOpKind::Create {
            name: "Tim".into(),
            members: members.iter().map(|c| k(*c)).collect(),
        };
        op(n, author, min, &[], kind)
    }

    fn add(n: u64, author: char, min: i64, deps: &[u64], members: &[char]) -> GroupOp {
        let kind = GroupOpKind::Add {
            members: members.iter().map(|c| k(*c)).collect(),
        };
        op(n, author, min, deps, kind)
    }

    fn remove(n: u64, author: char, min: i64, deps: &[u64], member: char) -> GroupOp {
        let kind = GroupOpKind::Remove { member: k(member) };
        op(n, author, min, deps, kind)
    }

    fn rename(n: u64, author: char, min: i64, deps: &[u64], name: &str) -> GroupOp {
        let kind = GroupOpKind::Rename { name: name.into() };
        op(n, author, min, deps, kind)
    }

    fn run(ops: &[GroupOp]) -> GroupState {
        fold(ops, &eligible).expect("has a create")
    }

    fn pks(state: &GroupState) -> Vec<String> {
        state.members.iter().map(|m| m.pk.clone()).collect()
    }

    fn keys(cs: &[char]) -> Vec<String> {
        cs.iter().map(|c| k(*c)).collect()
    }

    fn ids(ns: &[u64]) -> HashSet<String> {
        ns.iter().map(|n| id(*n)).collect()
    }

    #[test]
    fn create_makes_creator_owner_and_skips_ineligible_members() {
        let s = run(&[create(1, 'a', 0, &['b', 'c', 'e'])]);
        assert_eq!(pks(&s), keys(&['a', 'b', 'c']));
        assert_eq!(
            s.members.iter().map(|m| m.seq).collect::<Vec<_>>(),
            [0, 1, 2]
        );
        assert!(s.members.iter().all(|m| m.added_by == k('a')));
        assert_eq!(s.owner, Some(k('a')));
        assert_eq!(s.creator, k('a'));
        assert_eq!(s.name, "Tim");
        assert!(!s.ever_member(&k('e')));
        assert_eq!(
            s.events,
            [GroupEvent {
                op: id(1),
                at: t(0),
                author: k('a'),
                kind: EventKind::Created {
                    members: keys(&['a', 'b', 'c'])
                },
            }]
        );
        assert_eq!(s.applied, ids(&[1]));
    }

    #[test]
    fn no_create_folds_to_none() {
        assert!(fold(&[add(2, 'a', 1, &[1], &['b'])], &eligible).is_none());
        assert!(fold(&[], &eligible).is_none());
    }

    #[test]
    fn earliest_create_wins() {
        let s = run(&[create(2, 'b', 5, &['a']), create(1, 'a', 0, &['c'])]);
        assert_eq!(s.creator, k('a'));
        assert_eq!(s.ops.len(), 2);
        assert_eq!(s.applied, ids(&[1]));
    }

    #[test]
    fn fold_conv_fills_id_and_conv() {
        let conv = group_conv(&"9".repeat(32));
        let s = fold_conv(&conv, &[create(1, 'a', 0, &[])], &eligible).unwrap();
        assert_eq!(s.id, "9".repeat(32));
        assert_eq!(s.conv, conv);
        assert!(fold_conv("dm:x:y", &[create(1, 'a', 0, &[])], &eligible).is_none());
    }

    #[test]
    fn member_adds_and_non_member_add_is_ignored() {
        let s = run(&[
            create(1, 'a', 0, &['b']),
            add(2, 'b', 1, &[1], &['c', 'e', 'a']),
            add(3, 'f', 2, &[2], &['d']),
        ]);
        assert_eq!(pks(&s), keys(&['a', 'b', 'c']));
        let c = &s.members[2];
        assert_eq!(
            (c.added_by.as_str(), c.added_at, c.seq),
            (k('b').as_str(), t(1), 2)
        );
        assert_eq!(s.applied, ids(&[1, 2]));
        assert_eq!(
            s.events.last().unwrap().kind,
            EventKind::Added {
                members: keys(&['c'])
            }
        );
    }

    #[test]
    fn add_with_nobody_new_applies_without_event() {
        let s = run(&[create(1, 'a', 0, &['b']), add(2, 'a', 1, &[1], &['b', 'e'])]);
        assert!(s.applied.contains(&id(2)));
        assert_eq!(s.events.len(), 1);
    }

    #[test]
    fn owner_removes_and_non_owner_remove_is_ignored() {
        let s = run(&[
            create(1, 'a', 0, &['b', 'c']),
            remove(2, 'b', 1, &[1], 'c'),
            remove(3, 'a', 2, &[2], 'b'),
        ]);
        assert_eq!(pks(&s), keys(&['a', 'c']));
        assert!(!s.applied.contains(&id(2)));
        assert_eq!(s.last_revocation.get(&k('b')), Some(&id(3)));
        assert_eq!(s.intervals[&k('b')], [(t(0), Some(t(2)))]);
        assert_eq!(
            s.events.last().unwrap().kind,
            EventKind::Removed { member: k('b') }
        );
    }

    #[test]
    fn member_leaves() {
        let s = run(&[create(1, 'a', 0, &['b']), remove(2, 'b', 3, &[1], 'b')]);
        assert_eq!(pks(&s), keys(&['a']));
        assert_eq!(s.owner, Some(k('a')));
        assert_eq!(s.last_revocation.get(&k('b')), Some(&id(2)));
        assert_eq!(s.events.last().unwrap().kind, EventKind::Left);
        assert!(s.ever_member(&k('b')));
    }

    #[test]
    fn owner_leaving_passes_ownership_to_oldest_eligible_member() {
        let s = run(&[
            create(1, 'a', 0, &['b', 'c']),
            add(2, 'a', 1, &[1], &['d']),
            remove(3, 'a', 2, &[2], 'a'),
        ]);
        assert_eq!(s.owner, Some(k('b')));
        assert_eq!(s.effective_owner(&eligible), Some(k('b').as_str()));
        let tail: Vec<_> = s.events[2..].iter().map(|e| e.kind.clone()).collect();
        assert_eq!(
            tail,
            [EventKind::Left, EventKind::OwnerChanged { owner: k('b') }]
        );
    }

    #[test]
    fn last_member_leaving_leaves_no_owner() {
        let s = run(&[create(1, 'a', 0, &[]), remove(2, 'a', 1, &[1], 'a')]);
        assert!(s.members.is_empty());
        assert_eq!(s.owner, None);
        assert_eq!(s.effective_owner(&eligible), None);
        assert_eq!(s.events.last().unwrap().kind, EventKind::Left);
        assert_eq!(s.events.len(), 2);
    }

    #[test]
    fn effective_owner_skips_an_ineligible_stored_owner() {
        let not_a = |pk: &str| pk != k('a');
        let ops = [create(1, 'a', 0, &['b', 'c']), remove(2, 'b', 1, &[1], 'c')];
        let s = fold(&ops, &not_a).unwrap();
        assert_eq!(s.owner, Some(k('a')));
        assert_eq!(s.effective_owner(&not_a), Some(k('b').as_str()));
        assert_eq!(pks(&s), keys(&['a', 'b']));
        // The effective owner may remove the ineligible stored owner, and
        // ownership then passes to them.
        let ops = [create(1, 'a', 0, &['b', 'c']), remove(2, 'b', 1, &[1], 'a')];
        let s = fold(&ops, &not_a).unwrap();
        assert_eq!(s.owner, Some(k('b')));
        let kinds: Vec<_> = s.events.iter().map(|e| e.kind.clone()).collect();
        assert_eq!(kinds[2], EventKind::OwnerChanged { owner: k('b') });
    }

    #[test]
    fn rename_changes_name_and_same_name_applies_quietly() {
        let s = run(&[
            create(1, 'a', 0, &['b']),
            rename(2, 'b', 1, &[1], "Baru"),
            rename(3, 'a', 2, &[2], "Baru"),
            rename(4, 'f', 3, &[3], "Asing"),
        ]);
        assert_eq!(s.name, "Baru");
        assert_eq!(s.applied, ids(&[1, 2, 3]));
        assert_eq!(s.events.len(), 2);
        assert_eq!(
            s.events[1].kind,
            EventKind::Renamed {
                name: "Baru".into()
            }
        );
    }

    #[test]
    fn removed_member_can_be_added_again() {
        let s = run(&[
            create(1, 'a', 0, &['b', 'c']),
            remove(2, 'a', 1, &[1], 'b'),
            add(3, 'c', 2, &[2], &['b']),
        ]);
        assert_eq!(pks(&s), keys(&['a', 'c', 'b']));
        let b = &s.members[2];
        assert_eq!((b.seq, b.added_by.as_str()), (3, k('c').as_str()));
        assert_eq!(s.intervals[&k('b')], [(t(0), Some(t(1))), (t(2), None)]);
    }

    #[test]
    fn add_concurrent_with_the_authors_removal_is_ignored() {
        let s = run(&[
            create(1, 'a', 0, &['b']),
            add(2, 'b', 5, &[1], &['c']),
            remove(3, 'a', 1, &[1], 'b'),
        ]);
        assert_eq!(pks(&s), keys(&['a']));
        assert!(!s.applied.contains(&id(2)));
        assert!(!s.ever_member(&k('c')));
    }

    #[test]
    fn backdated_op_on_old_heads_by_removed_member_is_ignored() {
        let s = run(&[
            create(1, 'a', 0, &['b']),
            rename(2, 'a', 1, &[1], "Satu"),
            remove(3, 'a', 10, &[2], 'b'),
            // Made after the removal but dated before it and built on the
            // heads `b` knew.
            add(4, 'b', 2, &[2], &['c']),
            rename(5, 'b', 3, &[4], "Dua"),
        ]);
        assert_eq!(pks(&s), keys(&['a']));
        assert_eq!(s.name, "Satu");
        assert_eq!(s.applied, ids(&[1, 2, 3]));
    }

    #[test]
    fn op_after_being_added_again_is_honored() {
        let s = run(&[
            create(1, 'a', 0, &['b']),
            remove(2, 'a', 1, &[1], 'b'),
            add(3, 'b', 2, &[1], &['c']),
            add(4, 'a', 3, &[2, 3], &['b']),
            add(5, 'b', 4, &[4], &['d']),
        ]);
        assert_eq!(pks(&s), keys(&['a', 'b', 'd']));
        assert_eq!(s.applied, ids(&[1, 2, 4, 5]));
    }

    #[test]
    fn leave_cancels_the_leavers_concurrent_removal() {
        // `a` leaves (ownership to `b`) and, concurrently, removes `b`. The
        // removal sorts first, so a single pass would apply it; the leave is
        // an applied revocation of `a` concurrent with it, so it is dropped.
        let s = run(&[
            create(1, 'a', 0, &['b', 'c']),
            remove(2, 'a', 2, &[1], 'a'),
            remove(3, 'a', 1, &[1], 'b'),
        ]);
        assert_eq!(pks(&s), keys(&['b', 'c']));
        assert_eq!(s.owner, Some(k('b')));
        assert_eq!(s.applied, ids(&[1, 2]));
    }

    #[test]
    fn ops_with_missing_deps_are_kept_but_not_applied() {
        let s = run(&[create(1, 'a', 0, &['b']), add(2, 'a', 1, &[9], &['c'])]);
        assert_eq!(pks(&s), keys(&['a', 'b']));
        assert!(s.ops.contains_key(&id(2)));
        assert_eq!(s.applied, ids(&[1]));
    }

    #[test]
    fn check_right_codes() {
        let ops = [
            create(1, 'a', 0, &['b']),
            remove(2, 'a', 1, &[1], 'b'),
            add(3, 'a', 2, &[2], &['c']),
        ];
        let ok = |o: &GroupOp| check_right(&ops, o, &eligible);
        assert_eq!(ok(&create(9, 'f', 0, &[])), Ok(()));
        assert_eq!(ok(&add(10, 'a', 3, &[3], &['d'])), Ok(()));
        assert_eq!(ok(&add(10, 'a', 3, &[3, 8], &['d'])), Err("missing_deps"));
        assert_eq!(ok(&add(10, 'a', 3, &[], &['d'])), Err("no_group"));
        assert_eq!(ok(&add(10, 'b', 3, &[3], &['d'])), Err("not_group_member"));
        assert_eq!(ok(&rename(10, 'f', 3, &[3], "X")), Err("not_group_member"));
        assert_eq!(ok(&remove(10, 'c', 3, &[3], 'c')), Ok(()));
        assert_eq!(ok(&remove(10, 'c', 3, &[3], 'a')), Err("not_group_owner"));
        assert_eq!(ok(&remove(10, 'b', 3, &[3], 'a')), Err("not_group_member"));
        assert_eq!(ok(&remove(10, 'a', 3, &[3], 'c')), Ok(()));
        // Judged on its own past: `b` was a member before op 2.
        assert_eq!(ok(&add(10, 'b', 5, &[1], &['d'])), Ok(()));

        // A dep present but with an ancestor missing.
        let gap = [create(1, 'a', 0, &[]), add(3, 'a', 2, &[2], &['c'])];
        assert_eq!(
            check_right(&gap, &add(4, 'a', 3, &[3], &['d']), &eligible),
            Err("missing_deps")
        );
        let no_create = [add(2, 'a', 1, &[7], &['b'])];
        assert_eq!(
            check_right(&no_create, &add(3, 'a', 2, &[2], &['c']), &eligible),
            Err("missing_deps")
        );
        // Every dep present, but no create among them.
        let lone = [add(2, 'a', 1, &[], &['b'])];
        assert_eq!(
            check_right(&lone, &add(3, 'a', 2, &[2], &['c']), &eligible),
            Err("no_group")
        );
    }

    #[test]
    fn heads_are_the_unnamed_ops() {
        let s = run(&[
            create(1, 'a', 0, &['b']),
            rename(3, 'a', 1, &[1], "X"),
            rename(2, 'b', 1, &[1], "Y"),
        ]);
        assert_eq!(s.heads(), [id(2), id(3)]);
        let s = run(&[
            create(1, 'a', 0, &['b']),
            rename(2, 'a', 1, &[1], "X"),
            rename(3, 'b', 2, &[2], "Y"),
        ]);
        assert_eq!(s.heads(), [id(3)]);
    }

    #[test]
    fn heads_keep_the_latest_when_too_many() {
        let mut ops = vec![create(1, 'a', 0, &[])];
        let extra = MAX_GROUP_DEPS as u64 + 3;
        for n in 0..extra {
            // Dated so the lowest ids are the latest.
            ops.push(rename(100 + n, 'a', 100 - n as i64, &[1], "X"));
        }
        let heads = run(&ops).heads();
        assert_eq!(heads.len(), MAX_GROUP_DEPS);
        let want: Vec<String> = (100..100 + MAX_GROUP_DEPS as u64).map(id).collect();
        assert_eq!(heads, want);
    }

    #[test]
    fn deliverable_ops_by_peer() {
        let s = run(&[
            create(1, 'a', 0, &['b', 'c']),
            rename(2, 'a', 1, &[1], "X"),
            rename(3, 'c', 1, &[1], "Y"),
            remove(4, 'a', 2, &[2], 'b'),
            add(5, 'a', 3, &[3, 4], &['d']),
        ]);
        assert_eq!(s.deliverable_ops(&k('a')), ids(&[1, 2, 3, 4, 5]));
        assert_eq!(s.deliverable_ops(&k('b')), ids(&[1, 2, 4]));
        assert!(s.deliverable_ops(&k('f')).is_empty());
        assert!(s.deliverable_ops(&k('e')).is_empty());
    }

    #[test]
    fn member_at_uses_intervals_with_slack() {
        let s = run(&[
            create(1, 'a', 0, &['b']),
            remove(2, 'a', 60, &[1], 'b'),
            add(3, 'a', 120, &[2], &['c']),
        ]);
        let b = k('b');
        assert!(s.member_at(&b, t(-10)));
        assert!(!s.member_at(&b, t(-11)));
        assert!(s.member_at(&b, t(30)));
        assert!(s.member_at(&b, t(70)));
        assert!(!s.member_at(&b, t(71)));
        let c = k('c');
        // A current member counts at any time.
        assert!(s.member_at(&c, t(0)));
        assert!(!s.member_at(&k('f'), t(30)));
    }

    /// Ops from random steps: (action, author, target, deps mask, minute).
    fn build(steps: Vec<(u8, u8, u8, u8, i64)>) -> Vec<GroupOp> {
        const PEOPLE: [char; 6] = ['a', 'b', 'c', 'd', 'e', 'f'];
        let mut ops = vec![create(1, 'a', 0, &['b', 'c', 'e'])];
        for (i, (action, author, target, mask, min)) in steps.into_iter().enumerate() {
            let n = i as u64 + 2;
            let author = PEOPLE[author as usize % 6];
            let target = PEOPLE[target as usize % 6];
            let len = ops.len();
            let mut deps: Vec<u64> = (0..8u64)
                .filter(|&b| mask & (1u8 << b) != 0 && b < len as u64)
                .map(|b| n - 1 - b)
                .collect();
            if deps.is_empty() {
                deps.push(n - 1);
            }
            deps.sort();
            let next = match action % 7 {
                0 | 1 => add(n, author, min, &deps, &[target]),
                2 => remove(n, author, min, &deps, target),
                3 => remove(n, author, min, &deps, author),
                4 => rename(n, author, min, &deps, &format!("G{target}")),
                // Never the chosen create: later or same time, higher id.
                5 => create(n, author, min, &[target]),
                _ => add(n, author, min, &[n - 1, 9999], &[target]),
            };
            ops.push(next);
        }
        ops
    }

    fn shuffled_ops() -> impl Strategy<Value = (Vec<GroupOp>, Vec<GroupOp>)> {
        prop::collection::vec(
            (
                any::<u8>(),
                any::<u8>(),
                any::<u8>(),
                any::<u8>(),
                0i64..120,
            ),
            0..40,
        )
        .prop_map(build)
        .prop_flat_map(|ops| (Just(ops.clone()), Just(ops).prop_shuffle()))
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(128))]

        #[test]
        fn fold_ignores_input_order((ops, shuffled) in shuffled_ops()) {
            let a = run(&ops);
            let b = run(&shuffled);
            prop_assert_eq!(a.heads(), b.heads());
            prop_assert_eq!(a, b);
        }
    }
}
