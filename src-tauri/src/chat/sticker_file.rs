//! Checks for sticker images (docs/plans/chat-sticker.md 4). Pure: bytes in,
//! verdict out. The type comes from the file's own bytes, never from its
//! name or a peer's claim: PNG (APNG too), GIF and WebP only. SVG and
//! everything else is refused, so Mira never renders a user's SVG.
//!
//! STUB: the real parser is written by its own task.

/// Largest sticker file.
pub const MAX_STICKER_BYTES: u64 = 512 * 1024;
/// Largest width or height in pixels.
pub const MAX_STICKER_SIDE: u32 = 1024;
/// Most frames in an animated sticker (GIF, APNG, animated WebP).
pub const MAX_STICKER_FRAMES: u32 = 120;

/// What a valid sticker file is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StickerInfo {
    /// `image/png`, `image/gif` or `image/webp`.
    pub mime: &'static str,
    /// `png`, `gif` or `webp`.
    pub ext: &'static str,
    pub width: u32,
    pub height: u32,
    /// 1 for a still image.
    pub frames: u32,
}

/// Why a file is not a sticker. `message()` is shown to the person
/// (Indonesian; `src/i18n/errors-rust.en.ts` translates it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StickerFileError {
    Empty,
    TooLarge,
    /// Not PNG, GIF or WebP (SVG, JPEG, anything else).
    UnsupportedType,
    /// Header cut short or inconsistent.
    Corrupt,
    TooWide,
    TooManyFrames,
}

impl StickerFileError {
    pub fn message(self) -> &'static str {
        match self {
            StickerFileError::Empty => "File sticker kosong.",
            StickerFileError::TooLarge => "File sticker paling besar 512 KB.",
            StickerFileError::UnsupportedType => "Sticker harus berupa gambar PNG, WebP, atau GIF.",
            StickerFileError::Corrupt => "File sticker rusak atau tidak bisa dibaca.",
            StickerFileError::TooWide => "Ukuran gambar sticker paling besar 1024 x 1024 piksel.",
            StickerFileError::TooManyFrames => "Sticker bergerak paling banyak 120 frame.",
        }
    }
}

/// Checks `bytes` as a sticker image.
pub fn inspect(bytes: &[u8]) -> Result<StickerInfo, StickerFileError> {
    if bytes.is_empty() {
        return Err(StickerFileError::Empty);
    }
    if bytes.len() as u64 > MAX_STICKER_BYTES {
        return Err(StickerFileError::TooLarge);
    }
    Err(StickerFileError::UnsupportedType)
}

/// Extension for a checked `mime` (`image/png` → `png`).
pub fn ext_for_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}
