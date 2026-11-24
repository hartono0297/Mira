//! Talking to colleagues' laptops (plan section 2, contract 3.1).
//!
//! One QUIC endpoint per instance listens and dials. Both sides present a
//! self-signed Ed25519 certificate made from the laptop key and prove it in
//! the TLS 1.3 handshake (`tls`). After the handshake the application checks
//! membership through `SyncBackend::peer_auth` and exchanges `Hello`
//! (`node`). Members then sync opaque signed ops (`node`), non-members may
//! only redeem an invite on the join ALPN (`join`). Peers are found with
//! mDNS and remembered or manual addresses (`discovery`).
//!
//! This module knows nothing about SQLite or the op format beyond the op id
//! (BLAKE3 of the payload). Everything else is decided by the backend.

mod discovery;
pub mod feature;
mod feature_blob;
mod feature_net;
mod join;
mod node;
pub mod route;
pub mod tls;
pub mod wire;

#[cfg(test)]
mod feature_tests;
#[cfg(test)]
pub mod testing;
#[cfg(test)]
mod tests;

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use feature::FeatureHub;
use node::Inner;

/// Settings for `Network::start`.
pub struct NetConfig {
    /// The laptop's Ed25519 secret key, used for the TLS certificate.
    pub identity_secret: zeroize::Zeroizing<[u8; 32]>,
    /// 64 hex; must match `identity_secret`.
    pub public_key: String,
    /// `MIRA_PORT`. `None`: first free port of 47800..=47809.
    /// `Some(0)`: an ephemeral port chosen by the OS (used by tests).
    pub port: Option<u16>,
    /// `!MIRA_DISABLE_MDNS`.
    pub mdns_enabled: bool,
}

impl std::fmt::Debug for NetConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NetConfig")
            .field("public_key", &self.public_key)
            .field("port", &self.port)
            .field("mdns_enabled", &self.mdns_enabled)
            .finish_non_exhaustive()
    }
}

/// A signed op as sent on the wire; same shape as `permissions::SignedOp`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireOp {
    pub payload: String,
    pub sig: String,
}

/// Genesis record of an organization, as sent to a laptop that joins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrgRecord {
    pub id: String,
    pub name: String,
    pub founder_public_key: String,
    pub created_at: String,
    pub genesis_signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinChallenge {
    pub org: String,
    pub invite: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinProof {
    pub member: String,
    pub name: String,
    pub invite_sig: String,
    pub member_sig: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinAccepted {
    pub org: OrgRecord,
    pub ops: Vec<WireOp>,
}

/// A department a joining laptop can pick (v0.3, `join_info`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinDept {
    pub id: String,
    pub name: String,
}

/// `JoinInfoWire.extras` of a v0.4 member: it accepts join requests with
/// `note` and `account` (docs/plans/v04-onboarding.md).
pub const JOIN_INFO_EXTRAS: u32 = 1;

/// `JoinInfoWire.extras` of a member that also accepts the AD claim (`ad`)
/// in join requests (docs/plans/onboarding-ad.md). Mira v0.4.0 compares
/// `extras >= 1`, so it still reads 2 as "takes `note` and `account`".
pub const JOIN_INFO_EXTRAS_AD: u32 = 2;

/// Answer to `join_info_get` (v0.3): the organization's genesis record, its
/// short fingerprint and the open departments. The requester checks the
/// genesis record itself; the fingerprint is only shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinInfoWire {
    pub org: OrgRecord,
    pub fingerprint: String,
    pub departments: Vec<JoinDept>,
    /// v0.4: which optional join request fields this member accepts
    /// ([`JOIN_INFO_EXTRAS`], [`JOIN_INFO_EXTRAS_AD`]). Absent (0) from v0.3
    /// members. v0.3 parses this struct without `deny_unknown_fields`, so
    /// it ignores the field.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub extras: u32,
    /// AD onboarding: the organization's AD domain, lowercase. Absent when
    /// not set and from older members (which ignore it, like `extras`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ad_domain: Option<String>,
    /// AD onboarding: OU to department rows whose department is open.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ad_ou_map: Vec<OuMapWire>,
}

/// One OU mapping row in a `join_info` answer. Unlike `ad::OuMapping` (the
/// strict shape inside the `ad_settings_set` op), unknown fields are
/// ignored, so a later Mira can add some without breaking the answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OuMapWire {
    pub ou: String,
    pub team: String,
}

impl From<crate::ad::OuMapping> for OuMapWire {
    fn from(m: crate::ad::OuMapping) -> Self {
        OuMapWire {
            ou: m.ou,
            team: m.team,
        }
    }
}

