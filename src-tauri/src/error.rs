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
    fn database_errors_map_to_database_code() {
        let err: AppError = rusqlite::Error::InvalidQuery.into();
        assert_eq!(err.code(), "database");
    }
}
