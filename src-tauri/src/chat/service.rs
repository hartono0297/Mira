//! Service methods behind the Tauri chat commands (plan section 10). Every
//! method checks rights itself, returns Indonesian errors, and after a local
//! change calls `notify_changed` and `ui_changed` (through `finish`).

use std::path::{Path, PathBuf};

use super::audience::{Ctx, Scope, dm_allowed};
use super::fetch::{self, FetchKind};
use super::model::{
    self, Body, ChannelScope, CipherFileRef, FileRef, MAX_FILE_BYTES, MAX_FILES, MAX_MENTIONS,
    MAX_RECEIPT_MESSAGES, MAX_SEALED_CHARS, MAX_TEXT_CHARS, ReceiptState,
};
use super::read::{self, readable};
use super::seal::{self, FileKey, SealedContent};
use super::store::{self, Effects};
use super::sync::{ChatSync, NOTIFY_SETTING};
use super::view::{
    ChatOverview, ConversationSummary, ConversationView, MessageView, NewChannelScope, NotifyMode,
    ProjectRef, ReceiptView, ScopeKind, TeamRef,
};
use crate::blobs::{BlobHash, BlobStore, should_auto_replicate};
use crate::clock;
use crate::error::{AppError, AppResult};
use crate::identity::Identity;
use crate::permissions::format::format_time;

fn invalid(msg: &str) -> AppError {
    AppError::InvalidInput(msg.to_owned())
}

fn forbidden(msg: &str) -> AppError {
    AppError::Forbidden(msg.to_owned())
}

/// This laptop must be an active member to use chat.
pub(crate) fn require_member(ctx: &Ctx) -> AppResult<()> {
    match ctx.dir.member(ctx.me()) {
        Some(m) if m.active => Ok(()),
        Some(_) => Err(AppError::Removed),
        None => Err(forbidden(
            "Laptop ini belum tercatat sebagai anggota organisasi. Tunggu sampai tersambung dengan laptop rekan.",
        )),
    }
}

fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}')
}

/// Drops control characters (except new line and tab) and bidi overrides,
/// trims, checks the length.
fn clean_text(text: &str) -> AppResult<String> {
    let cleaned: String = text
        .chars()
        .filter(|c| !(c.is_control() && *c != '\n' && *c != '\t') && !is_bidi_control(*c))
        .collect();
    let cleaned = cleaned.trim().to_owned();
    if cleaned.chars().count() > MAX_TEXT_CHARS {
        return Err(invalid("Pesan terlalu panjang. Maksimal 8000 karakter."));
    }
    Ok(cleaned)
}

/// MIME type from the file extension; `application/octet-stream` otherwise.
pub fn mime_for(name: &str) -> &'static str {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "zip" => "application/zip",
        "rar" => "application/vnd.rar",
        "7z" => "application/x-7z-compressed",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "dwg" => "image/vnd.dwg",
        _ => "application/octet-stream",
    }
}

/// A picked file, checked and copied into the blob store before the core
/// lock is taken.
struct Picked {
    path: PathBuf,
    name: String,
    copied: fetch::Copied,
}

/// Checks one picked file and copies it into the blob store. Runs outside
/// the core lock: hashing and copying a large file must not block chat.
fn pick(blobs: &BlobStore, path: &Path) -> AppResult<Picked> {
    let meta = std::fs::metadata(path).map_err(|_| {
        invalid(&format!(
            "File {} tidak bisa dibaca. Pastikan file masih ada.",
            path.display()
        ))
    })?;
    if !meta.is_file() {
        return Err(invalid("Yang dipilih bukan file."));
    }
    if meta.len() == 0 {
        return Err(invalid("File kosong tidak bisa dikirim."));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(invalid("File terlalu besar. Maksimal 2 GB per file."));
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| model::is_file_name(n))
        .ok_or_else(|| invalid("Nama file tidak bisa dipakai. Ganti nama filenya dulu."))?;
    let (hash, _) = fetch::hash_file(path)?;
    let copied = fetch::copy_in(blobs, path, &hash)?;
    Ok(Picked {
        path: path.to_owned(),
        name,
        copied,
    })
}

