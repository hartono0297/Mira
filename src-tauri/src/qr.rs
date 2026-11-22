//! Share link (`mira://peer?...`) and its QR code (docs/plans/tahap-1.md 2.5).
//!
//! Link format: `mira://peer?pk=<64 lowercase hex>&addr=<ip:port>&addr=...`,
//! IPv6 addresses in brackets (`[fe80::1]:47800`). The link only carries
//! hints: the peer's identity is still proven by the TLS handshake.

use std::net::{SocketAddr, SocketAddrV6};

use qrcode::render::svg;
use qrcode::{EcLevel, QrCode};

/// Maximum number of `addr` values in one link (shared and parsed).
pub const MAX_ADDRS: usize = 8;
/// Longer input is rejected before parsing.
pub const MAX_LINK_LEN: usize = 2048;
/// Minimum rendered size of the QR code, in px (quiet zone included).
pub const QR_MIN_SIZE: u32 = 220;

const PREFIX: &str = "mira://peer";

/// Builds the share link for this laptop. `public_key` is included only when it
/// is 64 hex characters (normalized to lowercase). Addresses are deduplicated
/// and capped at [`MAX_ADDRS`]; unspecified addresses and port 0 are skipped.
/// IPv6 scope ids are dropped because they only mean something on this laptop.
pub fn share_link(public_key: &str, addrs: &[SocketAddr]) -> String {
    let mut params: Vec<String> = Vec::new();
    let pk = public_key.trim().to_ascii_lowercase();
    if is_public_key(&pk) {
        params.push(format!("pk={pk}"));
    }
    let mut seen: Vec<SocketAddr> = Vec::new();
    for addr in addrs {
        let addr = without_scope(*addr);
        if !usable(&addr) || seen.contains(&addr) {
            continue;
        }
        if seen.len() == MAX_ADDRS {
            break;
        }
        seen.push(addr);
        params.push(format!("addr={addr}"));
    }
    if params.is_empty() {
        PREFIX.to_owned()
    } else {
        format!("{PREFIX}?{}", params.join("&"))
    }
}

/// Parses a share link. Returns the public key (if present) and the addresses.
///
/// Strict: the scheme and host must be `mira://peer`, `pk` must be exactly 64
/// lowercase hex characters and appear at most once, every `addr` must be a
/// valid `ip:port` (IPv6 in brackets, port not 0, IP not unspecified), and at
/// most [`MAX_ADDRS`] addresses are allowed. Unknown parameters are ignored.
/// Percent-encoded values (`%5B`, `%3A`, ...) are decoded first, since some QR
/// scanners re-encode links. A link with neither `pk` nor `addr` is rejected.
pub fn parse_share_link(s: &str) -> Option<(Option<String>, Vec<SocketAddr>)> {
    let s = s.trim();
    if s.len() > MAX_LINK_LEN || !s.is_ascii() {
        return None;
    }
    let head = s.get(..PREFIX.len())?;
    if !head.eq_ignore_ascii_case(PREFIX) {
        return None;
    }
    let rest = &s[PREFIX.len()..];
    let rest = rest.split('#').next().unwrap_or("");
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    let query = rest.strip_prefix('?')?;

    let mut pk: Option<String> = None;
    let mut addrs: Vec<SocketAddr> = Vec::new();
    for part in query.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = match part.split_once('=') {
            Some((k, v)) => (k, Some(v)),
            None => (part, None),
        };
        match key {
            "pk" => {
                let value = percent_decode(value?)?;
                if pk.is_some() || !is_lower_public_key(&value) {
                    return None;
                }
                pk = Some(value);
            }
            "addr" => {
                let value = percent_decode(value?)?;
                let addr: SocketAddr = value.parse().ok()?;
                if !usable(&addr) {
                    return None;
                }
                let addr = without_scope(addr);
                if !addrs.contains(&addr) {
                    if addrs.len() == MAX_ADDRS {
                        return None;
                    }
                    addrs.push(addr);
                }
            }
            _ => {}
        }
    }
    if pk.is_none() && addrs.is_empty() {
        return None;
    }
    Some((pk, addrs))
}

/// Renders `text` as a QR code SVG: black modules on white, with the standard
/// quiet zone, at least [`QR_MIN_SIZE`] px wide. The result is a bare `<svg>`
/// element (no XML prolog, scripts or external references), safe to show as an
/// image. Returns an empty string if `text` is too long for a QR code.
pub fn qr_svg(text: &str) -> String {
    let code = match QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M) {
        Ok(code) => code,
        Err(_) => return String::new(),
    };
    let rendered = code
        .render::<svg::Color<'_>>()
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .quiet_zone(true)
        .min_dimensions(QR_MIN_SIZE, QR_MIN_SIZE)
        .build();
    match rendered.find("<svg") {
        Some(start) => rendered[start..].to_owned(),
        None => String::new(),
    }
}

