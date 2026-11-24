//! Office stickers, my own stickers and sticker messages (v0.5.1,
//! docs/plans/chat-sticker.md 2 to 4).
//!
//! STUB: written by its own task. Signatures are the contract; do not
//! change them without updating the callers in `model`, `judge`, `store`,
//! `read` and `commands`.

use std::path::Path;

use time::OffsetDateTime;

use super::audience::Ctx;
use super::judge::{Standing, Verdict};
use super::model::{FileRef, VerifiedRecord};
use super::store::Effects;
use super::sync::ChatSync;
use super::view::{
    FileView, MessageSticker, MessageView, MyStickerView, OfficeStickerState, OfficeStickerView,
    PickedSticker, StickerCatalog, StickerSource,
};
use crate::blobs::BlobStore;
use crate::error::{AppError, AppResult};

/// Field check for `Body::StickerSet` (called from `model`; `file` already
/// passed the generic file check).
pub fn validate_sticker_fields(
    _pack: &str,
    _name: &str,
    _keywords: &[String],
    _file: &FileRef,
) -> Result<(), String> {
    Ok(())
}

/// May the author make this `sticker_set` record?
pub(crate) fn judge(_ctx: &Ctx, _rec: &VerifiedRecord, _st: Standing) -> AppResult<Verdict> {
    Ok(Verdict::Defer)
}

/// Stores an accepted `sticker_set` record and updates
/// `chat_office_stickers`, queueing the image download.
pub fn apply(
    _ctx: &Ctx,
    _rec: &VerifiedRecord,
    _from: Option<&str>,
    _now: OffsetDateTime,
    _fx: &mut Effects,
) -> AppResult<()> {
    Ok(())
}

/// The sticker a message carries, if its text and files have the sticker
/// shape.
pub fn message_sticker(
    _ctx: &Ctx,
    _blobs: &BlobStore,
    _text: &str,
    _files: &[FileView],
) -> AppResult<Option<MessageSticker>> {
    Ok(None)
}

fn not_yet() -> AppError {
    AppError::Internal("Sticker belum tersedia.".into())
}

impl ChatSync {
    pub fn stickers(&self) -> AppResult<StickerCatalog> {
        Err(not_yet())
    }

    /// `data:` URL of a checked sticker image I may see.
    pub fn sticker_image(&self, _hash: &str) -> AppResult<String> {
        Err(not_yet())
    }

    /// Checks a file picked in Mira's sticker dialog.
    pub fn inspect_picked(&self, _path: &Path) -> AppResult<PickedSticker> {
        Err(not_yet())
    }

    pub fn my_sticker_add(
        &self,
        _path: &Path,
        _name: &str,
        _keywords: &[String],
    ) -> AppResult<MyStickerView> {
        Err(not_yet())
    }

    pub fn my_sticker_save(&self, _message_id: &str) -> AppResult<MyStickerView> {
        Err(not_yet())
    }

    pub fn my_sticker_remove(&self, _id: &str) -> AppResult<()> {
        Err(not_yet())
    }

    pub fn office_sticker_add(
        &self,
        _path: &Path,
        _pack: &str,
        _name: &str,
        _keywords: &[String],
    ) -> AppResult<OfficeStickerView> {
        Err(not_yet())
    }

    pub fn office_sticker_update(
        &self,
        _id: &str,
        _pack: &str,
        _name: &str,
        _keywords: &[String],
        _state: OfficeStickerState,
    ) -> AppResult<()> {
        Err(not_yet())
    }

    pub fn send_sticker(
        &self,
        _conv: &str,
        _source: StickerSource,
        _reply_to: Option<String>,
    ) -> AppResult<MessageView> {
        Err(not_yet())
    }
}