/// Records a picked file as attached by this laptop to its message in
/// `conv`, and describes it.
fn attach(ctx: &Ctx, blobs: &BlobStore, p: &Picked, conv: &str, now: &str) -> AppResult<FileRef> {
    fetch::track_copy(ctx.conn, blobs, &p.copied, &p.path, FetchKind::Plain, now)?;
    let hash = p.copied.info.hash.to_string();
    fetch::add_blob_conv(ctx.conn, &hash, conv, true)?;
    Ok(FileRef {
        hash,
        size: p.copied.info.size,
        mime: mime_for(&p.name).to_owned(),
        name: p.name.clone(),
    })
}

/// Checks that this laptop may send `text` with `files` files to `conv`.
/// Returns the conversation and the cleaned text.
fn check_send(
    ctx: &Ctx,
    conv: &str,
    text: &str,
    files: usize,
    reply_to: Option<&str>,
) -> AppResult<(super::audience::ConvInfo, String)> {
    require_member(ctx)?;
    let info = readable(ctx, conv)?;
    if info.archived {
        return Err(forbidden(
            "Channel ini diarsipkan. Kembalikan dulu sebelum mengirim pesan.",
        ));
    }
    if !read::can_post(ctx, &info)? {
        return Err(forbidden(
            "Kamu tidak bisa mengirim pesan di percakapan ini.",
        ));
    }
    let text = clean_text(text)?;
    if files > MAX_FILES {
        return Err(invalid("Maksimal 10 file dalam satu pesan."));
    }
    if text.is_empty() && files == 0 {
        return Err(invalid("Tulis pesan atau lampirkan file dulu."));
    }
    if let Some(r) = reply_to
        && read::message_row(ctx.conn, r)?.is_none_or(|m| m.conv != conv || m.deleted)
    {
        return Err(invalid("Pesan yang dibalas tidak ditemukan."));
    }
    Ok((info, text))
}

/// Encrypts the small files once for all envelopes of a message.
fn seal_files(
    ctx: &Ctx,
    blobs: &BlobStore,
    files: &[FileRef],
    now: &str,
) -> AppResult<(Vec<FileKey>, Vec<CipherFileRef>)> {
    let mut keys = Vec::new();
    let mut ciphers = Vec::new();
    for f in files.iter().filter(|f| should_auto_replicate(f.size)) {
        let bytes = blobs.read_all(&BlobHash::parse(&f.hash)?)?;
        let (key, cipher) = seal::encrypt_file(&bytes).map_err(AppError::Internal)?;
        let info = fetch::put_tracked_bytes(ctx.conn, blobs, &cipher, FetchKind::Cipher, now)?;
        keys.push(FileKey {
            hash: f.hash.clone(),
            cipher: info.hash.to_string(),
            key: hex::encode(*key),
        });
        ciphers.push(CipherFileRef {
            hash: info.hash.to_string(),
            size: info.size,
        });
    }
    Ok((keys, ciphers))
}

/// One envelope per audience member who is not connected right now.
fn make_envelopes(
    ctx: &Ctx,
    identity: &Identity,
    blobs: &BlobStore,
    message: &model::VerifiedRecord,
    files: &[FileRef],
    recipients: &[String],
    fx: &mut Effects,
) -> AppResult<()> {
    if recipients.is_empty() {
        return Ok(());
    }
    let now = clock::now();
    let (keys, ciphers) = seal_files(ctx, blobs, files, &format_time(now))?;
    let content = SealedContent::new(message.body_json.clone(), keys);
    for to in recipients {
        let Ok(sealed) = seal::seal_for(to, &content) else {
            continue;
        };
        if sealed.len() > MAX_SEALED_CHARS {
            continue;
        }
        let body = Body::Envelope {
            to: to.clone(),
            sealed,
            cipher_files: ciphers.clone(),
        };
        let env = store::create(ctx, identity, body, now, fx)?;
        ctx.conn.execute(
            "UPDATE chat_envelopes SET message_id = ?2 WHERE id = ?1",
            rusqlite::params![env.id, message.id],
        )?;
    }
    Ok(())
}

