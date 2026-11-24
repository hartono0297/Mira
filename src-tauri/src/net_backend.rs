//! Adapter between the network module and the local database: implements
//! `network::SyncBackend` on top of `permissions` and `peers`
//! (docs/plans/tahap-1.md, section 3).
//!
//! Every call takes the core lock briefly; nothing here awaits.

use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, OnceLock};

use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as AsyncMutex;

use crate::clock;
use crate::error::{AppError, AppResult};
use crate::network::feature::{FeatureHub, TOPIC_JOIN};
use crate::network::wire::{self, MAX_FRAME, Msg};
use crate::network::{
    self, AddressSource, IngestOutcome, JoinAccepted, JoinChallenge, JoinDept, JoinInfoWire,
    JoinProof, JoinReject, JoinRequestOk, JoinRequestWire, JoinStatusWire, KnownAddress, NetConfig,
    NetEvent, Network, OrgRecord, PeerAuth, SyncBackend, WireOp,
};
use crate::org::Organization;
use crate::peers;
use crate::permissions::{
    self, JoinProofData, JoinRequestRefusal, JoinStatusAnswer, Membership, PeerAuthState,
    SignedJoinRequest, SignedOp,
};
use crate::state::MiraState;

pub const PORT_ENV: &str = "MIRA_PORT";
pub const DISABLE_MDNS_ENV: &str = "MIRA_DISABLE_MDNS";

pub const EVENT_NETWORK: &str = "mira://network";
pub const EVENT_DIRECTORY: &str = "mira://directory";
/// Feature data from a colleague changed; payload `{ "topic": "<topic>" }`.
pub const EVENT_FEATURE: &str = "mira://feature";

pub fn to_wire(op: SignedOp) -> WireOp {
    WireOp {
        payload: op.payload,
        sig: op.sig,
    }
}

pub fn from_wire(op: WireOp) -> SignedOp {
    SignedOp {
        payload: op.payload,
        sig: op.sig,
    }
}

pub fn org_record(org: Organization) -> OrgRecord {
    OrgRecord {
        id: org.id,
        name: org.name,
        founder_public_key: org.founder_public_key,
        created_at: org.created_at,
        genesis_signature: org.genesis_signature,
    }
}

pub fn organization(rec: OrgRecord) -> Organization {
    Organization {
        id: rec.id,
        name: rec.name,
        founder_public_key: rec.founder_public_key,
        created_at: rec.created_at,
        genesis_signature: rec.genesis_signature,
    }
}

pub fn proof_to_wire(p: JoinProofData) -> JoinProof {
    JoinProof {
        member: p.member,
        name: p.name,
        invite_sig: p.invite_sig,
        member_sig: p.member_sig,
    }
}

fn proof_from_wire(p: JoinProof) -> JoinProofData {
    JoinProofData {
        member: p.member,
        name: p.name,
        invite_sig: p.invite_sig,
        member_sig: p.member_sig,
    }
}

fn source(s: AddressSource) -> peers::AddressSource {
    match s {
        AddressSource::Mdns => peers::AddressSource::Mdns,
        AddressSource::Hello => peers::AddressSource::Hello,
        AddressSource::Incoming => peers::AddressSource::Incoming,
        AddressSource::Outgoing => peers::AddressSource::Outgoing,
        AddressSource::Manual => peers::AddressSource::Manual,
    }
}

/// Requesters read `join_info` answers up to `MAX_JOIN_FRAME` (Mira v0.4.0
/// too). The OU mapping only feeds department suggestions, so it is left
/// out rather than making the whole answer unreadable. 1 KiB is kept for
/// the message envelope (`{"t":"join_info","info":...}`).
pub(crate) fn fit_join_info(info: &mut JoinInfoWire) {
    let size = |i: &JoinInfoWire| serde_json::to_vec(i).map_or(usize::MAX, |v| v.len());
    if !info.ad_ou_map.is_empty() && size(info) > wire::MAX_JOIN_FRAME - 1024 {
        info.ad_ou_map.clear();
    }
}

