//! Version gate for the records added in v0.5.1 (docs/plans/chat-sticker.md
//! section 5). A v0.5.0 laptop refuses records of a kind it does not know
//! (`model::verify_record`, `deny_unknown_fields`) and logs every refusal,
//! so `reaction` and `sticker_set` are only offered to a peer whose
//! reported Mira version (`members.app_version`, from its device profile) is
//! at least [`sticker_threshold`]. Sticker messages are ordinary `message`
//! records and reach every laptop; an older one shows the fallback text
//! `:nama:` with the image as an attachment.
//!
//! Same `min` rule as `permissions::join::JOIN_AD_SINCE`: while this build
//! is numbered below the constant, the threshold is this build's own
//! version, so development builds and tests talk to each other. The release
//! that ships reactions and stickers must be numbered 0.5.1 or later.

use super::audience::Ctx;
use crate::permissions::join::parse_app_version;

/// First Mira version that understands `reaction` and `sticker_set`.
pub const CHAT_STICKER_SINCE: &str = "0.5.1";

/// Record kinds only sent to laptops at or above [`sticker_threshold`].
pub const GATED_KINDS: &[&str] = &["reaction", "sticker_set"];

/// The version a peer must report to receive [`GATED_KINDS`].
pub fn sticker_threshold() -> (u32, u32, u32) {
    let since = parse_app_version(CHAT_STICKER_SINCE).unwrap_or((0, 5, 1));
    parse_app_version(crate::device::APP_VERSION).map_or(since, |own| own.min(since))
}

/// Whether a laptop reporting `app_version` understands [`GATED_KINDS`].
/// An unknown or unparseable version counts as older.
pub fn version_understands(app_version: Option<&str>, threshold: (u32, u32, u32)) -> bool {
    app_version
        .and_then(parse_app_version)
        .is_some_and(|v| v >= threshold)
}

/// Whether `peer` may be offered a record of `kind`.
pub fn peer_may_receive_kind(ctx: &Ctx, peer: &str, kind: &str) -> bool {
    if !GATED_KINDS.contains(&kind) {
        return true;
    }
    let version = ctx.dir.member(peer).and_then(|m| m.app_version.as_deref());
    version_understands(version, sticker_threshold())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn older_or_unknown_versions_do_not_understand() {
        let t = (0, 5, 1);
        assert!(!version_understands(None, t));
        assert!(!version_understands(Some(""), t));
        assert!(!version_understands(Some("0.5.0"), t));
        assert!(!version_understands(Some("0.4.9"), t));
        assert!(version_understands(Some("0.5.1"), t));
        assert!(version_understands(Some("0.6.0"), t));
        assert!(version_understands(Some("1.0.0-beta"), t));
    }

    #[test]
    fn threshold_never_above_this_build() {
        let own = parse_app_version(crate::device::APP_VERSION).unwrap();
        assert!(sticker_threshold() <= own);
        assert!(sticker_threshold() <= (0, 5, 1));
    }
}
