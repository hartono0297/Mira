//! Storage for the laptop's 32-byte Ed25519 secret key.
//!
//! Production uses the Windows Credential Manager through `keyring`
//! (`KeyringStore`); tests use `MemoryKeyStore`.

use std::collections::HashMap;
use std::sync::Mutex;

use zeroize::{Zeroize, Zeroizing};

use crate::error::{AppError, AppResult};

pub type SecretKey = Zeroizing<[u8; 32]>;

pub trait KeyStore: Send + Sync {
    /// `Ok(None)` when no secret is stored for `account`.
    fn get(&self, account: &str) -> AppResult<Option<SecretKey>>;
    fn set(&self, account: &str, secret: &[u8; 32]) -> AppResult<()>;
    /// Deleting a missing account is not an error.
    fn delete(&self, account: &str) -> AppResult<()>;
}

pub const KEYRING_SERVICE: &str = "id.mira.desktop";

/// Secrets in the OS credential store (Windows Credential Manager).
pub struct KeyringStore {
    service: String,
}

impl KeyringStore {
    pub fn new() -> Self {
        Self::with_service(KEYRING_SERVICE)
    }

    pub fn with_service(service: &str) -> Self {
        Self {
            service: service.to_owned(),
        }
    }

    fn entry(&self, account: &str) -> AppResult<keyring::Entry> {
        keyring::Entry::new(&self.service, account).map_err(keystore_error)
    }
}

impl Default for KeyringStore {
    fn default() -> Self {
        Self::new()
    }
}

impl KeyStore for KeyringStore {
    fn get(&self, account: &str) -> AppResult<Option<SecretKey>> {
        match self.entry(account)?.get_secret() {
            Ok(mut bytes) => {
                let result = <[u8; 32]>::try_from(bytes.as_slice())
                    .map(Zeroizing::new)
                    .map_err(|_| {
                        AppError::KeyMismatch(
                            "Kunci laptop di Windows Credential Manager rusak (panjangnya tidak sesuai)."
                                .into(),
                        )
                    });
                bytes.zeroize();
                result.map(Some)
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keystore_error(e)),
        }
    }

    fn set(&self, account: &str, secret: &[u8; 32]) -> AppResult<()> {
        self.entry(account)?
            .set_secret(secret)
            .map_err(keystore_error)
    }

    fn delete(&self, account: &str) -> AppResult<()> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keystore_error(e)),
        }
    }
}

fn keystore_error(err: keyring::Error) -> AppError {
    AppError::Keystore(format!(
        "Windows Credential Manager tidak bisa diakses untuk menyimpan atau membaca kunci laptop. Detail: {err}"
    ))
}

/// In-memory secrets for tests and tools. Shared by reference so a test can
/// "restart" the app against the same store.
#[derive(Default)]
pub struct MemoryKeyStore {
    secrets: Mutex<HashMap<String, SecretKey>>,
}

impl MemoryKeyStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, HashMap<String, SecretKey>>> {
        self.secrets
            .lock()
            .map_err(|_| AppError::Internal("Penyimpanan kunci uji rusak.".into()))
    }
}

impl KeyStore for MemoryKeyStore {
    fn get(&self, account: &str) -> AppResult<Option<SecretKey>> {
        Ok(self.lock()?.get(account).cloned())
    }

    fn set(&self, account: &str, secret: &[u8; 32]) -> AppResult<()> {
        self.lock()?
            .insert(account.to_owned(), Zeroizing::new(*secret));
        Ok(())
    }

    fn delete(&self, account: &str) -> AppResult<()> {
        self.lock()?.remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(store: &dyn KeyStore, account: &str) {
        assert!(store.get(account).unwrap().is_none());
        let secret = [7u8; 32];
        store.set(account, &secret).unwrap();
        assert_eq!(*store.get(account).unwrap().unwrap(), secret);
        store.delete(account).unwrap();
        assert!(store.get(account).unwrap().is_none());
        store.delete(account).unwrap();
    }

    #[test]
    fn memory_store_roundtrip() {
        roundtrip(&MemoryKeyStore::new(), "device-key-test");
    }

    /// Touches the real Windows Credential Manager. Run with
    /// `cargo test -- --ignored keyring_store_roundtrip`.
    #[test]
    #[ignore = "uses the real OS credential store"]
    fn keyring_store_roundtrip() {
        let mut nonce = [0u8; 8];
        rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut nonce);
        let account = format!("test-{}", hex::encode(nonce));
        roundtrip(
            &KeyringStore::with_service("id.mira.desktop.test"),
            &account,
        );
    }
}
