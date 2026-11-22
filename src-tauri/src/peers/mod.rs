//! Addresses of other laptops (plan 2.5, 3.3): remembered from connections,
//! mDNS and `Hello`, plus addresses typed or pasted by the person (F-NET-02,
//! F-NET-03), and when each peer was last seen.

use std::net::{IpAddr, SocketAddr};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use time::OffsetDateTime;

use crate::error::{AppError, AppResult};
use crate::permissions::format::{format_time, is_lower_hex};

pub const DEFAULT_PORT: u16 = 47800;
/// Remembered addresses kept per peer (most recent first).
pub const MAX_ADDRESSES_PER_PEER: i64 = 16;
/// `addr=` entries accepted from one `mira://peer` link.
pub const MAX_LINK_ADDRS: usize = 16;
const INPUT_MAX_CHARS: usize = 2048;
const ERROR_MAX_CHARS: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

    /// A verified connection over this address (sets `last_success_at`).
    pub fn is_success(self) -> bool {
        matches!(
            self,
            AddressSource::Incoming | AddressSource::Outgoing | AddressSource::Manual
        )
    }
}

/// An address to dial. `public_key` is the key expected there, if known.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownAddress {
    pub public_key: Option<String>,
    pub address: SocketAddr,
    pub last_success_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualAddress {
    pub address: String,
    pub added_at: String,
    pub last_tried_at: Option<String>,
    pub last_error: Option<String>,
    pub public_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerSeen {
    pub public_key: String,
    pub last_seen_at: String,
}

/// Result of parsing what the person typed or pasted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAddress {
    pub public_key: Option<String>,
    pub addrs: Vec<SocketAddr>,
}

fn invalid(detail: &str) -> AppError {
    AppError::InvalidAddress(format!(
        "{detail} Tulis alamat IP laptop rekan, misalnya 192.168.1.10 atau 192.168.1.10:47800, atau tempel tautan mira://peer dari laptop rekan."
    ))
}

/// Addresses that can be dialed: not unspecified, multicast or broadcast,
/// and not port 0. Loopback is allowed (several instances on one PC).
pub fn is_dialable(addr: &SocketAddr) -> bool {
    if addr.port() == 0 {
        return false;
    }
    match addr.ip() {
        IpAddr::V4(ip) => !(ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast()),
        IpAddr::V6(ip) => !(ip.is_unspecified() || ip.is_multicast()),
    }
}

/// `ip`, `ip:port`, `[v6]:port`, `[v6]` or bare IPv6; default port 47800.
pub fn parse_socket_addr(s: &str) -> Option<SocketAddr> {
    let s = s.trim();
    if let Ok(addr) = s.parse::<SocketAddr>() {
        return Some(addr);
    }
    let bare = s
        .strip_prefix('[')
        .and_then(|r| r.strip_suffix(']'))
        .unwrap_or(s);
    bare.parse::<IpAddr>()
        .ok()
        .map(|ip| SocketAddr::new(ip, DEFAULT_PORT))
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hex = s.get(i + 1..i + 3)?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// `mira://peer?pk=<64 hex>&addr=<ip:port>&addr=...`. Unknown parameters
/// are ignored so later versions can add some.
pub fn parse_share_link(input: &str) -> AppResult<ParsedAddress> {
    let s = input.trim();
    let rest = s
        .get(..7)
        .filter(|p| p.eq_ignore_ascii_case("mira://"))
        .map(|_| &s[7..])
        .ok_or_else(|| invalid("Tautan harus diawali mira://peer."))?;
    let (host, query) = rest.split_once('?').unwrap_or((rest, ""));
    if !host.trim_end_matches('/').eq_ignore_ascii_case("peer") {
        return Err(invalid(
            "Tautan ini bukan tautan laptop Mira (mira://peer).",
        ));
    }
    let mut pk = None;
    let mut addrs = Vec::new();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = percent_decode(value).ok_or_else(|| invalid("Tautan rusak."))?;
        match key {
            "pk" => {
                let v = value.to_ascii_lowercase();
                if pk.is_some() || !is_lower_hex(&v, 64) {
                    return Err(invalid("Kunci laptop di tautan tidak valid."));
                }
                pk = Some(v);
            }
            "addr" => {
                let addr = parse_socket_addr(&value)
                    .filter(is_dialable)
                    .ok_or_else(|| invalid(&format!("Alamat {value} di tautan tidak valid.")))?;
                if !addrs.contains(&addr) {
                    addrs.push(addr);
                }
                if addrs.len() > MAX_LINK_ADDRS {
                    return Err(invalid("Tautan berisi terlalu banyak alamat."));
                }
            }
            _ => {}
        }
    }
    let public_key = pk.ok_or_else(|| invalid("Tautan tidak berisi kunci laptop (pk)."))?;
    if addrs.is_empty() {
        return Err(invalid("Tautan tidak berisi alamat laptop (addr)."));
    }
    Ok(ParsedAddress {
        public_key: Some(public_key),
        addrs,
    })
}

