//! Storage for the laptop's 32-byte Ed25519 secret key.
//!
//! Production uses `KeyringStore`; tests use `MemoryKeyStore`.
//!
//! On Windows `KeyringStore` talks to the Credential Manager API directly
//! (`CredWriteW`/`CredReadW`/`CredDeleteW`) so it can store the key with
//! `CRED_PERSIST_LOCAL_MACHINE`: the key stays on this laptop and never roams
//! with a roaming profile. Tahap 0 used the `keyring` crate (3.x), which writes
//! `CRED_PERSIST_ENTERPRISE`. Entries keep keyring's layout so those old
//! entries are still found:
//! - type `CRED_TYPE_GENERIC`, target name `<account>.<service>`
//!   (e.g. `device-key-<pk>.id.mira.desktop`), user name `<account>`;
//! - the blob is the raw 32 secret bytes (keyring's `set_secret`, no encoding).
//!
//! An entry read with any other persist mode is rewritten with
//! `CRED_PERSIST_LOCAL_MACHINE` (same bytes and fields); if that rewrite fails
//! the key is still returned. Other platforms keep using `keyring`.

use std::collections::HashMap;
use std::sync::Mutex;

use zeroize::Zeroizing;

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

    /// Credential target name, identical to what `keyring` 3 builds for
    /// `Entry::new(service, account)` on Windows.
    #[cfg_attr(not(windows), allow(dead_code))]
    fn target_name(&self, account: &str) -> String {
        format!("{account}.{}", self.service)
    }
}

impl Default for KeyringStore {
    fn default() -> Self {
        Self::new()
    }
}

fn bad_length_error() -> AppError {
    AppError::KeyMismatch(
        "Kunci laptop di Windows Credential Manager rusak (panjangnya tidak sesuai).".into(),
    )
}

fn store_error(detail: impl std::fmt::Display) -> AppError {
    AppError::Keystore(format!(
        "Windows Credential Manager tidak bisa diakses untuk menyimpan atau membaca kunci laptop. Detail: {detail}"
    ))
}

#[cfg(windows)]
impl KeyStore for KeyringStore {
    fn get(&self, account: &str) -> AppResult<Option<SecretKey>> {
        let target = self.target_name(account);
        let Some(stored) = wincred::read(&target, true).map_err(win_error)? else {
            return Ok(None);
        };
        if let Some(code) = stored.upgrade_error {
            // The key is still usable; only the persist mode stays as it was.
            eprintln!(
                "Mira: kunci laptop tidak bisa dipindah ke penyimpanan lokal (kode Windows {code})."
            );
        }
        <[u8; 32]>::try_from(stored.blob.as_slice())
            .map(|secret| Some(Zeroizing::new(secret)))
            .map_err(|_| bad_length_error())
    }

    fn set(&self, account: &str, secret: &[u8; 32]) -> AppResult<()> {
        wincred::write(&self.target_name(account), account, secret).map_err(win_error)
    }

    fn delete(&self, account: &str) -> AppResult<()> {
        wincred::delete(&self.target_name(account)).map_err(win_error)
    }
}

#[cfg(windows)]
fn win_error(err: wincred::Error) -> AppError {
    match err {
        wincred::Error::InvalidName => store_error("nama entri tidak valid"),
        wincred::Error::Os(code) => store_error(format_args!("kode Windows {code}")),
    }
}

#[cfg(not(windows))]
impl KeyringStore {
    fn entry(&self, account: &str) -> AppResult<keyring::Entry> {
        keyring::Entry::new(&self.service, account).map_err(store_error)
    }
}

#[cfg(not(windows))]
impl KeyStore for KeyringStore {
    fn get(&self, account: &str) -> AppResult<Option<SecretKey>> {
        use zeroize::Zeroize;
        match self.entry(account)?.get_secret() {
            Ok(mut bytes) => {
                let result = <[u8; 32]>::try_from(bytes.as_slice())
                    .map(Zeroizing::new)
                    .map_err(|_| bad_length_error());
                bytes.zeroize();
                result.map(Some)
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(store_error(e)),
        }
    }

    fn set(&self, account: &str, secret: &[u8; 32]) -> AppResult<()> {
        self.entry(account)?.set_secret(secret).map_err(store_error)
    }

    fn delete(&self, account: &str) -> AppResult<()> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(store_error(e)),
        }
    }
}

