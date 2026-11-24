//! Distinguished names (RFC 4514), LDAP filter values (RFC 4515) and DNS
//! domain names.

/// Longest DN accepted in a join request, in characters.
pub const MAX_DN_CHARS: usize = 512;

/// One relative distinguished name, `OU=IT-Development`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rdn {
    /// Attribute type, uppercase (`CN`, `OU`, `DC`).
    pub attr: String,
    /// Value with escapes resolved.
    pub value: String,
}

/// Splits a DN into its RDNs, first (innermost) first. `None` when malformed.
///
/// Multi-valued RDNs (an unescaped `+`, `CN=a+UID=b`) are rejected: Active
/// Directory does not produce them, and guessing which value counts would
/// make OU matching ambiguous.
pub fn parse_dn(dn: &str) -> Option<Vec<Rdn>> {
    if dn.chars().count() > MAX_DN_CHARS {
        return None;
    }
    let chars = unescape(dn)?;
    chars.split(|ch| ch.is_raw(',')).map(parse_rdn).collect()
}

/// A DN character after escapes are resolved. Escaped characters never
/// separate anything and are never trimmed.
#[derive(Clone, Copy)]
struct DnChar {
    c: char,
    escaped: bool,
}

impl DnChar {
    fn is_raw(self, c: char) -> bool {
        !self.escaped && self.c == c
    }
}

/// Resolves `\<special>` and `\<hex><hex>` escapes. Consecutive hex bytes are
/// decoded together as UTF-8.
fn unescape(dn: &str) -> Option<Vec<DnChar>> {
    let mut out = Vec::with_capacity(dn.len());
    let mut bytes = Vec::new();
    let mut it = dn.chars();
    while let Some(c) = it.next() {
        if c != '\\' {
            flush_bytes(&mut bytes, &mut out)?;
            out.push(DnChar { c, escaped: false });
            continue;
        }
        let next = it.next()?;
        if let Some(hi) = next.to_digit(16) {
            let lo = it.next()?.to_digit(16)?;
            bytes.push((hi * 16 + lo) as u8);
        } else if matches!(
            next,
            ' ' | '"' | '#' | '+' | ',' | ';' | '<' | '=' | '>' | '\\'
        ) {
            flush_bytes(&mut bytes, &mut out)?;
            out.push(DnChar {
                c: next,
                escaped: true,
            });
        } else {
            return None;
        }
    }
    flush_bytes(&mut bytes, &mut out)?;
    Some(out)
}

fn flush_bytes(bytes: &mut Vec<u8>, out: &mut Vec<DnChar>) -> Option<()> {
    if bytes.is_empty() {
        return Some(());
    }
    let s = std::str::from_utf8(bytes).ok()?;
    out.extend(s.chars().map(|c| DnChar { c, escaped: true }));
    bytes.clear();
    Some(())
}

/// Strips unescaped spaces at both ends.
fn trim_spaces(mut s: &[DnChar]) -> &[DnChar] {
    while let [first, rest @ ..] = s {
        if !first.is_raw(' ') {
            break;
        }
        s = rest;
    }
    while let [rest @ .., last] = s {
        if !last.is_raw(' ') {
            break;
        }
        s = rest;
    }
    s
}

fn parse_rdn(part: &[DnChar]) -> Option<Rdn> {
    let eq = part.iter().position(|ch| ch.is_raw('='))?;
    let attr = trim_spaces(&part[..eq]);
    let value = trim_spaces(&part[eq + 1..]);
    let attr_ok = !attr.is_empty()
        && attr
            .iter()
            .all(|ch| !ch.escaped && (ch.c.is_ascii_alphanumeric() || matches!(ch.c, '-' | '.')));
    if !attr_ok || value.is_empty() {
        return None;
    }
    // A leading raw `#` is a BER-encoded value, which nothing here needs.
    if value[0].is_raw('#') {
        return None;
    }
    let bad = |ch: &DnChar| {
        ch.c.is_control() || (!ch.escaped && matches!(ch.c, '+' | '"' | ';' | '<' | '>'))
    };
    if value.iter().any(bad) {
        return None;
    }
    let value: String = value.iter().map(|ch| ch.c).collect();
    // OU names reach the approver's card and the fold's OU rules: no bidi,
    // invisible or blank-looking characters, even escaped (`\E2\80\AE`), and
    // no piles of combining marks.
    if value
        .chars()
        .any(crate::permissions::join::is_join_forbidden_char)
        || crate::permissions::join::has_long_mark_run(&value)
    {
        return None;
    }
    Some(Rdn {
        attr: attr.iter().map(|ch| ch.c.to_ascii_uppercase()).collect(),
        value,
    })
}

