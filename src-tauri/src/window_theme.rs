//! Window background color at startup, so a dark theme does not flash white
//! before the web view paints.
//!
//! The colors mirror the `bg` token of the Bata theme in `src/theme/tokens.ts`
//! (light and dark), which is the page background (`body { background: var(--bg) }`).
//! Keep [`BATA_BG_LIGHT`] and [`BATA_BG_DARK`] in sync with that file.
//!
//! Mode values follow `src/theme/mode.ts`: `light`, `dark`, `system`; anything
//! else (or no setting) means `system`.

use rusqlite::Connection;
use tauri::window::Color;

/// `bata.light.bg` in `src/theme/tokens.ts` (#FFFFFF).
pub const BATA_BG_LIGHT: (u8, u8, u8) = (0xFF, 0xFF, 0xFF);
/// `bata.dark.bg` in `src/theme/tokens.ts` (#1E1714).
pub const BATA_BG_DARK: (u8, u8, u8) = (0x1E, 0x17, 0x14);

/// Setting key read by the frontend too (`MODE_SETTING_KEY` in `mode.ts`).
pub const MODE_SETTING_KEY: &str = "theme.mode";

/// Background for a `theme.mode` value. `system_dark` is used for `system`
/// and for missing or unknown values.
pub fn background_for(mode: Option<&str>, system_dark: bool) -> (u8, u8, u8) {
    let dark = match mode {
        Some("light") => false,
        Some("dark") => true,
        _ => system_dark,
    };
    if dark { BATA_BG_DARK } else { BATA_BG_LIGHT }
}

/// Whether Windows apps use the dark theme: HKCU
/// `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`,
/// value `AppsUseLightTheme` = 0. Missing key or value means light. Read only.
#[cfg(windows)]
pub fn system_prefers_dark() -> bool {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_QUERY_VALUE};

    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            KEY_QUERY_VALUE,
        )
        .and_then(|key| key.get_value::<u32, _>("AppsUseLightTheme"))
        .map(|light| light == 0)
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub fn system_prefers_dark() -> bool {
    false
}

/// Window background for startup, from the `theme.mode` setting (when the
/// database is available) and the Windows app theme.
pub fn initial_background(conn: Option<&Connection>) -> Color {
    let mode = conn.and_then(|c| crate::settings::get(c, MODE_SETTING_KEY).ok().flatten());
    let (r, g, b) = background_for(mode.as_deref(), system_prefers_dark());
    Color(r, g, b, 255)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn mapping() {
        for system_dark in [false, true] {
            assert_eq!(background_for(Some("light"), system_dark), BATA_BG_LIGHT);
            assert_eq!(background_for(Some("dark"), system_dark), BATA_BG_DARK);
        }
        for mode in [None, Some("system"), Some(""), Some("Dark"), Some("sepia")] {
            assert_eq!(background_for(mode, false), BATA_BG_LIGHT, "{mode:?}");
            assert_eq!(background_for(mode, true), BATA_BG_DARK, "{mode:?}");
        }
    }

    #[test]
    fn colors_match_tokens_ts() {
        let tokens = include_str!("../../src/theme/tokens.ts");
        let hex = |(r, g, b): (u8, u8, u8)| format!("bg: \"#{r:02X}{g:02X}{b:02X}\"");
        assert!(tokens.contains(&hex(BATA_BG_LIGHT)), "light bg out of sync");
        assert!(tokens.contains(&hex(BATA_BG_DARK)), "dark bg out of sync");
    }

    #[test]
    fn initial_background_reads_setting() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = db::open(tmp.path()).unwrap();
        crate::settings::set(&conn, MODE_SETTING_KEY, "dark").unwrap();
        let (r, g, b) = BATA_BG_DARK;
        assert_eq!(initial_background(Some(&conn)), Color(r, g, b, 255));
        crate::settings::set(&conn, MODE_SETTING_KEY, "light").unwrap();
        assert_eq!(initial_background(Some(&conn)), Color(255, 255, 255, 255));
    }

    #[test]
    fn system_theme_read_does_not_panic() {
        let _ = system_prefers_dark();
        let _ = initial_background(None);
    }
}