/// `SyncBackend` over the shared `MiraState`.
pub struct MiraBackend {
    state: MiraState,
    /// The network using this backend, once started, so a join accepted
    /// here is pushed to the other members right away instead of on the
    /// next periodic sync.
    net: OnceLock<Network>,
    /// Test override of `extras` in `join_info` answers. `None`:
    /// `JOIN_INFO_EXTRAS_AD` or `JOIN_INFO_EXTRAS` when every member runs a
    /// recent enough Mira (`permissions::join::join_ad_allowed`,
    /// `join_extras_allowed`), 0 otherwise.
    join_extras: Option<u32>,
    /// Announce and answer like Mira 0.1/0.2 ([`LEGACY_ADVERT_ENV`]).
    legacy_advert: bool,
}

/// Debug builds only: `MIRA_TEST_LEGACY_ADVERT=1` makes this laptop look
/// like Mira 0.1/0.2 to others, for the e2e "old office" scenario. Its mDNS
/// advertisement carries only `org` (no `on`, `j` or `ad`), and `join_info`
/// is refused with `not_member` the way a member that takes no requests
/// answers. A real 0.2 laptop cannot parse `join_info_get` and closes the
/// stream instead; either way the requester gets no verified office.
/// Release builds never read the variable.
pub const LEGACY_ADVERT_ENV: &str = "MIRA_TEST_LEGACY_ADVERT";

#[cfg(debug_assertions)]
fn legacy_advert_from_env() -> bool {
    std::env::var(LEGACY_ADVERT_ENV).is_ok_and(|v| v.trim() == "1")
}

#[cfg(not(debug_assertions))]
fn legacy_advert_from_env() -> bool {
    false
}

impl MiraBackend {
    pub fn new(state: MiraState) -> Self {
        Self {
            state,
            net: OnceLock::new(),
            join_extras: None,
            legacy_advert: legacy_advert_from_env(),
        }
    }

    /// Behaves as if `MIRA_TEST_LEGACY_ADVERT=1` were set.
    #[cfg(test)]
    pub(crate) fn with_legacy_advert(mut self) -> Self {
        self.legacy_advert = true;
        self
    }

    /// Answers `join_info` with this `extras` whatever the members run
    /// (0: like Mira v0.3).
    #[cfg(test)]
    pub(crate) fn with_join_extras(mut self, extras: u32) -> Self {
        self.join_extras = Some(extras);
        self
    }

    pub fn attach(&self, net: Network) {
        let _ = self.net.set(net);
    }
}

fn log_err<T>(what: &str, r: AppResult<T>) -> Option<T> {
    match r {
        Ok(v) => Some(v),
        Err(e) => {
            eprintln!("Mira: {what} gagal [{}]: {e}", e.code());
            None
        }
    }
}

impl SyncBackend for MiraBackend {
    fn org_id(&self) -> Option<String> {
        self.state
            .with_core(|c| {
                if permissions::membership(&c.db, &c.identity)? != Membership::Active {
                    return Ok(None);
                }
                Ok(crate::org::load_organization(&c.db)?.map(|o| o.id))
            })
            .ok()
            .flatten()
    }

    fn display_name(&self) -> Option<String> {
        self.state
            .with_core(|c| Ok(c.identity.display_name().map(str::to_owned)))
            .ok()
            .flatten()
    }

    fn peer_auth(&self, public_key: &str) -> PeerAuth {
        let r = self.state.with_core(|c| {
            let Some(state) = permissions::load_state(&c.db)? else {
                return Ok(PeerAuth::Unknown);
            };
            Ok(match permissions::peer_auth(&state, public_key) {
                PeerAuthState::Member { display_name } => PeerAuth::Member { display_name },
                PeerAuthState::Removed { removal_op } => PeerAuth::Removed {
                    removal: match removal_op {
                        Some(id) => permissions::load_op(&c.db, &id)?.map(to_wire),
                        None => None,
                    },
                },
                PeerAuthState::Unknown => PeerAuth::Unknown,
            })
        });
        log_err("peer_auth", r).unwrap_or(PeerAuth::Unknown)
    }

