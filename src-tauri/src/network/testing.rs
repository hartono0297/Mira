//! In-memory `SyncBackend` for network tests.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::Mutex;

use super::wire::op_id;
use super::{
    AddressSource, IngestOutcome, JoinAccepted, JoinChallenge, JoinProof, JoinReject, KnownAddress,
    OrgRecord, PeerAuth, SyncBackend, WireOp,
};

/// Builds an opaque op with a dummy signature.
pub fn op(payload: &str) -> WireOp {
    WireOp {
        payload: payload.to_owned(),
        sig: "0".repeat(128),
    }
}

pub type IngestHook = Box<dyn Fn(&mut MemState, &str, &[WireOp]) + Send>;

#[derive(Default)]
pub struct MemState {
    pub org: Option<String>,
    pub name: Option<String>,
    /// Keys not listed here are `Unknown`.
    pub auth: HashMap<String, PeerAuth>,
    pub ops: BTreeMap<String, WireOp>,
    /// Per-peer restriction of what `op_ids_for`/`ops_for` offer. A peer
    /// missing from the map may receive every op.
    pub visible: HashMap<String, HashSet<String>>,
    pub known: Vec<KnownAddress>,
    pub remembered: Vec<(String, SocketAddr, AddressSource)>,
    pub manual: Vec<(SocketAddr, Result<String, String>)>,
    pub rejections: Vec<(Option<String>, Option<SocketAddr>, String)>,
    /// tag -> challenge
    pub invites: HashMap<String, JoinChallenge>,
    pub join_accepts: Vec<(String, JoinProof)>,
    /// Every (from, op ids) given to `ingest`.
    pub ingested: Vec<(String, Vec<String>)>,
    /// Every (peer, ids) answered by `ops_for`, with the ids returned.
    pub served: Vec<(String, Vec<String>)>,
    pub on_ingest: Option<IngestHook>,
}

#[derive(Default)]
pub struct MemoryBackend {
    pub state: Mutex<MemState>,
}

impl MemoryBackend {
    pub fn new(org: Option<&str>) -> Self {
        let b = Self::default();
        b.with(|s| s.org = org.map(str::to_owned));
        b
    }

    pub fn with<T>(&self, f: impl FnOnce(&mut MemState) -> T) -> T {
        let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut g)
    }

    pub fn add_member(&self, pk: &str) {
        self.with(|s| {
            s.auth.insert(
                pk.to_owned(),
                PeerAuth::Member {
                    display_name: format!("anggota {}", &pk[..4]),
                },
            );
        });
    }

    pub fn add_op(&self, op: WireOp) -> String {
        let id = op_id(&op);
        self.with(|s| s.ops.insert(id.clone(), op));
        id
    }

    pub fn has_op(&self, id: &str) -> bool {
        self.with(|s| s.ops.contains_key(id))
    }

    pub fn op_ids(&self) -> HashSet<String> {
        self.with(|s| s.ops.keys().cloned().collect())
    }

    pub fn know(&self, pk: Option<&str>, addr: SocketAddr) {
        self.with(|s| {
            s.known.push(KnownAddress {
                public_key: pk.map(str::to_owned),
                address: addr,
                last_success_at: None,
            })
        });
    }

    fn may_see(s: &MemState, peer: &str, id: &str) -> bool {
        s.visible.get(peer).is_none_or(|set| set.contains(id))
    }
}

impl SyncBackend for MemoryBackend {
    fn org_id(&self) -> Option<String> {
        self.with(|s| s.org.clone())
    }

    fn display_name(&self) -> Option<String> {
        self.with(|s| s.name.clone())
    }

    fn peer_auth(&self, public_key: &str) -> PeerAuth {
        self.with(|s| s.auth.get(public_key).cloned().unwrap_or(PeerAuth::Unknown))
    }

    fn active_members(&self) -> Vec<String> {
        self.with(|s| {
            s.auth
                .iter()
                .filter(|(_, a)| matches!(a, PeerAuth::Member { .. }))
                .map(|(k, _)| k.clone())
                .collect()
        })
    }

