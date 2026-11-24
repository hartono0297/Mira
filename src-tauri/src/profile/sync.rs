//! `ProfileSync`: profile photos on the feature sync contract (`FeatureSync`
//! for topic `profile`, `BlobSource` for the photos), plus the methods behind
//! the Tauri commands and the download queue the fetcher in `runtime.rs`
//! works through (docs/plans/foto-profil.md, section 2.5).
//!
//! Scoping: a peer that is not an active member (or this laptop itself) gets
//! nothing. Active members, guests included, get the winning record of every
//! owner and the `remove` records of active superadmins. Older records stay
//! in the table so they are never asked for again, but are not offered.
//!
//! Photos live in their own blob folder (`<data_dir>/profile-photos`), so a
//! photo nobody shows any more can be deleted without asking chat or
//! documents. Only bytes that passed `is_valid_photo` are ever stored there.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::{Connection, TransactionBehavior};
use time::OffsetDateTime;

use super::commands::{MyPhoto, PhotoEntry};
use super::image::is_valid_photo;
use super::record::{self, OwnerState, ProfileRecord, RecordKind};
use super::store::{self, PhotoJob};
use super::{
    MAX_PHOTO_BYTES, PHOTO_BROKEN, PHOTO_NO_ORG, PHOTO_NOT_ADMIN, PHOTO_NOT_FOUND,
    PHOTO_NOT_MEMBER, TOPIC_PROFILE,
};
use crate::blobs::{BlobHash, BlobStore};
use crate::chat::audience::Directory;
use crate::clock;
use crate::error::{AppError, AppResult};
use crate::identity::Identity;
use crate::network::feature::{BlobSource, FeatureIngest, FeatureRecord, FeatureSync, record_id};
use crate::permissions::{self, format::format_time};
use crate::state::{Core, MiraState};

/// Folder of the photo blob store under the data folder.
pub const PHOTO_DIR: &str = "profile-photos";
/// Folder for downloads in progress under the data folder.
pub const TMP_DIR: &str = "profile-tmp";

/// What profile sync needs from the app.
pub trait ProfileHooks: Send + Sync {
    /// A local change: offer the new record to colleagues.
    fn notify_changed(&self);
    /// What the screen shows changed: send `mira://feature` `{ topic: "profile" }`.
    fn ui_changed(&self);
    /// Something was queued or a colleague came online.
    fn wake_fetcher(&self);
}

#[derive(Debug, Default)]
pub struct NoopProfileHooks;

impl ProfileHooks for NoopProfileHooks {
    fn notify_changed(&self) {}
    fn ui_changed(&self) {}
    fn wake_fetcher(&self) {}
}

pub struct ProfileSync {
    state: MiraState,
    blobs: BlobStore,
    hooks: Arc<dyn ProfileHooks>,
}

/// Effective state per owner plus the directory it was computed with.
struct View {
    dir: Directory,
    owners: BTreeMap<String, OwnerState>,
}

impl View {
    fn load(conn: &Connection, me: &str, blobs: &BlobStore) -> AppResult<Option<View>> {
        let Some(dir) = Directory::load(conn, me)? else {
            return Ok(None);
        };
        let rows = store::rows(conn)?;
        let local = |h: &str| BlobHash::parse(h).is_ok_and(|h| blobs.contains(&h));
        let owners = record::effective(&rows, &dir, &local);
        Ok(Some(View { dir, owners }))
    }

    /// Ids `peer` may receive: the winning record of every owner and the
    /// removes of active superadmins. Empty for anyone but an active member.
    fn offer_for(&self, peer: &str) -> BTreeSet<String> {
        if !self.dir.is_active(peer) || peer == self.dir.me {
            return BTreeSet::new();
        }
        self.owners
            .values()
            .flat_map(|st| st.latest.iter().chain(&st.removes).cloned())
            .collect()
    }

    /// Photos colleagues should show (not removed), whether here or not.
    fn wanted(&self) -> BTreeSet<String> {
        self.owners
            .values()
            .filter_map(|st| st.wanted.clone())
            .collect()
    }

