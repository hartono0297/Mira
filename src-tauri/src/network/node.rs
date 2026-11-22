//! Connection registry, membership check after the handshake, `Hello`,
//! sync sessions and gossip (plan 2.1 to 2.3).

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use quinn::{Connection, ConnectionError, Endpoint, RecvStream, SendStream, VarInt};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinHandle;

use super::discovery::{self, Discovery};
use super::join::{self, RateLimiter};
use super::route;
use super::tls::{self, ALPN_JOIN, ALPN_MEMBER, SERVER_NAME, TlsIdentity};
use super::wire::{self, MAX_FRAME, Msg, PROTO_VERSION};
use super::{
    AddressSource, NetConfig, NetEvent, NetState, NetStatusSnapshot, PeerAuth, PeerConn, Route,
    SyncBackend, WireOp,
};

/// Application close codes.
pub(crate) mod code {
    pub const NORMAL: u32 = 0x00;
    pub const DUPLICATE: u32 = 0x01;
    pub const SHUTDOWN: u32 = 0x02;
    pub const NOT_MEMBER: u32 = 0x10;
    pub const REMOVED: u32 = 0x11;
    pub const UNEXPECTED_PEER: u32 = 0x12;
    pub const ORG_MISMATCH: u32 = 0x13;
    pub const PROTOCOL: u32 = 0x14;
    pub const SELF_CONNECTION: u32 = 0x15;
}

/// Limit for one frame read and for opening or accepting a stream.
pub(crate) const READ_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// A whole sync session, either side.
const SYNC_SESSION_TIMEOUT: Duration = Duration::from_secs(120);
const SYNC_INTERVAL: Duration = Duration::from_secs(30);
const STARTING_PERIOD: Duration = Duration::from_secs(5);
/// Time to let a `Removed` message reach the peer before closing.
const REMOVED_LINGER: Duration = Duration::from_secs(3);
/// Connections (established plus handshaking) at once.
const MAX_CONNECTIONS: usize = 128;
/// Incoming connections from one IP that are not (yet) registered members:
/// handshaking, being checked, or on the join ALPN. Keeps one device from
/// holding all `MAX_CONNECTIONS` slots with handshakes it never finishes.
/// Registered members do not count, so many members behind one NAT are fine.
pub(crate) const MAX_PENDING_PER_IP: usize = 16;
/// Op ids per `SyncHave` frame (about 670 KB of JSON).
const SYNC_ID_CHUNK: usize = 10_000;
/// Ops per `SyncOps` frame are batched up to this many bytes of JSON.
const SYNC_OPS_BATCH_BYTES: usize = 1024 * 1024;
/// Ids a responder keeps track of as "asked for" in one session.
const MAX_WANTED_PER_SESSION: usize = 200_000;
const MAX_HELLO_ADDRS: usize = 16;
const MAX_HELLO_FRAME: usize = 64 * 1024;
/// A `Removed` push carries one op of at most 16 KiB payload.
const MAX_PUSH_FRAME: usize = 256 * 1024;
/// Rejection log entries per remote IP per minute.
const REJECTION_LOGS_PER_MINUTE: usize = 10;

pub(crate) const PORT_RANGE: std::ops::RangeInclusive<u16> = 47800..=47809;

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Live items per remote IP, at most `max` each. Entries disappear when
/// their count drops to zero, so the map is bounded by the live items.
pub(crate) struct IpCounter {
    max: usize,
    counts: Arc<Mutex<HashMap<IpAddr, usize>>>,
}

/// One counted item; releases itself on drop.
pub(crate) struct IpSlot {
    ip: IpAddr,
    counts: Arc<Mutex<HashMap<IpAddr, usize>>>,
}

impl IpCounter {
    pub(crate) fn new(max: usize) -> Self {
        Self {
            max,
            counts: Arc::default(),
        }
    }

    pub(crate) fn try_acquire(&self, ip: IpAddr) -> Option<IpSlot> {
        let mut map = lock(&self.counts);
        let n = map.entry(ip).or_insert(0);
        if *n >= self.max {
            return None;
        }
        *n += 1;
        Some(IpSlot {
            ip,
            counts: self.counts.clone(),
        })
    }
}

impl Drop for IpSlot {
    fn drop(&mut self) {
        let mut map = lock(&self.counts);
        if let Some(n) = map.get_mut(&self.ip) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                map.remove(&self.ip);
            }
        }
    }
}

/// What a connection holds while it lives: a global slot, and for incoming
/// connections a per-IP slot until it is registered as a member.
pub(crate) struct ConnSlot {
    _permit: OwnedSemaphorePermit,
    pending: Option<IpSlot>,
}

struct PeerEntry {
    conn: Connection,
    /// Public key of the side that dialed this connection.
    opener: String,
    route: Route,
    connected_at: String,
}

#[derive(Default)]
struct SyncState {
    running: HashSet<String>,
    again: HashSet<String>,
}

/// How an outgoing connection was started.
#[derive(Debug, Clone)]
pub(crate) struct DialCtx {
    pub addr: SocketAddr,
    /// Key remembered for this address; the proven key must match.
    pub expected: Option<String>,
    /// Source to record when the connection succeeds.
    pub source: AddressSource,
}

