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
pub fn parse_dn(_dn: &str) -> Option<Vec<Rdn>> {
    None
}

/// `OU` values, innermost first.
pub fn ous(_dn: &str) -> Vec<String> {
    Vec::new()
}

/// `DC=macf,DC=co,DC=id` → `macf.co.id`.
pub fn domain_of(_dn: &str) -> Option<String> {
    None
}

/// Escapes `*`, `(`, `)`, `\` and NUL for an LDAP filter value.
pub fn escape_filter_value(s: &str) -> String {
    s.to_owned()
}

/// Trimmed, lowercase, without a trailing dot; at least two labels of 1 to
/// 63 `[a-z0-9-]` (not starting or ending with `-`), 253 characters at most.
pub fn normalize_domain(_s: &str) -> Option<String> {
    None
}