/// Parses `ip`, `ip:port` or a `mira://peer` link.
pub fn parse_address_input(input: &str) -> AppResult<ParsedAddress> {
    let s = input.trim();
    if s.is_empty() {
        return Err(invalid("Alamat masih kosong."));
    }
    if s.chars().count() > INPUT_MAX_CHARS {
        return Err(invalid("Alamat terlalu panjang."));
    }
    if s.len() >= 7 && s.is_char_boundary(7) && s[..7].eq_ignore_ascii_case("mira://") {
        return parse_share_link(s);
    }
    let addr = parse_socket_addr(s).ok_or_else(|| invalid("Alamat tidak dikenali."))?;
    if !is_dialable(&addr) {
        return Err(invalid("Alamat itu tidak bisa dihubungi."));
    }
    Ok(ParsedAddress {
        public_key: None,
        addrs: vec![addr],
    })
}

/// Remembers where a peer was reached or announced. Addresses that cannot
/// be dialed are ignored. Keeps the 16 most recent addresses per peer.
pub fn remember(
    conn: &Connection,
    public_key: &str,
    address: SocketAddr,
    source: AddressSource,
    now: OffsetDateTime,
) -> AppResult<()> {
    if !is_lower_hex(public_key, 64) {
        return Err(AppError::Internal(
            "Kunci laptop rekan tidak valid saat menyimpan alamat.".into(),
        ));
    }
    if !is_dialable(&address) {
        return Ok(());
    }
    let now = format_time(now);
    let success = source.is_success().then_some(now.as_str());
    conn.execute(
        "INSERT INTO peer_addresses (public_key, address, source, last_success_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (public_key, address) DO UPDATE SET
           source = excluded.source,
           last_seen_at = excluded.last_seen_at,
           last_success_at = COALESCE(excluded.last_success_at, peer_addresses.last_success_at)",
        params![
            public_key,
            address.to_string(),
            source.as_str(),
            success,
            now
        ],
    )?;
    conn.execute(
        "DELETE FROM peer_addresses WHERE public_key = ?1 AND address NOT IN (
           SELECT address FROM peer_addresses WHERE public_key = ?1
           ORDER BY COALESCE(last_success_at, '') DESC, last_seen_at DESC, address
           LIMIT ?2)",
        params![public_key, MAX_ADDRESSES_PER_PEER],
    )?;
    Ok(())
}