    fn active_members(&self) -> Vec<String> {
        let r = self.state.with_core(|c| {
            let Some(state) = permissions::load_state(&c.db)? else {
                return Ok(Vec::new());
            };
            let me = c.identity.public_key_hex();
            Ok(state
                .members
                .keys()
                .filter(|pk| pk.as_str() != me && state.is_active(pk))
                .cloned()
                .collect())
        });
        log_err("active_members", r).unwrap_or_default()
    }

    fn op_ids_for(&self, peer: &str) -> Result<Vec<String>, String> {
        self.state
            .with_core(|c| {
                let Some(state) = permissions::load_state(&c.db)? else {
                    return Ok(Vec::new());
                };
                permissions::op_ids_for(&c.db, &state, peer)
            })
            .map_err(|e| e.to_string())
    }

    fn ops_for(&self, peer: &str, ids: &[String]) -> Result<Vec<WireOp>, String> {
        self.state
            .with_core(|c| {
                let Some(state) = permissions::load_state(&c.db)? else {
                    return Ok(Vec::new());
                };
                Ok(permissions::ops_for(&c.db, &state, peer, ids)?
                    .into_iter()
                    .map(to_wire)
                    .collect())
            })
            .map_err(|e| e.to_string())
    }

    fn unknown_op_ids(&self, ids: &[String]) -> Result<Vec<String>, String> {
        self.state
            .with_core(|c| permissions::missing_op_ids(&c.db, ids))
            .map_err(|e| e.to_string())
    }

    fn ingest(&self, from: &str, ops: Vec<WireOp>) -> Result<IngestOutcome, String> {
        self.state
            .with_core(|c| {
                let ops = ops.into_iter().map(from_wire).collect();
                let report = permissions::ingest(&mut c.db, Some(from), ops, clock::now())?;
                Ok(IngestOutcome {
                    new_ops: report.new_ops,
                })
            })
            .map_err(|e| e.to_string())
    }

    fn join_lookup(&self, tag: &str) -> Result<JoinChallenge, JoinReject> {
        self.state
            .with_core(|c| Ok(permissions::join_lookup(&c.db, tag, clock::now())))
            .map_err(|e| JoinReject::new("internal", &e.to_string()))?
            .map(|(org, invite)| JoinChallenge { org, invite })
            .map_err(|code| JoinReject::new(code.code(), &code.message()))
    }

    fn join_accept(
        &self,
        tls_key: &str,
        challenge: &JoinChallenge,
        proof: JoinProof,
    ) -> Result<JoinAccepted, JoinReject> {
        let proof = proof_from_wire(proof);
        self.state
            .with_core(|c| {
                Ok(permissions::join_accept(
                    &mut c.db,
                    &c.identity,
                    tls_key,
                    &challenge.invite,
                    &proof,
                    clock::now(),
                ))
            })
            .map_err(|e| JoinReject::new("internal", &e.to_string()))?
            .map(|data| {
                // Tell the other members about the newcomer now, so they
                // accept its connection instead of refusing it as unknown.
                if let Some(net) = self.net.get() {
                    net.refresh();
                }
                JoinAccepted {
                    org: org_record(data.org),
                    ops: data.ops.into_iter().map(to_wire).collect(),
                }
            })
            .map_err(|code| JoinReject::new(code.code(), &code.message()))
    }

    fn org_name(&self) -> Option<String> {
        if self.legacy_advert {
            return None;
        }
        self.state
            .with_core(|c| {
                if permissions::membership(&c.db, &c.identity)? != Membership::Active {
                    return Ok(None);
                }
                Ok(crate::org::load_organization(&c.db)?.map(|o| o.name))
            })
            .ok()
            .flatten()
    }

