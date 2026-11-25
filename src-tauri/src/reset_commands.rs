//! 0.5.1: "Reset dan mulai dari awal" for a laptop removed for good
//! (docs/plans/perbaikan-bergabung.md, decision 7).
//!
//! What is open while Mira runs, and how the reset deals with it:
//! - `mira.db`: the only connection is the one in `MiraState`'s core
//!   (nothing else calls `db::open`). `MiraState::reset_with` closes it under
//!   the core lock, so every other command, background task (deadline
//!   reminders, document and chat sync, recovery) and feature runtime waits
//!   and then works on the new database.
//! - The network (`AppNet`) holds a copy of the old secret key for TLS and
//!   writes to the database for peers: stopped before the reset, and again
//!   after it in case a command restarted it meanwhile, then started with
//!   the new key.
//! - Folders: the document watcher may keep a handle on `working/<id>` and
//!   Office may hold a working copy open. Those folders are deleted in place
//!   when they cannot be moved; what still cannot be deleted is only logged
//!   (old content-addressed or per-document files, harmless to the new
//!   identity).
//! - In-memory state that is not reset here (other owners): `JoinClient`
//!   (offices found on the LAN, tracked request), `OrgAdCache`,
//!   `SignSessions` (PIN tokens, which expire), `DocumentsRuntime`'s cached
//!   environment (paths only), `UpdaterState`. None of it holds old
//!   organization rights; it refers to rows that no longer exist.

use tauri::{AppHandle, Emitter, State};

use crate::commands::{self, AppState};
use crate::error::{AppError, AppResult};
use crate::net_backend::{AppNet, EVENT_DIRECTORY, EVENT_NETWORK};
use crate::permissions::{self, MemberStatus};
use crate::state::{Core, MiraState, ResetOutcome};
use crate::{ui_lang, window_theme};

/// Settings kept by a reset: display language and theme (mode and name,
/// `src/theme/mode.ts`). Everything else belongs to the old organization.
pub const KEPT_SETTINGS: &[&str] = &[
    ui_lang::SETTING_LANGUAGE,
    window_theme::MODE_SETTING_KEY,
    "theme.name",
];

fn not_removed() -> AppError {
    AppError::Forbidden("Reset hanya bisa untuk laptop yang dikeluarkan permanen.".into())
}

/// Refuses unless this laptop's member was removed for good: its status in
/// the fold is exactly `removed`. `Membership::Removed` alone is not enough,
/// since it also covers a laptop that holds an organization it was never
/// admitted to.
pub fn check_removed(core: &Core) -> AppResult<()> {
    let state = permissions::load_state(&core.db)?;
    let removed = state
        .as_ref()
        .and_then(|s| s.member(core.identity.public_key_hex()))
        .is_some_and(|m| m.status == MemberStatus::Removed);
    if removed { Ok(()) } else { Err(not_removed()) }
}

/// The reset itself, without Tauri: see `MiraState::reset_with`.
pub fn reset_laptop(state: &MiraState) -> AppResult<ResetOutcome> {
    state.reset_with(check_removed, KEPT_SETTINGS)
}