/// Remembered and manual addresses, most recent success first. An address
/// appears once.
pub fn known(conn: &Connection) -> AppResult<Vec<KnownAddress>> {
    let mut rows: Vec<(KnownAddress, String)> = Vec::new();
    let mut stmt = conn
        .prepare("SELECT public_key, address, last_success_at, last_seen_at FROM peer_addresses")?;
    let remembered = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    for row in remembered {
        let (pk, addr, success, seen) = row?;
        if let Ok(address) = addr.parse() {
            rows.push((
                KnownAddress {
                    public_key: Some(pk),
                    address,
                    last_success_at: success,
                },
                seen,
            ));
        }
    }
    for m in manual_addresses(conn)? {
        if let Ok(address) = m.address.parse() {
            let success = m
                .last_tried_at
                .clone()
                .filter(|_| m.last_error.is_none() && m.public_key.is_some());
            rows.push((
                KnownAddress {
                    public_key: m.public_key,
                    address,
                    last_success_at: success,
                },
                m.last_tried_at.unwrap_or(m.added_at),
            ));
        }
    }
    rows.sort_by(|(a, a_seen), (b, b_seen)| {
        b.last_success_at
            .is_some()
            .cmp(&a.last_success_at.is_some())
            .then_with(|| b.last_success_at.cmp(&a.last_success_at))
            .then_with(|| b_seen.cmp(a_seen))
            .then_with(|| a.address.to_string().cmp(&b.address.to_string()))
    });
    let mut out: Vec<KnownAddress> = Vec::with_capacity(rows.len());
    for (k, _) in rows {
        if !out.iter().any(|o| {
            o.address == k.address && (o.public_key == k.public_key || k.public_key.is_none())
        }) {
            out.push(k);
        }
    }
    Ok(out)
}

/// Adds what the person typed or pasted. A `mira://` link can hold several
/// addresses; each is stored with the link's key. Returns the stored rows.
pub fn add_manual(
    conn: &Connection,
    input: &str,
    now: OffsetDateTime,
) -> AppResult<Vec<ManualAddress>> {
    let parsed = parse_address_input(input)?;
    let now = format_time(now);
    let mut stmt = conn.prepare(
        "INSERT INTO manual_addresses (address, added_at, last_tried_at, last_error, public_key)
         VALUES (?1, ?2, NULL, NULL, ?3)
         ON CONFLICT (address) DO UPDATE SET
           public_key = COALESCE(excluded.public_key, manual_addresses.public_key)",
    )?;
    for addr in &parsed.addrs {
        stmt.execute(params![addr.to_string(), now, parsed.public_key])?;
    }
    let wanted: Vec<String> = parsed.addrs.iter().map(|a| a.to_string()).collect();
    Ok(manual_addresses(conn)?
        .into_iter()
        .filter(|m| wanted.contains(&m.address))
        .collect())
}

/// Manual addresses, newest first.
pub fn manual_addresses(conn: &Connection) -> AppResult<Vec<ManualAddress>> {
    let mut stmt = conn.prepare(
        "SELECT address, added_at, last_tried_at, last_error, public_key
         FROM manual_addresses ORDER BY added_at DESC, address",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ManualAddress {
                address: r.get(0)?,
                added_at: r.get(1)?,
                last_tried_at: r.get(2)?,
                last_error: r.get(3)?,
                public_key: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Removes a manual address (written as shown, or as typed). Removing an
/// address that is not in the list is not an error.
pub fn remove_manual(conn: &Connection, address: &str) -> AppResult<()> {
    let addr = parse_socket_addr(address).ok_or_else(|| invalid("Alamat tidak dikenali."))?;
    conn.execute(
        "DELETE FROM manual_addresses WHERE address = ?1",
        [addr.to_string()],
    )?;
    Ok(())
}

/// Result of dialing a manual address: `Ok(public key)` or `Err(message)`.
pub fn manual_attempt(
    conn: &Connection,
    address: SocketAddr,
    result: Result<&str, &str>,
    now: OffsetDateTime,
) -> AppResult<()> {
    let now = format_time(now);
    match result {
        Ok(pk) => {
            conn.execute(
                "UPDATE manual_addresses SET last_tried_at = ?2, last_error = NULL, public_key = ?3
                 WHERE address = ?1",
                params![address.to_string(), now, pk],
            )?;
        }
        Err(msg) => {
            let msg: String = msg.chars().take(ERROR_MAX_CHARS).collect();
            conn.execute(
                "UPDATE manual_addresses SET last_tried_at = ?2, last_error = ?3 WHERE address = ?1",
                params![address.to_string(), now, msg],
            )?;
        }
    }
    Ok(())
}

pub fn mark_seen(conn: &Connection, public_key: &str, now: OffsetDateTime) -> AppResult<()> {
    conn.execute(
        "INSERT INTO peer_seen (public_key, last_seen_at) VALUES (?1, ?2)
         ON CONFLICT (public_key) DO UPDATE SET last_seen_at = excluded.last_seen_at",
        params![public_key, format_time(now)],
    )?;
    Ok(())
}

pub fn last_seen(conn: &Connection, public_key: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT last_seen_at FROM peer_seen WHERE public_key = ?1",
            [public_key],
            |r| r.get(0),
        )
        .optional()?)
}