impl ChatSync {
    pub fn overview(&self) -> AppResult<ChatOverview> {
        self.with_ctx(|ctx, _, _| {
            require_member(ctx)?;
            build_overview(ctx)
        })
    }

    pub fn conversation(
        &self,
        conv: &str,
        before: Option<String>,
        limit: u32,
    ) -> AppResult<ConversationView> {
        self.with_ctx(|ctx, _, _| {
            require_member(ctx)?;
            let info = readable(ctx, conv)?;
            let limit = if limit == 0 { 100 } else { limit };
            let (rows, has_more) = read::message_page(ctx.conn, conv, before.as_deref(), limit)?;
            let facts = read::conv_facts(ctx, &info)?;
            let messages = rows
                .iter()
                .map(|r| read::message_view(ctx, &self.blobs, &facts, r))
                .collect::<AppResult<Vec<_>>>()?;
            Ok(ConversationView {
                conversation: read::summary(ctx, &info)?,
                members: read::people(&ctx.dir, &ctx.audience(&info)?),
                messages,
                has_more,
            })
        })
    }

    pub fn message_receipts(&self, message_id: &str) -> AppResult<Vec<ReceiptView>> {
        self.with_ctx(|ctx, _, _| {
            require_member(ctx)?;
            let row = read::message_row(ctx.conn, message_id)?
                .ok_or_else(|| AppError::NotFound("Pesan tidak ditemukan.".into()))?;
            let info = readable(ctx, &row.conv)?;
            read::receipts_for(ctx, &info, &row)
        })
    }

    pub fn send(
        &self,
        conv: &str,
        text: &str,
        reply_to: Option<String>,
        mentions: Vec<String>,
        files: Vec<PathBuf>,
    ) -> AppResult<MessageView> {
        let connected = self.hooks.connected_peers();
        // Cheap checks first, so a refused send copies nothing; then the
        // files are hashed and copied without holding the core lock.
        if !files.is_empty() {
            self.with_ctx(|ctx, _, _| {
                check_send(ctx, conv, text, files.len(), reply_to.as_deref()).map(|_| ())
            })?;
        }
        let copies = files
            .iter()
            .map(|p| pick(&self.blobs, p))
            .collect::<AppResult<Vec<_>>>()?;
        self.with_ctx(|ctx, identity, fx| {
            let (info, text) = check_send(ctx, conv, text, copies.len(), reply_to.as_deref())?;
            let audience = ctx.audience(&info)?;
            let mut picked: Vec<String> = Vec::new();
            for m in mentions {
                if audience.contains(&m) && !picked.contains(&m) && picked.len() < MAX_MENTIONS {
                    picked.push(m);
                }
            }
            let now = clock::now();
            let now_s = format_time(now);
            let refs = copies
                .iter()
                .map(|p| attach(ctx, &self.blobs, p, conv, &now_s))
                .collect::<AppResult<Vec<_>>>()?;
            let body = Body::Message {
                conv: conv.to_owned(),
                text,
                reply_to,
                mentions: picked,
                files: refs.clone(),
            };
            let rec = store::create(ctx, identity, body, now, fx)?;
            let me = ctx.me().to_owned();
            let offline: Vec<String> = audience
                .into_iter()
                .filter(|p| *p != me && !connected.contains(p))
                .collect();
            make_envelopes(ctx, identity, &self.blobs, &rec, &refs, &offline, fx)?;
            let row = read::message_row(ctx.conn, &rec.id)?
                .ok_or_else(|| AppError::Internal("Pesan baru tidak tersimpan.".into()))?;
            let facts = read::conv_facts(ctx, &info)?;
            read::message_view(ctx, &self.blobs, &facts, &row)
        })
    }

