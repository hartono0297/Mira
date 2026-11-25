//! Checks for sticker images (docs/plans/chat-sticker.md 4). Pure: bytes in,
//! verdict out. The type comes from the file's own bytes, never from its
//! name or a peer's claim: PNG (APNG too), GIF and WebP only. SVG and
//! everything else is refused, so Mira never renders a user's SVG.
//!
//! The parsers only walk container structure (chunks, blocks); they never
//! decode pixels. Every read goes through `get` and `checked_add`, so no
//! input can panic, and every loop step moves forward by at least one byte,
//! so time is linear in the file size.
//!
//! Decisions on damaged files:
//! - PNG: IHDR must come first, at least one IDAT must follow, and every
//!   chunk must be whole. A missing IEND after whole chunks is accepted;
//!   bytes after IEND are ignored. CRCs are not checked.
//! - GIF: a missing trailer is accepted when the data stops exactly between
//!   blocks after at least one whole frame (browsers show such files).
//!   Data cut inside any block is `Corrupt`.
//! - WebP: the RIFF size may be smaller than the file (the tail is ignored)
//!   but never larger. A missing pad byte at the very end is tolerated.

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
    let (mime, ext, image) = if bytes.starts_with(&PNG_SIGNATURE) {
        ("image/png", "png", parse_png(bytes)?)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        ("image/gif", "gif", parse_gif(bytes)?)
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(&b"WEBP"[..]) {
        ("image/webp", "webp", parse_webp(bytes)?)
    } else {
        return Err(StickerFileError::UnsupportedType);
    };
    if image.width == 0 || image.height == 0 || image.frames == 0 {
        return Err(StickerFileError::Corrupt);
    }
    if image.width > MAX_STICKER_SIDE || image.height > MAX_STICKER_SIDE {
        return Err(StickerFileError::TooWide);
    }
    if image.frames > MAX_STICKER_FRAMES {
        return Err(StickerFileError::TooManyFrames);
    }
    Ok(StickerInfo { mime, ext, width: image.width, height: image.height, frames: image.frames })
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Size and frame count read from a header, before the limits are applied.
struct Image {
    width: u32,
    height: u32,
    frames: u32,
}

const CORRUPT: StickerFileError = StickerFileError::Corrupt;

fn offset(pos: usize, add: usize) -> Result<usize, StickerFileError> {
    pos.checked_add(add).ok_or(CORRUPT)
}

fn slice(bytes: &[u8], start: usize, len: usize) -> Result<&[u8], StickerFileError> {
    bytes.get(start..offset(start, len)?).ok_or(CORRUPT)
}

fn array<const N: usize>(bytes: &[u8], at: usize) -> Result<[u8; N], StickerFileError> {
    <[u8; N]>::try_from(slice(bytes, at, N)?).map_err(|_| CORRUPT)
}

fn byte(bytes: &[u8], at: usize) -> Result<u8, StickerFileError> {
    bytes.get(at).copied().ok_or(CORRUPT)
}

fn be_u32(bytes: &[u8], at: usize) -> Result<u32, StickerFileError> {
    array(bytes, at).map(u32::from_be_bytes)
}

fn le_u32(bytes: &[u8], at: usize) -> Result<u32, StickerFileError> {
    array(bytes, at).map(u32::from_le_bytes)
}

fn le_u16(bytes: &[u8], at: usize) -> Result<u16, StickerFileError> {
    array(bytes, at).map(u16::from_le_bytes)
}

fn le_u24(bytes: &[u8], at: usize) -> Result<u32, StickerFileError> {
    let [a, b, c] = array::<3>(bytes, at)?;
    Ok(u32::from_le_bytes([a, b, c, 0]))
}

/// PNG and APNG: walk the chunk list after the signature.
fn parse_png(bytes: &[u8]) -> Result<Image, StickerFileError> {
    let mut pos = PNG_SIGNATURE.len();
    let mut size: Option<(u32, u32)> = None;
    let mut frames: Option<u32> = None;
    let mut seen_idat = false;
    while pos < bytes.len() {
        let len = be_u32(bytes, pos)?;
        if len > 0x7FFF_FFFF {
            return Err(CORRUPT);
        }
        let kind: [u8; 4] = array(bytes, offset(pos, 4)?)?;
        let data = slice(bytes, offset(pos, 8)?, len as usize)?;
        // Length, type, data, CRC.
        let next = offset(offset(pos, 12)?, len as usize)?;
        if next > bytes.len() {
            return Err(CORRUPT);
        }
        match (&kind, size) {
            (b"IHDR", None) if len == 13 => size = Some((be_u32(data, 0)?, be_u32(data, 4)?)),
            (_, None) | (b"IHDR", Some(_)) => return Err(CORRUPT),
            (b"acTL", Some(_)) if !seen_idat => {
                if frames.is_some() || len != 8 {
                    return Err(CORRUPT);
                }
                frames = Some(be_u32(data, 0)?);
            }
            (b"IDAT", Some(_)) => seen_idat = true,
            (b"IEND", Some(_)) => break,
            _ => {}
        }
        pos = next;
    }
    let (width, height) = size.ok_or(CORRUPT)?;
    if !seen_idat {
        return Err(CORRUPT);
    }
    Ok(Image { width, height, frames: frames.unwrap_or(1) })
}

/// Bytes in a GIF color table whose flags byte is `packed`, or 0 if absent.
fn gif_color_table_len(packed: u8) -> usize {
    if packed & 0x80 == 0 {
        0
    } else {
        3 << ((packed & 0x07) + 1)
    }
}

/// Skips GIF data sub-blocks starting at `pos`; returns the position after
/// the zero-length terminator.
fn skip_gif_sub_blocks(bytes: &[u8], mut pos: usize) -> Result<usize, StickerFileError> {
    loop {
        let size = byte(bytes, pos)? as usize;
        pos = offset(pos, 1 + size)?;
        if size == 0 {
            return Ok(pos);
        }
        if pos > bytes.len() {
            return Err(CORRUPT);
        }
    }
}

/// GIF87a and GIF89a: canvas size from the logical screen descriptor,
/// frames by counting image descriptors.
fn parse_gif(bytes: &[u8]) -> Result<Image, StickerFileError> {
    let width = u32::from(le_u16(bytes, 6)?);
    let height = u32::from(le_u16(bytes, 8)?);
    let packed = byte(bytes, 10)?;
    // Background color index and pixel aspect ratio.
    slice(bytes, 11, 2)?;
    let mut pos = offset(13, gif_color_table_len(packed))?;
    if pos > bytes.len() {
        return Err(CORRUPT);
    }
    let mut frames: u32 = 0;
    // Stopping between blocks without a trailer is accepted (module docs).
    while let Some(&block) = bytes.get(pos) {
        match block {
            0x3B => break,
            0x21 => {
                // Introducer, label, then sub-blocks.
                byte(bytes, offset(pos, 1)?)?;
                pos = skip_gif_sub_blocks(bytes, offset(pos, 2)?)?;
            }
            0x2C => {
                // Separator, left, top, width, height (u16 each), flags.
                let flags = byte(bytes, offset(pos, 9)?)?;
                pos = offset(offset(pos, 10)?, gif_color_table_len(flags))?;
                // LZW minimum code size, then image data sub-blocks.
                byte(bytes, pos)?;
                pos = skip_gif_sub_blocks(bytes, offset(pos, 1)?)?;
                frames = frames.saturating_add(1);
            }
            _ => return Err(CORRUPT),
        }
    }
    Ok(Image { width, height, frames })
}

/// One RIFF chunk at `pos`: its FourCC, its data, and where the next chunk
/// starts (after the pad byte for odd sizes; may be one past `body`).
fn riff_chunk(body: &[u8], pos: usize) -> Result<([u8; 4], &[u8], usize), StickerFileError> {
    let kind: [u8; 4] = array(body, pos)?;
    let len = le_u32(body, offset(pos, 4)?)? as usize;
    let start = offset(pos, 8)?;
    let data = slice(body, start, len)?;
    let next = offset(offset(start, len)?, len & 1)?;
    Ok((kind, data, next))
}

/// Lossy bitstream: frame tag, start code, 14-bit width and height.
fn vp8_size(data: &[u8]) -> Result<(u32, u32), StickerFileError> {
    // Bit 0 of the frame tag is clear for a key frame.
    if byte(data, 0)? & 0x01 != 0 || slice(data, 3, 3)? != [0x9D, 0x01, 0x2A] {
        return Err(CORRUPT);
    }
    let width = u32::from(le_u16(data, 6)? & 0x3FFF);
    let height = u32::from(le_u16(data, 8)? & 0x3FFF);
    Ok((width, height))
}

/// Lossless bitstream: signature, then 14-bit width-1 and height-1.
fn vp8l_size(data: &[u8]) -> Result<(u32, u32), StickerFileError> {
    if byte(data, 0)? != 0x2F {
        return Err(CORRUPT);
    }
    let bits = le_u32(data, 1)?;
    // The top three bits are a version number that must be 0.
    if bits >> 29 != 0 {
        return Err(CORRUPT);
    }
    Ok(((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1))
}

/// WebP: simple lossy (`VP8 `), simple lossless (`VP8L`) or extended
/// (`VP8X`, which may be animated with `ANMF` frames).
fn parse_webp(bytes: &[u8]) -> Result<Image, StickerFileError> {
    let riff_size = le_u32(bytes, 4)? as usize;
    let end = offset(8, riff_size)?;
    if riff_size < 4 {
        return Err(CORRUPT);
    }
    let body = bytes.get(..end).ok_or(CORRUPT)?;
    let (kind, data, mut pos) = riff_chunk(body, 12)?;
    let still = |(width, height): (u32, u32)| Image { width, height, frames: 1 };
    match &kind {
        b"VP8 " => vp8_size(data).map(still),
        b"VP8L" => vp8l_size(data).map(still),
        b"VP8X" => {
            let flags = byte(data, 0)?;
            let width = le_u24(data, 4)? + 1;
            let height = le_u24(data, 7)? + 1;
            let mut anmf: u32 = 0;
            let mut has_image = false;
            while pos < body.len() {
                let (kind, _, next) = riff_chunk(body, pos)?;
                match &kind {
                    b"ANMF" => anmf = anmf.saturating_add(1),
                    b"VP8 " | b"VP8L" => has_image = true,
                    _ => {}
                }
                pos = next;
            }
            let frames = if flags & 0x02 != 0 {
                anmf
            } else if has_image {
                1
            } else {
                0
            };
            Ok(Image { width, height, frames })
        }
        _ => Err(CORRUPT),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

    // ---- PNG builders ----------------------------------------------------

    fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        // CRC is not checked by the parser; a fixed value is enough.
        out.extend_from_slice(&[0, 0, 0, 0]);
        out
    }

    fn ihdr(width: u32, height: u32) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&width.to_be_bytes());
        data.extend_from_slice(&height.to_be_bytes());
        // Bit depth 8, RGBA, deflate, adaptive filter, no interlace.
        data.extend_from_slice(&[8, 6, 0, 0, 0]);
        png_chunk(b"IHDR", &data)
    }

    fn png_with(width: u32, height: u32, frames: Option<u32>, idat_len: usize) -> Vec<u8> {
        let mut out = PNG_SIG.to_vec();
        out.extend(ihdr(width, height));
        if let Some(n) = frames {
            let mut actl = n.to_be_bytes().to_vec();
            actl.extend_from_slice(&0u32.to_be_bytes());
            out.extend(png_chunk(b"acTL", &actl));
        }
        out.extend(png_chunk(b"IDAT", &vec![0x78; idat_len]));
        out.extend(png_chunk(b"IEND", &[]));
        out
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        png_with(width, height, None, 10)
    }

    fn apng(width: u32, height: u32, frames: u32) -> Vec<u8> {
        png_with(width, height, Some(frames), 10)
    }

    // ---- GIF builders ----------------------------------------------------

    fn gif_frame() -> Vec<u8> {
        let mut out = Vec::new();
        // Graphic control extension.
        out.extend_from_slice(&[0x21, 0xF9, 0x04, 0x00, 0x0A, 0x00, 0x00, 0x00]);
        // Image descriptor: 1x1 at (0, 0), no local color table.
        out.extend_from_slice(&[0x2C, 0, 0, 0, 0, 1, 0, 1, 0, 0x00]);
        // LZW minimum code size, one data sub-block, terminator.
        out.extend_from_slice(&[0x02, 0x02, 0x44, 0x01, 0x00]);
        out
    }

    fn gif_head(width: u16, height: u16) -> Vec<u8> {
        let mut out = b"GIF89a".to_vec();
        out.extend_from_slice(&width.to_le_bytes());
        out.extend_from_slice(&height.to_le_bytes());
        // Global color table of 2 entries, background 0, aspect 0.
        out.extend_from_slice(&[0x80, 0x00, 0x00]);
        out.extend_from_slice(&[0, 0, 0, 255, 255, 255]);
        // Netscape looping extension, to exercise application extensions.
        out.extend_from_slice(&[0x21, 0xFF, 0x0B]);
        out.extend_from_slice(b"NETSCAPE2.0");
        out.extend_from_slice(&[0x03, 0x01, 0x00, 0x00, 0x00]);
        out
    }

    fn gif(width: u16, height: u16, frames: u32) -> Vec<u8> {
        let mut out = gif_head(width, height);
        for _ in 0..frames {
            out.extend(gif_frame());
        }
        out.push(0x3B);
        out
    }

    // ---- WebP builders ---------------------------------------------------

    fn riff_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = kind.to_vec();
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(data);
        if data.len() % 2 == 1 {
            out.push(0);
        }
        out
    }

    fn riff(chunks: &[Vec<u8>]) -> Vec<u8> {
        let body: Vec<u8> = chunks.concat();
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
        out.extend_from_slice(b"WEBP");
        out.extend(body);
        out
    }

    fn vp8_chunk(width: u16, height: u16) -> Vec<u8> {
        // Key frame tag (bit 0 clear), start code, 14-bit sizes, some data.
        let mut data = vec![0x50, 0x02, 0x00, 0x9D, 0x01, 0x2A];
        data.extend_from_slice(&width.to_le_bytes());
        data.extend_from_slice(&height.to_le_bytes());
        data.extend_from_slice(&[0x01, 0x02, 0x03]);
        riff_chunk(b"VP8 ", &data)
    }

    fn vp8l_chunk(width: u32, height: u32) -> Vec<u8> {
        let bits = (width - 1) | ((height - 1) << 14);
        let mut data = vec![0x2F];
        data.extend_from_slice(&bits.to_le_bytes());
        data.extend_from_slice(&[0x00, 0x00]);
        riff_chunk(b"VP8L", &data)
    }

    fn vp8x_chunk(flags: u8, width: u32, height: u32) -> Vec<u8> {
        let mut data = vec![flags, 0, 0, 0];
        data.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
        data.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
        riff_chunk(b"VP8X", &data)
    }

    fn anmf_chunk() -> Vec<u8> {
        // Frame x, y, width-1, height-1 (24 bits each), duration, flags.
        let mut data = vec![0; 16];
        data.extend(vp8l_chunk(1, 1));
        riff_chunk(b"ANMF", &data)
    }

    fn webp_lossy(width: u16, height: u16) -> Vec<u8> {
        riff(&[vp8_chunk(width, height)])
    }

    fn webp_lossless(width: u32, height: u32) -> Vec<u8> {
        riff(&[vp8l_chunk(width, height)])
    }

    fn webp_animated(width: u32, height: u32, frames: u32) -> Vec<u8> {
        let mut chunks = vec![
            vp8x_chunk(0x02, width, height),
            riff_chunk(b"ANIM", &[0, 0, 0, 0, 0, 0]),
        ];
        for _ in 0..frames {
            chunks.push(anmf_chunk());
        }
        riff(&chunks)
    }

    fn info(mime: &'static str, ext: &'static str, w: u32, h: u32, frames: u32) -> StickerInfo {
        StickerInfo { mime, ext, width: w, height: h, frames }
    }

    // ---- PNG ---------------------------------------------------------------

    #[test]
    fn png_one_pixel() {
        assert_eq!(inspect(&png(1, 1)), Ok(info("image/png", "png", 1, 1, 1)));
    }

    #[test]
    fn png_largest_side_is_accepted() {
        assert_eq!(inspect(&png(1024, 1024)), Ok(info("image/png", "png", 1024, 1024, 1)));
    }

    #[test]
    fn apng_three_frames() {
        assert_eq!(inspect(&apng(64, 32, 3)), Ok(info("image/png", "png", 64, 32, 3)));
    }

    #[test]
    fn apng_frame_limit() {
        assert_eq!(inspect(&apng(8, 8, 120)).map(|i| i.frames), Ok(120));
        assert_eq!(inspect(&apng(8, 8, 121)), Err(StickerFileError::TooManyFrames));
    }

    #[test]
    fn apng_zero_frames_is_corrupt() {
        assert_eq!(inspect(&apng(8, 8, 0)), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn actl_after_idat_is_ignored() {
        let mut bytes = PNG_SIG.to_vec();
        bytes.extend(ihdr(4, 4));
        bytes.extend(png_chunk(b"IDAT", &[1, 2, 3]));
        bytes.extend(png_chunk(b"acTL", &[0, 0, 0, 9, 0, 0, 0, 0]));
        bytes.extend(png_chunk(b"IEND", &[]));
        assert_eq!(inspect(&bytes).map(|i| i.frames), Ok(1));
    }

    #[test]
    fn png_too_wide() {
        assert_eq!(inspect(&png(2000, 10)), Err(StickerFileError::TooWide));
        assert_eq!(inspect(&png(10, 1025)), Err(StickerFileError::TooWide));
    }

    #[test]
    fn png_zero_side_is_corrupt() {
        assert_eq!(inspect(&png(0, 10)), Err(StickerFileError::Corrupt));
        assert_eq!(inspect(&png(10, 0)), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn png_truncated_ihdr_is_corrupt() {
        let full = png(1, 1);
        // Signature plus half of IHDR.
        assert_eq!(inspect(&full[..8 + 12]), Err(StickerFileError::Corrupt));
        // Signature only.
        assert_eq!(inspect(&full[..8]), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn png_first_chunk_must_be_ihdr() {
        let mut bytes = PNG_SIG.to_vec();
        bytes.extend(png_chunk(b"IDAT", &[1, 2, 3]));
        bytes.extend(ihdr(1, 1));
        bytes.extend(png_chunk(b"IEND", &[]));
        assert_eq!(inspect(&bytes), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn png_ihdr_wrong_length_is_corrupt() {
        let mut bytes = PNG_SIG.to_vec();
        bytes.extend(png_chunk(b"IHDR", &[0, 0, 0, 1, 0, 0, 0, 1]));
        bytes.extend(png_chunk(b"IDAT", &[1]));
        bytes.extend(png_chunk(b"IEND", &[]));
        assert_eq!(inspect(&bytes), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn png_without_idat_is_corrupt() {
        let mut bytes = PNG_SIG.to_vec();
        bytes.extend(ihdr(1, 1));
        bytes.extend(png_chunk(b"IEND", &[]));
        assert_eq!(inspect(&bytes), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn png_without_iend_after_complete_idat_is_accepted() {
        let mut bytes = PNG_SIG.to_vec();
        bytes.extend(ihdr(2, 2));
        bytes.extend(png_chunk(b"IDAT", &[1, 2, 3]));
        assert_eq!(inspect(&bytes), Ok(info("image/png", "png", 2, 2, 1)));
    }

    #[test]
    fn png_cut_inside_a_chunk_is_corrupt() {
        let full = png(1, 1);
        // Drop the last byte of the IEND CRC.
        assert_eq!(inspect(&full[..full.len() - 1]), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn png_giant_chunk_length_is_corrupt() {
        for len in [0xFFFF_FFFFu32, 0x7FFF_FFFF, 0x8000_0000, 1_000_000] {
            let mut bytes = PNG_SIG.to_vec();
            bytes.extend(ihdr(1, 1));
            bytes.extend_from_slice(&len.to_be_bytes());
            bytes.extend_from_slice(b"IDAT");
            bytes.extend_from_slice(&[0; 16]);
            assert_eq!(inspect(&bytes), Err(StickerFileError::Corrupt), "length {len:#x}");
        }
    }

    // ---- GIF ---------------------------------------------------------------

    #[test]
    fn gif_one_pixel() {
        assert_eq!(inspect(&gif(1, 1, 1)), Ok(info("image/gif", "gif", 1, 1, 1)));
    }

    #[test]
    fn gif87a_is_accepted() {
        let mut bytes = gif(3, 2, 1);
        bytes[..6].copy_from_slice(b"GIF87a");
        assert_eq!(inspect(&bytes), Ok(info("image/gif", "gif", 3, 2, 1)));
    }

    #[test]
    fn gif_frame_limit() {
        assert_eq!(inspect(&gif(10, 10, 120)).map(|i| i.frames), Ok(120));
        assert_eq!(inspect(&gif(10, 10, 121)), Err(StickerFileError::TooManyFrames));
    }

    #[test]
    fn gif_canvas_is_what_counts() {
        // The frame inside is 1x1; the canvas is too wide.
        assert_eq!(inspect(&gif(2000, 1, 1)), Err(StickerFileError::TooWide));
        // A frame larger than the canvas is fine.
        let mut bytes = gif_head(4, 4);
        let mut frame = gif_frame();
        // Frame width sits at 8 (control extension) + 5 in the frame bytes.
        frame[13] = 0xFF;
        frame[14] = 0x0F;
        bytes.extend(frame);
        bytes.push(0x3B);
        assert_eq!(inspect(&bytes), Ok(info("image/gif", "gif", 4, 4, 1)));
    }

    #[test]
    fn gif_with_local_color_table() {
        let mut bytes = gif_head(2, 2);
        bytes.extend_from_slice(&[0x2C, 0, 0, 0, 0, 2, 0, 2, 0, 0x81]);
        // Local color table of 4 entries.
        bytes.extend_from_slice(&[7; 12]);
        bytes.extend_from_slice(&[0x02, 0x01, 0x00, 0x00]);
        bytes.push(0x3B);
        assert_eq!(inspect(&bytes), Ok(info("image/gif", "gif", 2, 2, 1)));
    }

    #[test]
    fn gif_cut_inside_a_frame_is_corrupt() {
        let full = gif(5, 5, 2);
        // Drop the trailer and the last sub-block terminator.
        assert_eq!(inspect(&full[..full.len() - 2]), Err(StickerFileError::Corrupt));
        // Cut inside the image descriptor of the first frame.
        let head = gif_head(5, 5).len();
        assert_eq!(inspect(&full[..head + 8 + 4]), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn gif_missing_trailer_after_whole_frame_is_accepted() {
        let full = gif(5, 5, 2);
        assert_eq!(inspect(&full[..full.len() - 1]), Ok(info("image/gif", "gif", 5, 5, 2)));
    }

    #[test]
    fn gif_without_frames_is_corrupt() {
        assert_eq!(inspect(&gif(5, 5, 0)), Err(StickerFileError::Corrupt));
        assert_eq!(inspect(&gif_head(5, 5)), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn gif_unknown_block_is_corrupt() {
        let mut bytes = gif_head(5, 5);
        bytes.extend(gif_frame());
        bytes.push(0x99);
        bytes.push(0x3B);
        assert_eq!(inspect(&bytes), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn gif_zero_side_is_corrupt() {
        assert_eq!(inspect(&gif(0, 5, 1)), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn gif_truncated_header_is_corrupt() {
        assert_eq!(inspect(b"GIF89a\x01\x00"), Err(StickerFileError::Corrupt));
        // Global color table flag set but the table is missing.
        assert_eq!(
            inspect(b"GIF89a\x01\x00\x01\x00\x87\x00\x00\x2C"),
            Err(StickerFileError::Corrupt)
        );
    }

    // ---- WebP --------------------------------------------------------------

    #[test]
    fn webp_lossy_is_accepted() {
        assert_eq!(inspect(&webp_lossy(30, 20)), Ok(info("image/webp", "webp", 30, 20, 1)));
    }

    #[test]
    fn webp_lossy_scale_bits_are_ignored() {
        let mut bytes = webp_lossy(30, 20);
        // Width high byte sits at 12 + 8 + 7; set the two scale bits.
        bytes[12 + 8 + 7] |= 0xC0;
        assert_eq!(inspect(&bytes).map(|i| i.width), Ok(30));
    }

    #[test]
    fn webp_lossy_needs_start_code() {
        let mut bytes = webp_lossy(30, 20);
        bytes[12 + 8 + 3] = 0x00;
        assert_eq!(inspect(&bytes), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn webp_lossless_is_accepted() {
        assert_eq!(inspect(&webp_lossless(17, 300)), Ok(info("image/webp", "webp", 17, 300, 1)));
        assert_eq!(inspect(&webp_lossless(1025, 3)), Err(StickerFileError::TooWide));
    }

    #[test]
    fn webp_lossless_needs_signature() {
        let mut bytes = webp_lossless(17, 30);
        bytes[12 + 8] = 0x2E;
        assert_eq!(inspect(&bytes), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn webp_animated_two_frames() {
        assert_eq!(inspect(&webp_animated(48, 40, 2)), Ok(info("image/webp", "webp", 48, 40, 2)));
    }

    #[test]
    fn webp_animated_frame_limit() {
        assert_eq!(inspect(&webp_animated(8, 8, 120)).map(|i| i.frames), Ok(120));
        assert_eq!(inspect(&webp_animated(8, 8, 121)), Err(StickerFileError::TooManyFrames));
    }

    #[test]
    fn webp_animated_without_frames_is_corrupt() {
        assert_eq!(inspect(&webp_animated(8, 8, 0)), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn webp_extended_still_image() {
        let bytes = riff(&[vp8x_chunk(0x10, 640, 480), vp8l_chunk(640, 480)]);
        assert_eq!(inspect(&bytes), Ok(info("image/webp", "webp", 640, 480, 1)));
        let canvas_only = riff(&[vp8x_chunk(0x00, 64, 48)]);
        assert_eq!(inspect(&canvas_only), Err(StickerFileError::Corrupt));
        let too_wide = riff(&[vp8x_chunk(0x00, 5000, 48), vp8l_chunk(1, 1)]);
        assert_eq!(inspect(&too_wide), Err(StickerFileError::TooWide));
    }

    #[test]
    fn webp_riff_size_larger_than_file_is_corrupt() {
        let mut bytes = webp_lossy(30, 20);
        let lie = (bytes.len() as u32) + 100;
        bytes[4..8].copy_from_slice(&lie.to_le_bytes());
        assert_eq!(inspect(&bytes), Err(StickerFileError::Corrupt));
        bytes[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(inspect(&bytes), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn webp_riff_size_smaller_than_file_ignores_the_tail() {
        let mut bytes = webp_lossy(30, 20);
        bytes.extend_from_slice(b"trailing junk");
        assert_eq!(inspect(&bytes).map(|i| i.width), Ok(30));
    }

    #[test]
    fn webp_riff_size_too_small_for_chunk_is_corrupt() {
        let mut bytes = webp_lossy(30, 20);
        bytes[4..8].copy_from_slice(&10u32.to_le_bytes());
        assert_eq!(inspect(&bytes), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn webp_giant_chunk_size_is_corrupt() {
        let mut bytes = webp_lossy(30, 20);
        bytes[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(inspect(&bytes), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn webp_unknown_first_chunk_is_corrupt() {
        let bytes = riff(&[riff_chunk(b"ABCD", &[1, 2, 3, 4])]);
        assert_eq!(inspect(&bytes), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn riff_that_is_not_webp_is_unsupported() {
        let mut bytes = webp_lossy(30, 20);
        bytes[8..12].copy_from_slice(b"WAVE");
        assert_eq!(inspect(&bytes), Err(StickerFileError::UnsupportedType));
    }

    // ---- Other types and limits --------------------------------------------

    #[test]
    fn empty_file() {
        assert_eq!(inspect(&[]), Err(StickerFileError::Empty));
    }

    #[test]
    fn svg_is_unsupported() {
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>"#;
        assert_eq!(inspect(svg), Err(StickerFileError::UnsupportedType));
        let xml = br#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>"#;
        assert_eq!(inspect(xml), Err(StickerFileError::UnsupportedType));
    }

    #[test]
    fn svg_with_bom_is_unsupported() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(br#"<svg xmlns="http://www.w3.org/2000/svg"/>"#);
        assert_eq!(inspect(&bytes), Err(StickerFileError::UnsupportedType));
    }

    #[test]
    fn jpeg_is_unsupported() {
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0x00];
        assert_eq!(inspect(&jpeg), Err(StickerFileError::UnsupportedType));
    }

    #[test]
    fn bmp_is_unsupported() {
        assert_eq!(inspect(b"BM\x3a\x00\x00\x00\x00\x00"), Err(StickerFileError::UnsupportedType));
    }

    #[test]
    fn text_named_png_is_unsupported() {
        assert_eq!(inspect(b"this is not a picture.png"), Err(StickerFileError::UnsupportedType));
        // A partial signature is not a PNG either.
        assert_eq!(inspect(&PNG_SIG[..5]), Err(StickerFileError::UnsupportedType));
    }

    #[test]
    fn size_limit() {
        let max = MAX_STICKER_BYTES as usize;
        // Signature 8 + IHDR 25 + IDAT framing 12 + IEND 12.
        let at_limit = png_with(1, 1, None, max - 57);
        assert_eq!(at_limit.len(), max);
        assert!(inspect(&at_limit).is_ok());
        let over = png_with(1, 1, None, max - 56);
        assert_eq!(inspect(&over), Err(StickerFileError::TooLarge));
        assert_eq!(inspect(&vec![0u8; max + 1]), Err(StickerFileError::TooLarge));
    }

    #[test]
    fn mime_to_ext() {
        assert_eq!(ext_for_mime("image/png"), Some("png"));
        assert_eq!(ext_for_mime("image/gif"), Some("gif"));
        assert_eq!(ext_for_mime("image/webp"), Some("webp"));
        assert_eq!(ext_for_mime("image/svg+xml"), None);
    }

    // ---- Robustness ----------------------------------------------------------

    /// xorshift64: fixed-seed randomness without a crate.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }

        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    fn valid_samples() -> Vec<Vec<u8>> {
        vec![
            png(1, 1),
            apng(16, 16, 3),
            gif(1, 1, 1),
            gif(8, 8, 4),
            webp_lossy(30, 20),
            webp_lossless(17, 30),
            webp_animated(48, 40, 2),
            riff(&[vp8x_chunk(0x10, 64, 48), vp8l_chunk(64, 48)]),
        ]
    }

    #[test]
    fn every_prefix_is_handled() {
        for sample in valid_samples() {
            assert!(inspect(&sample).is_ok());
            for n in 0..sample.len() {
                // Must return, never panic.
                let _ = inspect(&sample[..n]);
            }
        }
    }

    #[test]
    fn random_mutations_are_handled() {
        let mut rng = Rng(0x5EED_1234_ABCD_0001);
        let interesting = [0x00, 0x01, 0x7F, 0x80, 0xFF, 0x2C, 0x21, 0x3B];
        for sample in valid_samples() {
            for _ in 0..2000 {
                let mut bytes = sample.clone();
                let edits = 1 + rng.below(6);
                for _ in 0..edits {
                    let at = rng.below(bytes.len());
                    bytes[at] = if rng.below(2) == 0 {
                        interesting[rng.below(interesting.len())]
                    } else {
                        rng.next() as u8
                    };
                }
                if rng.below(4) == 0 {
                    let keep = rng.below(bytes.len() + 1);
                    bytes.truncate(keep);
                }
                let _ = inspect(&bytes);
            }
        }
    }

    #[test]
    fn many_tiny_gif_sub_blocks_stay_linear() {
        // One frame whose data is ~260k one-byte sub-blocks: must finish fast.
        let mut bytes = gif_head(4, 4);
        bytes.extend_from_slice(&[0x2C, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x02]);
        while bytes.len() < MAX_STICKER_BYTES as usize - 4 {
            bytes.extend_from_slice(&[0x01, 0x00]);
        }
        bytes.extend_from_slice(&[0x00, 0x3B]);
        assert_eq!(inspect(&bytes).map(|i| i.frames), Ok(1));
    }
}