fn is_public_key(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_lower_public_key(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn usable(addr: &SocketAddr) -> bool {
    addr.port() != 0 && !addr.ip().is_unspecified() && !addr.ip().is_multicast()
}

fn without_scope(addr: SocketAddr) -> SocketAddr {
    match addr {
        SocketAddr::V6(v6) => SocketAddr::V6(SocketAddrV6::new(*v6.ip(), v6.port(), 0, 0)),
        v4 => v4,
    }
}

/// Decodes `%XX` escapes. Rejects malformed escapes and non-ASCII results.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    if !out.iter().all(|b| b.is_ascii_graphic()) {
        return None;
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PK: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn addr(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    #[test]
    fn share_link_format() {
        let link = share_link(PK, &[addr("192.168.1.10:47800"), addr("[fe80::1]:47801")]);
        assert_eq!(
            link,
            format!("mira://peer?pk={PK}&addr=192.168.1.10:47800&addr=[fe80::1]:47801")
        );
    }

    #[test]
    fn round_trip() {
        let addrs = vec![
            addr("192.168.1.10:47800"),
            addr("10.8.0.2:47809"),
            addr("[2001:db8::7]:47800"),
        ];
        let link = share_link(PK, &addrs);
        let (pk, parsed) = parse_share_link(&link).unwrap();
        assert_eq!(pk.as_deref(), Some(PK));
        assert_eq!(parsed, addrs);
    }

    #[test]
    fn share_link_normalizes_and_caps() {
        let upper = PK.to_ascii_uppercase();
        let many: Vec<SocketAddr> = (1..=12)
            .map(|i| addr(&format!("10.0.0.{i}:47800")))
            .chain([addr("10.0.0.1:47800"), addr("0.0.0.0:47800")])
            .collect();
        let link = share_link(&upper, &many);
        let (pk, parsed) = parse_share_link(&link).unwrap();
        assert_eq!(pk.as_deref(), Some(PK));
        assert_eq!(parsed.len(), MAX_ADDRS);
        assert_eq!(parsed[0], addr("10.0.0.1:47800"));

        let scoped = SocketAddr::V6(SocketAddrV6::new("fe80::1".parse().unwrap(), 47800, 0, 7));
        let link = share_link("not-a-key", &[scoped]);
        assert_eq!(link, "mira://peer?addr=[fe80::1]:47800");
        assert_eq!(share_link("", &[]), "mira://peer");
    }

    #[test]
    fn parse_accepts_variants() {
        let (pk, addrs) =
            parse_share_link(" MIRA://peer/?addr=%5Bfe80%3A%3A1%5D%3A47800&x=1&&v=2#frag ")
                .unwrap();
        assert_eq!(pk, None);
        assert_eq!(addrs, vec![addr("[fe80::1]:47800")]);

        let (pk, addrs) = parse_share_link(&format!("mira://peer?pk={PK}")).unwrap();
        assert_eq!(pk.as_deref(), Some(PK));
        assert!(addrs.is_empty());

        // Duplicates collapse.
        let (_, addrs) = parse_share_link("mira://peer?addr=10.0.0.1:1&addr=10.0.0.1:1").unwrap();
        assert_eq!(addrs.len(), 1);
    }

    #[test]
    fn parse_rejects_malformed() {
        let nine = (1..=9)
            .map(|i| format!("addr=10.0.0.{i}:47800"))
            .collect::<Vec<_>>()
            .join("&");
        let bad = [
            String::new(),
            "mira://peer".into(),
            "mira://peer?".into(),
            "mira://peer?foo=bar".into(),
            "http://peer?addr=10.0.0.1:47800".into(),
            "mira://peers?addr=10.0.0.1:47800".into(),
            "mira://peer?addr=10.0.0.1".into(),
            "mira://peer?addr=10.0.0.1:0".into(),
            "mira://peer?addr=0.0.0.0:47800".into(),
            "mira://peer?addr=224.0.0.251:5353".into(),
            "mira://peer?addr=fe80::1:47800".into(),
            "mira://peer?addr=host.local:47800".into(),
            "mira://peer?addr".into(),
            "mira://peer?addr=10.0.0.1%3".into(),
            "mira://peer?addr=10.0.0.1%zz:1".into(),
            "mira://peer?addr=10.0.0.1:1%00".into(),
            format!("mira://peer?pk={}", PK.to_ascii_uppercase()),
            format!("mira://peer?pk={}", &PK[..63]),
            format!("mira://peer?pk={PK}0"),
            "mira://peer?pk=".into(),
            format!("mira://peer?pk={PK}&pk={PK}"),
            format!("mira://peer?{nine}"),
            format!("mira://peer?addr=10.0.0.1:1&x={}", "a".repeat(MAX_LINK_LEN)),
            "mira://peer?addr=10.0.0.1:1&n=é".into(),
        ];
        for link in &bad {
            assert_eq!(parse_share_link(link), None, "{link:?}");
        }
    }

    #[test]
    fn svg_is_plain_and_safe() {
        let link = share_link(PK, &[addr("192.168.1.10:47800")]);
        let svg = qr_svg(&link);
        assert!(svg.starts_with("<svg"), "{}", &svg[..40]);
        assert!(svg.ends_with("</svg>"));
        assert!(!svg.contains("<script"));
        assert!(!svg.contains("href"));
        assert!(!svg.contains("<?xml"));
        assert!(svg.contains("#000000") && svg.contains("#ffffff"));
        let width: u32 = svg
            .split("width=\"")
            .nth(1)
            .and_then(|s| s.split('"').next())
            .and_then(|s| s.parse().ok())
            .unwrap();
        assert!(width >= QR_MIN_SIZE, "{width}");
    }

    #[test]
    fn svg_for_too_long_text_is_empty() {
        assert_eq!(qr_svg(&"x".repeat(5000)), "");
    }
}