    fn accepts_join_requests(&self) -> bool {
        if self.legacy_advert {
            return false;
        }
        self.state
            .with_core(|c| permissions::join_info(&c.db))
            .ok()
            .flatten()
            .is_some()
    }

    fn ad_domain(&self) -> Option<String> {
        if self.legacy_advert {
            return None;
        }
        self.state
            .with_core(|c| {
                if permissions::membership(&c.db, &c.identity)? != Membership::Active {
                    return Ok(None);
                }
                Ok(permissions::load_state(&c.db)?.and_then(|s| s.ad.domain))
            })
            .ok()
            .flatten()
    }

    fn join_info(&self) -> Option<JoinInfoWire> {
        if self.legacy_advert {
            return None;
        }
        let r = self.state.with_core(|c| permissions::join_info(&c.db));
        log_err("join_info", r).flatten().map(|info| {
            let extras = if info.accepts_ad {
                network::JOIN_INFO_EXTRAS_AD
            } else if info.extras {
                network::JOIN_INFO_EXTRAS
            } else {
                0
            };
            let mut wire = JoinInfoWire {
                org: org_record(info.org),
                fingerprint: info.fingerprint,
                departments: info
                    .departments
                    .into_iter()
                    .map(|d| JoinDept {
                        id: d.id,
                        name: d.name,
                    })
                    .collect(),
                extras: self.join_extras.unwrap_or(extras),
                ad_domain: info.ad_domain,
                ad_ou_map: info.ad_ou_map.into_iter().map(Into::into).collect(),
            };
            fit_join_info(&mut wire);
            wire
        })
    }

    fn join_request(
        &self,
        tls_key: &str,
        ip: IpAddr,
        request: JoinRequestWire,
    ) -> Result<JoinRequestOk, JoinReject> {
        let signed = SignedJoinRequest {
            payload: request.payload,
            sig: request.sig,
        };
        let r = self.state.with_core(|c| {
            Ok(permissions::receive_join_request(
                &mut c.db,
                &c.identity,
                &signed,
                tls_key,
                Some(ip),
                clock::now(),
            ))
        });
        let refused = |r: JoinRequestRefusal| JoinReject::new(r.code(), r.message());
        match log_err("join_request", r) {
            Some(Ok((request_id, code))) => Ok(JoinRequestOk { request_id, code }),
            Some(Err(refusal)) => Err(refused(refusal)),
            None => Err(refused(JoinRequestRefusal::Busy)),
        }
    }

    fn join_status(&self, tls_key: &str, request_id: &str) -> JoinStatusWire {
        let r = self
            .state
            .with_core(|c| permissions::join_status_for(&c.db, request_id, tls_key));
        match log_err("join_status", r) {
            Some(JoinStatusAnswer::Pending) => JoinStatusWire::Pending,
            Some(JoinStatusAnswer::Approved(data)) => {
                let msg = Msg::JoinStatusApproved {
                    accepted: JoinAccepted {
                        org: org_record(data.org),
                        ops: data.ops.into_iter().map(to_wire).collect(),
                    },
                };
                // The network cannot send a larger frame; the requester then
                // keeps asking (and sees "pending").
                let len = wire::encoded_len(&msg);
                if len > MAX_FRAME {
                    eprintln!(
                        "Mira: persetujuan bergabung terlalu besar untuk dikirim ({len} byte)."
                    );
                    return JoinStatusWire::Unknown;
                }
                match msg {
                    Msg::JoinStatusApproved { accepted } => JoinStatusWire::Approved(accepted),
                    _ => JoinStatusWire::Unknown,
                }
            }
            Some(JoinStatusAnswer::Rejected { by_name, at, op }) => JoinStatusWire::Rejected {
                by_name,
                at,
                op: to_wire(op),
            },
            Some(JoinStatusAnswer::Unknown) | None => JoinStatusWire::Unknown,
        }
    }