    /// Photos to keep in the store: every wanted photo and this laptop's own
    /// latest `set`, removed or not.
    fn keep(&self) -> BTreeSet<String> {
        let mut keep = self.wanted();
        if let Some((h, _)) = self.owners.get(&self.dir.me).and_then(|st| st.set.clone()) {
            keep.insert(h);
        }
        keep
    }

    /// Wanted photos that are not here yet.
    fn missing(&self) -> Vec<PhotoJob> {
        self.owners
            .iter()
            .filter(|(_, st)| st.wanted.is_some() && st.photo.is_none())
            .filter_map(|(owner, st)| {
                let (hash, size) = st.set.clone()?;
                Some(PhotoJob {
                    hash,
                    owner: owner.clone(),
                    size,
                })
            })
            .collect()
    }

    /// What the screen shows per owner.
    fn shown(&self) -> BTreeMap<String, (Option<String>, Option<String>, bool)> {
        self.owners
            .iter()
            .map(|(o, st)| {
                (
                    o.clone(),
                    (st.wanted.clone(), st.photo.clone(), st.removed_by_admin),
                )
            })
            .collect()
    }
}

fn str_err(e: AppError) -> String {
    e.to_string()
}

fn no_org() -> AppError {
    AppError::Forbidden(PHOTO_NO_ORG.into())
}

/// Fails unless this laptop's person may change their own photo.
fn require_active(dir: &Directory) -> AppResult<()> {
    match dir.member(&dir.me) {
        Some(m) if m.active => Ok(()),
        Some(_) => Err(AppError::Removed),
        None => Err(no_org()),
    }
}

fn log(
    conn: &Connection,
    from: &str,
    code: &str,
    detail: &str,
    now: OffsetDateTime,
) -> AppResult<()> {
    permissions::log_rejection(
        conn,
        Some(from),
        None,
        &format!("profile_{code}"),
        detail,
        now,
    )
}

impl ProfileSync {
    pub fn new(state: MiraState, hooks: Arc<dyn ProfileHooks>) -> AppResult<Self> {
        let blobs = BlobStore::open(state.data_dir()?.join(PHOTO_DIR))?;
        Ok(Self {
            state,
            blobs,
            hooks,
        })
    }

    pub fn data_dir(&self) -> AppResult<PathBuf> {
        Ok(self.state.data_dir()?.to_path_buf())
    }

    pub fn blobs(&self) -> &BlobStore {
        &self.blobs
    }

    fn view<T>(&self, f: impl FnOnce(Option<&View>) -> AppResult<T>) -> AppResult<T> {
        self.state.with_core(|core| {
            let me = core.identity.public_key_hex().to_owned();
            let view = View::load(&core.db, &me, &self.blobs)?;
            f(view.as_ref())
        })
    }

    /// Runs `f` in an immediate transaction; after commit, deletes photos
    /// nobody shows any more (still under the core lock, so a photo stored by
    /// a concurrent change is never deleted by mistake) and brings the
    /// download queue up to date.
    fn write<T>(
        &self,
        f: impl FnOnce(&Connection, &Identity, Option<&View>) -> AppResult<T>,
    ) -> AppResult<T> {
        self.state.with_core(|core| {
            let Core { db, identity } = core;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let me = identity.public_key_hex().to_owned();
            let view = View::load(&tx, &me, &self.blobs)?;
            let out = f(&tx, identity, view.as_ref())?;
            tx.commit()?;
            self.collect_garbage(db, &me)?;
            Ok(out)
        })
    }

    fn collect_garbage(&self, conn: &Connection, me: &str) -> AppResult<()> {
        let Some(view) = View::load(conn, me, &self.blobs)? else {
            return Ok(());
        };
        let keep = view.keep();
        for hash in store::named_photos(conn)? {
            if keep.contains(&hash) {
                continue;
            }
            if let Ok(h) = BlobHash::parse(&hash) {
                let _ = self.blobs.remove(&h);
            }
        }
        store::sync_queue(conn, &view.missing())?;
        Ok(())
    }

