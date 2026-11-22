//! Token unlock tanda tangan: bukti bahwa PIN baru saja dimasukkan.
//!
//! Stempel tanda tangan dikerjakan pdf-lib di frontend, jadi `sign_complete`
//! butuh bukti dari `sign_unlock`. `issue` membuat token acak 32 byte (hex)
//! yang dibalas ke frontend; yang disimpan di memori hanya hash BLAKE3-nya,
//! pemilik (kunci publik), waktu terbit, dan batas berlaku 5 menit. `take`
//! memakai token sekali saja. Token tidak pernah ditulis ke disk.
//!
//! Waktu terbit menjadi waktu tanda tangan resmi: frontend mencetak waktu yang
//! sama di stempel, dan `service::complete` mencatatnya di jejak audit.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use rand_core::{OsRng, RngCore};
use time::{Duration, OffsetDateTime};

use super::err;
use crate::clock;
use crate::error::{AppError, AppResult};

/// Lama token unlock berlaku.
pub const SESSION_TTL: Duration = Duration::minutes(5);

struct Entry {
    owner: String,
    issued_at: String,
    expires: OffsetDateTime,
}

/// Token unlock yang masih berlaku, dikelola Tauri (`app.manage`). Murah
/// untuk di-clone: semua salinan berbagi isi yang sama, jadi perintah bisa
/// membawanya ke `spawn_blocking`.
#[derive(Default, Clone)]
pub struct SignSessions {
    entries: Arc<Mutex<HashMap<[u8; 32], Entry>>>,
}

fn expired() -> AppError {
    err(
        "session_expired",
        "Waktu konfirmasi PIN sudah habis. Masukkan PIN lagi.",
    )
}

fn token_key(token: &str) -> [u8; 32] {
    *blake3::hash(token.as_bytes()).as_bytes()
}

impl SignSessions {
    fn entries(&self) -> MutexGuard<'_, HashMap<[u8; 32], Entry>> {
        // Isinya hanya data sederhana; kalau ada panik di tengah, data tetap
        // utuh, jadi kunci yang "poisoned" boleh dipakai lagi.
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Membuat token baru untuk `owner`. Membalas `(token, issued_at)`, dengan
    /// `issued_at` RFC 3339 UTC. Entri yang sudah kedaluwarsa dibuang.
    pub fn issue(&self, owner: &str, now: OffsetDateTime) -> (String, String) {
        let mut raw = [0u8; 32];
        OsRng.fill_bytes(&mut raw);
        let token = hex::encode(raw);
        let issued_at = clock::format_rfc3339(now);
        let mut entries = self.entries();
        entries.retain(|_, e| e.expires > now);
        entries.insert(
            token_key(&token),
            Entry {
                owner: owner.to_owned(),
                issued_at: issued_at.clone(),
                expires: now + SESSION_TTL,
            },
        );
        (token, issued_at)
    }

    /// Memakai token sekali. Membalas waktu terbitnya. Token yang tidak ada,
    /// kedaluwarsa, atau milik kunci lain ditolak dengan `session_expired`
    /// (dan tetap dibuang).
    pub fn take(&self, token: &str, owner: &str, now: OffsetDateTime) -> AppResult<String> {
        let entry = self
            .entries()
            .remove(&token_key(token))
            .ok_or_else(expired)?;
        if entry.owner != owner || now >= entry.expires {
            return Err(expired());
        }
        Ok(entry.issued_at)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "aa";
    const OTHER: &str = "bb";

    fn at(secs: i64) -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(1_795_000_000 + secs).unwrap()
    }

    #[test]
    fn token_is_single_use_and_returns_issue_time() {
        let s = SignSessions::default();
        let (token, issued) = s.issue(ME, at(0));
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(issued, clock::format_rfc3339(at(0)));
        assert_eq!(s.take(&token, ME, at(10)).unwrap(), issued);
        assert_eq!(
            s.take(&token, ME, at(11)).unwrap_err().code(),
            "session_expired"
        );
    }

    #[test]
    fn tokens_differ() {
        let s = SignSessions::default();
        let (a, _) = s.issue(ME, at(0));
        let (b, _) = s.issue(ME, at(0));
        assert_ne!(a, b);
    }

    #[test]
    fn expired_token_is_refused() {
        let s = SignSessions::default();
        let (token, _) = s.issue(ME, at(0));
        assert_eq!(
            s.take(&token, ME, at(5 * 60)).unwrap_err().code(),
            "session_expired"
        );
        let (token, _) = s.issue(ME, at(0));
        assert!(s.take(&token, ME, at(5 * 60 - 1)).is_ok());
    }

    #[test]
    fn foreign_owner_and_unknown_token_are_refused() {
        let s = SignSessions::default();
        let (token, _) = s.issue(ME, at(0));
        assert_eq!(
            s.take(&token, OTHER, at(1)).unwrap_err().code(),
            "session_expired"
        );
        // Sudah dibuang pada percobaan pertama.
        assert!(s.take(&token, ME, at(2)).is_err());
        assert!(s.take("", ME, at(2)).is_err());
        assert!(s.take(&"0".repeat(64), ME, at(2)).is_err());
    }

    #[test]
    fn clones_share_tokens() {
        let s = SignSessions::default();
        let c = s.clone();
        let (token, _) = s.issue(ME, at(0));
        assert!(c.take(&token, ME, at(1)).is_ok());
        assert!(s.take(&token, ME, at(1)).is_err());
    }

    #[test]
    fn issue_drops_expired_entries() {
        let s = SignSessions::default();
        s.issue(ME, at(0));
        s.issue(ME, at(1));
        assert_eq!(s.len(), 2);
        s.issue(ME, at(10 * 60));
        assert_eq!(s.len(), 1);
    }

    #[test]
    fn message_has_no_em_dash() {
        assert!(!expired().to_string().contains('\u{2014}'));
    }
}
