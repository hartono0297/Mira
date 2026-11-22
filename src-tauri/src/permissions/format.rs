//! Field formats shared by ops, invites and views.

use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, UtcOffset};

use crate::error::{AppError, AppResult};
use crate::identity;

pub use crate::org::is_lower_hex;

/// Crockford base32 alphabet (no I, L, O, U).
pub const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub const TEAM_NAME_MIN_CHARS: usize = 2;
pub const TEAM_NAME_MAX_CHARS: usize = 60;
pub const CHANNEL_NAME_MAX_CHARS: usize = 120;
pub const TAG_LEN: usize = 8;

/// Earliest and latest accepted instants (1970-01-01 and 9000-01-01 UTC).
/// Times come from other laptops; keeping them far from the limits of
/// `time` means adding days, subtracting minutes or converting to UTC can
/// never overflow (which would panic).
const MIN_UNIX: i64 = 0;
const MAX_UNIX: i64 = 221_845_392_000;

/// RFC 3339 time between 1970 and 9000 (UTC).
pub fn parse_time(s: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(s, &Rfc3339)
        .ok()
        .filter(|t| (MIN_UNIX..MAX_UNIX).contains(&t.unix_timestamp()))
}

/// UTC, whole seconds, e.g. `2026-11-22T08:15:00Z`.
pub fn format_time(t: OffsetDateTime) -> String {
    let t = t.to_offset(UtcOffset::UTC);
    t.replace_nanosecond(0)
        .unwrap_or(t)
        .format(&Rfc3339)
        .expect("UTC timestamps always format as RFC 3339")
}

/// 8 characters of the uppercase Crockford alphabet.
pub fn is_tag(s: &str) -> bool {
    s.len() == TAG_LEN && s.bytes().all(|b| CROCKFORD.contains(&b))
}

/// Trimmed team name, 2 to 60 characters, same character rules as the
/// organization name.
pub fn validate_team_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    let len = name.chars().count();
    if len < TEAM_NAME_MIN_CHARS {
        return Err(AppError::InvalidName(format!(
            "Nama tim minimal {TEAM_NAME_MIN_CHARS} karakter."
        )));
    }
    if len > TEAM_NAME_MAX_CHARS {
        return Err(AppError::InvalidName(format!(
            "Nama tim paling banyak {TEAM_NAME_MAX_CHARS} karakter."
        )));
    }
    if identity::has_forbidden_chars(name) {
        return Err(AppError::InvalidName(
            "Nama tim berisi karakter yang tidak diizinkan, misalnya baris baru atau tab.".into(),
        ));
    }
    Ok(name.to_owned())
}

pub fn is_canonical_team_name(s: &str) -> bool {
    validate_team_name(s).is_ok_and(|v| v == s)
}

pub fn is_canonical_display_name(s: &str) -> bool {
    identity::validate_display_name(s).is_ok_and(|v| v == s)
}

/// Team channel name: team name in lowercase, spaces become `-`.
pub fn channel_name_for(team_name: &str) -> String {
    team_name.to_lowercase().replace(' ', "-")
}

/// Trimmed, 1 to 120 characters, no control or invisible characters.
pub fn is_valid_channel_name(s: &str) -> bool {
    let len = s.chars().count();
    s.trim() == s
        && (1..=CHANNEL_NAME_MAX_CHARS).contains(&len)
        && !identity::has_forbidden_chars(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_round_trip_is_utc_whole_seconds() {
        let t = parse_time("2026-11-22T15:15:00.75+07:00").unwrap();
        assert_eq!(format_time(t), "2026-11-22T08:15:00Z");
        assert!(parse_time("2026-11-22 08:15:00").is_none());
        assert!(parse_time("kemarin").is_none());
        assert!(parse_time("1970-01-01T00:00:00Z").is_some());
        assert!(parse_time("1969-12-31T23:59:59Z").is_none());
        assert!(parse_time("8999-12-31T23:59:59Z").is_some());
        assert!(parse_time("9000-01-01T00:00:00Z").is_none());
        assert!(parse_time("8999-12-31T20:00:00-05:00").is_none());
        assert!(parse_time("0000-01-01T00:00:00Z").is_none());
    }

    #[test]
    fn tags_use_uppercase_crockford() {
        assert!(is_tag("ABCD0123"));
        assert!(is_tag("ZZZZZZZZ"));
        for bad in [
            "abcd0123",
            "ABCD012",
            "ABCD01234",
            "ABCDI123",
            "ABCDU123",
            "ABCD-123",
        ] {
            assert!(!is_tag(bad), "{bad}");
        }
    }

    #[test]
    fn team_names() {
        assert_eq!(validate_team_name("  Tim Desain ").unwrap(), "Tim Desain");
        assert!(is_canonical_team_name("Tim Desain"));
        assert!(!is_canonical_team_name(" Tim Desain"));
        assert!(!is_canonical_team_name("A"));
        assert!(!is_canonical_team_name(&"x".repeat(61)));
        assert!(is_canonical_team_name(&"é".repeat(60)));
        assert!(!is_canonical_team_name("Tim\tA"));
        assert!(!is_canonical_team_name("Tim\u{200B}A"));
    }

    #[test]
    fn channel_names() {
        assert_eq!(channel_name_for("Tim Desain Grafis"), "tim-desain-grafis");
        assert!(is_valid_channel_name("tim-desain"));
        assert!(!is_valid_channel_name(""));
        assert!(!is_valid_channel_name(" a"));
        assert!(!is_valid_channel_name("a\nb"));
    }
}