    pub fn delete_message(&self, conv: &str, message_id: &str) -> AppResult<()> {
        self.with_ctx(|ctx, identity, fx| {
            require_member(ctx)?;
            let info = readable(ctx, conv)?;
            let row = read::message_row(ctx.conn, message_id)?
                .filter(|m| m.conv == conv && !m.deleted)
                .ok_or_else(|| {
                    AppError::NotFound("Pesan tidak ditemukan atau sudah dihapus.".into())
                })?;
            let mine = row.author == ctx.me();
            if !mine && (!info.is_channel() || !ctx.is_admin(&info, ctx.me())?) {
                return Err(forbidden("Kamu hanya bisa menghapus pesanmu sendiri."));
            }
            let body = Body::MessageDelete {
                conv: conv.to_owned(),
                message: row.id,
                message_author: row.author,
                message_at: row.at,
            };
            store::create(ctx, identity, body, clock::now(), fx)?;
            Ok(())
        })
    }

    pub fn mark_read(&self, conv: &str) -> AppResult<()> {
        self.with_ctx(|ctx, identity, fx| {
            require_member(ctx)?;
            readable(ctx, conv)?;
            let now = clock::now();
            ctx.conn.execute(
                "INSERT INTO chat_conv_settings (conv, opened_at) VALUES (?1, ?2)
                 ON CONFLICT (conv) DO UPDATE SET opened_at = excluded.opened_at",
                rusqlite::params![conv, format_time(now)],
            )?;
            let ids = read::unread_ids(ctx.conn, conv, ctx.me())?;
            for chunk in ids.chunks(MAX_RECEIPT_MESSAGES) {
                let body = Body::Receipt {
                    conv: conv.to_owned(),
                    state: ReceiptState::Read,
                    messages: chunk.to_vec(),
                };
                store::create(ctx, identity, body, now, fx)?;
            }
            Ok(())
        })
    }

    pub fn create_channel(
        &self,
        name: &str,
        scope: NewChannelScope,
    ) -> AppResult<ConversationSummary> {
        self.with_ctx(|ctx, identity, fx| {
            require_member(ctx)?;
            let me = ctx.me().to_owned();
            if !ctx.dir.is_full_member(&me) {
                return Err(forbidden("Tamu tidak bisa membuat channel."));
            }
            let name = model::normalize_channel_name(name).ok_or_else(|| {
                invalid("Nama channel hanya boleh huruf, angka, dan tanda hubung, maksimal 40 karakter.")
            })?;
            let scope = channel_scope(ctx, &me, scope)?;
            ensure_unique_name(ctx, &name, &scope)?;
            let body = Body::ChannelCreate {
                channel: model::random_hex32(),
                name,
                scope,
            };
            let rec = store::create(ctx, identity, body, clock::now(), fx)?;
            let conv = rec.body().conv().ok_or_else(|| AppError::Internal("Channel tanpa id.".into()))?;
            let info = ctx.conv(&conv)?.ok_or_else(read::not_found_conv)?;
            read::summary(ctx, &info)
        })
    }

    pub fn set_archived(&self, conv: &str, archived: bool) -> AppResult<()> {
        self.with_ctx(|ctx, identity, fx| {
            require_member(ctx)?;
            let info = readable(ctx, conv)?;
            if !info.is_channel() {
                return Err(invalid("Chat pribadi tidak bisa diarsipkan."));
            }
            if info.scope == Scope::Umum {
                return Err(forbidden("#umum tidak bisa diarsipkan."));
            }
            if !read::can_admin_channel(ctx, &info)? {
                return Err(forbidden("Hanya admin channel ini yang bisa mengarsipkan."));
            }
            if info.archived == archived {
                return Ok(());
            }
            let body = Body::ChannelArchive {
                conv: conv.to_owned(),
                archived,
            };
            store::create(ctx, identity, body, after_last_archive(ctx, conv)?, fx)?;
            Ok(())
        })
    }

    pub fn delete_channel(&self, conv: &str) -> AppResult<()> {
        self.with_ctx(|ctx, identity, fx| {
            require_member(ctx)?;
            let info = readable(ctx, conv)?;
            if !info.is_channel() {
                return Err(invalid("Chat pribadi tidak bisa dihapus."));
            }
            if info.scope == Scope::Umum {
                return Err(forbidden("#umum tidak bisa dihapus."));
            }
            if !read::can_admin_channel(ctx, &info)? {
                return Err(forbidden("Hanya admin channel ini yang bisa menghapusnya."));
            }
            let body = Body::ChannelDelete {
                conv: conv.to_owned(),
            };
            store::create(ctx, identity, body, clock::now(), fx)?;
            Ok(())
        })
    }

