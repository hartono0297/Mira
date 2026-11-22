//! In-process integration tests for Tahap 1: several laptops, each a real
//! `MiraState` (SQLite in a temp dir, `MemoryKeyStore`) behind `MiraBackend`
//! and a real `Network` on loopback QUIC. mDNS is off; laptops find each
//! other through manual addresses, as with `MIRA_DISABLE_MDNS=1`.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use tempfile::TempDir;
use time::OffsetDateTime;

use super::{MiraBackend, from_wire, organization, proof_to_wire};
use crate::clock;
use crate::error::AppResult;
use crate::identity::{self, MemoryKeyStore};
use crate::network::{NetConfig, NetEvent, Network, ProveFn};
use crate::org::{self, OrgInfo, Role};
use crate::peers;
use crate::permissions::{
    self, ChannelView, InviteRole, InviteView, MemberStatus, MemberView, Membership, TeamRole,
    TeamView, Validity,
};
use crate::state::{Core, MiraState};

const TIMEOUT: Duration = Duration::from_secs(20);

async fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + TIMEOUT;
    while Instant::now() < deadline {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out after {TIMEOUT:?} waiting for: {what}");
}

/// A few sync rounds, so anything that would leak has had the chance to.
async fn settle(nodes: &[&Node]) {
    for _ in 0..3 {
        for n in nodes {
            n.net.refresh();
        }
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
}

async fn start_net(state: &MiraState, org_changed: &Arc<AtomicUsize>) -> Network {
    let (identity_secret, public_key) = state
        .with_core(|c| {
            Ok((
                c.identity.secret_bytes(),
                c.identity.public_key_hex().to_owned(),
            ))
        })
        .expect("identity");
    let counter = org_changed.clone();
    Network::start(
        NetConfig {
            identity_secret,
            public_key,
            port: Some(0),
            mdns_enabled: false,
        },
        Arc::new(MiraBackend::new(state.clone())),
        Arc::new(move |ev| {
            if ev == NetEvent::OrgChanged {
                counter.fetch_add(1, Ordering::Relaxed);
            }
        }),
    )
    .await
    .expect("network starts")
}

/// One laptop. Fields drop in order, so the database closes before the
/// temp dir is removed (as far as the network tasks let go of it).
struct Node {
    name: &'static str,
    net: Network,
    state: MiraState,
    pk: String,
    org_changed: Arc<AtomicUsize>,
    _dir: TempDir,
}

impl Node {
    async fn new(name: &'static str) -> Node {
        let dir = tempfile::tempdir().expect("temp dir");
        let state = MiraState::new(
            Ok(dir.path().to_path_buf()),
            Box::new(MemoryKeyStore::new()),
        );
        let pk = state
            .with_core(|c| {
                identity::save_display_name(&mut c.db, &mut c.identity, name)?;
                Ok(c.identity.public_key_hex().to_owned())
            })
            .expect("display name");
        let org_changed = Arc::new(AtomicUsize::new(0));
        let net = start_net(&state, &org_changed).await;
        Node {
            name,
            net,
            state,
            pk,
            org_changed,
            _dir: dir,
        }
    }

    /// A laptop that founds an organization with one team.
    async fn founder(name: &'static str, org_name: &str, team: &str) -> (Node, String) {
        let n = Node::new(name).await;
        n.core(|c| org::create_organization(&mut c.db, &c.identity, org_name));
        let team = n.create_team(team);
        (n, team)
    }

    fn core<T>(&self, f: impl FnOnce(&mut Core) -> AppResult<T>) -> T {
        self.state
            .with_core(f)
            .unwrap_or_else(|e| panic!("{}: [{}] {e}", self.name, e.code()))
    }

    fn addr(&self) -> SocketAddr {
        let port = self.net.status().listen_port.expect("listening");
        SocketAddr::from((Ipv4Addr::LOCALHOST, port))
    }

    /// Adds `other`'s loopback address as a manual address and dials.
    fn know(&self, other: &Node) {
        let addr = other.addr().to_string();
        self.core(|c| peers::add_manual(&c.db, &addr, clock::now()));
        self.net.refresh();
    }

    fn connected(&self, other: &Node) -> bool {
        self.net.connected_peers().contains(&other.pk)
    }

    /// Stops the network and starts a new one on a fresh port, same data.
    async fn restart(&mut self) {
        self.net.shutdown().await;
        self.net = start_net(&self.state, &self.org_changed).await;
    }

    /// `team_commands::join_with_code` without Tauri: returns the error code.
    async fn join(&self, code: &str, via: &Node) -> Result<OrgInfo, String> {
        let code = permissions::normalize_code(code).map_err(|e| e.code().to_owned())?;
        let prover_state = self.state.clone();
        let prover_code = code.clone();
        let prove: ProveFn = Box::new(move |challenge| {
            prover_state
                .with_core(|c| {
                    permissions::build_join_proof(
                        &prover_code,
                        &challenge.org,
                        &challenge.invite,
                        &c.identity,
                    )
                })
                .map(proof_to_wire)
                .map_err(|e| e.to_string())
        });
        let accepted = self
            .net
            .join(code.tag(), vec![via.addr()], prove)
            .await
            .map_err(|r| r.code)?;
        let info = self
            .state
            .with_core(|c| {
                permissions::install_joined_org(
                    &mut c.db,
                    &c.identity,
                    organization(accepted.org),
                    accepted.ops.into_iter().map(from_wire).collect(),
                    &code,
                    clock::now(),
                )
            })
            .map_err(|e| e.code().to_owned())?;
        self.net.refresh();
        Ok(info)
    }

    fn create_team(&self, name: &str) -> String {
        let team =
            self.core(|c| permissions::create_team(&mut c.db, &c.identity, name, clock::now()));
        self.net.refresh();
        team.id
    }

    fn add_to_team(&self, team: &str, member: &Node) {
        self.core(|c| {
            permissions::add_team_member(&mut c.db, &c.identity, team, &member.pk, clock::now())
        });
        self.net.refresh();
    }

    fn invite(
        &self,
        team: &str,
        role: InviteRole,
        validity: Validity,
        at: OffsetDateTime,
    ) -> (InviteView, String) {
        let r = self.core(|c| {
            permissions::create_invite(&mut c.db, &c.identity, team, role, vec![], validity, at)
        });
        self.net.refresh();
        r
    }

    fn has_org(&self) -> bool {
        self.core(|c| org::load_organization(&c.db)).is_some()
    }

    fn membership(&self) -> Membership {
        self.core(|c| permissions::membership(&c.db, &c.identity))
    }

    /// Members and teams: what every laptop of the organization must agree on.
    fn shared_view(&self) -> (Vec<MemberView>, Vec<TeamView>) {
        let d = self.core(|c| permissions::directory(&c.db, &c.identity, clock::now()));
        (d.members, d.teams)
    }

    fn channels(&self) -> Vec<ChannelView> {
        self.core(|c| permissions::directory(&c.db, &c.identity, clock::now()))
            .channels
    }

    fn team_id(&self, name: &str) -> Option<String> {
        self.core(|c| {
            Ok(permissions::load_state(&c.db)?.and_then(|s| {
                s.teams
                    .values()
                    .find(|t| !t.deleted && t.name == name)
                    .map(|t| t.id.clone())
            }))
        })
    }

    fn member_status(&self, pk: &str) -> Option<MemberStatus> {
        self.core(|c| {
            Ok(permissions::load_state(&c.db)?.and_then(|s| s.member(pk).map(|m| m.status)))
        })
    }

    fn team_scoped_ops(&self, team: &str) -> i64 {
        self.core(|c| {
            Ok(c.db.query_row(
                "SELECT count(*) FROM org_ops WHERE scope_team = ?1",
                [team],
                |r| r.get(0),
            )?)
        })
    }

    fn rejected(&self, peer: &str, code: &str) -> bool {
        self.core(|c| permissions::rejected_changes(&c.db, 1000))
            .iter()
            .any(|r| r.peer.as_deref() == Some(peer) && r.code == code)
    }
}

/// Scenario 1 as a fixture: A founds "CV Maju Jaya" with "Tim Desain", B
/// joins with a 24-hour member code, C with a single-use team admin code.
/// Returns once all three agree on the directory and form a full mesh.
struct Office {
    a: Node,
    b: Node,
    c: Node,
    desain: String,
    b_info: OrgInfo,
    c_info: OrgInfo,
}

async fn office() -> Office {
    let t0 = Instant::now();
    let (a, desain) = Node::founder("Andi", "CV Maju Jaya", "Tim Desain").await;
    let (_, member_code) = a.invite(&desain, InviteRole::Member, Validity::H24, clock::now());
    let (_, admin_code) = a.invite(&desain, InviteRole::TeamAdmin, Validity::Once, clock::now());

    let b = Node::new("Budi").await;
    let b_info = b.join(&member_code, &a).await.expect("B joins");
    let c = Node::new("Citra").await;
    let c_info = c.join(&admin_code, &a).await.expect("C joins");
    let joined = t0.elapsed();

    // Joining does not store the address used, and mDNS is off.
    b.know(&a);
    c.know(&a);
    b.know(&c);
    c.know(&b);
    a.net.refresh();
    wait_until("A, B and C have the same directory", || {
        let va = a.shared_view();
        va == b.shared_view() && va == c.shared_view()
    })
    .await;
    let agreed = t0.elapsed();

    // Dials refused before B knew C may have backed off; start over.
    for n in [&a, &b, &c] {
        n.net.refresh();
    }
    wait_until("full mesh", || {
        a.connected(&b)
            && a.connected(&c)
            && b.connected(&a)
            && b.connected(&c)
            && c.connected(&a)
            && c.connected(&b)
    })
    .await;
    eprintln!(
        "office: joined {joined:?}, directory agreed {agreed:?}, mesh {:?}",
        t0.elapsed()
    );
    Office {
        a,
        b,
        c,
        desain,
        b_info,
        c_info,
    }
}

async fn shutdown(nodes: &[&Node]) {
    for n in nodes {
        n.net.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn three_laptops_join_and_agree() {
    let Office {
        a,
        b,
        c,
        desain,
        b_info,
        c_info,
    } = office().await;

    assert_eq!(b_info.name, "CV Maju Jaya");
    assert_eq!(b_info.role, Role::Member);
    assert_eq!(c_info.role, Role::TeamAdmin);
    for n in [&a, &b, &c] {
        assert_eq!(n.membership(), Membership::Active, "{}", n.name);
    }

    let (members, teams) = a.shared_view();
    let role_of = |pk: &str| {
        members
            .iter()
            .find(|m| m.public_key == pk)
            .map(|m| (m.display_name.as_str(), m.org_role, m.status))
    };
    assert_eq!(members.len(), 3);
    assert_eq!(
        role_of(&a.pk),
        Some(("Andi", Role::Superadmin, MemberStatus::Active))
    );
    assert_eq!(
        role_of(&b.pk),
        Some(("Budi", Role::Member, MemberStatus::Active))
    );
    assert_eq!(
        role_of(&c.pk),
        Some(("Citra", Role::TeamAdmin, MemberStatus::Active))
    );
    assert_eq!(teams.len(), 1);
    assert_eq!(teams[0].id, desain);
    assert_eq!(teams[0].name, "Tim Desain");
    let team_role = |pk: &str| {
        teams[0]
            .members
            .iter()
            .find(|m| m.public_key == pk)
            .map(|m| m.role)
    };
    assert_eq!(team_role(&b.pk), Some(TeamRole::Member));
    assert_eq!(team_role(&c.pk), Some(TeamRole::Admin));

    // Every laptop sees the team channel of a team it belongs to.
    for n in [&b, &c] {
        assert!(
            n.channels()
                .iter()
                .any(|ch| ch.team_id.as_deref() == Some(desain.as_str())),
            "{} misses the Tim Desain channel",
            n.name
        );
    }
    // B learned about C through sync, which the network reports.
    assert!(b.org_changed.load(Ordering::Relaxed) > 0);
    shutdown(&[&a, &b, &c]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn bad_codes_are_refused_and_strangers_are_not_served() {
    let (a, team) = Node::founder("Andi", "CV Maju Jaya", "Tim Desain").await;
    let (_, once) = a.invite(&team, InviteRole::Member, Validity::Once, clock::now());
    let b = Node::new("Budi").await;
    b.join(&once, &a)
        .await
        .expect("first use of the single-use code");

    let d = Node::new("Dewi").await;
    let assert_refused = |code: Result<OrgInfo, String>, expected: &str| {
        assert_eq!(code.unwrap_err(), expected);
        assert!(!d.has_org(), "after {expected} Dewi has an organization");
        assert_eq!(d.membership(), Membership::None);
    };

    let unknown = permissions::generate_invite_code();
    assert_refused(d.join(&unknown, &a).await, "invite_not_found");
    assert_refused(d.join(&once, &a).await, "invite_used");

    // Created 25 hours ago with a 24-hour validity: expired by A's clock.
    let past = clock::now() - time::Duration::hours(25);
    let (_, expired) = a.invite(&team, InviteRole::Member, Validity::H24, past);
    assert_refused(d.join(&expired, &a).await, "invite_expired");

    let (view, revoked) = a.invite(&team, InviteRole::Member, Validity::D7, clock::now());
    a.core(|c| permissions::revoke_invite(&mut c.db, &c.identity, &view.id, clock::now()));
    assert_refused(d.join(&revoked, &a).await, "invite_revoked");

    // A laptop of another organization dials A on the member ALPN.
    let (x, _) = Node::founder("Xena", "PT Lain Sendiri", "Tim Lain").await;
    x.know(&a);
    let deadline = Instant::now() + TIMEOUT;
    while !a.rejected(&x.pk, "not_member") {
        assert!(
            Instant::now() < deadline,
            "A never logged the stranger as not_member"
        );
        // Each dial is a separate attempt; nudge X past its backoff.
        tokio::time::sleep(Duration::from_millis(500)).await;
        x.net.refresh();
    }
    assert!(!a.connected(&x));
    assert!(x.net.connected_peers().is_empty());
    assert!(a.member_status(&x.pk).is_none());
    shutdown(&[&a, &b, &d, &x]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn removed_member_learns_it_and_gets_nothing_new() {
    let Office { a, b, c, .. } = office().await;
    let t0 = Instant::now();

    a.core(|c| permissions::remove_member(&mut c.db, &c.identity, &b.pk, clock::now()));
    a.net.refresh();
    wait_until("B learns it was removed", || {
        b.membership() == Membership::Removed
    })
    .await;
    let learned = t0.elapsed();
    wait_until("C applies the removal", || {
        c.member_status(&b.pk) == Some(MemberStatus::Removed)
    })
    .await;

    a.create_team("Tim Rahasia");
    wait_until("C receives Tim Rahasia", || {
        c.team_id("Tim Rahasia").is_some()
    })
    .await;
    wait_until("A and C drop B", || !a.connected(&b) && !c.connected(&b)).await;
    settle(&[&a, &c]).await;

    assert!(b.team_id("Tim Rahasia").is_none(), "B received Tim Rahasia");
    let rahasia = a.team_id("Tim Rahasia").unwrap();
    assert_eq!(b.team_scoped_ops(&rahasia), 0);
    assert!(!a.connected(&b) && !c.connected(&b));
    assert!(b.net.connected_peers().is_empty());
    assert!(a.rejected(&b.pk, "removed_member"));
    assert_eq!(b.membership(), Membership::Removed);
    eprintln!("removal: B learned in {learned:?}, done {:?}", t0.elapsed());
    shutdown(&[&a, &b, &c]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn laptop_back_online_catches_up() {
    let Office { a, b, mut c, .. } = office().await;

    c.net.shutdown().await;
    wait_until("A and B see C go offline", || {
        !a.connected(&c) && !b.connected(&c)
    })
    .await;

    let pemasaran = a.create_team("Tim Pemasaran");
    a.add_to_team(&pemasaran, &b);
    wait_until("B receives Tim Pemasaran", || {
        b.team_id("Tim Pemasaran").is_some()
    })
    .await;
    assert!(c.team_id("Tim Pemasaran").is_none());

    let t0 = Instant::now();
    c.restart().await;
    c.net.refresh();
    wait_until("C catches up with Tim Pemasaran", || {
        c.team_id("Tim Pemasaran").is_some()
    })
    .await;
    let caught_up = t0.elapsed();
    wait_until("all three agree again", || {
        let va = a.shared_view();
        va == b.shared_view() && va == c.shared_view()
    })
    .await;
    wait_until("C reconnects to A and B", || {
        c.connected(&a) && c.connected(&b)
    })
    .await;
    let (_, teams) = c.shared_view();
    let team = teams.iter().find(|t| t.id == pemasaran).unwrap();
    assert!(team.members.iter().any(|m| m.public_key == b.pk));
    eprintln!("catch-up: C had Tim Pemasaran {caught_up:?} after restart");
    shutdown(&[&a, &b, &c]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn team_channel_reaches_only_team_members() {
    let Office {
        a, b, c, desain, ..
    } = office().await;

    let pemasaran = a.create_team("Tim Pemasaran");
    a.add_to_team(&pemasaran, &b);
    let in_pemasaran = |ch: &ChannelView| ch.team_id.as_deref() == Some(pemasaran.as_str());
    wait_until("B receives the Tim Pemasaran channel", || {
        b.channels().iter().any(in_pemasaran)
    })
    .await;
    wait_until("C knows the team exists (directory is org-wide)", || {
        c.team_id("Tim Pemasaran").is_some()
    })
    .await;
    settle(&[&a, &b, &c]).await;

    let ch = b.channels().into_iter().find(in_pemasaran).unwrap();
    assert_eq!(ch.name, "tim-pemasaran");
    assert!(!c.channels().iter().any(in_pemasaran));
    assert_eq!(c.team_scoped_ops(&pemasaran), 0);
    assert_eq!(b.team_scoped_ops(&pemasaran), 1);
    assert_eq!(a.team_scoped_ops(&pemasaran), 1);
    // Control: C does get the channel of its own team.
    assert!(
        c.channels()
            .iter()
            .any(|ch| ch.team_id.as_deref() == Some(desain.as_str()))
    );
    assert_eq!(c.team_scoped_ops(&desain), 1);
    shutdown(&[&a, &b, &c]).await;
}
