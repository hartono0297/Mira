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
//!
//! Decoder memory: a small file can declare huge frames (a 1x1 GIF canvas
//! with a 65535x65535 frame compresses to a few hundred bytes), and the
//! WebView would allocate for them. So every frame must be non-empty and lie
//! inside the canvas: GIF image descriptors, APNG `fcTL` and WebP `ANMF`.
//! A frame outside the canvas is `Corrupt` (the file contradicts its own
//! header), not `TooWide`, which is about the canvas the person sees. On top
//! of that, canvas pixels times frames is capped by `MAX_STICKER_PIXELS`.

/// Largest sticker file.
pub const MAX_STICKER_BYTES: u64 = 512 * 1024;
/// Largest width or height in pixels.
pub const MAX_STICKER_SIDE: u32 = 1024;
/// Most frames in an animated sticker (GIF, APNG, animated WebP).
pub const MAX_STICKER_FRAMES: u32 = 120;
/// Most pixels over all frames (width x height x frames), so decoding one
/// sticker stays around 128 MB of RGBA at worst.
pub const MAX_STICKER_PIXELS: u64 = 32_000_000;

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
    /// Width x height x frames over `MAX_STICKER_PIXELS`.
    TooManyPixels,
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
            StickerFileError::TooManyPixels => {
                "Sticker bergerak terlalu besar. Kecilkan gambarnya atau kurangi jumlah frame (paling banyak 32 juta piksel untuk semua frame)."
            }
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
    // Each factor is bounded above, so the product fits in u64.
    let pixels = u64::from(image.width) * u64::from(image.height) * u64::from(image.frames);
    if pixels > MAX_STICKER_PIXELS {
        return Err(StickerFileError::TooManyPixels);
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

/// A frame of `width` x `height` at (`x`, `y`) must be non-empty and lie
/// inside a canvas of `canvas_w` x `canvas_h`.
fn frame_fits(
    (x, y, width, height): (u32, u32, u32, u32),
    (canvas_w, canvas_h): (u32, u32),
) -> Result<(), StickerFileError> {
    let fits = |at: u32, len: u32, limit: u32| u64::from(at) + u64::from(len) <= u64::from(limit);
    if width == 0 || height == 0 || !fits(x, width, canvas_w) || !fits(y, height, canvas_h) {
        return Err(CORRUPT);
    }
    Ok(())
}

/// PNG and APNG: walk the chunk list after the signature.
fn parse_png(bytes: &[u8]) -> Result<Image, StickerFileError> {
    let mut pos = PNG_SIGNATURE.len();
    let mut size: Option<(u32, u32)> = None;
    let mut frames: Option<u32> = None;
    let mut frame_controls: u32 = 0;
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
            (b"fcTL", Some(canvas)) => {
                // Sequence, width, height, x offset, y offset, delays,
                // dispose and blend ops.
                if len != 26 {
                    return Err(CORRUPT);
                }
                let frame = (be_u32(data, 12)?, be_u32(data, 16)?, be_u32(data, 4)?, be_u32(data, 8)?);
                frame_fits(frame, canvas)?;
                frame_controls = frame_controls.saturating_add(1);
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
    // Without acTL the file is a still PNG and decoders ignore fcTL. With
    // it, more frame controls than declared frames is inconsistent; a
    // declared count over the limit is refused later as TooManyFrames.
    if frames.is_some_and(|n| frame_controls > n) {
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
                let field = |n: usize| -> Result<u32, StickerFileError> {
                    Ok(u32::from(le_u16(bytes, offset(pos, 1 + 2 * n)?)?))
                };
                frame_fits((field(0)?, field(1)?, field(2)?, field(3)?), (width, height))?;
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
                let (kind, chunk, next) = riff_chunk(body, pos)?;
                match &kind {
                    b"ANMF" => {
                        // X and Y are stored halved; width and height minus one.
                        let frame = (
                            le_u24(chunk, 0)? * 2,
                            le_u24(chunk, 3)? * 2,
                            le_u24(chunk, 6)? + 1,
                            le_u24(chunk, 9)? + 1,
                        );
                        // Duration and flags complete the 16-byte header.
                        slice(chunk, 12, 4)?;
                        frame_fits(frame, (width, height))?;
                        anmf = anmf.saturating_add(1);
                    }
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

    fn actl(frames: u32) -> Vec<u8> {
        let mut data = frames.to_be_bytes().to_vec();
        data.extend_from_slice(&0u32.to_be_bytes());
        png_chunk(b"acTL", &data)
    }

    fn fctl(width: u32, height: u32, x: u32, y: u32) -> Vec<u8> {
        let mut data = 0u32.to_be_bytes().to_vec();
        for v in [width, height, x, y] {
            data.extend_from_slice(&v.to_be_bytes());
        }
        // Delay 1/10 s, dispose none, blend source.
        data.extend_from_slice(&[0, 1, 0, 10, 0, 0]);
        png_chunk(b"fcTL", &data)
    }

    /// With `frames`, an APNG whose every frame covers the whole image: one
    /// fcTL before IDAT and the rest after it.
    fn png_with(width: u32, height: u32, frames: Option<u32>, idat_len: usize) -> Vec<u8> {
        let mut out = PNG_SIG.to_vec();
        out.extend(ihdr(width, height));
        if let Some(n) = frames {
            out.extend(actl(n));
            if n > 0 {
                out.extend(fctl(width, height, 0, 0));
            }
        }
        out.extend(png_chunk(b"IDAT", &vec![0x78; idat_len]));
        for _ in 1..frames.unwrap_or(0) {
            out.extend(fctl(width, height, 0, 0));
            out.extend(png_chunk(b"fdAT", &[0, 0, 0, 0, 0x78]));
        }
        out.extend(png_chunk(b"IEND", &[]));
        out
    }

    /// APNG of 4x4 with two frames, the second one given by `second`.
    fn apng_second_frame(second: Vec<u8>) -> Vec<u8> {
        let mut out = PNG_SIG.to_vec();
        out.extend(ihdr(4, 4));
        out.extend(actl(2));
        out.extend(fctl(4, 4, 0, 0));
        out.extend(png_chunk(b"IDAT", &[1, 2, 3]));
        out.extend(second);
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
        anmf_chunk_at(0, 0, 1, 1)
    }

    /// `x` and `y` are stored halved, as the format does.
    fn anmf_chunk_at(x: u32, y: u32, width: u32, height: u32) -> Vec<u8> {
        let mut data = Vec::new();
        for v in [x / 2, y / 2, width - 1, height - 1] {
            data.extend_from_slice(&v.to_le_bytes()[..3]);
        }
        // Duration (24 bits) and flags.
        data.extend_from_slice(&[100, 0, 0, 0]);
        data.extend(vp8l_chunk(width.min(1024), height.min(1024)));
        riff_chunk(b"ANMF", &data)
    }

    fn webp_with_frames(width: u32, height: u32, frames: Vec<Vec<u8>>) -> Vec<u8> {
        let mut chunks = vec![
            vp8x_chunk(0x02, width, height),
            riff_chunk(b"ANIM", &[0, 0, 0, 0, 0, 0]),
        ];
        chunks.extend(frames);
        riff(&chunks)
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
        // A frame wider than the canvas is refused.
        let mut frame = gif_frame();
        // Frame width sits at 8 (control extension) + 5 in the frame bytes.
        frame[13] = 0x05;
        assert_eq!(inspect(&gif_with_frame(4, 4, frame)), Err(StickerFileError::Corrupt));
    }

    /// GIF of `width` x `height` holding one frame given as raw bytes.
    fn gif_with_frame(width: u16, height: u16, frame: Vec<u8>) -> Vec<u8> {
        let mut bytes = gif_head(width, height);
        bytes.extend(frame);
        bytes.push(0x3B);
        bytes
    }

    /// Image descriptor plus a tiny data stream, for a frame at `left`,
    /// `top` of `w` x `h`.
    fn gif_frame_at(left: u16, top: u16, w: u16, h: u16) -> Vec<u8> {
        let mut out = vec![0x2C];
        for v in [left, top, w, h] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&[0x00, 0x02, 0x02, 0x44, 0x01, 0x00]);
        out
    }

    #[test]
    fn gif_giant_frame_in_tiny_canvas_is_refused() {
        // 1x1 canvas, 65535x65535 frame: a decoder would allocate gigabytes.
        let bytes = gif_with_frame(1, 1, gif_frame_at(0, 0, 0xFFFF, 0xFFFF));
        assert!(bytes.len() < 100);
        assert_eq!(inspect(&bytes), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn gif_frame_must_fit_the_canvas() {
        let fits = |l, t, w, h| inspect(&gif_with_frame(4, 3, gif_frame_at(l, t, w, h)));
        assert!(fits(0, 0, 4, 3).is_ok());
        assert!(fits(3, 2, 1, 1).is_ok());
        assert_eq!(fits(4, 0, 1, 1), Err(StickerFileError::Corrupt));
        assert_eq!(fits(0, 3, 1, 1), Err(StickerFileError::Corrupt));
        assert_eq!(fits(1, 0, 4, 1), Err(StickerFileError::Corrupt));
        assert_eq!(fits(0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF), Err(StickerFileError::Corrupt));
        assert_eq!(fits(0, 0, 0, 1), Err(StickerFileError::Corrupt));
        assert_eq!(fits(0, 0, 1, 0), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn gif_any_bad_frame_refuses_the_file() {
        let mut bytes = gif_head(4, 4);
        bytes.extend(gif_frame());
        bytes.extend(gif_frame_at(0, 0, 5, 5));
        bytes.push(0x3B);
        assert_eq!(inspect(&bytes), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn apng_frames_must_fit_the_image() {
        assert!(inspect(&apng_second_frame(fctl(2, 2, 2, 2))).is_ok());
        assert_eq!(inspect(&apng_second_frame(fctl(5, 1, 0, 0))), Err(StickerFileError::Corrupt));
        assert_eq!(inspect(&apng_second_frame(fctl(1, 5, 0, 0))), Err(StickerFileError::Corrupt));
        assert_eq!(inspect(&apng_second_frame(fctl(2, 2, 3, 0))), Err(StickerFileError::Corrupt));
        assert_eq!(inspect(&apng_second_frame(fctl(2, 2, 0, 3))), Err(StickerFileError::Corrupt));
        assert_eq!(inspect(&apng_second_frame(fctl(0, 2, 0, 0))), Err(StickerFileError::Corrupt));
        assert_eq!(inspect(&apng_second_frame(fctl(2, 0, 0, 0))), Err(StickerFileError::Corrupt));
        let overflow = fctl(2, 2, u32::MAX, u32::MAX);
        assert_eq!(inspect(&apng_second_frame(overflow)), Err(StickerFileError::Corrupt));
        let giant = fctl(0x7FFF_FFFF, 0x7FFF_FFFF, 0, 0);
        assert_eq!(inspect(&apng_second_frame(giant)), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn apng_fctl_must_be_whole() {
        let short = png_chunk(b"fcTL", &[0; 20]);
        assert_eq!(inspect(&apng_second_frame(short)), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn apng_more_fctl_than_actl_frames_is_corrupt() {
        let mut extra = fctl(4, 4, 0, 0);
        extra.extend(fctl(4, 4, 0, 0));
        assert_eq!(inspect(&apng_second_frame(extra)), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn webp_frames_must_fit_the_canvas() {
        let one = |frame| inspect(&webp_with_frames(8, 6, vec![frame]));
        assert!(one(anmf_chunk_at(0, 0, 8, 6)).is_ok());
        assert!(one(anmf_chunk_at(6, 4, 2, 2)).is_ok());
        assert_eq!(one(anmf_chunk_at(0, 0, 9, 1)), Err(StickerFileError::Corrupt));
        assert_eq!(one(anmf_chunk_at(0, 0, 1, 7)), Err(StickerFileError::Corrupt));
        assert_eq!(one(anmf_chunk_at(8, 0, 1, 1)), Err(StickerFileError::Corrupt));
        assert_eq!(one(anmf_chunk_at(0, 6, 1, 1)), Err(StickerFileError::Corrupt));
        let giant = anmf_chunk_at(0, 0, 1 << 24, 1 << 24);
        assert_eq!(one(giant), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn webp_anmf_header_must_be_whole() {
        let short = riff_chunk(b"ANMF", &[0; 10]);
        assert_eq!(inspect(&webp_with_frames(8, 6, vec![short])), Err(StickerFileError::Corrupt));
    }

    #[test]
    fn pixel_budget_over_all_frames() {
        // 1024 * 1024 * 30 = 31.4 million pixels: allowed.
        assert_eq!(inspect(&apng(1024, 1024, 30)).map(|i| i.frames), Ok(30));
        // 1024 * 1024 * 31 = 32.5 million: over the budget.
        assert_eq!(inspect(&apng(1024, 1024, 31)), Err(StickerFileError::TooManyPixels));
        assert_eq!(
            inspect(&webp_animated(1024, 1024, 31)),
            Err(StickerFileError::TooManyPixels)
        );
        // 1000 * 1000 * 32 is exactly the budget.
        assert_eq!(inspect(&gif(1000, 1000, 32)).map(|i| i.frames), Ok(32));
        assert_eq!(inspect(&gif(1000, 1000, 33)), Err(StickerFileError::TooManyPixels));
        // A still image at the largest side is far below it.
        assert!(inspect(&png(1024, 1024)).is_ok());
        assert!(StickerFileError::TooManyPixels.message().contains("32 juta"));
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