    fn known_addresses(&self) -> Vec<KnownAddress> {
        let r = self.state.with_core(|c| peers::known(&c.db));
        log_err("known_addresses", r)
            .unwrap_or_default()
            .into_iter()
            .map(|k| KnownAddress {
                public_key: k.public_key,
                address: k.address,
                last_success_at: k.last_success_at,
            })
            .collect()
    }

    fn remember_address(&self, public_key: &str, address: SocketAddr, src: AddressSource) {
        let r = self.state.with_core(|c| {
            let now = clock::now();
            let src = source(src);
            peers::remember(&c.db, public_key, address, src, now)?;
            if src.is_success() {
                peers::mark_seen(&c.db, public_key, now)?;
            }
            Ok(())
        });
        log_err("remember_address", r);
    }

    fn manual_attempt(&self, address: SocketAddr, result: Result<String, String>) {
        let r = self.state.with_core(|c| {
            let result = match &result {
                Ok(pk) => Ok(pk.as_str()),
                Err(e) => Err(e.as_str()),
            };
            peers::manual_attempt(&c.db, address, result, clock::now())
        });
        log_err("manual_attempt", r);
    }

    fn log_rejection(
        &self,
        peer: Option<&str>,
        address: Option<SocketAddr>,
        code: &str,
        detail: &str,
    ) {
        let r = self.state.with_core(|c| {
            permissions::log_rejection(&c.db, peer, address, code, detail, clock::now())
        });
        log_err("log_rejection", r);
    }
}

/// The running network, managed by Tauri. Started lazily so a failed core
/// initialization ("Coba lagi") can still start it later.
#[derive(Clone, Default)]
pub struct AppNet {
    inner: Arc<AsyncMutex<Option<Network>>>,
    /// The managed feature hub; the network sets its link on it.
    features: Arc<FeatureHub>,
}

impl AppNet {
    pub fn new(features: Arc<FeatureHub>) -> Self {
        Self {
            inner: Arc::default(),
            features,
        }
    }

    /// The network, starting it if needed.
    pub async fn get(&self, state: &MiraState, app: &AppHandle) -> AppResult<Network> {
        let mut guard = self.inner.lock().await;
        if let Some(net) = guard.as_ref() {
            return Ok(net.clone());
        }
        let (secret, public_key) = state.with_core(|c| {
            Ok((
                c.identity.secret_bytes(),
                c.identity.public_key_hex().to_owned(),
            ))
        })?;
        let port = std::env::var(PORT_ENV)
            .ok()
            .and_then(|v| v.trim().parse::<u16>().ok());
        let mdns_enabled = std::env::var(DISABLE_MDNS_ENV).map_or(true, |v| v.trim() != "1");
        let cfg = NetConfig {
            identity_secret: secret,
            public_key,
            port,
            mdns_enabled,
        };
        let backend = Arc::new(MiraBackend::new(state.clone()));
        let handle = app.clone();
        let events = Arc::new(move |ev: NetEvent| {
            let _ = match ev {
                NetEvent::StatusChanged => handle.emit(EVENT_NETWORK, ()),
                NetEvent::OrgChanged => handle.emit(EVENT_DIRECTORY, ()),
                NetEvent::FeatureChanged { topic } => {
                    // Forwarded join requests: the approver list and the
                    // OS notification (contract 7 and 8.6).
                    if topic == TOPIC_JOIN {
                        crate::join_sync::join_requests_changed(&handle);
                    }
                    handle.emit(EVENT_FEATURE, serde_json::json!({ "topic": topic }))
                }
                NetEvent::JoinRequestsChanged => {
                    crate::join_sync::join_requests_changed(&handle);
                    Ok(())
                }
            };
        });
        let net = Network::start_with_features(cfg, backend.clone(), events, self.features.clone())
            .await
            .map_err(|e| AppError::Network(format!("Jaringan Mira tidak bisa dimulai: {e}")))?;
        backend.attach(net.clone());
        *guard = Some(net.clone());
        Ok(net)
    }