    // ---- Commands ----

    /// Photos shown on this laptop (effective and here).
    pub fn photos(&self) -> AppResult<Vec<PhotoEntry>> {
        self.view(|view| {
            let Some(view) = view else {
                return Ok(Vec::new());
            };
            Ok(view
                .owners
                .iter()
                .filter_map(|(owner, st)| {
                    Some(PhotoEntry {
                        owner: owner.clone(),
                        hash: st.photo.clone()?,
                    })
                })
                .collect())
        })
    }

    /// Bytes of a photo someone shows now. Anything else is `not_found`.
    pub fn photo_data(&self, hash: &str) -> AppResult<Vec<u8>> {
        let not_found = || AppError::NotFound(PHOTO_NOT_FOUND.into());
        let parsed = BlobHash::parse(hash).map_err(|_| not_found())?;
        let shown = self.view(|view| {
            Ok(view.is_some_and(|v| {
                v.owners
                    .values()
                    .any(|st| st.photo.as_deref() == Some(hash))
            }))
        })?;
        if !shown {
            return Err(not_found());
        }
        let bytes = self.blobs.read_all(&parsed).map_err(|_| not_found())?;
        if !is_valid_photo(&bytes) {
            return Err(not_found());
        }
        Ok(bytes)
    }

    pub fn my_photo(&self) -> AppResult<MyPhoto> {
        self.view(|view| {
            let st = view.and_then(|v| v.owners.get(&v.dir.me));
            Ok(MyPhoto {
                hash: st.and_then(|s| s.photo.clone()),
                removed_by_admin: st.is_some_and(|s| s.removed_by_admin),
            })
        })
    }

    /// Fails when this laptop may not set a photo (no organization, removed).
    pub fn ensure_can_set(&self) -> AppResult<()> {
        self.view(|view| require_active(&view.ok_or_else(no_org)?.dir))
    }

    /// Sets a photo made by `image::crop_to_photo`.
    pub fn set_photo(&self, jpeg: &[u8]) -> AppResult<PhotoEntry> {
        if jpeg.len() as u64 > MAX_PHOTO_BYTES || !is_valid_photo(jpeg) {
            return Err(AppError::InvalidInput(PHOTO_BROKEN.into()));
        }
        let entry = self.write(|conn, identity, view| {
            let view = view.ok_or_else(no_org)?;
            require_active(&view.dir)?;
            let info = self.blobs.put_bytes(jpeg)?;
            let me = identity.public_key_hex();
            let seq = store::max_seq(conn, me)? + 1;
            let rec = ProfileRecord::sign_new(
                identity,
                RecordKind::Set,
                &view.dir.org_id,
                me,
                Some(info.hash.as_str()),
                Some(info.size),
                seq,
                &format_time(clock::now()),
            )?;
            let body = rec.to_body();
            store::insert(conn, &record_id(&body), &rec, &body, clock::now())?;
            Ok(PhotoEntry {
                owner: me.to_owned(),
                hash: info.hash.as_str().to_owned(),
            })
        })?;
        self.local_change();
        Ok(entry)
    }

    /// Back to initials.
    pub fn clear_photo(&self) -> AppResult<()> {
        self.write(|conn, identity, view| {
            let view = view.ok_or_else(no_org)?;
            require_active(&view.dir)?;
            let me = identity.public_key_hex();
            let seq = store::max_seq(conn, me)? + 1;
            let rec = ProfileRecord::sign_new(
                identity,
                RecordKind::Clear,
                &view.dir.org_id,
                me,
                None,
                None,
                seq,
                &format_time(clock::now()),
            )?;
            let body = rec.to_body();
            store::insert(conn, &record_id(&body), &rec, &body, clock::now())?;
            Ok(())
        })?;
        self.local_change();
        Ok(())
    }