    pub fn open_dm(&self, public_key: &str) -> AppResult<ConversationSummary> {
        self.with_ctx(|ctx, _, fx| {
            require_member(ctx)?;
            let me = ctx.me().to_owned();
            if !model::is_key(public_key) {
                return Err(invalid("Kunci rekan tidak valid."));
            }
            if public_key == me {
                return Err(invalid("Pilih rekan lain, bukan diri sendiri."));
            }
            if !ctx.dir.is_full_member(&me) {
                return Err(forbidden("Tamu tidak bisa memakai chat pribadi."));
            }
            if ctx.dir.member(public_key).is_none() {
                return Err(AppError::NotFound("Rekan ini tidak ditemukan.".into()));
            }
            if !dm_allowed(&ctx.dir, &me, public_key) {
                return Err(forbidden("Rekan ini tidak bisa diajak chat pribadi."));
            }
            let conv = model::dm_conv(&me, public_key);
            ctx.conn.execute(
                "INSERT INTO chat_conv_settings (conv, opened_at) VALUES (?1, ?2)
                 ON CONFLICT (conv) DO UPDATE SET opened_at = coalesce(chat_conv_settings.opened_at, excluded.opened_at)",
                rusqlite::params![conv, format_time(clock::now())],
            )?;
            fx.visible = true;
            let info = ctx.conv(&conv)?.ok_or_else(read::not_found_conv)?;
            read::summary(ctx, &info)
        })
    }

    pub fn set_notify(&self, mode: NotifyMode) -> AppResult<()> {
        self.with_ctx(|ctx, _, fx| {
            crate::settings::set(ctx.conn, NOTIFY_SETTING, mode.as_str())?;
            fx.visible = true;
            Ok(())
        })
    }

    pub fn set_muted(&self, conv: &str, muted: bool) -> AppResult<()> {
        self.with_ctx(|ctx, _, fx| {
            require_member(ctx)?;
            readable(ctx, conv)?;
            ctx.conn.execute(
                "INSERT INTO chat_conv_settings (conv, muted) VALUES (?1, ?2)
                 ON CONFLICT (conv) DO UPDATE SET muted = excluded.muted",
                rusqlite::params![conv, muted],
            )?;
            fx.visible = true;
            Ok(())
        })
    }
}

