//! Error type shared by every module and returned by every Tauri command.
//!
//! Serialized to the frontend as `{ "code": string, "message": string }`.
//! `code` is stable and machine readable; `message` is Indonesian text that the
//! frontend can show as is.

use serde::ser::{Serialize, SerializeStruct, Serializer};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    InvalidName(String),
    #[error("Isi nama tampilan dulu sebelum membuat organisasi.")]
    NameRequired,
    #[error(
        "Laptop ini sudah tergabung dalam sebuah organisasi. Satu laptop hanya bisa memegang satu organisasi."
    )]
    OrgExists,
    #[error("{0}")]
    Keystore(String),
    #[error("{0}")]
    KeyMismatch(String),
    #[error("{0}")]
    Database(String),
    #[error("{0}")]
    Internal(String),
    #[error("{0}")]
    InvalidSetting(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    NotFound(String),
    #[error(
        "Kode undangan tidak valid. Kode terdiri dari 20 huruf dan angka, misalnya ABCD-EFGH-JKMN-PQRS-TVWX."
    )]
    InviteInvalid,
    #[error(
        "Kode undangan tidak dikenal oleh laptop rekan yang ditemukan. Periksa kodenya, atau minta kode baru ke admin tim."
    )]
    InviteNotFound,
    #[error("Kode undangan ini sudah kedaluwarsa. Minta kode baru ke admin tim.")]
    InviteExpired,
    #[error("Kode undangan sekali pakai ini sudah dipakai. Minta kode baru ke admin tim.")]
    InviteUsed,
    #[error("Kode undangan ini sudah dicabut. Minta kode baru ke admin tim.")]
    InviteRevoked,
    #[error(
        "Tidak ada laptop rekan yang ditemukan di jaringan. Pastikan laptop rekan menyala dan membuka Mira, atau isi alamat laptop rekan."
    )]
    NoPeerFound,
    #[error("{0}")]
    PeerUnreachable(String),
    #[error(
        "Laptop ini sudah tergabung dalam sebuah organisasi. Satu laptop hanya bisa memegang satu organisasi."
    )]
    AlreadyInOrg,
    #[error(
        "Laptop ini sudah dikeluarkan dari organisasi, jadi tidak bisa membuat perubahan lagi."
    )]
    Removed,
    #[error(
        "Organisasi harus punya minimal satu superadmin. Angkat superadmin lain dulu sebelum melepas yang terakhir."
    )]
    LastSuperadmin,
    #[error("{0}")]
    InvalidAddress(String),
    #[error("{0}")]
    Network(String),
    /// Tahap 4: reading or writing files on this laptop failed (disk full, no access).
    #[error("{0}")]
    Storage(String),
    /// Tahap 4: input from the frontend that cannot be used as is.
    #[error("{0}")]
    InvalidInput(String),
    /// Tahap 4: the action needs the file to be closed in Office first.
    #[error("{0}")]
    DocumentEditing(String),
    /// Tahap 4: Windows could not open the file in Office or another app.
    #[error("{0}")]
    OpenFailed(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::InvalidName(_) => "invalid_name",
            AppError::NameRequired => "name_required",
            AppError::OrgExists => "org_exists",
            AppError::Keystore(_) => "keystore",
            AppError::KeyMismatch(_) => "key_mismatch",
            AppError::Database(_) => "database",
            AppError::Internal(_) => "internal",
            AppError::InvalidSetting(_) => "invalid_setting",
            AppError::Forbidden(_) => "forbidden",
            AppError::NotFound(_) => "not_found",
            AppError::InviteInvalid => "invite_invalid",
            AppError::InviteNotFound => "invite_not_found",
            AppError::InviteExpired => "invite_expired",
            AppError::InviteUsed => "invite_used",
            AppError::InviteRevoked => "invite_revoked",
            AppError::NoPeerFound => "no_peer_found",
            AppError::PeerUnreachable(_) => "peer_unreachable",
            AppError::AlreadyInOrg => "already_in_org",
            AppError::Removed => "removed",
            AppError::LastSuperadmin => "last_superadmin",
            AppError::InvalidAddress(_) => "invalid_address",
            AppError::Network(_) => "network",
            AppError::Storage(_) => "storage",
            AppError::InvalidInput(_) => "invalid_input",
            AppError::DocumentEditing(_) => "document_editing",
            AppError::OpenFailed(_) => "open_failed",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        AppError::Database(format!(
            "Database lokal Mira tidak bisa dibaca atau ditulis. Detail: {err}"
        ))
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_code_and_message() {
        let json = serde_json::to_value(AppError::NameRequired).unwrap();
        assert_eq!(json["code"], "name_required");
        assert_eq!(
            json["message"],
            "Isi nama tampilan dulu sebelum membuat organisasi."
        );
        assert_eq!(json.as_object().unwrap().len(), 2);
    }

    #[test]
    fn tahap_1_codes_are_stable_and_messages_have_no_em_dash() {
        let cases = [
            (AppError::Forbidden("x".into()), "forbidden"),
            (AppError::NotFound("x".into()), "not_found"),
            (AppError::InviteInvalid, "invite_invalid"),
            (AppError::InviteNotFound, "invite_not_found"),
            (AppError::InviteExpired, "invite_expired"),
            (AppError::InviteUsed, "invite_used"),
            (AppError::InviteRevoked, "invite_revoked"),
            (AppError::NoPeerFound, "no_peer_found"),
            (AppError::PeerUnreachable("x".into()), "peer_unreachable"),
            (AppError::AlreadyInOrg, "already_in_org"),
            (AppError::Removed, "removed"),
            (AppError::LastSuperadmin, "last_superadmin"),
            (AppError::InvalidAddress("x".into()), "invalid_address"),
            (AppError::Network("x".into()), "network"),
        ];
        for (err, code) in cases {
            assert_eq!(err.code(), code);
            let json = serde_json::to_value(&err).unwrap();
            assert_eq!(json["code"], code);
            assert!(!err.to_string().contains('\u{2014}'), "{code}");
        }
    }

    #[test]
    fn tahap_4_codes_are_stable() {
        let cases = [
            (AppError::Storage("x".into()), "storage"),
            (AppError::InvalidInput("x".into()), "invalid_input"),
            (AppError::DocumentEditing("x".into()), "document_editing"),
            (AppError::OpenFailed("x".into()), "open_failed"),
        ];
        for (err, code) in cases {
            assert_eq!(err.code(), code);
            assert_eq!(serde_json::to_value(&err).unwrap()["code"], code);
        }
    }

    #[test]
    fn database_errors_map_to_database_code() {
        let err: AppError = rusqlite::Error::InvalidQuery.into();
        assert_eq!(err.code(), "database");
    }
}