    /// A superadmin hides `owner`'s current photo.
    pub fn admin_remove(&self, owner: &str) -> AppResult<()> {
        let made = self.write(|conn, identity, view| {
            let view = view.ok_or_else(no_org)?;
            let me = identity.public_key_hex();
            if !view.dir.is_superadmin(me) {
                return Err(AppError::Forbidden(PHOTO_NOT_ADMIN.into()));
            }
            if owner == me {
                return Err(AppError::InvalidInput(PHOTO_NOT_FOUND.into()));
            }
            if view.dir.member(owner).is_none() {
                return Err(AppError::NotFound(PHOTO_NOT_MEMBER.into()));
            }
            let st = view.owners.get(owner);
            let Some((hash, _)) = st.and_then(|s| s.set.clone()) else {
                return Err(AppError::NotFound(PHOTO_NOT_FOUND.into()));
            };
            if st.is_some_and(|s| s.removed_by_admin) {
                return Ok(false);
            }
            let rec = ProfileRecord::sign_new(
                identity,
                RecordKind::Remove,
                &view.dir.org_id,
                owner,
                Some(&hash),
                None,
                0,
                &format_time(clock::now()),
            )?;
            let body = rec.to_body();
            store::insert(conn, &record_id(&body), &rec, &body, clock::now())?;
            Ok(true)
        })?;
        if made {
            self.local_change();
        }
        Ok(())
    }

    fn local_change(&self) {
        self.hooks.notify_changed();
        self.hooks.ui_changed();
    }

    // ---- Download queue ----

    /// Brings the queue in line with the photos wanted now (a superadmin may
    /// have been demoted since, for example) and returns the jobs due.
    pub fn fetch_jobs(&self) -> AppResult<Vec<PhotoJob>> {
        self.state.with_core(|core| {
            let me = core.identity.public_key_hex().to_owned();
            let Some(view) = View::load(&core.db, &me, &self.blobs)? else {
                return Ok(Vec::new());
            };
            store::sync_queue(&core.db, &view.missing())?;
            store::due_jobs(&core.db, clock::now())
        })
    }

    /// A download of `job` landed at `tmp` (size and BLAKE3 checked by the
    /// transport). Stores it when it is a valid photo that is still wanted;
    /// invalid bytes mark the hash bad for good.
    pub fn fetch_done(&self, job: &PhotoJob, tmp: &Path) -> AppResult<()> {
        let bytes = std::fs::read(tmp)
            .map_err(|e| AppError::Storage(format!("Foto unduhan tidak bisa dibaca: {e}")))?;
        let valid = bytes.len() as u64 <= MAX_PHOTO_BYTES
            && blake3::hash(&bytes).to_hex().as_str() == job.hash
            && is_valid_photo(&bytes);
        if !valid {
            self.state
                .with_core(|core| store::mark_bad(&core.db, &job.hash))?;
            return Err(AppError::InvalidInput(PHOTO_BROKEN.into()));
        }
        let shown = self.state.with_core(|core| {
            let me = core.identity.public_key_hex().to_owned();
            let Some(view) = View::load(&core.db, &me, &self.blobs)? else {
                return Ok(false);
            };
            store::unqueue(&core.db, &job.hash)?;
            if !view.wanted().contains(&job.hash) {
                return Ok(false);
            }
            self.blobs.put_bytes(&bytes)?;
            Ok(true)
        })?;
        if shown {
            self.hooks.ui_changed();
        }
        Ok(())
    }

    /// A download failed: wait longer before the next try (`store::retry_delay`).
    pub fn fetch_failed(&self, job: &PhotoJob) -> AppResult<()> {
        self.state
            .with_core(|core| store::mark_failed(&core.db, &job.hash, clock::now()))
    }

    // ---- Sync ----

    fn ids_for(&self, peer: &str) -> AppResult<Vec<String>> {
        self.view(|view| {
            Ok(view
                .map(|v| v.offer_for(peer).into_iter().collect())
                .unwrap_or_default())
        })
    }

