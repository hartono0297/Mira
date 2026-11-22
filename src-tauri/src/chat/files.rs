//! Attachment service methods: file views, opening and saving, and the
//! download queue the Tauri fetcher loop drives.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};

use super::audience::Ctx;
use super::fetch::{self, FetchJob, FetchKind, PRIORITY_USER};
use super::model;
use super::read::{self, readable};
use super::service::require_member;
use super::store::envelope;
use super::sync::ChatSync;
use super::view::{FileState, FileView};
use crate::blobs::{BlobHash, should_auto_replicate};
use crate::clock;
use crate::error::{AppError, AppResult};
use crate::permissions::format::format_time;

/// Folder under the data folder where opened attachments are copied.
pub const OPEN_DIR: &str = "chat-files";

/// A message file this laptop may see: name, size, mime, message author and
/// conversation.
struct FileRow {
    name: String,
    size: u64,
    mime: String,
    author: String,
    conv: String,
}

fn file_row(ctx: &Ctx, hash: &str) -> AppResult<FileRow> {
    let mut stmt = ctx.conn.prepare(
        "SELECT f.name, f.size, f.mime, m.author, m.conv FROM chat_files f
         JOIN chat_messages m ON m.id = f.message_id
         WHERE f.hash = ?1 AND m.deleted = 0 ORDER BY m.at DESC",
    )?;
    let rows = stmt
        .query_map([hash], |r| {
            Ok(FileRow {
                name: r.get(0)?,
                size: u64::try_from(r.get::<_, i64>(1)?).unwrap_or(0),
                mime: r.get(2)?,
                author: r.get(3)?,
                conv: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for row in rows {
        if readable(ctx, &row.conv).is_ok() {
            return Ok(row);
        }
    }
    Err(AppError::NotFound(
        "File tidak ditemukan di percakapan yang bisa kamu buka.".into(),
    ))
}

/// Name of file `hash` in message `message_id`, if this laptop may read the
/// message and the file is in it.
fn message_file_name(ctx: &Ctx, message_id: &str, hash: &str) -> AppResult<String> {
    let missing = || AppError::NotFound("File tidak ditemukan di pesan ini.".into());
    let row = read::message_row(ctx.conn, message_id)?
        .filter(|m| !m.deleted)
        .ok_or_else(missing)?;
    readable(ctx, &row.conv)?;
    ctx.conn
        .query_row(
            "SELECT name FROM chat_files WHERE message_id = ?1 AND hash = ?2 ORDER BY idx LIMIT 1",
            params![message_id, hash],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(missing)
}

/// Folder that holds opened copies of blob `hash`.
pub fn open_dir(data_dir: &Path, hash: &str) -> PathBuf {
    data_dir.join(OPEN_DIR).join(hash)
}

fn parse_hash(hash: &str) -> AppResult<BlobHash> {
    BlobHash::parse(hash)
}

/// File name safe for Windows: forbidden characters become `_`.
pub fn safe_file_name(name: &str) -> String {
    if model::is_file_name(name) {
        return name.to_owned();
    }
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "\\/:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_owned();
    if cleaned.is_empty() || !model::is_file_name(&cleaned) {
        "file".to_owned()
    } else {
        cleaned
    }
}

impl ChatSync {
    pub fn file_view(&self, hash: &str) -> AppResult<FileView> {
        parse_hash(hash)?;
        self.with_ctx(|ctx, _, _| {
            require_member(ctx)?;
            let row = file_row(ctx, hash)?;
            Ok(FileView {
                hash: hash.to_owned(),
                state: read::file_state(ctx.conn, &self.blobs, hash, row.size)?,
                auto_download: should_auto_replicate(row.size),
                name: row.name,
                size: row.size,
                mime: row.mime,
            })
        })
    }

    /// Copies file `hash` of message `message_id` to
    /// `<data_dir>/chat-files/<hash>/<name in that message>` if it is not
    /// there yet and returns that path; the caller opens it. The message must
    /// be readable by this laptop, not deleted, and carry the file.
    pub fn open_file_path(&self, message_id: &str, hash: &str) -> AppResult<PathBuf> {
        let blob = parse_hash(hash)?;
        let name = self.with_ctx(|ctx, _, _| {
            require_member(ctx)?;
            message_file_name(ctx, message_id, hash)
        })?;
        if !self.blobs.contains(&blob) {
            return Err(AppError::NotFound(
                "File belum ada di laptop ini. Unduh dulu.".into(),
            ));
        }
        let path = open_dir(&self.data_dir()?, hash).join(safe_file_name(&name));
        if !path.is_file() {
            self.blobs.copy_to(&blob, &path)?;
        }
        Ok(path)
    }

    pub fn save_file(&self, hash: &str, dest: &Path) -> AppResult<()> {
        let blob = parse_hash(hash)?;
        self.with_ctx(|ctx, _, _| {
            require_member(ctx)?;
            file_row(ctx, hash).map(|_| ())
        })?;
        if !self.blobs.contains(&blob) {
            return Err(AppError::NotFound(
                "File belum ada di laptop ini. Unduh dulu.".into(),
            ));
        }
        self.blobs.copy_to(&blob, dest)
    }

    /// Queues a file (usually a large one) for download, first in line.
    pub fn request_download(&self, hash: &str) -> AppResult<()> {
        let blob = parse_hash(hash)?;
        if self.blobs.contains(&blob) {
            return Ok(());
        }
        self.with_ctx(|ctx, _, fx| {
            require_member(ctx)?;
            let row = file_row(ctx, hash)?;
            let now = format_time(clock::now());
            fetch::queue(
                ctx.conn,
                hash,
                FetchKind::Plain,
                row.size,
                None,
                &[row.author],
                PRIORITY_USER,
                &now,
            )?;
            fetch::queue_for_conv(ctx.conn, hash, &row.conv)?;
            fx.queued = true;
            fx.visible = true;
            Ok(())
        })
    }

    /// Jobs due now. Drops jobs that are no longer needed and expires old
    /// envelopes on the way.
    pub fn fetch_jobs(&self) -> AppResult<Vec<FetchJob>> {
        self.with_ctx(|ctx, identity, fx| {
            let now = clock::now();
            envelope::expire(ctx, now, fx)?;
            for job in fetch::all_jobs(ctx.conn)? {
                let present = BlobHash::parse(&job.hash).is_ok_and(|h| self.blobs.contains(&h));
                if present || !still_needed(ctx.conn, &job)? {
                    fetch::unqueue(ctx.conn, &job.hash, job.kind)?;
                }
            }
            envelope::complete(ctx, identity, &self.blobs, now, fx)?;
            fetch::due_jobs(ctx.conn, &format_time(now))
        })
    }

    /// A download finished into `downloaded`. The file is re-hashed and
    /// copied into the blob store before the core lock is taken; a mismatch
    /// counts as a failed try. A plain file becomes held for the
    /// conversations it was queued for.
    pub fn fetch_done(&self, job: &FetchJob, downloaded: &Path) -> AppResult<()> {
        let hash = match fetch::hash_file(downloaded) {
            Ok((h, size)) if h.as_str() == job.hash && size == job.size => h,
            _ => {
                let _ = std::fs::remove_file(downloaded);
                self.fetch_failed(job, "isi file tidak cocok dengan hash")?;
                return Err(AppError::InvalidInput(
                    "File yang diunduh tidak cocok dengan aslinya.".into(),
                ));
            }
        };
        let result = fetch::copy_in(&self.blobs, downloaded, &hash).and_then(|copied| {
            self.with_ctx(|ctx, identity, fx| {
                let now = clock::now();
                fetch::track_copy(
                    ctx.conn,
                    &self.blobs,
                    &copied,
                    downloaded,
                    job.kind,
                    &format_time(now),
                )?;
                if job.kind == FetchKind::Plain {
                    fetch::land_fetch_convs(ctx.conn, &job.hash)?;
                }
                fetch::unqueue(ctx.conn, &job.hash, job.kind)?;
                envelope::complete(ctx, identity, &self.blobs, now, fx)?;
                fx.visible = true;
                Ok(())
            })
        });
        let _ = std::fs::remove_file(downloaded);
        result
    }

    pub fn fetch_failed(&self, job: &FetchJob, err: &str) -> AppResult<()> {
        self.with_ctx(|ctx, identity, fx| {
            let now = clock::now();
            let dropped = fetch::mark_failed(ctx.conn, job, err, now)?;
            if dropped && job.kind == FetchKind::Cipher {
                envelope::give_up_cipher(ctx, &job.hash)?;
                envelope::complete(ctx, identity, &self.blobs, now, fx)?;
            }
            fx.visible = true;
            Ok(())
        })
    }

    /// `FileState` shortcut for tests and the runtime.
    pub fn file_state(&self, hash: &str) -> AppResult<FileState> {
        Ok(self.file_view(hash)?.state)
    }
}

/// A plain file still referenced by a message, or a cipher file of a live
/// envelope.
fn still_needed(conn: &Connection, job: &FetchJob) -> AppResult<bool> {
    let n: i64 = match job.kind {
        FetchKind::Plain => conn.query_row(
            "SELECT count(*) FROM chat_files f JOIN chat_messages m ON m.id = f.message_id
             WHERE f.hash = ?1 AND m.deleted = 0",
            params![job.hash],
            |r| r.get(0),
        )?,
        FetchKind::Cipher => i64::from(fetch::live_envelope_lists(conn, &job.hash)?),
    };
    Ok(n > 0)
}
