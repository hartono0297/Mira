//! Attachment service methods: file views, opening and saving, and the
//! download queue the Tauri fetcher loop drives.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};

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

/// A message file this laptop may see: name, size, mime, message author.
struct FileRow {
    name: String,
    size: u64,
    mime: String,
    author: String,
}

fn file_row(ctx: &Ctx, hash: &str) -> AppResult<FileRow> {
    let mut stmt = ctx.conn.prepare(
        "SELECT f.name, f.size, f.mime, m.author, m.conv FROM chat_files f
         JOIN chat_messages m ON m.id = f.message_id
         WHERE f.hash = ?1 AND m.deleted = 0 ORDER BY m.at DESC",
    )?;
    let rows = stmt
        .query_map([hash], |r| {
            Ok((
                FileRow {
                    name: r.get(0)?,
                    size: u64::try_from(r.get::<_, i64>(1)?).unwrap_or(0),
                    mime: r.get(2)?,
                    author: r.get(3)?,
                },
                r.get::<_, String>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (row, conv) in rows {
        if readable(ctx, &conv).is_ok() {
            return Ok(row);
        }
    }
    Err(AppError::NotFound("File tidak ditemukan di percakapan yang bisa kamu buka.".into()))
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
        .map(|c| if c.is_control() || "\\/:*?\"<>|".contains(c) { '_' } else { c })
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

    /// Copies the file to `<data_dir>/chat-files/<hash>/<stored name>` if it
    /// is not there yet and returns that path; the caller opens it. The name
    /// argument is ignored: the stored name of the file is used.
    pub fn open_file_path(&self, hash: &str, _name: &str) -> AppResult<PathBuf> {
        let blob = parse_hash(hash)?;
        let name = self.with_ctx(|ctx, _, _| {
            require_member(ctx)?;
            Ok(file_row(ctx, hash)?.name)
        })?;
        if !self.blobs.contains(&blob) {
            return Err(AppError::NotFound("File belum ada di laptop ini. Unduh dulu.".into()));
        }
        let path = self.data_dir()?.join(OPEN_DIR).join(hash).join(safe_file_name(&name));
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
            return Err(AppError::NotFound("File belum ada di laptop ini. Unduh dulu.".into()));
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
            fetch::queue(ctx.conn, hash, FetchKind::Plain, row.size, None, &[row.author], PRIORITY_USER, &now)?;
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

    /// A download finished into `downloaded`. The file is re-hashed here; a
    /// mismatch counts as a failed try.
    pub fn fetch_done(&self, job: &FetchJob, downloaded: &Path) -> AppResult<()> {
        let check = fetch::hash_file(downloaded);
        let ok = matches!(&check, Ok((h, size)) if h.as_str() == job.hash && *size == job.size);
        if !ok {
            let _ = std::fs::remove_file(downloaded);
            self.fetch_failed(job, "isi file tidak cocok dengan hash")?;
            return Err(AppError::InvalidInput("File yang diunduh tidak cocok dengan aslinya.".into()));
        }
        let result = self.with_ctx(|ctx, identity, fx| {
            let now = clock::now();
            fetch::put_tracked_file(ctx.conn, &self.blobs, downloaded, job.kind, &format_time(now))?;
            fetch::unqueue(ctx.conn, &job.hash, job.kind)?;
            envelope::complete(ctx, identity, &self.blobs, now, fx)?;
            fx.visible = true;
            Ok(())
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
        FetchKind::Cipher => conn.query_row(
            "SELECT count(*) FROM chat_envelopes WHERE acked = 0 AND cipher_files LIKE ?1",
            params![format!("%\"{}\"%", job.hash)],
            |r| r.get(0),
        )?,
    };
    Ok(n > 0)
}
