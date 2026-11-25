//! `ProfileSync`: profile photos on the feature sync contract (`FeatureSync`
//! for topic `profile`, `BlobSource` for the photos), plus the methods behind
//! the Tauri commands and the download queue the fetcher in `runtime.rs`
//! works through (docs/plans/foto-profil.md, section 2.5).
//!
//! Scoping: a peer that is not an active member (or this laptop itself) gets
//! nothing. Active members, guests included, get the winning record of every
//! owner and the `remove` records of active superadmins. Records that lost
//! are kept as ids only (`profile_seen`), so they are never asked for again
//! and never offered.
//!
//! Photos live in their own blob folder (`<data_dir>/profile-photos`), so a
//! photo nobody shows any more can be deleted without asking chat or
//! documents. Only bytes that passed `is_valid_photo` are ever stored there.
//!
//! A write looks only at what it changed: the owners it touched and their
//! photo hashes, through the indexes of `profile_records`. Whole-table views
//! are built only for lists (`photos`, offers) and the periodic queue check,
//! and the table holds one record per owner plus the removes.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::{Connection, TransactionBehavior};
use time::OffsetDateTime;

use super::commands::{MyPhoto, PhotoEntry};
use super::image::is_valid_photo;
use super::record::{self, MAX_SEQ, OwnerState, ProfileRecord, RecordKind, RecordRow};
use super::store::{self, PhotoJob, Placed};
use super::{
    MAX_PHOTO_BYTES, PHOTO_BROKEN, PHOTO_NO_ORG, PHOTO_NOT_ADMIN, PHOTO_NOT_FOUND,
    PHOTO_NOT_MEMBER, PHOTO_SEQ_LIMIT, TOPIC_PROFILE,
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

/// Photo hashes a write changed; settled after the commit.
type Touched = BTreeSet<String>;

/// Effective state of every owner plus the directory it was computed with.
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

/// The `seq` for this laptop's next own record.
fn next_seq(conn: &Connection, me: &str) -> AppResult<u64> {
    store::max_seq(conn, me)?
        .checked_add(1)
        .filter(|s| *s <= MAX_SEQ)
        .ok_or_else(|| AppError::InvalidInput(PHOTO_SEQ_LIMIT.into()))
}

/// Whether an active superadmin removed `hash` (for any owner).
fn is_removed(conn: &Connection, dir: &Directory, hash: &str) -> AppResult<bool> {
    Ok(store::removers(conn, hash)?
        .iter()
        .any(|a| dir.is_superadmin(a)))
}

/// A download job for `hash` when someone's current record sets it and no
/// active superadmin removed it; `None` when nobody shows it.
fn wanted_job(conn: &Connection, dir: &Directory, hash: &str) -> AppResult<Option<PhotoJob>> {
    let Some((owner, size)) = store::setters(conn, hash)?.into_iter().next() else {
        return Ok(None);
    };
    if is_removed(conn, dir, hash)? {
        return Ok(None);
    }
    Ok(Some(PhotoJob {
        hash: hash.to_owned(),
        owner,
        size,
    }))
}

/// The photo this laptop's own current record sets, removed or not.
fn my_set(conn: &Connection, me: &str) -> AppResult<Option<String>> {
    Ok(store::current(conn, me)?
        .filter(|r| r.kind == RecordKind::Set)
        .and_then(|r| r.photo))
}

/// Whether a live record may be offered: owner records always (only the
/// winner is live), removes while their author is an active superadmin.
fn offerable(dir: &Directory, row: &RecordRow) -> bool {
    row.kind != RecordKind::Remove || dir.is_superadmin(&row.author)
}

fn may_receive(dir: &Directory, peer: &str) -> bool {
    dir.is_active(peer) && peer != dir.me
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

    /// Runs `f` with the directory (`None` without an organization).
    fn read<T>(&self, f: impl FnOnce(&Connection, Option<&Directory>) -> AppResult<T>) -> AppResult<T> {
        self.state.with_core(|core| {
            let me = core.identity.public_key_hex().to_owned();
            let dir = Directory::load(&core.db, &me)?;
            f(&core.db, dir.as_ref())
        })
    }

    fn view<T>(&self, f: impl FnOnce(Option<&View>) -> AppResult<T>) -> AppResult<T> {
        self.state.with_core(|core| {
            let me = core.identity.public_key_hex().to_owned();
            let view = View::load(&core.db, &me, &self.blobs)?;
            f(view.as_ref())
        })
    }

    /// Runs `f` in an immediate transaction and settles the photos it touched
    /// after the commit. Returns `f`'s result and whether a photo was queued.
    fn write<T>(
        &self,
        f: impl FnOnce(&Connection, &Identity, Option<&Directory>, &mut Touched) -> AppResult<T>,
    ) -> AppResult<(T, bool)> {
        self.state.with_core(|core| self.write_locked(core, f))
    }

    fn write_locked<T>(
        &self,
        core: &mut Core,
        f: impl FnOnce(&Connection, &Identity, Option<&Directory>, &mut Touched) -> AppResult<T>,
    ) -> AppResult<(T, bool)> {
        let Core { db, identity } = core;
        let me = identity.public_key_hex().to_owned();
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let dir = Directory::load(&tx, &me)?;
        let mut touched = Touched::new();
        let out = f(&tx, identity, dir.as_ref(), &mut touched)?;
        tx.commit()?;
        let queued = match &dir {
            Some(dir) => self.settle(db, dir, &touched)?,
            None => false,
        };
        Ok((out, queued))
    }

    /// For each photo a write touched: queue it when someone shows it and it
    /// is not here, drop it from the queue when nobody does, and delete it
    /// when nobody shows it and it is not this laptop's own latest photo.
    /// Runs under the core lock, so a photo stored by a concurrent change is
    /// never deleted by mistake. Returns `true` when a job was added.
    fn settle(&self, conn: &Connection, dir: &Directory, touched: &Touched) -> AppResult<bool> {
        let mut queued = false;
        let mine = my_set(conn, &dir.me)?;
        for hash in touched {
            let Ok(parsed) = BlobHash::parse(hash) else {
                continue;
            };
            match wanted_job(conn, dir, hash)? {
                Some(job) => {
                    if !self.blobs.contains(&parsed) {
                        queued |= store::enqueue(conn, &job)?;
                    }
                }
                None => {
                    store::unqueue(conn, hash)?;
                    if mine.as_deref() != Some(hash.as_str()) {
                        let _ = self.blobs.remove(&parsed);
                    }
                }
            }
        }
        Ok(queued)
    }

    /// Run once at start, before the downloader: deletes downloads a crash
    /// left in `profile-tmp`, and photos nothing refers to any more (nobody
    /// shows them and they are not this laptop's own latest photo).
    pub fn sweep(&self) -> AppResult<()> {
        if let Ok(entries) = std::fs::read_dir(self.data_dir()?.join(TMP_DIR)) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|x| x == "part") && path.is_file() {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        self.view(|view| {
            let Some(view) = view else {
                return Ok(());
            };
            let keep = view.keep();
            for hash in self.stored_photos() {
                if !keep.contains(hash.as_str()) {
                    let _ = self.blobs.remove(&hash);
                }
            }
            Ok(())
        })
    }

    /// Every photo file in the blob store (`<xx>/<hash>`).
    fn stored_photos(&self) -> Vec<BlobHash> {
        let mut out = Vec::new();
        let Ok(dirs) = std::fs::read_dir(self.blobs.root()) else {
            return out;
        };
        for dir in dirs.flatten() {
            let name = dir.file_name();
            let Some(prefix) = name.to_str().filter(|p| p.len() == 2) else {
                continue;
            };
            let Ok(files) = std::fs::read_dir(dir.path()) else {
                continue;
            };
            for file in files.flatten() {
                let file_name = file.file_name();
                if let Some(name) = file_name.to_str()
                    && name.starts_with(prefix)
                    && let Ok(hash) = BlobHash::parse(name)
                {
                    out.push(hash);
                }
            }
        }
        out
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
    /// The bytes are not decoded again: only photos that passed
    /// `is_valid_photo` are stored, so size and hash are checked instead.
    pub fn photo_data(&self, hash: &str) -> AppResult<Vec<u8>> {
        let not_found = || AppError::NotFound(PHOTO_NOT_FOUND.into());
        let parsed = BlobHash::parse(hash).map_err(|_| not_found())?;
        let shown = self.read(|conn, dir| match dir {
            Some(dir) => Ok(wanted_job(conn, dir, hash)?.is_some()),
            None => Ok(false),
        })?;
        if !shown {
            return Err(not_found());
        }
        let bytes = self.blobs.read_all(&parsed).map_err(|_| not_found())?;
        if bytes.len() as u64 > MAX_PHOTO_BYTES || BlobHash::of_bytes(&bytes) != parsed {
            return Err(not_found());
        }
        Ok(bytes)
    }

    pub fn my_photo(&self) -> AppResult<MyPhoto> {
        self.read(|conn, dir| {
            let mut out = MyPhoto {
                hash: None,
                removed_by_admin: false,
            };
            let Some(dir) = dir else {
                return Ok(out);
            };
            if let Some(hash) = my_set(conn, &dir.me)? {
                out.removed_by_admin = is_removed(conn, dir, &hash)?;
                let here = BlobHash::parse(&hash).is_ok_and(|h| self.blobs.contains(&h));
                if !out.removed_by_admin && here {
                    out.hash = Some(hash);
                }
            }
            Ok(out)
        })
    }

    /// Fails when this laptop may not set a photo (no organization, removed).
    pub fn ensure_can_set(&self) -> AppResult<()> {
        self.read(|_, dir| require_active(dir.ok_or_else(no_org)?))
    }

    /// Sets a photo made by `image::crop_to_photo`. When saving the record
    /// fails, the stored bytes are deleted again unless they were already
    /// here.
    pub fn set_photo(&self, jpeg: &[u8]) -> AppResult<PhotoEntry> {
        if jpeg.len() as u64 > MAX_PHOTO_BYTES || !is_valid_photo(jpeg) {
            return Err(AppError::InvalidInput(PHOTO_BROKEN.into()));
        }
        let hash = BlobHash::of_bytes(jpeg);
        let (entry, _) = self.state.with_core(|core| {
            let existed = self.blobs.contains(&hash);
            let out = self.write_locked(core, |conn, identity, dir, touched| {
                let dir = dir.ok_or_else(no_org)?;
                require_active(dir)?;
                let info = self.blobs.put_bytes(jpeg)?;
                let me = identity.public_key_hex();
                let seq = next_seq(conn, me)?;
                let rec = ProfileRecord::sign_new(
                    identity,
                    RecordKind::Set,
                    &dir.org_id,
                    me,
                    Some(info.hash.as_str()),
                    Some(info.size),
                    seq,
                    &format_time(clock::now()),
                )?;
                let body = rec.to_body();
                if let Placed::Won {
                    replaced: Some(old),
                } = store::put_owner_record(conn, &record_id(&body), &rec, &body, clock::now())?
                {
                    touched.extend(old.photo);
                }
                touched.insert(info.hash.as_str().to_owned());
                Ok(PhotoEntry {
                    owner: me.to_owned(),
                    hash: info.hash.as_str().to_owned(),
                })
            });
            if out.is_err() && !existed {
                let _ = self.blobs.remove(&hash);
            }
            out
        })?;
        self.local_change();
        Ok(entry)
    }

    /// Back to initials.
    pub fn clear_photo(&self) -> AppResult<()> {
        self.write(|conn, identity, dir, touched| {
            let dir = dir.ok_or_else(no_org)?;
            require_active(dir)?;
            let me = identity.public_key_hex();
            let seq = next_seq(conn, me)?;
            let rec = ProfileRecord::sign_new(
                identity,
                RecordKind::Clear,
                &dir.org_id,
                me,
                None,
                None,
                seq,
                &format_time(clock::now()),
            )?;
            let body = rec.to_body();
            if let Placed::Won {
                replaced: Some(old),
            } = store::put_owner_record(conn, &record_id(&body), &rec, &body, clock::now())?
            {
                touched.extend(old.photo);
            }
            Ok(())
        })?;
        self.local_change();
        Ok(())
    }

    /// A superadmin hides `owner`'s current photo, for every owner that
    /// shows the same bytes.
    pub fn admin_remove(&self, owner: &str) -> AppResult<()> {
        let (made, _) = self.write(|conn, identity, dir, touched| {
            let dir = dir.ok_or_else(no_org)?;
            let me = identity.public_key_hex();
            if !dir.is_superadmin(me) {
                return Err(AppError::Forbidden(PHOTO_NOT_ADMIN.into()));
            }
            if owner == me {
                return Err(AppError::InvalidInput(PHOTO_NOT_FOUND.into()));
            }
            if dir.member(owner).is_none() {
                return Err(AppError::NotFound(PHOTO_NOT_MEMBER.into()));
            }
            let Some(hash) = store::current(conn, owner)?
                .filter(|r| r.kind == RecordKind::Set)
                .and_then(|r| r.photo)
            else {
                return Err(AppError::NotFound(PHOTO_NOT_FOUND.into()));
            };
            if is_removed(conn, dir, &hash)? {
                return Ok(false);
            }
            let rec = ProfileRecord::sign_new(
                identity,
                RecordKind::Remove,
                &dir.org_id,
                owner,
                Some(&hash),
                None,
                0,
                &format_time(clock::now()),
            )?;
            let body = rec.to_body();
            store::insert(conn, &record_id(&body), &rec, &body, clock::now())?;
            touched.insert(hash);
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
        self.fetch_done_with(job, tmp, is_valid_photo)
    }

    /// `fetch_done` with the photo check passed in (tests simulate a decoder
    /// crash with it).
    pub(crate) fn fetch_done_with(
        &self,
        job: &PhotoJob,
        tmp: &Path,
        valid: impl FnOnce(&[u8]) -> bool,
    ) -> AppResult<()> {
        let bytes = std::fs::read(tmp)
            .map_err(|e| AppError::Storage(format!("Foto unduhan tidak bisa dibaca: {e}")))?;
        // Marked bad and committed before decoding: release builds abort on a
        // panic, and a decoder that crashes on these bytes must not run on
        // them again after a restart. Passing the check clears the mark.
        self.state
            .with_core(|core| store::mark_bad(&core.db, job))?;
        let ok = bytes.len() as u64 <= MAX_PHOTO_BYTES
            && blake3::hash(&bytes).to_hex().as_str() == job.hash
            && valid(&bytes);
        if !ok {
            return Err(AppError::InvalidInput(PHOTO_BROKEN.into()));
        }
        let shown = self.state.with_core(|core| {
            store::checked_ok(&core.db, &job.hash)?;
            let me = core.identity.public_key_hex().to_owned();
            let Some(dir) = Directory::load(&core.db, &me)? else {
                return Ok(false);
            };
            if wanted_job(&core.db, &dir, &job.hash)?.is_none() {
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
        self.read(|conn, dir| {
            let Some(dir) = dir.filter(|d| may_receive(d, peer)) else {
                return Ok(Vec::new());
            };
            Ok(store::rows(conn)?
                .into_iter()
                .filter(|r| offerable(dir, r))
                .map(|r| r.id)
                .collect())
        })
    }

    fn records(&self, peer: &str, ids: &[String]) -> AppResult<Vec<FeatureRecord>> {
        self.read(|conn, dir| {
            let Some(dir) = dir.filter(|d| may_receive(d, peer)) else {
                return Ok(Vec::new());
            };
            let mut out = Vec::new();
            for id in ids {
                if let Some((row, body)) = store::live_record(conn, id)?
                    && offerable(dir, &row)
                {
                    out.push(FeatureRecord {
                        id: id.clone(),
                        body,
                    });
                }
            }
            Ok(out)
        })
    }

    /// Stores valid records. Of the owner records in one batch only the
    /// newest per owner is compared with the stored one; the others lose at
    /// once and keep only their id, so a flood of old records costs a
    /// signature check and one small row each.
    fn ingest_records(&self, from: &str, records: Vec<FeatureRecord>) -> AppResult<FeatureIngest> {
        let now = clock::now();
        let (out, queued) = self.write(|conn, _identity, dir, touched| {
            let mut out = FeatureIngest::default();
            let Some(dir) = dir else {
                return Ok(out);
            };
            let mut newest: BTreeMap<String, (String, ProfileRecord, String)> = BTreeMap::new();
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
                if let Err(rej) = rec.check_against(dir) {
                    log(conn, from, rej.code, &rej.detail, now)?;
                    out.rejected += 1;
                    continue;
                }
                if rec.kind == RecordKind::Remove {
                    let Some(hash) = rec.photo.clone() else {
                        continue;
                    };
                    let was_removed = is_removed(conn, dir, &hash)?;
                    if store::insert(conn, &r.id, &rec, &r.body, now)? {
                        out.accepted += 1;
                        out.changed |= !was_removed && !store::setters(conn, &hash)?.is_empty();
                        touched.insert(hash);
                    }
                    continue;
                }
                let key = (rec.seq, rec.at.clone(), r.id.clone());
                let lost = match newest.get(&rec.owner) {
                    Some((id, _, _)) if *id == r.id => continue,
                    Some((id, cur, _)) if (cur.seq, cur.at.clone(), id.clone()) >= key => {
                        Some(r.id.clone())
                    }
                    Some((id, _, _)) => {
                        let old = id.clone();
                        newest.insert(rec.owner.clone(), (r.id, rec, r.body));
                        Some(old)
                    }
                    None => {
                        newest.insert(rec.owner.clone(), (r.id, rec, r.body));
                        None
                    }
                };
                if let Some(id) = lost {
                    store::forget(conn, &id)?;
                    out.accepted += 1;
                }
            }
            for (id, rec, body) in newest.into_values() {
                out.accepted += 1;
                if let Placed::Won { replaced } = store::put_owner_record(conn, &id, &rec, &body, now)? {
                    let before = replaced.and_then(|r| r.photo);
                    out.changed |= before != rec.photo;
                    touched.extend(before);
                    touched.extend(rec.photo);
                }
            }
            Ok(out)
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
        let ok = self.read(|conn, dir| match dir {
            Some(dir) => Ok(may_receive(dir, peer) && wanted_job(conn, dir, hash)?.is_some()),
            None => Ok(false),
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