/// Every peer's last seen time.
pub fn peer_rows(conn: &Connection) -> AppResult<Vec<PeerSeen>> {
    let mut stmt =
        conn.prepare("SELECT public_key, last_seen_at FROM peer_seen ORDER BY last_seen_at DESC")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PeerSeen {
                public_key: r.get(0)?,
                last_seen_at: r.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use time::Duration;

    fn sa(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    fn t0() -> OffsetDateTime {
        crate::permissions::format::parse_time("2026-11-22T08:00:00Z").unwrap()
    }

    fn conn() -> (tempfile::TempDir, Connection) {
        let tmp = tempfile::tempdir().unwrap();
        let conn = db::open(tmp.path()).unwrap();
        (tmp, conn)
    }

    #[test]
    fn parses_plain_addresses() {
        let one = |s: &str| parse_address_input(s).unwrap().addrs[0];
        assert_eq!(one("192.168.1.10"), sa("192.168.1.10:47800"));
        assert_eq!(one(" 192.168.1.10:47805 "), sa("192.168.1.10:47805"));
        assert_eq!(one("127.0.0.1:47801"), sa("127.0.0.1:47801"));
        assert_eq!(one("fe80::1"), sa("[fe80::1]:47800"));
        assert_eq!(one("[fe80::1]"), sa("[fe80::1]:47800"));
        assert_eq!(one("[fe80::1]:9000"), sa("[fe80::1]:9000"));
        assert_eq!(parse_address_input("10.0.0.2").unwrap().public_key, None);
    }

    #[test]
    fn rejects_bad_addresses_with_indonesian_message() {
        for bad in [
            "",
            "   ",
            "laptop-budi",
            "laptop-budi:47800",
            "192.168.1",
            "192.168.1.300",
            "192.168.1.10:0",
            "192.168.1.10:70000",
            "0.0.0.0",
            "255.255.255.255",
            "224.0.0.251",
            "::",
            "http://192.168.1.10",
            "192.168.1.10:47800:1",
        ] {
            let err = parse_address_input(bad).unwrap_err();
            assert_eq!(err.code(), "invalid_address", "{bad:?}");
            let msg = err.to_string();
            assert!(msg.contains("192.168.1.10"), "{msg}");
            assert!(!msg.contains('\u{2014}'), "{msg}");
        }
    }

    #[test]
    fn parses_share_links() {
        let pk = "ab".repeat(32);
        let link = format!("mira://peer?pk={pk}&addr=192.168.1.10:47800&addr=10.8.0.5:47801");
        let p = parse_address_input(&link).unwrap();
        assert_eq!(p.public_key.as_deref(), Some(pk.as_str()));
        assert_eq!(
            p.addrs,
            vec![sa("192.168.1.10:47800"), sa("10.8.0.5:47801")]
        );

        let upper = format!(
            "  MIRA://PEER/?pk={}&addr=%5Bfe80%3A%3A1%5D%3A47800&addr=192.168.1.10&v=2&addr=192.168.1.10 ",
            pk.to_uppercase()
        );
        let p = parse_address_input(&upper).unwrap();
        assert_eq!(p.public_key.as_deref(), Some(pk.as_str()));
        assert_eq!(
            p.addrs,
            vec![sa("[fe80::1]:47800"), sa("192.168.1.10:47800")]
        );
    }

    #[test]
    fn rejects_bad_share_links() {
        let pk = "ab".repeat(32);
        let many: String = (1..=17).map(|i| format!("&addr=10.0.0.{i}")).collect();
        for bad in [
            "mira://peer".to_owned(),
            "mira://peer?addr=192.168.1.10".to_owned(),
            format!("mira://peer?pk={pk}"),
            "mira://peer?pk=abc&addr=192.168.1.10".to_owned(),
            format!("mira://peer?pk={pk}&pk={pk}&addr=192.168.1.10"),
            format!("mira://peer?pk={pk}&addr=laptop"),
            format!("mira://peer?pk={pk}&addr=0.0.0.0:47800"),
            format!("mira://peer?pk={pk}&addr=%ZZ"),
            format!("mira://org?pk={pk}&addr=192.168.1.10"),
            format!("mira://peer?pk={pk}{many}"),
        ] {
            assert_eq!(
                parse_address_input(&bad).unwrap_err().code(),
                "invalid_address",
                "{bad}"
            );
        }
    }

    #[test]
    fn remembers_addresses_and_orders_by_last_success() {
        let (_tmp, conn) = conn();
        let (a, b) = ("aa".repeat(32), "bb".repeat(32));
        remember(
            &conn,
            &a,
            sa("192.168.1.10:47800"),
            AddressSource::Outgoing,
            t0(),
        )
        .unwrap();
        remember(
            &conn,
            &b,
            sa("192.168.1.11:47800"),
            AddressSource::Mdns,
            t0(),
        )
        .unwrap();
        remember(
            &conn,
            &b,
            sa("10.8.0.2:47800"),
            AddressSource::Incoming,
            t0() + Duration::minutes(5),
        )
        .unwrap();
        // Hint later does not erase the earlier success.
        remember(
            &conn,
            &a,
            sa("192.168.1.10:47800"),
            AddressSource::Hello,
            t0() + Duration::minutes(9),
        )
        .unwrap();
        remember(&conn, &a, sa("0.0.0.0:47800"), AddressSource::Hello, t0()).unwrap();
        assert!(remember(&conn, "bukan", sa("10.0.0.1:1"), AddressSource::Hello, t0()).is_err());

        let k = known(&conn).unwrap();
        assert_eq!(k.len(), 3);
        assert_eq!(k[0].address, sa("10.8.0.2:47800"));
        assert_eq!(k[0].public_key.as_deref(), Some(b.as_str()));
        assert_eq!(k[1].address, sa("192.168.1.10:47800"));
        assert_eq!(
            k[1].last_success_at.as_deref(),
            Some("2026-11-22T08:00:00Z")
        );
        assert_eq!(k[2].address, sa("192.168.1.11:47800"));
        assert_eq!(k[2].last_success_at, None);
    }

    #[test]
    fn keeps_at_most_16_addresses_per_peer() {
        let (_tmp, conn) = conn();
        let a = "aa".repeat(32);
        for i in 0..20 {
            remember(
                &conn,
                &a,
                sa(&format!("10.0.0.{i}:47800")),
                AddressSource::Hello,
                t0() + Duration::seconds(i),
            )
            .unwrap();
        }
        let k = known(&conn).unwrap();
        assert_eq!(k.len(), 16);
        assert_eq!(k[0].address, sa("10.0.0.19:47800"));
        assert!(!k.iter().any(|x| x.address == sa("10.0.0.3:47800")));
    }

    #[test]
    fn manual_addresses_lifecycle() {
        let (_tmp, conn) = conn();
        let added = add_manual(&conn, "192.168.1.20", t0()).unwrap();
        assert_eq!(added.len(), 1);
        assert_eq!(added[0].address, "192.168.1.20:47800");
        assert_eq!(added[0].added_at, "2026-11-22T08:00:00Z");
        assert_eq!(added[0].public_key, None);
        let json = serde_json::to_value(&added[0]).unwrap();
        for k in [
            "address",
            "addedAt",
            "lastTriedAt",
            "lastError",
            "publicKey",
        ] {
            assert!(json.get(k).is_some(), "{k}");
        }
        assert_eq!(
            add_manual(&conn, "nama-laptop", t0()).unwrap_err().code(),
            "invalid_address"
        );

        let pk = "cd".repeat(32);
        let link = format!("mira://peer?pk={pk}&addr=192.168.1.21:47801&addr=192.168.1.20");
        let added = add_manual(&conn, &link, t0() + Duration::minutes(1)).unwrap();
        assert_eq!(added.len(), 2);
        assert!(
            added
                .iter()
                .all(|m| m.public_key.as_deref() == Some(pk.as_str()))
        );
        assert_eq!(manual_addresses(&conn).unwrap().len(), 2);

        let k = known(&conn).unwrap();
        assert_eq!(k.len(), 2);
        assert!(k.iter().all(|x| x.last_success_at.is_none()));

        manual_attempt(
            &conn,
            sa("192.168.1.20:47800"),
            Err("Laptop rekan tidak menjawab."),
            t0() + Duration::minutes(2),
        )
        .unwrap();
        let m = manual_addresses(&conn)
            .unwrap()
            .into_iter()
            .find(|m| m.address == "192.168.1.20:47800")
            .unwrap();
        assert_eq!(
            m.last_error.as_deref(),
            Some("Laptop rekan tidak menjawab.")
        );
        assert_eq!(m.last_tried_at.as_deref(), Some("2026-11-22T08:02:00Z"));

        let other = "ef".repeat(32);
        manual_attempt(
            &conn,
            sa("192.168.1.21:47801"),
            Ok(&other),
            t0() + Duration::minutes(3),
        )
        .unwrap();
        let k = known(&conn).unwrap();
        assert_eq!(k[0].address, sa("192.168.1.21:47801"));
        assert_eq!(k[0].public_key.as_deref(), Some(other.as_str()));
        assert_eq!(
            k[0].last_success_at.as_deref(),
            Some("2026-11-22T08:03:00Z")
        );

        // Once connected, the remembered address carries the key too; it is listed once.
        remember(
            &conn,
            &other,
            sa("192.168.1.21:47801"),
            AddressSource::Manual,
            t0() + Duration::minutes(3),
        )
        .unwrap();
        let k = known(&conn).unwrap();
        assert_eq!(
            k.iter()
                .filter(|x| x.address == sa("192.168.1.21:47801"))
                .count(),
            1
        );

        remove_manual(&conn, "192.168.1.20").unwrap();
        remove_manual(&conn, "192.168.1.20:47800").unwrap();
        assert_eq!(manual_addresses(&conn).unwrap().len(), 1);
        assert_eq!(
            remove_manual(&conn, "x").unwrap_err().code(),
            "invalid_address"
        );
    }

    #[test]
    fn last_seen_is_tracked() {
        let (_tmp, conn) = conn();
        let a = "aa".repeat(32);
        assert_eq!(last_seen(&conn, &a).unwrap(), None);
        mark_seen(&conn, &a, t0()).unwrap();
        mark_seen(&conn, &a, t0() + Duration::hours(1)).unwrap();
        mark_seen(&conn, &"bb".repeat(32), t0()).unwrap();
        assert_eq!(
            last_seen(&conn, &a).unwrap().as_deref(),
            Some("2026-11-22T09:00:00Z")
        );
        let rows = peer_rows(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].public_key, a);
    }
}