impl From<OuMapWire> for crate::ad::OuMapping {
    fn from(m: OuMapWire) -> Self {
        crate::ad::OuMapping {
            ou: m.ou,
            team: m.team,
        }
    }
}

fn is_zero(v: &u32) -> bool {
    *v == 0
}

/// A signed join request on the wire; same shape as
/// `permissions::SignedJoinRequest`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinRequestWire {
    pub payload: String,
    pub sig: String,
}

/// Answer to `join_request`: the request id and the matching code the
/// member computed (the requester compares it with its own).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinRequestOk {
    pub request_id: String,
    pub code: String,
}

/// Answer to `join_status_get`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JoinStatusWire {
    Pending,
    /// Same shape as the invite flow's `JoinAccepted`.
    Approved(JoinAccepted),
    /// The signed `join_reject` op and its author's name as the member
    /// knows it.
    Rejected {
        by_name: String,
        at: String,
        op: WireOp,
    },
    Unknown,
}

/// A laptop announcing an organization over mDNS (TXT `org`, `on`, `j`,
/// `ad`).
/// Hints only: nothing here is authenticated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OfficeHint {
    pub public_key: String,
    pub address: SocketAddr,
    pub org: String,
    /// TXT `on`, at most 63 bytes.
    pub org_name: Option<String>,
    /// TXT `j` = `"1"`: an active non-guest member that takes join requests.
    pub accepts_join: bool,
    /// TXT `ad`: the organization's AD domain, normalized; `None` when not
    /// announced or not a valid domain (onboarding-ad).
    pub ad_domain: Option<String>,
}

/// What the backend says about a key proven in a handshake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerAuth {
    Member {
        display_name: String,
    },
    /// 0.5.1: suspended. The connection is kept out of the peer list and
    /// serves membership op sync only (docs/plans/perbaikan-bergabung.md).
    /// `suspension` is the op that suspended them, pushed once when a live
    /// member connection is cut.
    Suspended {
        display_name: String,
        suspension: Option<WireOp>,
    },
    /// Removed from the organization. `removal` is the op that removed them,
    /// sent once so their laptop learns about it.
    Removed {
        removal: Option<WireOp>,
    },
    Unknown,
}

/// Why a join attempt failed. Codes: `invite_not_found`, `invite_expired`,
/// `invite_used`, `invite_revoked`, `invalid_proof`, `rate_limited`,
/// `no_peer_found`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinReject {
    pub code: String,
    pub message: String,
}

impl JoinReject {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.to_owned(),
            message: message.to_owned(),
        }
    }
}

impl std::fmt::Display for JoinReject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for JoinReject {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct IngestOutcome {
    pub new_ops: usize,
}

/// An address to dial: remembered for a key, or manual (`public_key` may be
/// `None` until a connection proves who is there).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownAddress {
    pub public_key: Option<String>,
    pub address: SocketAddr,
    pub last_success_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AddressSource {
    Mdns,
    Hello,
    Incoming,
    Outgoing,
    Manual,
}

impl AddressSource {
    pub fn as_str(self) -> &'static str {
        match self {
            AddressSource::Mdns => "mdns",
            AddressSource::Hello => "hello",
            AddressSource::Incoming => "incoming",
            AddressSource::Outgoing => "outgoing",
            AddressSource::Manual => "manual",
        }
    }
}