/// Minimal safe wrapper over the Credential Manager API (generic credentials).
#[cfg(windows)]
mod wincred {
    use windows_sys::Win32::Foundation::{ERROR_NOT_FOUND, GetLastError};
    use windows_sys::Win32::Security::Credentials::{
        CRED_FLAGS_VALID_INPUT_FLAGS, CRED_PERSIST, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
        CREDENTIALW, CredDeleteW, CredFree, CredReadW, CredWriteW,
    };
    use zeroize::{Zeroize, Zeroizing};

    /// Comment on entries Mira writes (keyring wrote `keyring v<version>`;
    /// the comment is not used for lookup).
    const COMMENT: &str = "Mira";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Error {
        /// Target or user name contains NUL.
        InvalidName,
        /// `GetLastError` code.
        Os(u32),
    }

    pub struct Stored {
        pub blob: Zeroizing<Vec<u8>>,
        /// Persist mode as read (before any upgrade).
        #[cfg_attr(not(test), allow(dead_code))]
        pub persist: CRED_PERSIST,
        #[cfg_attr(not(test), allow(dead_code))]
        pub user_name: String,
        /// Set when an upgrade to `CRED_PERSIST_LOCAL_MACHINE` was needed and failed.
        pub upgrade_error: Option<u32>,
    }

    fn wide(s: &str) -> Result<Vec<u16>, Error> {
        if s.contains('\0') {
            return Err(Error::InvalidName);
        }
        Ok(s.encode_utf16().chain(std::iter::once(0)).collect())
    }

    fn last_error() -> u32 {
        // SAFETY: plain FFI call without arguments.
        unsafe { GetLastError() }
    }

    /// Owns a buffer returned by `CredReadW`; wipes the secret and frees it.
    struct CredBuf(*mut CREDENTIALW);

    impl CredBuf {
        fn cred(&self) -> &CREDENTIALW {
            // SAFETY: `CredReadW` succeeded, so the pointer is a valid
            // CREDENTIALW that lives until `CredFree` in `drop`.
            unsafe { &*self.0 }
        }