/// `OU` values, innermost first.
pub fn ous(dn: &str) -> Vec<String> {
    parse_dn(dn)
        .unwrap_or_default()
        .into_iter()
        .filter(|rdn| rdn.attr == "OU")
        .map(|rdn| rdn.value)
        .collect()
}

/// `DC=macf,DC=co,DC=id` → `macf.co.id`, from the trailing run of `DC`s.
pub fn domain_of(dn: &str) -> Option<String> {
    let rdns = parse_dn(dn)?;
    let start = rdns
        .iter()
        .rposition(|rdn| rdn.attr != "DC")
        .map_or(0, |i| i + 1);
    let dcs = &rdns[start..];
    if dcs.is_empty() {
        return None;
    }
    let labels: Vec<String> = dcs.iter().map(|rdn| rdn.value.to_lowercase()).collect();
    Some(labels.join("."))
}

/// Escapes `*`, `(`, `)`, `\` and NUL for an LDAP filter value.
pub fn escape_filter_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '*' => out.push_str("\\2a"),
            '(' => out.push_str("\\28"),
            ')' => out.push_str("\\29"),
            '\\' => out.push_str("\\5c"),
            '\0' => out.push_str("\\00"),
            c => out.push(c),
        }
    }
    out
}

/// Trimmed, lowercase, without a trailing dot; at least two labels of 1 to
/// 63 `[a-z0-9-]` (not starting or ending with `-`), 253 characters at most.
/// An all-digit last label (an IPv4 address) is rejected.
pub fn normalize_domain(s: &str) -> Option<String> {
    let lower = s.trim().to_ascii_lowercase();
    let name = lower.strip_suffix('.').unwrap_or(&lower);
    if name.len() > 253 {
        return None;
    }
    let labels: Vec<&str> = name.split('.').collect();
    if labels.len() < 2 {
        return None;
    }
    let label_ok = |l: &&str| {
        (1..=63).contains(&l.len())
            && l.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && !l.starts_with('-')
            && !l.ends_with('-')
    };
    if !labels.iter().all(label_ok) {
        return None;
    }
    if labels.last()?.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(name.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rdn(attr: &str, value: &str) -> Rdn {
        Rdn {
            attr: attr.to_owned(),
            value: value.to_owned(),
        }
    }

    const REAL: &str = "CN=hartono,OU=IT-Development,OU=IT-Department,OU=IT & CP Department,OU=HO,OU=Member Users,DC=macf,DC=co,DC=id";

    #[test]
    fn parses_real_dn() {
        let rdns = parse_dn(REAL).unwrap();
        assert_eq!(rdns.len(), 9);
        assert_eq!(rdns[0], rdn("CN", "hartono"));
        assert_eq!(rdns[3], rdn("OU", "IT & CP Department"));
        assert_eq!(rdns[8], rdn("DC", "id"));
    }

    #[test]
    fn ous_innermost_first() {
        assert_eq!(
            ous(REAL),
            vec![
                "IT-Development",
                "IT-Department",
                "IT & CP Department",
                "HO",
                "Member Users"
            ]
        );
    }

    #[test]
    fn ous_of_malformed_dn_is_empty() {
        assert!(ous("CN=a,OU=").is_empty());
        assert!(ous("not a dn").is_empty());
    }

    #[test]
    fn attribute_uppercased_and_spaces_trimmed() {
        let rdns = parse_dn("cn = Budi Santoso , ou= Sales ,dc=x").unwrap();
        assert_eq!(
            rdns,
            vec![
                rdn("CN", "Budi Santoso"),
                rdn("OU", "Sales"),
                rdn("DC", "x")
            ]
        );
    }

    #[test]
    fn escaped_comma_stays_in_value() {
        let rdns = parse_dn(r"CN=Budi,OU=Sales\, Jakarta,DC=macf,DC=co,DC=id").unwrap();
        assert_eq!(rdns[1], rdn("OU", "Sales, Jakarta"));
        assert_eq!(
            ous(r"CN=Budi,OU=Sales\, Jakarta,DC=x"),
            vec!["Sales, Jakarta"]
        );
    }

    #[test]
    fn special_escapes() {
        let rdns = parse_dn(r#"CN=a\+b\"c\\d\<e\>f\;g\=h,OU=\#1,OU=x\ "#).unwrap();
        assert_eq!(rdns[0].value, r#"a+b"c\d<e>f;g=h"#);
        assert_eq!(rdns[1].value, "#1");
        assert_eq!(rdns[2].value, "x ");
    }

    #[test]
    fn hex_escapes() {
        assert_eq!(
            parse_dn(r"OU=Sales\2C Jakarta").unwrap()[0].value,
            "Sales, Jakarta"
        );
        assert_eq!(
            parse_dn(r"OU=Sales\2c Jakarta").unwrap()[0].value,
            "Sales, Jakarta"
        );
        // Consecutive bytes form one UTF-8 character.
        assert_eq!(parse_dn(r"CN=Jos\C3\A9").unwrap()[0].value, "José");
        assert_eq!(parse_dn(r"CN=\E2\82\AC5").unwrap()[0].value, "€5");
    }

    #[test]
    fn invalid_hex_or_utf8_rejected() {
        assert_eq!(parse_dn(r"CN=Jos\C3"), None);
        assert_eq!(parse_dn(r"CN=Jos\C3x"), None);
        assert_eq!(parse_dn(r"CN=\FF\FE"), None);
        assert_eq!(parse_dn(r"CN=a\2"), None);
        assert_eq!(parse_dn(r"CN=a\2G"), None);
        // Control characters, even escaped, are not names.
        assert_eq!(parse_dn(r"CN=a\00b"), None);
        assert_eq!(parse_dn(r"CN=a\0Ab"), None);
    }

    #[test]
    fn malformed_dns_rejected() {
        for dn in [
            "",
            "   ",
            "CN=",
            "=a",
            "CN=a,",
            ",CN=a",
            "CN=a,,DC=b",
            "CNa",
            r"CN=a\",
            r"CN=a\q",
            "CN=a\"b",
            "CN=a;DC=b",
            "CN=a<b",
            "CN=#04",
            r"C\N=a",
            "C N=a",
        ] {
            assert_eq!(parse_dn(dn), None, "{dn:?}");
        }
    }

    #[test]
    fn invisible_or_stacked_characters_rejected_even_escaped() {
        for dn in [
            "OU=Dir\\E2\\80\\AEeksi,DC=macf,DC=co,DC=id",
            "OU=Dir\u{202E}eksi,DC=macf,DC=co,DC=id",
            "OU=Keu\\E2\\80\\8Bangan,DC=macf,DC=co,DC=id",
            "OU=Keu\u{3164}angan,DC=macf,DC=co,DC=id",
            "CN=a\u{0301}\u{0301}\u{0301},DC=macf,DC=co,DC=id",
            "CN=Budi\\EF\\B8\\8F,DC=macf,DC=co,DC=id",
        ] {
            assert_eq!(parse_dn(dn), None, "{dn:?}");
            assert!(ous(dn).is_empty(), "{dn:?}");
            assert_eq!(domain_of(dn), None, "{dn:?}");
        }
        // Two stacked marks and plain accents are fine.
        let ok = parse_dn("OU=Nguye\u{0302}\u{0323}n,OU=Pe\\C3\\B1a,DC=x,DC=id").unwrap();
        assert_eq!(ok[1].value, "Pe\u{f1}a");
    }

    #[test]
    fn multi_valued_rdn_rejected() {
        assert_eq!(parse_dn("CN=a+UID=b,DC=x"), None);
        assert_eq!(parse_dn(r"CN=a\+UID=b,DC=x").unwrap()[0].value, "a+UID=b");
    }

    #[test]
    fn unescaped_equals_in_value_allowed() {
        assert_eq!(parse_dn("CN=a=b").unwrap()[0], rdn("CN", "a=b"));
    }

    #[test]
    fn oid_attribute_accepted() {
        assert_eq!(parse_dn("2.5.4.3=a").unwrap()[0], rdn("2.5.4.3", "a"));
    }

    #[test]
    fn length_limit() {
        let ok = format!("CN={}", "a".repeat(MAX_DN_CHARS - 3));
        assert!(parse_dn(&ok).is_some());
        let long = format!("CN={}", "a".repeat(MAX_DN_CHARS - 2));
        assert_eq!(parse_dn(&long), None);
        // Counted in characters, not bytes.
        let wide = format!("CN={}", "é".repeat(MAX_DN_CHARS - 3));
        assert!(parse_dn(&wide).is_some());
    }

    #[test]
    fn domain_of_dcs() {
        assert_eq!(domain_of(REAL).as_deref(), Some("macf.co.id"));
        assert_eq!(
            domain_of("CN=a,DC=MACF,DC=Co,DC=ID").as_deref(),
            Some("macf.co.id")
        );
        assert_eq!(domain_of("CN=a,OU=b"), None);
        assert_eq!(domain_of("CN=a,DC="), None);
        assert_eq!(domain_of(""), None);
    }

    #[test]
    fn filter_escape() {
        assert_eq!(escape_filter_value("hartono"), "hartono");
        assert_eq!(escape_filter_value(r"a*b(c)d\e"), r"a\2ab\28c\29d\5ce");
        assert_eq!(escape_filter_value("a\0b"), r"a\00b");
        assert_eq!(escape_filter_value("José"), "José");
    }

    #[test]
    fn filter_injection_neutralised() {
        let escaped = escape_filter_value("*)(uid=*");
        assert_eq!(escaped, r"\2a\29\28uid=\2a");
        assert!(!escaped.contains(['*', '(', ')']));
    }

    #[test]
    fn normalize_domain_accepts() {
        assert_eq!(
            normalize_domain("macf.co.id").as_deref(),
            Some("macf.co.id")
        );
        assert_eq!(
            normalize_domain("MACF.Co.ID").as_deref(),
            Some("macf.co.id")
        );
        assert_eq!(
            normalize_domain("macf.co.id.").as_deref(),
            Some("macf.co.id")
        );
        assert_eq!(
            normalize_domain("  macf.co.id \n").as_deref(),
            Some("macf.co.id")
        );
        assert_eq!(
            normalize_domain("my-corp.local").as_deref(),
            Some("my-corp.local")
        );
        assert_eq!(normalize_domain("x1.y2").as_deref(), Some("x1.y2"));
    }

    #[test]
    fn normalize_domain_rejects() {
        let label64 = format!("{}.com", "a".repeat(64));
        let too_long = format!("{}.com", vec!["a".repeat(60); 5].join("."));
        for s in [
            "",
            "   ",
            ".",
            "macf",
            "macf.",
            "10.0.0.1",
            "192.168.1.10.",
            "::1",
            "[::1]",
            "_ldap._tcp.macf.co.id",
            "macf_corp.co.id",
            "macf..co.id",
            ".macf.co.id",
            "macf.co.id..",
            "-macf.co.id",
            "macf-.co.id",
            "macf co.id",
            "macf.co.id/x",
            "mácf.co.id",
            label64.as_str(),
            too_long.as_str(),
        ] {
            assert_eq!(normalize_domain(s), None, "{s:?}");
        }
        let label63 = format!("{}.com", "a".repeat(63));
        assert!(normalize_domain(&label63).is_some());
    }
}