    fn op_ids_for(&self, peer: &str) -> Result<Vec<String>, String> {
        self.with(|s| {
            if !matches!(s.auth.get(peer), Some(PeerAuth::Member { .. })) {
                return Ok(vec![]);
            }
            Ok(s.ops
                .keys()
                .filter(|id| Self::may_see(s, peer, id))
                .cloned()
                .collect())
        })
    }

    fn ops_for(&self, peer: &str, ids: &[String]) -> Result<Vec<WireOp>, String> {
        self.with(|s| {
            if !matches!(s.auth.get(peer), Some(PeerAuth::Member { .. })) {
                return Ok(vec![]);
            }
            let out: Vec<(String, WireOp)> = ids
                .iter()
                .filter(|id| Self::may_see(s, peer, id))
                .filter_map(|id| s.ops.get(id).map(|o| (id.clone(), o.clone())))
                .collect();
            s.served.push((
                peer.to_owned(),
                out.iter().map(|(i, _)| i.clone()).collect(),
            ));
            Ok(out.into_iter().map(|(_, o)| o).collect())
        })
    }

    fn ingest(&self, from: &str, ops: Vec<WireOp>) -> Result<IngestOutcome, String> {
        self.with(|s| {
            s.ingested
                .push((from.to_owned(), ops.iter().map(op_id).collect()));
            let mut new_ops = 0;
            for o in &ops {
                let id = op_id(o);
                if let std::collections::btree_map::Entry::Vacant(e) = s.ops.entry(id) {
                    e.insert(o.clone());
                    new_ops += 1;
                }
            }
            if let Some(hook) = s.on_ingest.take() {
                hook(s, from, &ops);
                s.on_ingest = Some(hook);
            }
            Ok(IngestOutcome { new_ops })
        })
    }

    fn unknown_op_ids(&self, ids: &[String]) -> Result<Vec<String>, String> {
        self.with(|s| {
            Ok(ids
                .iter()
                .filter(|id| !s.ops.contains_key(*id))
                .cloned()
                .collect())
        })
    }

    fn join_lookup(&self, tag: &str) -> Result<JoinChallenge, JoinReject> {
        self.with(|s| {
            s.invites
                .get(tag)
                .cloned()
                .ok_or_else(|| JoinReject::new("invite_not_found", "Kode tidak dikenal."))
        })
    }

    fn join_accept(
        &self,
        tls_key: &str,
        challenge: &JoinChallenge,
        proof: JoinProof,
    ) -> Result<JoinAccepted, JoinReject> {
        self.with(|s| {
            if proof.member != tls_key || proof.invite_sig != "good" {
                return Err(JoinReject::new("invalid_proof", "Bukti salah."));
            }
            s.join_accepts.push((tls_key.to_owned(), proof));
            Ok(JoinAccepted {
                org: OrgRecord {
                    id: challenge.org.clone(),
                    name: "Kantor".into(),
                    founder_public_key: "f".repeat(64),
                    created_at: "2026-11-22T08:00:00Z".into(),
                    genesis_signature: "0".repeat(128),
                },
                ops: s.ops.values().cloned().collect(),
            })
        })
    }

    fn known_addresses(&self) -> Vec<KnownAddress> {
        self.with(|s| s.known.clone())
    }

    fn remember_address(&self, public_key: &str, address: SocketAddr, source: AddressSource) {
        self.with(|s| s.remembered.push((public_key.to_owned(), address, source)));
    }

    fn manual_attempt(&self, address: SocketAddr, result: Result<String, String>) {
        self.with(|s| {
            if let Ok(pk) = &result {
                for k in s.known.iter_mut() {
                    if k.address == address && k.public_key.is_none() {
                        k.public_key = Some(pk.clone());
                    }
                }
            }
            s.manual.push((address, result));
        });
    }

    fn log_rejection(
        &self,
        peer: Option<&str>,
        address: Option<SocketAddr>,
        code: &str,
        _detail: &str,
    ) {
        self.with(|s| {
            s.rejections
                .push((peer.map(str::to_owned), address, code.to_owned()))
        });
    }
}
