use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

/// Current UTC time as RFC 3339 with whole seconds, e.g. `2026-11-22T08:15:00Z`.
pub fn now_rfc3339() -> String {
    let now = OffsetDateTime::now_utc();
    now.replace_nanosecond(0)
        .unwrap_or(now)
        .format(&Rfc3339)
        .expect("UTC timestamps always format as RFC 3339")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn produces_parseable_rfc3339() {
        let s = now_rfc3339();
        assert!(OffsetDateTime::parse(&s, &Rfc3339).is_ok(), "{s}");
        assert!(s.ends_with('Z'), "{s}");
    }
}