/// Now, or one second after the latest archive record when the clock is
/// behind it, so a local change always wins last-writer-wins.
fn after_last_archive(ctx: &Ctx, conv: &str) -> AppResult<time::OffsetDateTime> {
    let now = clock::now();
    let last: Option<String> = ctx
        .conn
        .query_row(
            "SELECT archive_at FROM chat_channels WHERE conv = ?1",
            [conv],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    let last = last
        .as_deref()
        .and_then(crate::permissions::format::parse_time);
    Ok(match last {
        Some(t) if t >= now => t + time::Duration::seconds(1),
        _ => now,
    })
}

fn channel_scope(ctx: &Ctx, me: &str, scope: NewChannelScope) -> AppResult<ChannelScope> {
    match (scope.kind, scope.id) {
        (ScopeKind::Org, _) => {
            if !ctx.dir.is_superadmin(me) {
                return Err(forbidden(
                    "Hanya superadmin yang bisa membuat channel untuk seluruh kantor.",
                ));
            }
            Ok(ChannelScope::Org)
        }
        (ScopeKind::Team, Some(id)) => {
            if ctx.dir.team(&id).is_none() {
                return Err(AppError::NotFound("Tim tidak ditemukan.".into()));
            }
            if !ctx.dir.in_team(&id, me) {
                return Err(forbidden("Kamu bukan anggota tim ini."));
            }
            Ok(ChannelScope::Team { id })
        }
        (ScopeKind::Project, Some(id)) => {
            if ctx.projects.project(ctx.conn, &id)?.is_none() {
                return Err(AppError::NotFound("Proyek tidak ditemukan.".into()));
            }
            if !ctx.projects.is_member(ctx.conn, &id, me)? {
                return Err(forbidden("Kamu bukan anggota proyek ini."));
            }
            Ok(ChannelScope::Project { id })
        }
        (_, None) => Err(invalid("Pilih tim atau proyek untuk channel ini.")),
    }
}

fn ensure_unique_name(ctx: &Ctx, name: &str, scope: &ChannelScope) -> AppResult<()> {
    let wanted = match scope {
        ChannelScope::Org => None,
        ChannelScope::Team { id } | ChannelScope::Project { id } => Some(id.as_str()),
    };
    for conv in ctx.all_channel_convs()? {
        let Some(info) = ctx.conv(&conv)? else {
            continue;
        };
        let same_scope = match (&info.scope, wanted) {
            (Scope::Umum | Scope::Org, None) => matches!(scope, ChannelScope::Org),
            (Scope::Team(t), Some(id)) => matches!(scope, ChannelScope::Team { .. }) && t == id,
            (Scope::Project(p), Some(id)) => {
                matches!(scope, ChannelScope::Project { .. }) && p == id
            }
            _ => false,
        };
        if same_scope && !info.deleted && info.name == name {
            return Err(invalid(&format!("Channel #{name} sudah ada.")));
        }
    }
    Ok(())
}

fn build_overview(ctx: &Ctx) -> AppResult<ChatOverview> {
    let me = ctx.me().to_owned();
    let mut convs = Vec::new();
    for conv in ctx.all_channel_convs()? {
        let Some(info) = ctx.conv(&conv)? else {
            continue;
        };
        if !info.deleted && ctx.in_audience(&info, &me)? {
            convs.push(read::summary(ctx, &info)?);
        }
    }
    let mut stmt = ctx.conn.prepare(
        "SELECT conv FROM chat_messages WHERE conv LIKE 'dm:%'
         UNION SELECT conv FROM chat_conv_settings WHERE conv LIKE 'dm:%' AND opened_at IS NOT NULL",
    )?;
    let dms = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for conv in dms {
        let Some(info) = ctx.conv(&conv)? else {
            continue;
        };
        if read::dm_peer(&info, &me).is_some()
            && matches!(&info.scope, Scope::Direct(a, b) if *a == me || *b == me)
        {
            convs.push(read::summary(ctx, &info)?);
        }
    }
    convs.sort_by(|a, b| {
        let group = |s: &ConversationSummary| {
            if s.archived {
                2
            } else if s.kind == super::view::ConversationKind::Channel {
                0
            } else {
                1
            }
        };
        group(a)
            .cmp(&group(b))
            .then_with(|| b.last_at.cmp(&a.last_at))
            .then_with(|| a.name.cmp(&b.name))
    });
    let people_keys: Vec<String> = ctx
        .dir
        .full_members()
        .into_iter()
        .filter(|p| *p != me)
        .collect();
    let mut teams: Vec<TeamRef> = ctx
        .dir
        .teams
        .iter()
        .filter(|(id, _)| ctx.dir.in_team(id, &me))
        .map(|(id, t)| TeamRef {
            id: id.clone(),
            name: t.name.clone(),
        })
        .collect();
    teams.sort_by(|a, b| a.name.cmp(&b.name));
    let mut projects = Vec::new();
    for p in ctx.projects.projects(ctx.conn)? {
        if ctx.projects.is_member(ctx.conn, &p.id, &me)? {
            projects.push(ProjectRef {
                id: p.id,
                name: p.name,
                team_id: p.team_id,
            });
        }
    }
    let full = ctx.dir.is_full_member(&me);
    let notify = crate::settings::get(ctx.conn, NOTIFY_SETTING)?
        .map_or(NotifyMode::All, |m| NotifyMode::parse(&m));
    Ok(ChatOverview {
        me: me.clone(),
        can_create_channel: full,
        can_create_org_channel: full && ctx.dir.is_superadmin(&me),
        can_direct_message: full,
        conversations: convs,
        people: read::people(&ctx.dir, &people_keys),
        teams,
        projects,
        notify,
    })
}
