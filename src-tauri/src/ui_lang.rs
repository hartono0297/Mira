//! Display language for text that Rust shows directly: file dialog titles,
//! Windows notifications and a few chat view strings.
//!
//! The frontend stores the choice per laptop under [`SETTING_LANGUAGE`]
//! (`"id"` or `"en"`). It is read each time such a text is built, so a change
//! applies right away. Error messages (`AppError`) stay Indonesian; the
//! frontend maps their codes itself.

use rusqlite::Connection;

use crate::settings;
use crate::state::MiraState;

/// Setting key written by the frontend's language picker.
pub const SETTING_LANGUAGE: &str = "app.language";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum UiLang {
    /// Indonesian, the default for a missing or unknown value.
    #[default]
    Id,
    En,
}

impl UiLang {
    pub fn parse(value: &str) -> Self {
        if value.trim().eq_ignore_ascii_case("en") {
            UiLang::En
        } else {
            UiLang::Id
        }
    }

    /// The language chosen on this laptop. Indonesian when unset or unreadable.
    pub fn load(conn: &Connection) -> Self {
        match settings::get(conn, SETTING_LANGUAGE) {
            Ok(Some(v)) => Self::parse(&v),
            _ => UiLang::Id,
        }
    }

    /// Like [`UiLang::load`], through the shared state. Indonesian when the
    /// database cannot be opened.
    pub fn current(state: &MiraState) -> Self {
        state
            .with_core(|core| Ok(Self::load(&core.db)))
            .unwrap_or_default()
    }

    /// `id` or `en`, by language.
    pub fn pick<'a>(self, id: &'a str, en: &'a str) -> &'a str {
        match self {
            UiLang::Id => id,
            UiLang::En => en,
        }
    }
}

/// Title of the file picker for chat attachments.
pub fn attach_dialog_title(lang: UiLang) -> &'static str {
    lang.pick("Lampirkan file", "Attach files")
}

/// Title of the save dialog for a chat attachment.
pub fn save_dialog_title(lang: UiLang) -> &'static str {
    lang.pick("Simpan file", "Save file")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn parse_defaults_to_indonesian() {
        assert_eq!(UiLang::parse("en"), UiLang::En);
        assert_eq!(UiLang::parse(" EN "), UiLang::En);
        assert_eq!(UiLang::parse("id"), UiLang::Id);
        assert_eq!(UiLang::parse(""), UiLang::Id);
        assert_eq!(UiLang::parse("fr"), UiLang::Id);
        assert_eq!(UiLang::parse("english"), UiLang::Id);
    }

    #[test]
    fn load_reads_the_setting() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = db::open(tmp.path()).unwrap();
        assert_eq!(UiLang::load(&conn), UiLang::Id);
        settings::set(&conn, SETTING_LANGUAGE, "en").unwrap();
        assert_eq!(UiLang::load(&conn), UiLang::En);
        settings::set(&conn, SETTING_LANGUAGE, "id").unwrap();
        assert_eq!(UiLang::load(&conn), UiLang::Id);
        settings::set(&conn, SETTING_LANGUAGE, "").unwrap();
        assert_eq!(UiLang::load(&conn), UiLang::Id);
        settings::set(&conn, SETTING_LANGUAGE, "jp").unwrap();
        assert_eq!(UiLang::load(&conn), UiLang::Id);
    }

    #[test]
    fn current_reads_through_state() {
        let tmp = tempfile::tempdir().unwrap();
        let state = MiraState::new(
            Ok(tmp.path().to_path_buf()),
            Box::new(crate::identity::MemoryKeyStore::new()),
        );
        assert_eq!(UiLang::current(&state), UiLang::Id);
        state
            .with_core(|c| settings::set(&c.db, SETTING_LANGUAGE, "en"))
            .unwrap();
        assert_eq!(UiLang::current(&state), UiLang::En);
    }

    #[test]
    fn dialog_titles() {
        assert_eq!(attach_dialog_title(UiLang::Id), "Lampirkan file");
        assert_eq!(attach_dialog_title(UiLang::En), "Attach files");
        assert_eq!(save_dialog_title(UiLang::Id), "Simpan file");
        assert_eq!(save_dialog_title(UiLang::En), "Save file");
    }
}