    fn records(&self, peer: &str, ids: &[String]) -> AppResult<Vec<FeatureRecord>> {
        self.state.with_core(|core| {
            let me = core.identity.public_key_hex().to_owned();
            let Some(view) = View::load(&core.db, &me, &self.blobs)? else {
                return Ok(Vec::new());
            };
            let allowed = view.offer_for(peer);
            let mut out = Vec::new();
            for id in ids.iter().filter(|id| allowed.contains(*id)) {
                if let Some(body) = store::body_of(&core.db, id)? {
                    out.push(FeatureRecord {
                        id: id.clone(),
                        body,
                    });
                }
            }
            Ok(out)
        })
    }

    fn ingest_records(&self, from: &str, records: Vec<FeatureRecord>) -> AppResult<FeatureIngest> {
        let now = clock::now();
        let (out, queued) = self.write(|conn, _identity, view| {
            let mut out = FeatureIngest::default();
            let Some(view) = view else {
                return Ok((out, false));
            };
            for r in records {
                if store::is_known(conn, &r.id)? {
                    continue;
                }
                let rec = match ProfileRecord::parse(&r.body) {
                    Ok(rec) => rec,
                    Err(e) => {
                        log(conn, from, "invalid", &e.to_string(), now)?;
                        out.rejected += 1;
                        continue;
                    }
                };
                if let Err(rej) = rec.check_against(&view.dir) {
                    log(conn, from, rej.code, &rej.detail, now)?;
                    out.rejected += 1;
                    continue;
                }
                if store::insert(conn, &r.id, &rec, &r.body, now)? {
                    out.accepted += 1;
                }
            }
            let after = View::load(conn, &view.dir.me, &self.blobs)?.ok_or_else(no_org)?;
            out.changed = after.shown() != view.shown();
            let queued = store::sync_queue(conn, &after.missing())?;
            Ok((out, queued))
        })?;
        if queued {
            self.hooks.wake_fetcher();
        }
        Ok(out)
    }

    /// Whether `peer` may download `hash` from here: an active member (not
    /// this laptop), and `hash` is a photo someone shows now (not removed by
    /// a superadmin) that is on this laptop.
    fn blob_allowed(&self, peer: &str, hash: &str) -> AppResult<Option<PathBuf>> {
        let Ok(parsed) = BlobHash::parse(hash) else {
            return Ok(None);
        };
        if !self.blobs.contains(&parsed) {
            return Ok(None);
        }
        let ok = self.view(|view| {
            Ok(view.is_some_and(|v| {
                v.dir.is_active(peer) && peer != v.dir.me && v.wanted().contains(hash)
            }))
        })?;
        Ok(ok.then(|| self.blobs.path_of(&parsed)))
    }
}

impl FeatureSync for ProfileSync {
    fn topic(&self) -> &'static str {
        TOPIC_PROFILE
    }

    fn record_ids_for(&self, peer: &str) -> Result<Vec<String>, String> {
        self.ids_for(peer).map_err(str_err)
    }

    fn unknown_ids(&self, ids: &[String]) -> Result<Vec<String>, String> {
        self.state
            .with_core(|core| store::unknown_ids(&core.db, ids))
            .map_err(str_err)
    }

    fn records_for(&self, peer: &str, ids: &[String]) -> Result<Vec<FeatureRecord>, String> {
        self.records(peer, ids).map_err(str_err)
    }

    fn ingest(&self, from: &str, records: Vec<FeatureRecord>) -> Result<FeatureIngest, String> {
        self.ingest_records(from, records).map_err(str_err)
    }

    fn peer_connected(&self, _peer: &str) {
        let _ = self.state.with_core(|core| store::reset_backoff(&core.db));
        self.hooks.wake_fetcher();
    }
}

impl BlobSource for ProfileSync {
    fn blob_path_for(&self, peer: &str, hash: &str) -> Option<PathBuf> {
        self.blob_allowed(peer, hash).ok().flatten()
    }
}