/// Everything the network needs from the rest of the app. Methods are
/// synchronous and should be fast; the network calls the slow ones (sync and
/// join) on tokio's blocking pool.
pub trait SyncBackend: Send + Sync + 'static {
    /// `None`: not joined yet, removed, or suspended.
    fn org_id(&self) -> Option<String>;
    /// 0.5.1: the organization when this laptop's own membership is
    /// suspended (`org_id` is then `None`). Such a laptop keeps dialing its
    /// colleagues but syncs the membership log only, so it learns when it is
    /// reinstated or removed. Default: never suspended.
    fn suspended_org(&self) -> Option<String> {
        None
    }
    fn display_name(&self) -> Option<String>;
    fn peer_auth(&self, public_key: &str) -> PeerAuth;
    /// Public keys of active members, without this laptop.
    fn active_members(&self) -> Vec<String>;
    /// Ids of the ops `peer` may receive.
    fn op_ids_for(&self, peer: &str) -> Result<Vec<String>, String>;
    /// The ops among `ids` that `peer` may receive (filtered again).
    fn ops_for(&self, peer: &str, ids: &[String]) -> Result<Vec<WireOp>, String>;
    fn ingest(&self, from: &str, ops: Vec<WireOp>) -> Result<IngestOutcome, String>;
    fn join_lookup(&self, tag: &str) -> Result<JoinChallenge, JoinReject>;
    fn join_accept(
        &self,
        tls_key: &str,
        challenge: &JoinChallenge,
        proof: JoinProof,
    ) -> Result<JoinAccepted, JoinReject>;
    /// Remembered and manual addresses.
    fn known_addresses(&self) -> Vec<KnownAddress>;
    fn remember_address(&self, public_key: &str, address: SocketAddr, source: AddressSource);
    /// Result of dialing an address from `known_addresses`: `Ok(pk)` or
    /// `Err(message)`. Called for every such address; the adapter updates the
    /// row only if the address is a manual one.
    fn manual_attempt(&self, address: SocketAddr, result: Result<String, String>);
    fn log_rejection(
        &self,
        peer: Option<&str>,
        address: Option<SocketAddr>,
        code: &str,
        detail: &str,
    );

    /// Organization name for TXT `on` (v0.3). Default: none.
    fn org_name(&self) -> Option<String> {
        None
    }

    /// TXT `j`: this laptop is an active non-guest member and answers
    /// `join_info_get` and `join_request` (v0.3). Default: no.
    fn accepts_join_requests(&self) -> bool {
        false
    }

    /// TXT `ad`: the organization's AD domain, when it has one
    /// (onboarding-ad). Default: none.
    fn ad_domain(&self) -> Option<String> {
        None
    }

    /// Answer to `join_info_get`; `None` when this laptop does not take join
    /// requests (v0.3).
    fn join_info(&self) -> Option<JoinInfoWire> {
        None
    }

    /// A laptop that is not a member yet sent its signed request directly
    /// (v0.3). `tls_key` is the key proven in the handshake and `ip` the
    /// address the connection came from. Refusal codes are listed in the
    /// contract (`not_member`, `invalid_request`, `wrong_key`,
    /// `request_expired`, `team_not_found`, `removed`, `busy`).
    fn join_request(
        &self,
        _tls_key: &str,
        _ip: IpAddr,
        _request: JoinRequestWire,
    ) -> Result<JoinRequestOk, JoinReject> {
        Err(JoinReject::new(
            "not_member",
            "Laptop rekan ini tidak bisa menerima permintaan bergabung.",
        ))
    }

    /// Status of request `request_id` for the laptop with `tls_key` (v0.3).
    fn join_status(&self, _tls_key: &str, _request_id: &str) -> JoinStatusWire {
        JoinStatusWire::Unknown
    }

    /// Of the offered op ids, the ones this laptop does not have yet (answer
    /// to `SyncHave`). Addition to plan 3.1: the default asks for every id,
    /// which is correct (ingest ignores duplicates) but sends everything on
    /// every sync. The adapter should override it with a database lookup.
    fn unknown_op_ids(&self, ids: &[String]) -> Result<Vec<String>, String> {
        Ok(ids.to_vec())
    }
}