    /// The network if it is already running.
    pub async fn running(&self) -> Option<Network> {
        self.inner.lock().await.clone()
    }

    pub async fn shutdown(&self) {
        if let Some(net) = self.inner.lock().await.take() {
            net.shutdown().await;
        }
    }
}

/// After a local membership change: sync now and tell the UI.
pub async fn after_change(net: &AppNet, app: &AppHandle) {
    if let Some(n) = net.running().await {
        n.refresh();
    }
    let _ = app.emit(EVENT_DIRECTORY, ());
    let _ = app.emit(EVENT_NETWORK, ());
}

/// Maps a join failure from the network to an `AppError`.
pub fn join_error(r: JoinReject) -> AppError {
    match r.code.as_str() {
        "invite_not_found" => AppError::InviteNotFound,
        "invite_expired" => AppError::InviteExpired,
        "invite_used" => AppError::InviteUsed,
        "invite_revoked" => AppError::InviteRevoked,
        "no_peer_found" => AppError::NoPeerFound,
        "removed" => AppError::Removed,
        "rate_limited" => AppError::Network(
            "Terlalu banyak percobaan bergabung dari laptop ini. Tunggu satu menit, lalu coba lagi."
                .into(),
        ),
        "invalid_proof" => AppError::Network(
            "Laptop rekan menolak bukti dari laptop ini. Periksa kodenya, lalu coba lagi.".into(),
        ),
        _ => AppError::PeerUnreachable(format!(
            "Laptop rekan tidak bisa memeriksa kode ini. Detail: {}",
            r.message
        )),
    }
}

pub use network::NetState;
#[cfg(test)]
#[path = "net_backend_tests.rs"]
mod integration_tests;

#[cfg(test)]
mod advert_tests {
    use super::*;
    use crate::identity::MemoryKeyStore;

    /// A founder whose office has the AD domain `macf.co.id`.
    fn office_with_ad() -> (tempfile::TempDir, MiraState) {
        let dir = tempfile::tempdir().expect("temp dir");
        let state = MiraState::new(
            Ok(dir.path().to_path_buf()),
            Box::new(MemoryKeyStore::new()),
        );
        state
            .with_core(|c| {
                crate::identity::save_display_name(&mut c.db, &mut c.identity, "Andi")?;
                crate::org::create_organization(&mut c.db, &c.identity, "MCF")?;
                permissions::create_team(&mut c.db, &c.identity, "Keuangan", clock::now())?;
                permissions::ensure_device_op(
                    &mut c.db,
                    &c.identity,
                    &crate::device::current(),
                    clock::now(),
                )?;
                permissions::set_ad_settings(
                    &mut c.db,
                    &c.identity,
                    "macf.co.id",
                    Vec::new(),
                    clock::now(),
                )
            })
            .expect("office with AD");
        (dir, state)
    }

    #[test]
    fn member_announces_the_ad_domain() {
        let (_dir, state) = office_with_ad();
        let b = MiraBackend::new(state);
        assert!(b.org_id().is_some());
        assert_eq!(b.org_name().as_deref(), Some("MCF"));
        assert!(b.accepts_join_requests());
        assert_eq!(b.ad_domain().as_deref(), Some("macf.co.id"));
        assert!(b.join_info().is_some());
    }

    #[test]
    fn legacy_advert_looks_like_mira_0_2() {
        let (_dir, state) = office_with_ad();
        let b = MiraBackend::new(state).with_legacy_advert();
        // TXT `org` only; no `on`, `j` or `ad`, and no `join_info` answer.
        assert!(b.org_id().is_some());
        assert_eq!(b.org_name(), None);
        assert!(!b.accepts_join_requests());
        assert_eq!(b.ad_domain(), None);
        assert_eq!(b.join_info(), None);
    }
}
