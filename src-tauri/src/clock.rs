use std::sync::OnceLock;

use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

/// Test hook: `MIRA_CLOCK_OFFSET_SECS` shifts this laptop's clock, so the
/// multi-instance test can check that an expired invite is refused without
/// waiting 24 hours. It only changes what this laptop believes the time is,
/// which a user could also do by changing the Windows clock.
pub const CLOCK_OFFSET_ENV: &str = "MIRA_CLOCK_OFFSET_SECS";

fn offset() -> Duration {
    static OFFSET: OnceLock<Duration> = OnceLock::new();
    *OFFSET.get_or_init(|| {
        std::env::var(CLOCK_OFFSET_ENV)
            .ok()
            .and_then(|v| v.trim().parse::<i64>().ok())
            .map(Duration::seconds)
            .unwrap_or(Duration::ZERO)
    })
}

/// Current UTC time with whole seconds (plus the test offset, if set).
pub fn now() -> OffsetDateTime {
    let now = OffsetDateTime::now_utc() + offset();
    now.replace_nanosecond(0).unwrap_or(now)
}

/// Current UTC time as RFC 3339 with whole seconds, e.g. `2026-11-22T08:15:00Z`.
pub fn now_rfc3339() -> String {
    format_rfc3339(now())
}

pub fn format_rfc3339(t: OffsetDateTime) -> String {
    t.format(&Rfc3339)
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