/// Sent to the UI (`mira://network`, `mira://directory`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetEvent {
    /// Connection state or peer list changed.
    StatusChanged,
    /// New ops were applied.
    OrgChanged,
    /// `FeatureSync::ingest` of `topic` reported `changed: true`
    /// (`mira://feature` with `{ "topic": topic }`).
    FeatureChanged { topic: &'static str },
    /// A join request arrived directly over the join ALPN (v0.3,
    /// `mira://join-requests`).
    JoinRequestsChanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetState {
    Starting,
    NoOrg,
    Alone,
    Lan,
    Vpn,
    Offline,
    /// Set by the adapter; the network never produces it.
    Removed,
    /// 0.5.1: this laptop is suspended (set by the adapter).
    Suspended,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Route {
    Lan,
    Vpn,
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerConn {
    pub public_key: String,
    pub address: SocketAddr,
    pub route: Route,
    pub connected_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetStatusSnapshot {
    pub state: NetState,
    pub listen_port: Option<u16>,
    /// Shareable IPv4 addresses of this laptop with the listen port.
    pub local_addresses: Vec<SocketAddr>,
    /// Peers with a live connection.
    pub peers: Vec<PeerConn>,
    pub mdns_ok: bool,
    pub mdns_error: Option<String>,
}

/// Builds the `JoinProof` for a challenge (called at most once per join).
pub type ProveFn = Box<dyn FnOnce(&JoinChallenge) -> Result<JoinProof, String> + Send>;

/// Handle to the running network. Cheap to clone.
#[derive(Clone)]
pub struct Network {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Network {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Network")
            .field("public_key", &self.inner.me)
            .field("listen_port", &self.inner.listen_port)
            .finish_non_exhaustive()
    }
}

impl Network {
    /// Binds the endpoint and starts listening, mDNS, dialing and sync.
    /// Must be called inside a tokio runtime.
    pub async fn start(
        cfg: NetConfig,
        backend: Arc<dyn SyncBackend>,
        events: Arc<dyn Fn(NetEvent) + Send + Sync>,
    ) -> Result<Network, String> {
        Self::start_with_features(cfg, backend, events, Arc::new(FeatureHub::default())).await
    }

    /// `start` with the app's feature hub: the network sets its link on the
    /// hub (and `OfflineLink` again on shutdown) and syncs the registered
    /// features with connected members.
    pub async fn start_with_features(
        cfg: NetConfig,
        backend: Arc<dyn SyncBackend>,
        events: Arc<dyn Fn(NetEvent) + Send + Sync>,
        features: Arc<FeatureHub>,
    ) -> Result<Network, String> {
        let inner = Inner::start(cfg, backend, events, features).await?;
        Ok(Network { inner })
    }

    /// The organization or ops changed: re-advertise mDNS, re-check peers,
    /// dial members that are not connected, and sync with everyone.
    pub fn refresh(&self) {
        self.inner.refresh();
    }

    pub fn status(&self) -> NetStatusSnapshot {
        self.inner.status()
    }

    /// Public keys of the peers with a live connection. Addition to 3.1.
    pub fn connected_peers(&self) -> Vec<String> {
        self.inner.connected_peers()
    }

    /// 0.5.1 "Periksa lagi": dials the colleagues that are not connected
    /// (backoff reset), syncs the membership log with every connected one
    /// and waits until each has sent its ops, at most `limit`. Returns the
    /// number of laptops synced with during the check. A suspended laptop
    /// counts a laptop only once that laptop has offered it its ops (the
    /// colleague syncs back after the suspended laptop's session).
    pub async fn check_membership(&self, limit: std::time::Duration) -> usize {
        self.inner.check_membership(limit).await
    }

    /// Tests: application close codes `pk` sent when it closed a
    /// registered connection with this laptop.
    #[cfg(test)]
    pub(crate) fn close_codes_from(&self, pk: &str) -> Vec<u64> {
        node::lock(&self.inner.peer_closes)
            .iter()
            .filter(|(p, _)| p == pk)
            .map(|(_, c)| *c)
            .collect()
    }

    /// Tests: `pk` has a live connection, limited (0.5.1) or full.
    #[cfg(test)]
    pub(crate) fn is_linked(&self, pk: &str) -> bool {
        self.inner.is_linked(pk)
    }

    /// Redeems an invite on a laptop that is already a member. Candidates are
    /// the `extra` addresses and laptops found with mDNS. `prove` is called
    /// once, with the first challenge received.
    pub async fn join(
        &self,
        tag: &str,
        extra: Vec<SocketAddr>,
        prove: ProveFn,
    ) -> Result<JoinAccepted, JoinReject> {
        join::join(&self.inner, tag, extra, prove).await
    }

    /// Laptops announcing an organization over mDNS right now, freshest
    /// first (v0.3 onboarding). Hints only.
    pub fn office_hints(&self) -> Vec<OfficeHint> {
        self.inner.disc.office_hints(&self.inner.me)
    }

    /// Asks the laptop at `addr` for its organization (`join_info_get`).
    /// Returns the key it proved in the handshake and its answer.
    pub async fn join_info_at(
        &self,
        addr: SocketAddr,
    ) -> Result<(String, JoinInfoWire), JoinReject> {
        join::info_at(&self.inner, addr).await
    }

    /// Sends this laptop's signed request to the member at `addr`.
    pub async fn join_request_at(
        &self,
        addr: SocketAddr,
        request: JoinRequestWire,
    ) -> Result<(String, JoinRequestOk), JoinReject> {
        join::request_at(&self.inner, addr, request).await
    }

    /// Asks the member at `addr` for the status of request `request_id`.
    pub async fn join_status_at(
        &self,
        addr: SocketAddr,
        request_id: &str,
    ) -> Result<(String, JoinStatusWire), JoinReject> {
        join::status_at(&self.inner, addr, request_id).await
    }

    /// Closes all connections and the endpoint, and stops mDNS.
    pub async fn shutdown(&self) {
        self.inner.shutdown().await;
    }
}