/// Deletes this laptop's organization data and key, makes a new key, and
/// returns the new app state (onboarding). Only when this laptop was
/// removed for good.
#[tauri::command]
pub async fn reset_removed_laptop(
    state: State<'_, MiraState>,
    net: State<'_, AppNet>,
    app: AppHandle,
) -> AppResult<AppState> {
    // Refuse before stopping anything.
    state.with_core(|core| check_removed(core))?;
    net.shutdown().await;
    let st = state.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || reset_laptop(&st))
        .await
        .map_err(|e| AppError::Internal(format!("Reset tidak selesai. Detail: {e}")))
        .and_then(|r| r);
    // A command may have started the network again with the old key while
    // the reset waited for the core lock.
    net.shutdown().await;
    // The old UDP socket can take a moment to be released (a fixed
    // `MIRA_PORT` then fails with "address in use"): retry for a few seconds.
    for attempt in 0..10 {
        match net.get(&state, &app).await {
            Ok(_) => break,
            Err(err) if attempt == 9 => eprintln!(
                "Mira: jaringan belum berjalan setelah reset [{}]: {err}",
                err.code()
            ),
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(500)).await,
        }
    }
    let _ = app.emit(EVENT_DIRECTORY, ());
    let _ = app.emit(EVENT_NETWORK, ());
    let outcome = result?;
    if !outcome.leftovers.is_empty() {
        eprintln!(
            "Mira: reset selesai, {} folder lama belum terhapus seluruhnya",
            outcome.leftovers.len()
        );
    }
    commands::app_state(&state)
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Arc;

    use rusqlite::Connection;
    use time::OffsetDateTime;

    use super::*;
    use crate::identity::{self, Identity, KeyStore, MemoryKeyStore, SecretKey, keystore_account};
    use crate::permissions::{self as p, InviteRole, Membership, PeerAuthState, Validity};
    use crate::{db, org, paths, settings};

    /// Forwards to a shared `MemoryKeyStore` so the test can look inside;
    /// `fail_delete` makes `delete` fail like a locked Credential Manager.
    struct Shared {
        store: Arc<MemoryKeyStore>,
        fail_delete: bool,
    }

    impl KeyStore for Shared {
        fn get(&self, a: &str) -> AppResult<Option<SecretKey>> {
            self.store.get(a)
        }
        fn set(&self, a: &str, s: &[u8; 32]) -> AppResult<()> {
            self.store.set(a, s)
        }
        fn delete(&self, a: &str) -> AppResult<()> {
            if self.fail_delete {
                return Err(AppError::Keystore("uji: tidak bisa dihapus".into()));
            }
            self.store.delete(a)
        }
    }

    struct Laptop {
        tmp: tempfile::TempDir,
        store: Arc<MemoryKeyStore>,
        state: MiraState,
    }

    impl Laptop {
        fn new(fail_delete: bool) -> Laptop {
            let tmp = tempfile::tempdir().unwrap();
            let store = Arc::new(MemoryKeyStore::new());
            let state = Self::open(tmp.path(), &store, fail_delete);
            Laptop { tmp, store, state }
        }

        fn open(dir: &Path, store: &Arc<MemoryKeyStore>, fail_delete: bool) -> MiraState {
            MiraState::new(
                Ok(dir.to_path_buf()),
                Box::new(Shared {
                    store: store.clone(),
                    fail_delete,
                }),
            )
        }

        fn dir(&self) -> &Path {
            self.tmp.path()
        }

        fn pk(&self) -> String {
            self.state
                .with_core(|c| Ok(c.identity.public_key_hex().to_owned()))
                .unwrap()
        }

        fn has_key(&self, pk: &str) -> bool {
            self.store.get(&keystore_account(pk)).unwrap().is_some()
        }

        fn membership(&self) -> Membership {
            self.state
                .with_core(|c| p::membership(&c.db, &c.identity))
                .unwrap()
        }

        fn setting(&self, key: &str) -> Option<String> {
            self.state.with_core(|c| settings::get(&c.db, key)).unwrap()
        }
    }

    fn now() -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }

    /// Founder laptop with its own temp folder and keystore.
    struct Founder {
        _tmp: tempfile::TempDir,
        conn: Connection,
        id: Identity,
        team: String,
    }

    fn founder() -> Founder {
        let tmp = tempfile::tempdir().unwrap();
        let mut conn = db::open(tmp.path()).unwrap();
        let mut id = identity::ensure_identity(&conn, &MemoryKeyStore::new()).unwrap();
        identity::save_display_name(&mut conn, &mut id, "Sari").unwrap();
        org::create_organization(&mut conn, &id, "CV Maju Jaya").unwrap();
        let team = p::create_team(&mut conn, &id, "Tim Desain", now())
            .unwrap()
            .id;
        Founder {
            _tmp: tmp,
            conn,
            id,
            team,
        }
    }

    /// The laptop joins the founder's organization with an invite code.
    fn join(f: &mut Founder, laptop: &Laptop) {
        let (_, code) = p::create_invite(
            &mut f.conn,
            &f.id,
            &f.team,
            InviteRole::Member,
            vec![],
            Validity::Once,
            now(),
        )
        .unwrap();
        let code = p::normalize_code(&code).unwrap();
        let (org, invite) = p::join_lookup(&f.conn, code.tag(), now())
            .map_err(|c| c.to_app_error())
            .unwrap();
        laptop
            .state
            .with_core(|c| {
                identity::save_display_name(&mut c.db, &mut c.identity, "Ani")?;
                let proof = p::build_join_proof(&code, &org, &invite, &c.identity)?;
                let accepted = p::join_accept(
                    &mut f.conn,
                    &f.id,
                    c.identity.public_key_hex(),
                    &invite,
                    &proof,
                    now(),
                )
                .map_err(|c| c.to_app_error())?;
                p::install_joined_org(
                    &mut c.db,
                    &c.identity,
                    accepted.org,
                    accepted.ops,
                    &code,
                    now(),
                )
            })
            .unwrap();
    }

    /// The founder removes the laptop for good and the laptop learns of it.
    fn remove(f: &mut Founder, laptop: &Laptop) {
        let pk = laptop.pk();
        p::remove_member(&mut f.conn, &f.id, &pk, now()).unwrap();
        let state = p::load_state(&f.conn).unwrap().unwrap();
        let PeerAuthState::Removed { removal_op } = p::peer_auth(&state, &pk) else {
            panic!("expected removed");
        };
        let op = p::load_op(&f.conn, removal_op.as_deref().unwrap())
            .unwrap()
            .unwrap();
        laptop
            .state
            .with_core(|c| p::ingest(&mut c.db, Some(f.id.public_key_hex()), vec![op], now()))
            .unwrap();
    }

    /// Organization files in every known Mira folder, plus files that are
    /// not Mira's.
    fn write_files(dir: &Path) {
        for folder in paths::ORG_FOLDERS {
            let sub = dir.join(folder).join("ab");
            std::fs::create_dir_all(&sub).unwrap();
            std::fs::write(sub.join("berkas"), b"data organisasi").unwrap();
        }
        std::fs::write(dir.join("catatan-pribadi.txt"), b"bukan milik Mira").unwrap();
        std::fs::create_dir_all(dir.join("webview")).unwrap();
        std::fs::write(dir.join("webview").join("Local State"), b"{}").unwrap();
    }

    fn set_preferences(laptop: &Laptop) {
        laptop
            .state
            .with_core(|c| {
                settings::set(&c.db, ui_lang::SETTING_LANGUAGE, "en")?;
                settings::set(&c.db, window_theme::MODE_SETTING_KEY, "dark")?;
                settings::set(&c.db, "theme.name", "bata")?;
                settings::set(&c.db, "board.reminder.day_before", "off")?;
                settings::set(&c.db, "join.addresses", "[\"10.0.0.5:47800\"]")
            })
            .unwrap();
    }

    fn removed_laptop(fail_delete: bool) -> Laptop {
        let mut f = founder();
        let laptop = Laptop::new(fail_delete);
        join(&mut f, &laptop);
        assert_eq!(laptop.membership(), Membership::Active);
        remove(&mut f, &laptop);
        assert_eq!(laptop.membership(), Membership::Removed);
        set_preferences(&laptop);
        write_files(laptop.dir());
        laptop
    }

    fn trash_dirs(dir: &Path) -> usize {
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(paths::RESET_TRASH_PREFIX)
            })
            .count()
    }

    /// Nothing changed: same key in the store, same files, still removed.
    fn assert_untouched(laptop: &Laptop, pk: &str) {
        assert!(laptop.has_key(pk));
        for folder in paths::ORG_FOLDERS {
            assert!(
                laptop.dir().join(folder).join("ab").join("berkas").exists(),
                "{folder}"
            );
        }
        assert_eq!(trash_dirs(laptop.dir()), 0);
        assert_eq!(laptop.pk(), pk);
        assert_eq!(laptop.membership(), Membership::Removed);
        assert!(laptop.setting("join.addresses").is_some());
    }

    #[test]
    fn refused_without_organization() {
        let laptop = Laptop::new(false);
        let pk = laptop.pk();
        write_files(laptop.dir());
        let err = reset_laptop(&laptop.state).unwrap_err();
        assert_eq!(err.code(), "forbidden");
        assert_eq!(
            err.to_string(),
            "Reset hanya bisa untuk laptop yang dikeluarkan permanen."
        );
        assert!(laptop.has_key(&pk));
        assert_eq!(laptop.pk(), pk);
        assert!(
            laptop
                .dir()
                .join("blobs")
                .join("ab")
                .join("berkas")
                .exists()
        );
    }

    #[test]
    fn refused_for_active_member() {
        let mut f = founder();
        let laptop = Laptop::new(false);
        join(&mut f, &laptop);
        let pk = laptop.pk();
        write_files(laptop.dir());
        let err = reset_laptop(&laptop.state).unwrap_err();
        assert_eq!(err.code(), "forbidden");
        assert!(laptop.has_key(&pk));
        assert_eq!(laptop.membership(), Membership::Active);
        assert!(
            laptop
                .dir()
                .join("working")
                .join("ab")
                .join("berkas")
                .exists()
        );
    }

    /// A laptop that holds an organization record it was never admitted to
    /// reads as `Membership::Removed`, but the reset needs the fold status
    /// `removed`.
    #[test]
    fn refused_for_a_laptop_never_admitted() {
        let f = founder();
        let laptop = Laptop::new(false);
        let org = org::load_organization(&f.conn).unwrap().unwrap();
        laptop
            .state
            .with_core(|c| {
                c.db.execute(
                    "INSERT INTO organizations (id, name, founder_public_key, created_at, genesis_signature)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![
                        org.id,
                        org.name,
                        org.founder_public_key,
                        org.created_at,
                        org.genesis_signature
                    ],
                )?;
                Ok(())
            })
            .unwrap();
        assert_eq!(laptop.membership(), Membership::Removed);
        let pk = laptop.pk();
        write_files(laptop.dir());
        let err = reset_laptop(&laptop.state).unwrap_err();
        assert_eq!(err.code(), "forbidden");
        assert!(laptop.has_key(&pk));
        assert_eq!(laptop.pk(), pk);
        assert!(laptop.dir().join("blobs").join("ab").join("berkas").exists());
    }

    /// Sends the founder every op the laptop has that the founder may get.
    fn laptop_to_founder(f: &mut Founder, laptop: &Laptop) {
        let to = f.id.public_key_hex().to_owned();
        let ids = laptop
            .state
            .with_core(|c| {
                let s = p::load_state(&c.db)?.unwrap();
                p::op_ids_for(&c.db, &s, &to)
            })
            .unwrap();
        let missing = p::missing_op_ids(&f.conn, &ids).unwrap();
        let ops = laptop
            .state
            .with_core(|c| {
                let s = p::load_state(&c.db)?.unwrap();
                p::ops_for(&c.db, &s, &to, &missing)
            })
            .unwrap();
        p::ingest(&mut f.conn, Some(&laptop.pk()), ops, now()).unwrap();
    }

    /// Sends the laptop every op of the founder's it may get.
    fn founder_to_laptop(f: &Founder, laptop: &Laptop) {
        let to = laptop.pk();
        let s = p::load_state(&f.conn).unwrap().unwrap();
        let ids = p::op_ids_for(&f.conn, &s, &to).unwrap();
        let from = f.id.public_key_hex().to_owned();
        laptop
            .state
            .with_core(|c| {
                let missing = p::missing_op_ids(&c.db, &ids)?;
                let ops = p::ops_for(&f.conn, &s, &to, &missing)?;
                p::ingest(&mut c.db, Some(&from), ops, now())
            })
            .unwrap();
    }

    #[test]
    fn refused_for_suspended_member() {
        let mut f = founder();
        let laptop = Laptop::new(false);
        join(&mut f, &laptop);
        // Both laptops report this build's version, so the suspend gate opens.
        let device = crate::device::current();
        p::ensure_device_op(&mut f.conn, &f.id, &device, now()).unwrap();
        laptop
            .state
            .with_core(|c| p::ensure_device_op(&mut c.db, &c.identity, &device, now()))
            .unwrap();
        laptop_to_founder(&mut f, &laptop);
        p::suspend_member(&mut f.conn, &f.id, &laptop.pk(), now()).unwrap();
        founder_to_laptop(&f, &laptop);
        assert_eq!(laptop.membership(), Membership::Suspended);

        let pk = laptop.pk();
        write_files(laptop.dir());
        let err = reset_laptop(&laptop.state).unwrap_err();
        assert_eq!(err.code(), "forbidden");
        assert!(laptop.has_key(&pk));
        assert_eq!(laptop.membership(), Membership::Suspended);
        assert!(
            laptop
                .dir()
                .join("blobs")
                .join("ab")
                .join("berkas")
                .exists()
        );
    }

    #[test]
    fn removed_laptop_starts_over_with_a_new_key() {
        let laptop = removed_laptop(false);
        let old = laptop.pk();

        let outcome = reset_laptop(&laptop.state).unwrap();
        assert_eq!(outcome.old_public_key, old);
        assert_ne!(outcome.new_public_key, old);
        assert!(outcome.leftovers.is_empty(), "{:?}", outcome.leftovers);

        // Only the old key's entry is gone; the new key is stored.
        assert!(!laptop.has_key(&old));
        assert!(laptop.has_key(&outcome.new_public_key));

        // Organization data gone, other files kept, no trash left.
        for folder in paths::ORG_FOLDERS {
            assert!(!laptop.dir().join(folder).exists(), "{folder}");
        }
        assert!(laptop.dir().join("catatan-pribadi.txt").exists());
        assert!(laptop.dir().join("webview").join("Local State").exists());
        assert_eq!(trash_dirs(laptop.dir()), 0);

        // Display preferences kept, organization settings gone.
        assert_eq!(
            laptop.setting(ui_lang::SETTING_LANGUAGE).as_deref(),
            Some("en")
        );
        assert_eq!(
            laptop.setting(window_theme::MODE_SETTING_KEY).as_deref(),
            Some("dark")
        );
        assert_eq!(laptop.setting("theme.name").as_deref(), Some("bata"));
        assert_eq!(laptop.setting("board.reminder.day_before"), None);
        assert_eq!(laptop.setting("join.addresses"), None);

        // Onboarding: no name, no organization.
        let app = commands::app_state(&laptop.state).unwrap();
        assert_eq!(app.identity.public_key, outcome.new_public_key);
        assert_eq!(app.identity.display_name, None);
        assert_eq!(app.organization, None);
        assert_eq!(app.membership, Membership::None);

        // The new database works and survives a restart.
        laptop
            .state
            .with_core(|c| {
                identity::save_display_name(&mut c.db, &mut c.identity, "Ani")?;
                org::create_organization(&mut c.db, &c.identity, "Kantor Baru")
            })
            .unwrap();
        drop(laptop.state);
        let again = Laptop::open(laptop.tmp.path(), &laptop.store, false);
        let app = commands::app_state(&again).unwrap();
        assert_eq!(app.identity.public_key, outcome.new_public_key);
        assert_eq!(app.membership, Membership::Active);
        assert_eq!(
            again
                .with_core(|c| settings::get(&c.db, "theme.name"))
                .unwrap()
                .as_deref(),
            Some("bata")
        );
    }

    #[test]
    fn second_reset_is_refused() {
        let laptop = removed_laptop(false);
        reset_laptop(&laptop.state).unwrap();
        let err = reset_laptop(&laptop.state).unwrap_err();
        assert_eq!(err.code(), "forbidden");
    }

    #[test]
    fn key_delete_failure_changes_nothing() {
        let laptop = removed_laptop(true);
        let pk = laptop.pk();
        let err = reset_laptop(&laptop.state).unwrap_err();
        assert_eq!(err.code(), "storage");
        assert!(err.to_string().contains(identity::STORE_NAME), "{err}");
        assert_untouched(&laptop, &pk);
    }

    /// Windows: another open connection keeps `mira.db` from being moved.
    /// Everything stays as it was and the laptop keeps working.
    #[cfg(windows)]
    #[test]
    fn database_in_use_changes_nothing() {
        let laptop = removed_laptop(false);
        let pk = laptop.pk();
        let other = Connection::open(laptop.dir().join(db::DB_FILE_NAME)).unwrap();
        let err = reset_laptop(&laptop.state).unwrap_err();
        assert_eq!(err.code(), "storage");
        assert!(err.to_string().contains("mira.db"), "{err}");
        drop(other);
        assert_untouched(&laptop, &pk);

        // Once the file is free the reset goes through.
        let outcome = reset_laptop(&laptop.state).unwrap();
        assert!(!laptop.has_key(&pk));
        assert_ne!(outcome.new_public_key, pk);
    }

    #[test]
    fn kept_settings_are_display_only() {
        assert_eq!(KEPT_SETTINGS, &["app.language", "theme.mode", "theme.name"]);
    }
}