        fn blob(&self) -> &[u8] {
            let cred = self.cred();
            if cred.CredentialBlob.is_null() || cred.CredentialBlobSize == 0 {
                return &[];
            }
            // SAFETY: the API guarantees `CredentialBlobSize` bytes at
            // `CredentialBlob`, owned by this buffer.
            unsafe {
                std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize)
            }
        }
    }

    impl Drop for CredBuf {
        fn drop(&mut self) {
            let cred = self.cred();
            if !cred.CredentialBlob.is_null() && cred.CredentialBlobSize > 0 {
                // SAFETY: same region as `blob()`, writable memory owned by
                // this buffer, no other reference alive during drop.
                unsafe {
                    std::slice::from_raw_parts_mut(
                        cred.CredentialBlob,
                        cred.CredentialBlobSize as usize,
                    )
                    .zeroize();
                }
            }
            // SAFETY: the pointer came from `CredReadW` and is freed once.
            unsafe { CredFree(self.0 as *const _) };
        }
    }

    /// Reads a generic credential. `Ok(None)` when it does not exist. With
    /// `upgrade`, an entry whose persist mode is not LOCAL_MACHINE is written
    /// back with LOCAL_MACHINE; a failure there is reported in `upgrade_error`.
    pub fn read(target: &str, upgrade: bool) -> Result<Option<Stored>, Error> {
        let target_w = wide(target)?;
        let mut ptr: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `target_w` is NUL-terminated; `ptr` receives a buffer that
        // `CredBuf` frees.
        let ok = unsafe { CredReadW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0, &mut ptr) };
        if ok == 0 {
            let code = last_error();
            return if code == ERROR_NOT_FOUND {
                Ok(None)
            } else {
                Err(Error::Os(code))
            };
        }
        if ptr.is_null() {
            return Err(Error::Os(0));
        }
        let buf = CredBuf(ptr);
        let cred = buf.cred();
        let persist = cred.Persist;
        let mut upgrade_error = None;
        if upgrade && persist != CRED_PERSIST_LOCAL_MACHINE {
            // Write the same credential back (same target, user, comment,
            // alias, attributes and blob, all still owned by `buf`).
            let mut copy = *cred;
            copy.Persist = CRED_PERSIST_LOCAL_MACHINE;
            copy.Flags &= CRED_FLAGS_VALID_INPUT_FLAGS;
            // SAFETY: every pointer in `copy` points into `buf`, alive here.
            if unsafe { CredWriteW(&copy, 0) } == 0 {
                upgrade_error = Some(last_error());
            }
        }
        let user_name = if cred.UserName.is_null() {
            String::new()
        } else {
            // SAFETY: NUL-terminated UTF-16 string owned by `buf`.
            let len = (0..)
                .take_while(|&i| unsafe { *cred.UserName.add(i) } != 0)
                .count();
            // SAFETY: `len` u16 values were just read above.
            String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(cred.UserName, len) })
        };
        Ok(Some(Stored {
            blob: Zeroizing::new(buf.blob().to_vec()),
            persist,
            user_name,
            upgrade_error,
        }))
    }

    /// Creates or replaces a generic credential with LOCAL_MACHINE persistence.
    pub fn write(target: &str, user_name: &str, secret: &[u8]) -> Result<(), Error> {
        let mut target_w = wide(target)?;
        let mut user_w = wide(user_name)?;
        let mut comment_w = wide(COMMENT)?;
        let mut blob = Zeroizing::new(secret.to_vec());
        let cred = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target_w.as_mut_ptr(),
            Comment: comment_w.as_mut_ptr(),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: user_w.as_mut_ptr(),
            ..Default::default()
        };
        // SAFETY: all pointers refer to buffers alive until the end of scope.
        let ok = unsafe { CredWriteW(&cred, 0) };
        if ok == 0 {
            Err(Error::Os(last_error()))
        } else {
            Ok(())
        }
    }

    /// Deletes a generic credential; a missing one is not an error.
    pub fn delete(target: &str) -> Result<(), Error> {
        let target_w = wide(target)?;
        // SAFETY: `target_w` is NUL-terminated.
        let ok = unsafe { CredDeleteW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok == 0 {
            let code = last_error();
            if code != ERROR_NOT_FOUND {
                return Err(Error::Os(code));
            }
        }
        Ok(())
    }
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

    const TEST_SERVICE: &str = "id.mira.desktop.test";

    fn roundtrip(store: &dyn KeyStore, account: &str) {
        assert!(store.get(account).unwrap().is_none());
        let secret = [7u8; 32];
        store.set(account, &secret).unwrap();
        assert_eq!(*store.get(account).unwrap().unwrap(), secret);
        let other = [9u8; 32];
        store.set(account, &other).unwrap();
        assert_eq!(*store.get(account).unwrap().unwrap(), other);
        store.delete(account).unwrap();
        assert!(store.get(account).unwrap().is_none());
        store.delete(account).unwrap();
    }

    fn throwaway_account() -> String {
        let mut nonce = [0u8; 8];
        rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut nonce);
        format!("test-{}", hex::encode(nonce))
    }

    #[test]
    fn memory_store_roundtrip() {
        roundtrip(&MemoryKeyStore::new(), "device-key-test");
    }

    /// The target name must match what `keyring` 3 used in Tahap 0, or
    /// existing keys would not be found. Building an `Entry` does not touch
    /// the credential store.
    #[cfg(windows)]
    #[test]
    fn target_name_matches_keyring() {
        let account = format!("device-key-{}", "ab".repeat(32));
        let entry = keyring::Entry::new(KEYRING_SERVICE, &account).unwrap();
        let cred = entry
            .get_credential()
            .downcast_ref::<keyring::windows::WinCredential>()
            .unwrap();
        assert_eq!(cred.target_name, KeyringStore::new().target_name(&account));
        assert_eq!(cred.username, account);
        assert_eq!(
            KeyringStore::new().target_name("device-key-x"),
            "device-key-x.id.mira.desktop"
        );
    }

    /// Deletes the throwaway entry even when an assertion fails.
    struct Cleanup<'a>(&'a KeyringStore, &'a str);

    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            let _ = self.0.delete(self.1);
        }
    }

    /// Touches the real Windows Credential Manager with a throwaway entry.
    /// Run with `cargo test -- --ignored keystore`.
    #[test]
    #[ignore = "uses the real OS credential store"]
    fn keyring_store_roundtrip() {
        let store = KeyringStore::with_service(TEST_SERVICE);
        let account = throwaway_account();
        let _cleanup = Cleanup(&store, &account);
        roundtrip(&store, &account);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "uses the real OS credential store"]
    fn keyring_store_writes_local_machine() {
        use windows_sys::Win32::Security::Credentials::CRED_PERSIST_LOCAL_MACHINE;

        let store = KeyringStore::with_service(TEST_SERVICE);
        let account = throwaway_account();
        let _cleanup = Cleanup(&store, &account);
        store.set(&account, &[3u8; 32]).unwrap();
        let stored = wincred::read(&store.target_name(&account), false)
            .unwrap()
            .unwrap();
        assert_eq!(stored.persist, CRED_PERSIST_LOCAL_MACHINE);
        assert_eq!(stored.user_name, account);
        assert_eq!(stored.blob.as_slice(), &[3u8; 32]);
    }

    /// A Tahap 0 entry (written by `keyring`, persist ENTERPRISE) is found,
    /// returns the same bytes, and is rewritten with LOCAL_MACHINE.
    #[cfg(windows)]
    #[test]
    #[ignore = "uses the real OS credential store"]
    fn keyring_store_upgrades_enterprise_entry() {
        use windows_sys::Win32::Security::Credentials::{
            CRED_PERSIST_ENTERPRISE, CRED_PERSIST_LOCAL_MACHINE,
        };

        let store = KeyringStore::with_service(TEST_SERVICE);
        let account = throwaway_account();
        let _cleanup = Cleanup(&store, &account);
        let secret: [u8; 32] = std::array::from_fn(|i| i as u8);
        keyring::Entry::new(TEST_SERVICE, &account)
            .unwrap()
            .set_secret(&secret)
            .unwrap();

        let target = store.target_name(&account);
        let before = wincred::read(&target, false).unwrap().unwrap();
        assert_eq!(
            before.persist, CRED_PERSIST_ENTERPRISE,
            "keyring 3 behaviour"
        );

        assert_eq!(*store.get(&account).unwrap().unwrap(), secret);

        let after = wincred::read(&target, false).unwrap().unwrap();
        assert_eq!(after.persist, CRED_PERSIST_LOCAL_MACHINE);
        assert_eq!(after.blob.as_slice(), &secret);
        assert_eq!(after.user_name, account);
        // keyring can still read it (same layout).
        assert_eq!(
            keyring::Entry::new(TEST_SERVICE, &account)
                .unwrap()
                .get_secret()
                .unwrap(),
            secret
        );

        store.delete(&account).unwrap();
        assert!(wincred::read(&target, false).unwrap().is_none());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "uses the real OS credential store"]
    fn keyring_store_rejects_wrong_length() {
        let store = KeyringStore::with_service(TEST_SERVICE);
        let account = throwaway_account();
        let _cleanup = Cleanup(&store, &account);
        wincred::write(&store.target_name(&account), &account, &[1u8; 31]).unwrap();
        assert_eq!(store.get(&account).unwrap_err().code(), "key_mismatch");
    }

    #[cfg(windows)]
    #[test]
    fn names_with_nul_are_rejected() {
        let store = KeyringStore::with_service(TEST_SERVICE);
        assert_eq!(store.get("a\0b").unwrap_err().code(), "keystore");
        assert_eq!(
            store.set("a\0b", &[0u8; 32]).unwrap_err().code(),
            "keystore"
        );
        assert_eq!(store.delete("a\0b").unwrap_err().code(), "keystore");
    }
}