pub(crate) struct Inner {
    pub(crate) me: String,
    pub(crate) backend: Arc<dyn SyncBackend>,
    events: Arc<dyn Fn(NetEvent) + Send + Sync>,
    pub(crate) endpoint: Endpoint,
    member_client: quinn::ClientConfig,
    pub(crate) join_client: quinn::ClientConfig,
    pub(crate) listen_port: u16,
    pub(crate) rt: tokio::runtime::Handle,
    started: Instant,
    closing: AtomicBool,
    peers: Mutex<HashMap<String, PeerEntry>>,
    sync: Mutex<SyncState>,
    pub(crate) disc: Discovery,
    pub(crate) join_limiter: Mutex<RateLimiter>,
    rejection_limiter: Mutex<RateLimiter>,
    pub(crate) join_slots: Arc<Semaphore>,
    /// Incoming connections (handshaking or established).
    conn_slots: Arc<Semaphore>,
    /// Incoming connections per IP that are not registered members yet.
    pending_by_ip: IpCounter,
    /// Join sessions per IP.
    pub(crate) joins_by_ip: IpCounter,
    /// Outgoing connections, separate so a flood of incoming handshakes
    /// cannot stop this laptop from dialing its colleagues.
    out_slots: Arc<Semaphore>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

fn bind_socket(port: Option<u16>) -> Result<UdpSocket, String> {
    match port {
        Some(p) => UdpSocket::bind((Ipv4Addr::UNSPECIFIED, p))
            .map_err(|e| format!("Port UDP {p} tidak bisa dipakai: {e}")),
        None => {
            for p in PORT_RANGE {
                if let Ok(s) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, p)) {
                    return Ok(s);
                }
            }
            Err(format!(
                "Port UDP {} sampai {} sedang dipakai semua.",
                PORT_RANGE.start(),
                PORT_RANGE.end()
            ))
        }
    }
}

impl Inner {
    pub(crate) async fn start(
        cfg: NetConfig,
        backend: Arc<dyn SyncBackend>,
        events: Arc<dyn Fn(NetEvent) + Send + Sync>,
    ) -> Result<Arc<Inner>, String> {
        let identity = TlsIdentity::new(&cfg.identity_secret)?;
        if identity.public_key() != cfg.public_key {
            return Err("Kunci laptop tidak cocok dengan kunci publik yang tersimpan.".into());
        }
        let server_cfg = tls::server_config(&identity)?;
        let member_client = tls::client_config(&identity, ALPN_MEMBER)?;
        let join_client = tls::client_config(&identity, ALPN_JOIN)?;

        let socket = bind_socket(cfg.port)?;
        let listen_port = socket
            .local_addr()
            .map_err(|e| format!("Alamat soket tidak terbaca: {e}"))?
            .port();
        let runtime =
            quinn::default_runtime().ok_or_else(|| "Runtime tokio tidak ditemukan.".to_owned())?;
        let endpoint = Endpoint::new(
            quinn::EndpointConfig::default(),
            Some(server_cfg),
            socket,
            runtime,
        )
        .map_err(|e| format!("Endpoint QUIC gagal dibuat: {e}"))?;

        let inner = Arc::new(Inner {
            me: identity.public_key().to_owned(),
            backend,
            events,
            endpoint: endpoint.clone(),
            member_client,
            join_client,
            listen_port,
            rt: tokio::runtime::Handle::current(),
            started: Instant::now(),
            closing: AtomicBool::new(false),
            peers: Mutex::new(HashMap::new()),
            sync: Mutex::new(SyncState::default()),
            disc: Discovery::new(),
            join_limiter: Mutex::new(RateLimiter::new(
                join::JOIN_ATTEMPTS_PER_MINUTE,
                Duration::from_secs(60),
            )),
            rejection_limiter: Mutex::new(RateLimiter::new(
                REJECTION_LOGS_PER_MINUTE,
                Duration::from_secs(60),
            )),
            join_slots: Arc::new(Semaphore::new(join::MAX_CONCURRENT_JOINS)),
            conn_slots: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
            pending_by_ip: IpCounter::new(MAX_PENDING_PER_IP),
            joins_by_ip: IpCounter::new(join::MAX_JOINS_PER_IP),
            out_slots: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
            tasks: Mutex::new(Vec::new()),
        });

        if cfg.mdns_enabled {
            discovery::start_mdns(&inner).await;
        } else {
            inner.disc.set_mdns_status(
                false,
                Some("mDNS dimatikan (MIRA_DISABLE_MDNS). Pakai alamat manual.".into()),
            );
        }

        let weak = Arc::downgrade(&inner);
        let mut tasks = Vec::new();
        tasks.push(tokio::spawn(accept_loop(weak.clone(), endpoint)));
        tasks.push(tokio::spawn(discovery::dial_loop(weak.clone())));
        tasks.push(tokio::spawn(sync_loop(weak.clone())));
        tasks.push(tokio::spawn(async move {
            tokio::time::sleep(STARTING_PERIOD).await;
            if let Some(inner) = weak.upgrade() {
                inner.emit(NetEvent::StatusChanged);
            }
        }));
        lock(&inner.tasks).extend(tasks);
        Ok(inner)
    }

    pub(crate) fn is_closing(&self) -> bool {
        self.closing.load(Ordering::SeqCst)
    }

    pub(crate) fn emit(&self, ev: NetEvent) {
        (self.events)(ev);
    }

