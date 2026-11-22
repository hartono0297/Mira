//! Which local interface reaches a peer, and whether it is a VPN (plan 2.6).

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};

use super::Route;

/// Substrings (lowercase) that mark an interface name as a VPN adapter.
pub const VPN_PATTERNS: &[&str] = &[
    "wireguard",
    "wg",
    "tun",
    "tap",
    "vpn",
    "openvpn",
    "anyconnect",
    "forti",
    "globalprotect",
    "pangp",
    "zerotier",
    "tailscale",
    "ppp",
    "wan miniport",
];

/// True when the interface name contains one of `VPN_PATTERNS`, ignoring case.
pub fn is_vpn_interface_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    VPN_PATTERNS.iter().any(|p| lower.contains(p))
}

/// Classifies the route to `peer` using the interface the OS would send from.
pub fn classify(peer: SocketAddr) -> Route {
    if peer.ip().is_loopback() {
        return Route::Local;
    }
    let Some(local) = local_ip_towards(peer) else {
        return Route::Lan;
    };
    let interfaces: Vec<(String, IpAddr)> = if_addrs::get_if_addrs()
        .map(|list| list.into_iter().map(|i| (i.name.clone(), i.ip())).collect())
        .unwrap_or_default();
    classify_with(local, &interfaces)
}

/// Pure part of `classify`: given the local source address and the list of
/// interfaces (name, address), pick the route.
pub fn classify_with(local: IpAddr, interfaces: &[(String, IpAddr)]) -> Route {
    if local.is_loopback() {
        return Route::Local;
    }
    match interfaces.iter().find(|(_, ip)| *ip == local) {
        Some((name, _)) if is_vpn_interface_name(name) => Route::Vpn,
        _ => Route::Lan,
    }
}

/// Local address the OS picks to reach `peer`. Connecting a UDP socket sends
/// nothing; it only resolves the route.
fn local_ip_towards(peer: SocketAddr) -> Option<IpAddr> {
    let bind: SocketAddr = match peer {
        SocketAddr::V4(_) => (Ipv4Addr::UNSPECIFIED, 0).into(),
        SocketAddr::V6(_) => (std::net::Ipv6Addr::UNSPECIFIED, 0).into(),
    };
    let sock = UdpSocket::bind(bind).ok()?;
    sock.connect(peer).ok()?;
    let ip = sock.local_addr().ok()?.ip();
    (!ip.is_unspecified()).then_some(ip)
}

/// IPv4 addresses of this laptop that other laptops can use: not loopback,
/// not link-local (169.254.x.x), not unspecified.
pub fn shareable_ipv4() -> Vec<Ipv4Addr> {
    let mut out: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.ip() {
            IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified() => {
                Some(v4)
            }
            _ => None,
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// True for an address worth dialing: IPv4 unicast with a port.
pub fn is_dialable(addr: &SocketAddr) -> bool {
    match addr {
        SocketAddr::V4(v4) => {
            let ip = v4.ip();
            v4.port() != 0 && !ip.is_unspecified() && !ip.is_multicast() && !ip.is_broadcast()
        }
        SocketAddr::V6(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vpn_names_are_recognized_case_insensitively() {
        for name in [
            "WireGuard Tunnel",
            "wg0",
            "tun0",
            "TAP-Windows Adapter V9",
            "OpenVPN Data Channel Offload",
            "Cisco AnyConnect Secure Mobility Client",
            "Fortinet SSL VPN",
            "FortiClient",
            "GlobalProtect",
            "PANGP Virtual Ethernet Adapter",
            "ZeroTier One [abcd]",
            "Tailscale",
            "ppp0",
            "WAN Miniport (IKEv2)",
            "Kantor VPN",
        ] {
            assert!(is_vpn_interface_name(name), "{name}");
        }
    }

    #[test]
    fn ordinary_names_are_lan() {
        for name in [
            "Ethernet",
            "Ethernet 2",
            "Wi-Fi",
            "WLAN",
            "eth0",
            "en0",
            "Local Area Connection",
            "Bluetooth Network Connection",
            "vEthernet (Default Switch)",
        ] {
            assert!(!is_vpn_interface_name(name), "{name}");
        }
    }

    #[test]
    fn classification_uses_the_matching_interface() {
        let ifs = vec![
            ("Wi-Fi".to_owned(), IpAddr::from([192, 168, 1, 10])),
            ("Tailscale".to_owned(), IpAddr::from([100, 64, 0, 5])),
            ("Loopback".to_owned(), IpAddr::from([127, 0, 0, 1])),
        ];
        assert_eq!(classify_with([192, 168, 1, 10].into(), &ifs), Route::Lan);
        assert_eq!(classify_with([100, 64, 0, 5].into(), &ifs), Route::Vpn);
        assert_eq!(classify_with([127, 0, 0, 1].into(), &ifs), Route::Local);
        // Unknown interface: assume LAN.
        assert_eq!(classify_with([10, 0, 0, 1].into(), &ifs), Route::Lan);
    }

    #[test]
    fn loopback_peer_is_local() {
        assert_eq!(classify("127.0.0.1:47800".parse().unwrap()), Route::Local);
    }

    #[test]
    fn dialable_addresses() {
        assert!(is_dialable(&"192.168.1.2:47800".parse().unwrap()));
        assert!(is_dialable(&"127.0.0.1:47800".parse().unwrap()));
        assert!(!is_dialable(&"0.0.0.0:47800".parse().unwrap()));
        assert!(!is_dialable(&"192.168.1.2:0".parse().unwrap()));
        assert!(!is_dialable(&"224.0.0.251:5353".parse().unwrap()));
        assert!(!is_dialable(&"255.255.255.255:1".parse().unwrap()));
        assert!(!is_dialable(&"[::1]:47800".parse().unwrap()));
    }
}
