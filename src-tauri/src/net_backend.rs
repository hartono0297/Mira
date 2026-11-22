//! Adapter between the network module and the local database: implements
//! `network::SyncBackend` on top of `permissions` and `peers`
//! (docs/plans/tahap-1.md, section 3).
//!
//! Every call takes the core lock briefly; nothing here awaits.

use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};

use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as AsyncMutex;

use crate::clock;
use crate::error::{AppError, AppResult};
use crate::network::{
    self, AddressSource, IngestOutcome, JoinAccepted, JoinChallenge, JoinProof, JoinReject,
    KnownAddress, NetConfig, NetEvent, Network, OrgRecord, PeerAuth, SyncBackend, WireOp,
};
use crate::org::Organization;
use crate::peers;
use crate::permissions::{self, JoinProofData, Membership, PeerAuthState, SignedOp};
use crate::state::MiraState;

pub const PORT_ENV: &str = "MIRA_PORT";
pub const DISABLE_MDNS_ENV: &str = "MIRA_DISABLE_MDNS";

pub const EVENT_NETWORK: &str = "mira://network";
pub const EVENT_DIRECTORY: &str = "mira://directory";

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

/// `SyncBackend` over the shared `MiraState`.
pub struct MiraBackend {
    state: MiraState,
    /// The network using this backend, once started, so a join accepted
    /// here is pushed to the other members right away instead of on the
    /// next periodic sync.
    net: OnceLock<Network>,
}

impl MiraBackend {
    pub fn new(state: MiraState) -> Self {
        Self {
            state,
            net: OnceLock::new(),
        }
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
}

impl AppNet {
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
            let name = match ev {
                NetEvent::StatusChanged => EVENT_NETWORK,
                NetEvent::OrgChanged => EVENT_DIRECTORY,
            };
            let _ = handle.emit(name, ());
        });
        let net = Network::start(cfg, backend.clone(), events)
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