    /// Runs a backend call on the blocking pool.
    pub(crate) async fn blocking<T: Send + 'static>(
        &self,
        f: impl FnOnce(&dyn SyncBackend) -> T + Send + 'static,
    ) -> Option<T> {
        let b = self.backend.clone();
        tokio::task::spawn_blocking(move || f(b.as_ref()))
            .await
            .ok()
    }

    /// Records a rejection, at most a few per remote IP per minute so a
    /// flood of connections cannot flood the log.
    pub(crate) fn log_rejection(
        &self,
        peer: Option<&str>,
        address: Option<SocketAddr>,
        code: &str,
        detail: &str,
    ) {
        let allowed = match address {
            Some(a) => lock(&self.rejection_limiter).check(a.ip(), Instant::now()),
            None => true,
        };
        if allowed {
            self.backend.log_rejection(peer, address, code, detail);
        }
    }

    pub(crate) fn connected_peers(&self) -> Vec<String> {
        let mut v: Vec<String> = lock(&self.peers)
            .iter()
            .filter(|(_, e)| e.conn.close_reason().is_none())
            .map(|(k, _)| k.clone())
            .collect();
        v.sort();
        v
    }

    pub(crate) fn connected_addresses(&self) -> HashSet<SocketAddr> {
        lock(&self.peers)
            .values()
            .map(|e| e.conn.remote_address())
            .collect()
    }

    /// Addresses at which this laptop itself is reachable.
    pub(crate) fn own_addresses(&self) -> HashSet<SocketAddr> {
        let mut set: HashSet<SocketAddr> = route::shareable_ipv4()
            .into_iter()
            .map(|ip| SocketAddr::from((ip, self.listen_port)))
            .collect();
        set.insert(SocketAddr::from((Ipv4Addr::LOCALHOST, self.listen_port)));
        set
    }

    pub(crate) fn status(&self) -> NetStatusSnapshot {
        let org = self.backend.org_id();
        let mut peers: Vec<PeerConn> = lock(&self.peers)
            .iter()
            .filter(|(_, e)| e.conn.close_reason().is_none())
            .map(|(pk, e)| PeerConn {
                public_key: pk.clone(),
                address: e.conn.remote_address(),
                route: e.route,
                connected_at: e.connected_at.clone(),
            })
            .collect();
        peers.sort_by(|a, b| a.public_key.cmp(&b.public_key));

        let state = if org.is_none() {
            NetState::NoOrg
        } else if peers.is_empty() && self.started.elapsed() < STARTING_PERIOD {
            NetState::Starting
        } else if self.backend.active_members().iter().all(|m| *m == self.me) {
            NetState::Alone
        } else if peers
            .iter()
            .any(|p| matches!(p.route, Route::Lan | Route::Local))
        {
            NetState::Lan
        } else if !peers.is_empty() {
            NetState::Vpn
        } else {
            NetState::Offline
        };
        let (mdns_ok, mdns_error) = self.disc.mdns_status();
        NetStatusSnapshot {
            state,
            listen_port: Some(self.listen_port),
            local_addresses: route::shareable_ipv4()
                .into_iter()
                .map(|ip| SocketAddr::from((ip, self.listen_port)))
                .collect(),
            peers,
            mdns_ok,
            mdns_error,
        }
    }

    pub(crate) fn refresh(self: &Arc<Self>) {
        if self.is_closing() {
            return;
        }
        let me = self.clone();
        self.rt.spawn(async move {
            discovery::refresh_mdns(&me).await;
            me.recheck_peers();
            me.disc.reset_backoff();
            discovery::dial_pass(&me);
            me.sync_all(None);
        });
    }

    pub(crate) async fn shutdown(&self) {
        if self.closing.swap(true, Ordering::SeqCst) {
            return;
        }
        for t in lock(&self.tasks).drain(..) {
            t.abort();
        }
        let conns: Vec<Connection> = lock(&self.peers).drain().map(|(_, e)| e.conn).collect();
        for c in conns {
            c.close(VarInt::from_u32(code::SHUTDOWN), b"shutdown");
        }
        discovery::stop_mdns(self).await;
        self.endpoint
            .close(VarInt::from_u32(code::SHUTDOWN), b"shutdown");
        let _ = tokio::time::timeout(Duration::from_secs(2), self.endpoint.wait_idle()).await;
        self.emit(NetEvent::StatusChanged);
    }

    // ----- Connections -----------------------------------------------------

    async fn handle_incoming(self: Arc<Self>, incoming: quinn::Incoming, slot: ConnSlot) {
        let Ok(connecting) = incoming.accept() else {
            return;
        };
        let conn = match tokio::time::timeout(HANDSHAKE_TIMEOUT, connecting).await {
            Ok(Ok(c)) => c,
            _ => return,
        };
        match tls::negotiated_alpn(&conn).as_deref() {
            Some(ALPN_MEMBER) => {
                let _ = self.establish(conn, None, slot).await;
            }
            Some(ALPN_JOIN) => {
                join::serve(&self, conn).await;
                drop(slot);
            }
            _ => conn.close(VarInt::from_u32(code::PROTOCOL), b"alpn"),
        }
    }

    /// Dials `ctx.addr` on the member ALPN. `Ok(pk)` once the peer is proven
    /// and authorized (also when the connection turned out to be a duplicate).
    pub(crate) async fn dial(self: &Arc<Self>, ctx: &DialCtx) -> Result<String, String> {
        if self.is_closing() {
            return Err("Jaringan Mira sedang dimatikan.".into());
        }
        let Ok(permit) = self.out_slots.clone().try_acquire_owned() else {
            return Err("Terlalu banyak koneksi terbuka.".into());
        };
        let connecting = self
            .endpoint
            .connect_with(self.member_client.clone(), ctx.addr, SERVER_NAME)
            .map_err(|e| format!("Alamat tidak bisa dihubungi: {e}"))?;
        let conn = match tokio::time::timeout(HANDSHAKE_TIMEOUT, connecting).await {
            Ok(Ok(c)) => c,
            Ok(Err(e)) => return Err(describe_connection_error(&e)),
            Err(_) => return Err("Tidak ada jawaban dari alamat ini.".into()),
        };
        let slot = ConnSlot {
            _permit: permit,
            pending: None,
        };
        match self.establish(conn.clone(), Some(ctx), slot).await {
            Ok(pk) => Ok(pk),
            Err(local) => Err(conn
                .close_reason()
                .and_then(|r| describe_peer_close(&r))
                .unwrap_or(local)),
        }
    }

    /// Everything after a completed handshake on the member ALPN: identity,
    /// membership, `Hello`, registration. Closes the connection on failure.
    async fn establish(
        self: &Arc<Self>,
        conn: Connection,
        dial: Option<&DialCtx>,
        mut slot: ConnSlot,
    ) -> Result<String, String> {
        let remote = conn.remote_address();
        let close = |c: u32, why: &'static [u8]| conn.close(VarInt::from_u32(c), why);

        let Some(pk) = tls::peer_public_key(&conn) else {
            close(code::PROTOCOL, b"no identity");
            return Err("Laptop di alamat ini tidak menunjukkan identitas yang sah.".into());
        };
        if pk == self.me {
            close(code::SELF_CONNECTION, b"self");
            return Err("Alamat ini adalah laptop ini sendiri.".into());
        }
        let Some(org) = self.backend.org_id() else {
            close(code::ORG_MISMATCH, b"no org");
            return Err("Laptop ini belum tergabung di organisasi.".into());
        };
        if let Some(expected) = dial.and_then(|d| d.expected.as_ref())
            && *expected != pk
        {
            self.log_rejection(
                Some(&pk),
                Some(remote),
                "unexpected_peer",
                "Laptop di alamat yang diingat membuktikan kunci lain dari yang diharapkan.",
            );
            close(code::UNEXPECTED_PEER, b"unexpected peer");
            return Err("Laptop di alamat ini bukan laptop yang diharapkan.".into());
        }
        self.authorize(&conn, &pk).await?;

        // Pushes (a `Removed` notice) can arrive at any time from here on.
        tokio::spawn(self.clone().read_pushes(conn.clone(), pk.clone()));

        let hello = if dial.is_some() {
            self.hello_as_dialer(&conn, &pk, &org).await
        } else {
            self.hello_as_listener(&conn, &pk, &org).await
        };
        let hello = match hello {
            Ok(h) => h,
            Err(e) => {
                if conn.close_reason().is_none() {
                    close(code::PROTOCOL, b"hello");
                }
                return Err(e);
            }
        };

        match dial {
            Some(d) => self.backend.remember_address(&pk, d.addr, d.source),
            None => self
                .backend
                .remember_address(&pk, remote, AddressSource::Incoming),
        }
        for a in hello.addrs {
            self.backend.remember_address(&pk, a, AddressSource::Hello);
        }
        if dial.is_none() && hello.listen_port != 0 && hello.listen_port != remote.port() {
            let a = SocketAddr::new(remote.ip(), hello.listen_port);
            if route::is_dialable(&a) {
                self.backend.remember_address(&pk, a, AddressSource::Hello);
            }
        }

        let opener = if dial.is_some() {
            self.me.clone()
        } else {
            pk.clone()
        };
        let route = route::classify(remote);
        if !self.register(&pk, &conn, opener, route) {
            return Ok(pk);
        }
        // A registered member no longer counts against its IP.
        slot.pending = None;
        self.emit(NetEvent::StatusChanged);
        tokio::spawn(self.clone().drive(conn, pk.clone(), slot));
        self.schedule_sync(&pk);
        Ok(pk)
    }

    /// Membership check for a proven key. Closes the connection (sending the
    /// removal op first, when there is one) unless the key is a member.
    async fn authorize(&self, conn: &Connection, pk: &str) -> Result<(), String> {
        let remote = conn.remote_address();
        match self.backend.peer_auth(pk) {
            PeerAuth::Member { .. } => Ok(()),
            PeerAuth::Unknown => {
                self.log_rejection(
                    Some(pk),
                    Some(remote),
                    "not_member",
                    "Koneksi dari laptop yang bukan anggota organisasi ditolak.",
                );
                conn.close(VarInt::from_u32(code::NOT_MEMBER), b"not a member");
                Err("Laptop di alamat ini bukan anggota organisasi.".into())
            }
            PeerAuth::Removed { removal } => {
                self.log_rejection(
                    Some(pk),
                    Some(remote),
                    "removed_member",
                    "Koneksi dari laptop yang sudah dikeluarkan dari organisasi ditolak.",
                );
                send_removed_and_close(conn, removal).await;
                Err("Laptop di alamat ini sudah dikeluarkan dari organisasi.".into())
            }
        }
    }

    fn my_hello(&self, org: &str) -> Msg {
        Msg::Hello {
            proto: PROTO_VERSION,
            org: org.to_owned(),
            pk: self.me.clone(),
            listen_port: self.listen_port,
            addrs: route::shareable_ipv4()
                .into_iter()
                .take(MAX_HELLO_ADDRS)
                .map(|ip| SocketAddr::from((ip, self.listen_port)).to_string())
                .collect(),
        }
    }

    async fn hello_as_dialer(
        &self,
        conn: &Connection,
        pk: &str,
        org: &str,
    ) -> Result<HelloInfo, String> {
        let (mut send, mut recv) = tokio::time::timeout(READ_TIMEOUT, conn.open_bi())
            .await
            .map_err(|_| "Waktu tunggu habis saat membuka sesi.".to_owned())?
            .map_err(|e| describe_connection_error(&e))?;
        wire::write_msg_timeout(&mut send, &self.my_hello(org), WRITE_TIMEOUT)
            .await
            .map_err(|e| e.to_string())?;
        let _ = send.finish();
        let msg = wire::read_msg_timeout(&mut recv, MAX_HELLO_FRAME, READ_TIMEOUT)
            .await
            .map_err(|e| e.to_string())?;
        self.check_hello(conn, msg, pk, org)
    }

    async fn hello_as_listener(
        &self,
        conn: &Connection,
        pk: &str,
        org: &str,
    ) -> Result<HelloInfo, String> {
        let (mut send, mut recv) = tokio::time::timeout(READ_TIMEOUT, conn.accept_bi())
            .await
            .map_err(|_| "Waktu tunggu habis saat menunggu salam.".to_owned())?
            .map_err(|e| describe_connection_error(&e))?;
        let msg = wire::read_msg_timeout(&mut recv, MAX_HELLO_FRAME, READ_TIMEOUT)
            .await
            .map_err(|e| e.to_string())?;
        let info = self.check_hello(conn, msg, pk, org)?;
        wire::write_msg_timeout(&mut send, &self.my_hello(org), WRITE_TIMEOUT)
            .await
            .map_err(|e| e.to_string())?;
        let _ = send.finish();
        Ok(info)
    }

    fn check_hello(
        &self,
        conn: &Connection,
        msg: Option<Msg>,
        pk: &str,
        org: &str,
    ) -> Result<HelloInfo, String> {
        let Some(Msg::Hello {
            proto,
            org: their_org,
            pk: their_pk,
            listen_port,
            addrs,
        }) = msg
        else {
            return Err("Laptop rekan tidak mengirim salam yang benar.".into());
        };
        if proto != PROTO_VERSION {
            return Err(format!(
                "Versi protokol laptop rekan ({proto}) berbeda dengan laptop ini."
            ));
        }
        if their_pk != pk {
            return Err("Kunci di salam berbeda dari kunci yang dibuktikan.".into());
        }
        if their_org != org {
            self.log_rejection(
                Some(pk),
                Some(conn.remote_address()),
                "org_mismatch",
                "Laptop rekan menyebut organisasi lain.",
            );
            conn.close(VarInt::from_u32(code::ORG_MISMATCH), b"org mismatch");
            return Err("Laptop rekan berada di organisasi lain.".into());
        }
        let addrs = hello_addresses(&addrs, conn.remote_address());
        Ok(HelloInfo { listen_port, addrs })
    }

    /// Adds the connection to the registry. Of two live connections with the
    /// same peer, the one opened by the lexicographically smaller key stays;
    /// a newer connection from the same opener replaces the older one.
    /// Returns false when `conn` was closed as the duplicate.
    fn register(&self, pk: &str, conn: &Connection, opener: String, route: Route) -> bool {
        let mut peers = lock(&self.peers);
        if self.is_closing() {
            conn.close(VarInt::from_u32(code::SHUTDOWN), b"shutdown");
            return false;
        }
        if let Some(existing) = peers.get(pk) {
            let live = existing.conn.close_reason().is_none();
            if live && existing.conn.stable_id() != conn.stable_id() {
                let keep_new = existing.opener == opener || opener < existing.opener;
                if !keep_new {
                    drop(peers);
                    conn.close(VarInt::from_u32(code::DUPLICATE), b"duplicate");
                    return false;
                }
                existing
                    .conn
                    .close(VarInt::from_u32(code::DUPLICATE), b"duplicate");
            }
        }
        peers.insert(
            pk.to_owned(),
            PeerEntry {
                conn: conn.clone(),
                opener,
                route,
                connected_at: crate::clock::now_rfc3339(),
            },
        );
        true
    }

    fn unregister(&self, pk: &str, conn_id: usize) -> bool {
        let mut peers = lock(&self.peers);
        if peers.get(pk).map(|e| e.conn.stable_id()) == Some(conn_id) {
            peers.remove(pk);
            true
        } else {
            false
        }
    }

    /// Serves the peer's streams until the connection ends.
    async fn drive(self: Arc<Self>, conn: Connection, pk: String, slot: ConnSlot) {
        let streams = Arc::new(Semaphore::new(tls::MAX_BIDI_STREAMS as usize));
        while let Ok((mut send, mut recv)) = conn.accept_bi().await {
            let Ok(slot) = streams.clone().try_acquire_owned() else {
                let _ = send.reset(VarInt::from_u32(code::PROTOCOL));
                let _ = recv.stop(VarInt::from_u32(code::PROTOCOL));
                continue;
            };
            let me = self.clone();
            let pk = pk.clone();
            tokio::spawn(async move {
                me.handle_stream(&pk, send, recv).await;
                drop(slot);
            });
        }
        if self.unregister(&pk, conn.stable_id()) {
            self.emit(NetEvent::StatusChanged);
        }
        drop(slot);
    }

    /// Uni streams from the peer. The only push is `Removed`, accepted once.
    async fn read_pushes(self: Arc<Self>, conn: Connection, pk: String) {
        let mut removed_seen = false;
        while let Ok(mut recv) = conn.accept_uni().await {
            match wire::read_msg_timeout(&mut recv, MAX_PUSH_FRAME, READ_TIMEOUT).await {
                Ok(Some(Msg::Removed { op })) if !removed_seen => {
                    removed_seen = true;
                    self.ingest_from(&pk, vec![op]).await;
                }
                _ => {
                    let _ = recv.stop(VarInt::from_u32(code::PROTOCOL));
                }
            }
        }
    }

    async fn handle_stream(self: &Arc<Self>, pk: &str, mut send: SendStream, mut recv: RecvStream) {
        if !matches!(self.backend.peer_auth(pk), PeerAuth::Member { .. }) {
            let _ = send.reset(VarInt::from_u32(code::NOT_MEMBER));
            self.recheck_peers();
            return;
        }
        match wire::read_msg_timeout(&mut recv, MAX_FRAME, READ_TIMEOUT).await {
            Ok(Some(Msg::SyncHave { ids })) => {
                let _ = tokio::time::timeout(
                    SYNC_SESSION_TIMEOUT,
                    self.respond_sync(pk, ids, &mut send, &mut recv),
                )
                .await;
                let _ = send.finish();
            }
            _ => {
                let _ = send.reset(VarInt::from_u32(code::PROTOCOL));
                let _ = recv.stop(VarInt::from_u32(code::PROTOCOL));
            }
        }
    }

    // ----- Sync ------------------------------------------------------------

    /// Responder side of a sync session: answer each `SyncHave` with the ids
    /// we lack, ingest `SyncOps` that contain only ops we asked for.
    async fn respond_sync(
        self: &Arc<Self>,
        pk: &str,
        first: Vec<String>,
        send: &mut SendStream,
        recv: &mut RecvStream,
    ) {
        let mut wanted: HashSet<String> = HashSet::new();
        let mut have = Some(first);
        loop {
            if let Some(ids) = have.take() {
                if ids.len() > SYNC_ID_CHUNK {
                    return;
                }
                let offered: HashSet<String> =
                    ids.into_iter().filter(|id| wire::is_hex64(id)).collect();
                let ask: Vec<String> = offered.iter().cloned().collect();
                let missing = match self.blocking(move |b| b.unknown_op_ids(&ask)).await {
                    Some(Ok(m)) => m,
                    _ => return,
                };
                let mut want: Vec<String> = missing
                    .into_iter()
                    .filter(|id| offered.contains(id) && !wanted.contains(id))
                    .collect();
                want.sort();
                want.dedup();
                if wanted.len() + want.len() > MAX_WANTED_PER_SESSION {
                    return;
                }
                wanted.extend(want.iter().cloned());
                if wire::write_msg_timeout(send, &Msg::SyncWant { ids: want }, WRITE_TIMEOUT)
                    .await
                    .is_err()
                {
                    return;
                }
            }
            match wire::read_msg_timeout(recv, MAX_FRAME, READ_TIMEOUT).await {
                Ok(None) => return,
                Ok(Some(Msg::SyncHave { ids })) => have = Some(ids),
                Ok(Some(Msg::SyncOps { ops })) => {
                    let ops: Vec<WireOp> = ops
                        .into_iter()
                        .filter(|op| wanted.remove(&wire::op_id(op)))
                        .collect();
                    if !ops.is_empty() {
                        self.ingest_from(pk, ops).await;
                    }
                }
                _ => return,
            }
        }
    }

    pub(crate) async fn ingest_from(self: &Arc<Self>, pk: &str, ops: Vec<WireOp>) {
        let from = pk.to_owned();
        let out = self.blocking(move |b| b.ingest(&from, ops)).await;
        match out {
            Some(Ok(out)) if out.new_ops > 0 => self.on_new_ops(Some(pk)).await,
            // Membership may still have changed (for example a removal
            // arrived earlier in the same batch): re-check anyway.
            _ => self.recheck_peers(),
        }
    }

    async fn on_new_ops(self: &Arc<Self>, from: Option<&str>) {
        self.emit(NetEvent::OrgChanged);
        self.recheck_peers();
        discovery::refresh_mdns(self).await;
        self.sync_all(from);
    }

    /// Re-checks every connected peer against the backend and drops those
    /// that are no longer members. Also drops everyone when this laptop has
    /// no organization any more.
    pub(crate) fn recheck_peers(self: &Arc<Self>) {
        let org = self.backend.org_id();
        let mut dropped: Vec<(String, Connection, Option<PeerAuth>)> = Vec::new();
        {
            let mut peers = lock(&self.peers);
            let keys: Vec<String> = peers.keys().cloned().collect();
            for pk in keys {
                let auth = if org.is_none() {
                    None
                } else {
                    match self.backend.peer_auth(&pk) {
                        PeerAuth::Member { .. } => continue,
                        other => Some(other),
                    }
                };
                if let Some(e) = peers.remove(&pk) {
                    dropped.push((pk, e.conn, auth));
                }
            }
        }
        if dropped.is_empty() {
            return;
        }
        for (pk, conn, auth) in dropped {
            let remote = conn.remote_address();
            match auth {
                None => conn.close(VarInt::from_u32(code::ORG_MISMATCH), b"no org"),
                Some(PeerAuth::Removed { removal }) => {
                    self.log_rejection(
                        Some(&pk),
                        Some(remote),
                        "removed_member",
                        "Anggota yang dikeluarkan diputus dari jaringan.",
                    );
                    tokio::spawn(async move { send_removed_and_close(&conn, removal).await });
                }
                Some(_) => {
                    self.log_rejection(
                        Some(&pk),
                        Some(remote),
                        "not_member",
                        "Laptop yang tidak lagi terdaftar sebagai anggota diputus.",
                    );
                    conn.close(VarInt::from_u32(code::NOT_MEMBER), b"not a member");
                }
            }
        }
        self.emit(NetEvent::StatusChanged);
    }

    pub(crate) fn sync_all(self: &Arc<Self>, except: Option<&str>) {
        for pk in self.connected_peers() {
            if Some(pk.as_str()) != except {
                self.schedule_sync(&pk);
            }
        }
    }

    /// Runs a sync session with `pk`, coalescing requests that arrive while
    /// one is running into a single follow-up session.
    fn schedule_sync(self: &Arc<Self>, pk: &str) {
        {
            let mut s = lock(&self.sync);
            if s.running.contains(pk) {
                s.again.insert(pk.to_owned());
                return;
            }
            s.running.insert(pk.to_owned());
        }
        let me = self.clone();
        let pk = pk.to_owned();
        tokio::spawn(async move {
            loop {
                let _ = tokio::time::timeout(SYNC_SESSION_TIMEOUT, me.sync_once(&pk)).await;
                let mut s = lock(&me.sync);
                if s.again.remove(&pk) && !me.is_closing() {
                    continue;
                }
                s.running.remove(&pk);
                break;
            }
        });
    }

    /// Initiator side: offer the ids the backend allows for this peer, send
    /// exactly the requested ones that `ops_for` returns.
    async fn sync_once(self: &Arc<Self>, pk: &str) -> Result<(), String> {
        let conn = lock(&self.peers)
            .get(pk)
            .map(|e| e.conn.clone())
            .ok_or("tidak tersambung")?;
        if !matches!(self.backend.peer_auth(pk), PeerAuth::Member { .. }) {
            self.recheck_peers();
            return Err("bukan anggota".into());
        }
        let peer = pk.to_owned();
        let ids = self
            .blocking(move |b| b.op_ids_for(&peer))
            .await
            .ok_or("backend gagal")??;
        if ids.is_empty() {
            return Ok(());
        }
        let (mut send, mut recv) = tokio::time::timeout(READ_TIMEOUT, conn.open_bi())
            .await
            .map_err(|_| "timeout")?
            .map_err(|e| e.to_string())?;
        for chunk in ids.chunks(SYNC_ID_CHUNK) {
            wire::write_msg_timeout(
                &mut send,
                &Msg::SyncHave {
                    ids: chunk.to_vec(),
                },
                WRITE_TIMEOUT,
            )
            .await
            .map_err(|e| e.to_string())?;
            let want = match wire::read_msg_timeout(&mut recv, MAX_FRAME, READ_TIMEOUT)
                .await
                .map_err(|e| e.to_string())?
            {
                Some(Msg::SyncWant { ids }) => ids,
                _ => return Err("jawaban sinkron tidak sah".into()),
            };
            let offered: HashSet<&String> = chunk.iter().collect();
            let mut want: Vec<String> =
                want.into_iter().filter(|id| offered.contains(id)).collect();
            want.sort();
            want.dedup();
            if want.is_empty() {
                continue;
            }
            let peer = pk.to_owned();
            let ask = want.clone();
            let ops = self
                .blocking(move |b| b.ops_for(&peer, &ask))
                .await
                .ok_or("backend gagal")??;
            let want_set: HashSet<String> = want.into_iter().collect();
            let mut sent: HashSet<String> = HashSet::new();
            let mut batch: Vec<WireOp> = Vec::new();
            let mut batch_bytes = 0usize;
            for op in ops {
                let id = wire::op_id(&op);
                if !want_set.contains(&id) || !sent.insert(id) {
                    continue;
                }
                let size = serde_json::to_vec(&op)
                    .map(|v| v.len())
                    .unwrap_or(usize::MAX);
                if size > MAX_FRAME / 2 {
                    continue;
                }
                if !batch.is_empty() && batch_bytes + size > SYNC_OPS_BATCH_BYTES {
                    let ops = std::mem::take(&mut batch);
                    wire::write_msg_timeout(&mut send, &Msg::SyncOps { ops }, WRITE_TIMEOUT)
                        .await
                        .map_err(|e| e.to_string())?;
                    batch_bytes = 0;
                }
                batch_bytes += size + 1;
                batch.push(op);
            }
            if !batch.is_empty() {
                wire::write_msg_timeout(&mut send, &Msg::SyncOps { ops: batch }, WRITE_TIMEOUT)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        let _ = send.finish();
        // Wait for the responder to finish reading (it finishes its side when
        // done) so the session's ops are ingested before we report back.
        let _ = wire::read_msg_timeout(&mut recv, MAX_FRAME, READ_TIMEOUT).await;
        Ok(())
    }
}

/// Dialable addresses from a peer's `Hello`. Loopback addresses count only
/// when the peer itself connected over loopback (same machine); from anyone
/// else they would make this laptop dial its own local ports.
pub(crate) fn hello_addresses(addrs: &[String], remote: SocketAddr) -> Vec<SocketAddr> {
    let remote_is_local = remote.ip().is_loopback();
    addrs
        .iter()
        .take(MAX_HELLO_ADDRS)
        .filter_map(|a| a.parse::<SocketAddr>().ok())
        .filter(route::is_dialable)
        .filter(|a| remote_is_local || !a.ip().is_loopback())
        .collect()
}

struct HelloInfo {
    listen_port: u16,
    addrs: Vec<SocketAddr>,
}

/// Sends the removal op (if any) on a uni stream, gives it a moment to
/// arrive, then closes with `REMOVED`.
async fn send_removed_and_close(conn: &Connection, removal: Option<WireOp>) {
    if let Some(op) = removal
        && let Ok(Ok(mut s)) = tokio::time::timeout(REMOVED_LINGER, conn.open_uni()).await
        && wire::write_msg_timeout(&mut s, &Msg::Removed { op }, REMOVED_LINGER)
            .await
            .is_ok()
    {
        let _ = s.finish();
        let _ = tokio::time::timeout(REMOVED_LINGER, s.stopped()).await;
    }
    conn.close(VarInt::from_u32(code::REMOVED), b"removed");
}

async fn accept_loop(weak: Weak<Inner>, endpoint: Endpoint) {
    while let Some(incoming) = endpoint.accept().await {
        let Some(inner) = weak.upgrade() else {
            incoming.refuse();
            break;
        };
        if inner.is_closing() {
            incoming.refuse();
            break;
        }
        // Make the sender prove it receives packets at its address before
        // any state is kept. A Retry is stateless, so handshakes from spoofed
        // addresses (or ones that are never answered) cost no slot.
        if !incoming.remote_address_validated() {
            let _ = incoming.retry();
            continue;
        }
        // A laptop without an organization serves nobody.
        if inner.backend.org_id().is_none() {
            incoming.refuse();
            continue;
        }
        let Some(pending) = inner
            .pending_by_ip
            .try_acquire(incoming.remote_address().ip())
        else {
            incoming.refuse();
            continue;
        };
        let Ok(permit) = inner.conn_slots.clone().try_acquire_owned() else {
            incoming.refuse();
            continue;
        };
        let slot = ConnSlot {
            _permit: permit,
            pending: Some(pending),
        };
        tokio::spawn(inner.handle_incoming(incoming, slot));
    }
}

async fn sync_loop(weak: Weak<Inner>) {
    let mut tick = tokio::time::interval(SYNC_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    tick.tick().await;
    loop {
        tick.tick().await;
        let Some(inner) = weak.upgrade() else {
            break;
        };
        if inner.is_closing() {
            break;
        }
        inner.sync_all(None);
    }
}

fn describe_connection_error(e: &ConnectionError) -> String {
    match e {
        ConnectionError::ApplicationClosed(c) => {
            describe_close_code(c.error_code.into_inner()).to_owned()
        }
        ConnectionError::TimedOut => "Tidak ada jawaban dari alamat ini.".into(),
        ConnectionError::TransportError(_) | ConnectionError::ConnectionClosed(_) => {
            "Jabat tangan aman dengan laptop di alamat ini gagal.".into()
        }
        ConnectionError::Reset => "Laptop di alamat ini menolak koneksi.".into(),
        other => format!("Koneksi gagal: {other}"),
    }
}

fn describe_peer_close(e: &ConnectionError) -> Option<String> {
    match e {
        ConnectionError::ApplicationClosed(c) => {
            Some(describe_close_code(c.error_code.into_inner()).to_owned())
        }
        _ => None,
    }
}

fn describe_close_code(c: u64) -> &'static str {
    match c {
        x if x == u64::from(code::NOT_MEMBER) => {
            "Laptop rekan menolak: laptop ini bukan anggota organisasinya."
        }
        x if x == u64::from(code::REMOVED) => "Laptop ini sudah dikeluarkan dari organisasi.",
        x if x == u64::from(code::ORG_MISMATCH) => "Laptop rekan berada di organisasi lain.",
        x if x == u64::from(code::UNEXPECTED_PEER) => "Laptop rekan mengharapkan laptop lain.",
        x if x == u64::from(code::SELF_CONNECTION) => "Alamat ini adalah laptop ini sendiri.",
        x if x == u64::from(code::DUPLICATE) => "Sudah tersambung lewat koneksi lain.",
        x if x == u64::from(code::SHUTDOWN) => "Laptop rekan sedang menutup Mira.",
        _ => "Laptop rekan menutup koneksi.",
    }
}
