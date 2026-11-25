//! Image processing for profile photos: format sniffing, bounded decoding,
//! EXIF orientation, cropping and metadata-free JPEG encoding.
//!
//! Every output is re-encoded from raw pixels, so no EXIF, GPS, XMP or ICC
//! data from the source file can reach a stored or shared photo.

use std::io::Cursor;

use ::image::codecs::jpeg::{JpegDecoder, JpegEncoder};
use ::image::codecs::png::PngDecoder;
use ::image::codecs::webp::WebPDecoder;
use ::image::imageops::{self, FilterType};
use ::image::metadata::Orientation;
use ::image::{
    DynamicImage, ExtendedColorType, ImageDecoder, ImageEncoder, ImageError, Limits, Rgb,
    RgbImage,
};

use super::{
    MAX_PHOTO_BYTES, MAX_SOURCE_BYTES, MAX_SOURCE_PIXELS, MAX_SOURCE_SIDE, PHOTO_ANIMATED,
    PHOTO_BROKEN, PHOTO_CROP, PHOTO_DIMENSIONS, PHOTO_FORMAT, PHOTO_SIZE, PHOTO_TOO_BIG,
    PREVIEW_SIDE, TARGET_PHOTO_BYTES,
};
use crate::error::{AppError, AppResult};

/// Shortest accepted side of a source image and of a crop box.
const MIN_SIDE: u32 = 16;
/// Decoder allocation budget. 24 M pixels of 16-bit RGBA is 192 MB.
const MAX_DECODE_BYTES: u64 = 256 * 1024 * 1024;
const PREVIEW_QUALITY: u8 = 85;
const PHOTO_QUALITY_START: u8 = 88;
const PHOTO_QUALITY_MIN: u8 = 50;
const PHOTO_QUALITY_STEP: u8 = 6;

const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";
const JPEG_MAGIC: &[u8] = &[0xFF, 0xD8, 0xFF];

fn invalid(msg: &str) -> AppError {
    AppError::InvalidInput(msg.to_owned())
}

/// Limit errors mean the header asked for too much; anything else is a
/// damaged or unreadable file.
fn decode_error(err: ImageError) -> AppError {
    match err {
        ImageError::Limits(_) => invalid(PHOTO_DIMENSIONS),
        _ => invalid(PHOTO_BROKEN),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceFormat {
    Png,
    Jpeg,
    WebP,
}

/// Detects the format from magic bytes only; the file name is never trusted.
pub fn sniff(bytes: &[u8]) -> Option<SourceFormat> {
    if bytes.starts_with(PNG_MAGIC) {
        Some(SourceFormat::Png)
    } else if bytes.starts_with(JPEG_MAGIC) {
        Some(SourceFormat::Jpeg)
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(SourceFormat::WebP)
    } else {
        None
    }
}

/// Decoded source image with the EXIF orientation already applied.
pub struct SourceImage {
    pub image: ::image::DynamicImage,
    pub format: SourceFormat,
}

impl SourceImage {
    pub fn width(&self) -> u32 {
        self.image.width()
    }
    pub fn height(&self) -> u32 {
        self.image.height()
    }
}

fn source_limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SOURCE_SIDE);
    limits.max_image_height = Some(MAX_SOURCE_SIDE);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    limits
}

/// Decodes a file the person picked. Dimensions are checked from the header
/// before any pixel buffer is allocated.
pub fn load_source(bytes: &[u8]) -> AppResult<SourceImage> {
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err(invalid(PHOTO_TOO_BIG));
    }
    let format = sniff(bytes).ok_or_else(|| invalid(PHOTO_FORMAT))?;
    let limits = source_limits();
    let reader = Cursor::new(bytes);
    let image = match format {
        SourceFormat::Png => {
            let decoder =
                PngDecoder::with_limits(reader, limits.clone()).map_err(decode_error)?;
            decode_bounded(decoder, limits)?
        }
        SourceFormat::Jpeg => {
            // The JPEG decoder fills a cut off scan with gray instead of failing.
            if !jpeg_has_end(bytes) {
                return Err(invalid(PHOTO_BROKEN));
            }
            let decoder = JpegDecoder::new(reader).map_err(decode_error)?;
            decode_bounded(decoder, limits)?
        }
        SourceFormat::WebP => {
            let decoder = WebPDecoder::new(reader).map_err(decode_error)?;
            if decoder.has_animation() {
                return Err(invalid(PHOTO_ANIMATED));
            }
            decode_bounded(decoder, limits)?
        }
    };
    Ok(SourceImage { image, format })
}

fn decode_bounded(mut decoder: impl ImageDecoder, limits: Limits) -> AppResult<DynamicImage> {
    let (w, h) = decoder.dimensions();
    let sides_ok = (MIN_SIDE..=MAX_SOURCE_SIDE).contains(&w)
        && (MIN_SIDE..=MAX_SOURCE_SIDE).contains(&h);
    if !sides_ok
        || u64::from(w) * u64::from(h) > MAX_SOURCE_PIXELS
        || decoder.total_bytes() > MAX_DECODE_BYTES
    {
        return Err(invalid(PHOTO_DIMENSIONS));
    }
    decoder.set_limits(limits).map_err(decode_error)?;
    // Damaged EXIF only costs the rotation, never the photo.
    let orientation = decoder
        .orientation()
        .unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder).map_err(decode_error)?;
    image.apply_orientation(orientation);
    Ok(image)
}

/// Walks the JPEG marker structure and reports whether an EOI marker closes
/// the main image. Segments are skipped by length, so an EOI inside an EXIF
/// thumbnail does not count, and data appended after EOI is allowed. Used
/// for files the person picks; photos from colleagues get `jpeg_is_plain`.
fn jpeg_has_end(bytes: &[u8]) -> bool {
    let mut i = 2;
    loop {
        // Resync on stray bytes between segments, then skip fill bytes.
        while i < bytes.len() && bytes[i] != 0xFF {
            i += 1;
        }
        while i < bytes.len() && bytes[i] == 0xFF {
            i += 1;
        }
        let Some(&marker) = bytes.get(i) else {
            return false;
        };
        i += 1;
        match marker {
            0xD9 => return true,
            0x00 | 0x01 | 0xD0..=0xD8 => continue,
            _ => {}
        }
        let Some(len) = bytes.get(i..i + 2) else {
            return false;
        };
        let len = usize::from(u16::from_be_bytes([len[0], len[1]]));
        if len < 2 {
            return false;
        }
        i += len;
        if marker == 0xDA {
            // Entropy coded data ends at the first marker that is neither a
            // stuffed zero nor a restart marker.
            loop {
                match bytes.get(i) {
                    None => return false,
                    Some(0xFF) => match bytes.get(i + 1) {
                        None => return false,
                        Some(0x00 | 0xD0..=0xD7) => i += 2,
                        Some(0xFF) => i += 1,
                        Some(_) => break,
                    },
                    Some(_) => i += 1,
                }
            }
        }
    }
}

/// Length of an APP0 JFIF payload without a thumbnail: identifier, version,
/// units, two densities and two zero thumbnail sides.
const JFIF_PAYLOAD_LEN: usize = 14;

/// Strict structure check for a photo from a colleague. Only the segments a
/// plain baseline or progressive JPEG needs are allowed: SOI, one APP0 JFIF
/// without thumbnail right after SOI, DQT, one SOF0 or SOF2 before the first
/// scan, DHT, DRI, SOS with its entropy coded data and restart markers, and
/// EOI as the very last bytes. APP1..APP15, COM, any other marker and bytes
/// after EOI are refused, so a shared photo cannot carry metadata or hidden
/// data, and less of the decoder is reachable.
fn jpeg_is_plain(bytes: &[u8]) -> bool {
    if !bytes.starts_with(&[0xFF, 0xD8]) {
        return false;
    }
    let mut i = 2;
    let mut frames = 0;
    let mut scans = 0;
    loop {
        if bytes.get(i) != Some(&0xFF) {
            return false;
        }
        let Some(&marker) = bytes.get(i + 1) else {
            return false;
        };
        let at_start = i == 2;
        i += 2;
        match marker {
            0xD9 => return i == bytes.len() && scans > 0,
            0xE0 | 0xDB | 0xC0 | 0xC2 | 0xC4 | 0xDD | 0xDA => {}
            _ => return false,
        }
        let Some(len) = bytes.get(i..i + 2) else {
            return false;
        };
        let len = usize::from(u16::from_be_bytes([len[0], len[1]]));
        let Some(payload) = len
            .checked_sub(2)
            .and_then(|n| bytes.get(i + 2..i + 2 + n))
        else {
            return false;
        };
        match marker {
            0xE0 => {
                let plain_jfif = payload.len() == JFIF_PAYLOAD_LEN
                    && payload.starts_with(b"JFIF\0")
                    && payload[12..] == [0, 0];
                if !at_start || !plain_jfif {
                    return false;
                }
            }
            0xC0 | 0xC2 => {
                frames += 1;
                if frames > 1 || scans > 0 {
                    return false;
                }
            }
            0xDA => {
                if frames == 0 {
                    return false;
                }
                scans += 1;
            }
            _ => {}
        }
        i += len;
        if marker == 0xDA {
            // Entropy coded data ends at the first marker that is neither a
            // stuffed zero nor a restart marker; fill bytes may precede it.
            loop {
                match bytes.get(i) {
                    None => return false,
                    Some(0xFF) => match bytes.get(i + 1) {
                        None => return false,
                        Some(0x00 | 0xD0..=0xD7) => i += 2,
                        Some(0xFF) => i += 1,
                        Some(_) => break,
                    },
                    Some(_) => i += 1,
                }
            }
        }
    }
}

/// Composites any alpha channel over white, since JPEG has no transparency.
fn flatten_on_white(image: &DynamicImage) -> RgbImage {
    if !image.color().has_alpha() {
        return image.to_rgb8();
    }
    let rgba = image.to_rgba8();
    RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [r, g, b, a] = rgba.get_pixel(x, y).0;
        let a = u32::from(a);
        let blend = |c: u8| ((u32::from(c) * a + 255 * (255 - a) + 127) / 255) as u8;
        Rgb([blend(r), blend(g), blend(b)])
    })
}

/// Encodes raw RGB pixels. Nothing but JFIF headers and the scan is written.
fn encode_jpeg(image: &RgbImage, quality: u8) -> AppResult<Vec<u8>> {
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, quality)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgb8,
        )
        .map_err(|_| invalid(PHOTO_BROKEN))?;
    Ok(out)
}

/// Preview for the crop dialog: longest side at most PREVIEW_SIDE, no metadata.
pub fn preview_jpeg(src: &SourceImage) -> AppResult<Vec<u8>> {
    let resized;
    let image = if src.width().max(src.height()) > PREVIEW_SIDE {
        resized = src
            .image
            .resize(PREVIEW_SIDE, PREVIEW_SIDE, FilterType::Triangle);
        &resized
    } else {
        &src.image
    };
    encode_jpeg(&flatten_on_white(image), PREVIEW_QUALITY)
}

/// Crop box in source pixels, after orientation.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Crop {
    pub x: u32,
    pub y: u32,
    pub size: u32,
}

/// Crops, scales to PHOTO_SIZE with Lanczos3, flattens alpha over white and
/// encodes a JPEG, lowering the quality from 88 until it fits
/// TARGET_PHOTO_BYTES (never below 50). An oversized box is clamped into the
/// image; a box smaller than 16 or starting outside the image is rejected.
pub fn crop_to_photo(src: &SourceImage, crop: Crop) -> AppResult<Vec<u8>> {
    let (w, h) = (src.width(), src.height());
    if crop.size < MIN_SIDE || crop.x >= w || crop.y >= h {
        return Err(invalid(PHOTO_CROP));
    }
    let size = crop.size.min(w).min(h);
    if size < MIN_SIDE {
        return Err(invalid(PHOTO_CROP));
    }
    let x = crop.x.min(w - size);
    let y = crop.y.min(h - size);

    // Flatten before scaling so transparent pixels do not bleed dark fringes.
    let square = flatten_on_white(&src.image.crop_imm(x, y, size, size));
    let photo = imageops::resize(&square, PHOTO_SIZE, PHOTO_SIZE, FilterType::Lanczos3);

    let mut quality = PHOTO_QUALITY_START;
    loop {
        let jpeg = encode_jpeg(&photo, quality)?;
        if jpeg.len() <= TARGET_PHOTO_BYTES {
            return Ok(jpeg);
        }
        if quality == PHOTO_QUALITY_MIN {
            return if jpeg.len() as u64 <= MAX_PHOTO_BYTES {
                Ok(jpeg)
            } else {
                Err(invalid(PHOTO_BROKEN))
            };
        }
        quality = quality
            .saturating_sub(PHOTO_QUALITY_STEP)
            .max(PHOTO_QUALITY_MIN);
    }
}

/// Checks a photo received from a peer or made here: JPEG magic, at most
/// MAX_PHOTO_BYTES, only the segments `jpeg_is_plain` allows, exactly
/// PHOTO_SIZE square and fully decodable under tight limits.
pub fn is_valid_photo(bytes: &[u8]) -> bool {
    if bytes.len() as u64 > MAX_PHOTO_BYTES || !bytes.starts_with(JPEG_MAGIC) {
        return false;
    }
    if !jpeg_is_plain(bytes) {
        return false;
    }
    let Ok(mut decoder) = JpegDecoder::new(Cursor::new(bytes)) else {
        return false;
    };
    if decoder.dimensions() != (PHOTO_SIZE, PHOTO_SIZE) {
        return false;
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(PHOTO_SIZE);
    limits.max_image_height = Some(PHOTO_SIZE);
    limits.max_alloc = Some(16 * 1024 * 1024);
    decoder.set_limits(limits).is_ok() && DynamicImage::from_decoder(decoder).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;
    use crate::profile::{
        MAX_PHOTO_BYTES, PHOTO_ANIMATED, PHOTO_BROKEN, PHOTO_CROP, PHOTO_DIMENSIONS, PHOTO_FORMAT,
        PHOTO_SIZE, PHOTO_TOO_BIG, PREVIEW_SIDE, TARGET_PHOTO_BYTES,
    };
    use ::image::codecs::jpeg::JpegEncoder;
    use ::image::codecs::png::PngEncoder;
    use ::image::codecs::webp::WebPEncoder;
    use ::image::{
        ExtendedColorType, GenericImageView, ImageEncoder, Rgb, RgbImage, Rgba, RgbaImage,
    };

    const SECRET: &[u8] = b"GPSLATITUDE-SECRET";

    /// Small deterministic xorshift generator, enough for noise and fuzz input.
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
        fn byte(&mut self) -> u8 {
            (self.next() >> 24) as u8
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    fn message(err: AppError) -> String {
        match err {
            AppError::InvalidInput(msg) => msg,
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    fn load_err(bytes: &[u8]) -> String {
        match load_source(bytes) {
            Ok(img) => panic!("expected error, got {}x{}", img.width(), img.height()),
            Err(err) => message(err),
        }
    }

    fn gradient(w: u32, h: u32) -> RgbImage {
        RgbImage::from_fn(w, h, |x, y| {
            Rgb([(x * 255 / w) as u8, (y * 255 / h) as u8, 128])
        })
    }

    fn noise(w: u32, h: u32, seed: u64) -> RgbImage {
        let mut rng = Rng(seed);
        RgbImage::from_fn(w, h, |_, _| Rgb([rng.byte(), rng.byte(), rng.byte()]))
    }

    fn encode_jpeg(img: &RgbImage, quality: u8) -> Vec<u8> {
        let mut out = Vec::new();
        JpegEncoder::new_with_quality(&mut out, quality)
            .write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgb8)
            .unwrap();
        out
    }

    fn encode_png_rgba(img: &RgbaImage) -> Vec<u8> {
        let mut out = Vec::new();
        PngEncoder::new(&mut out)
            .write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgba8)
            .unwrap();
        out
    }

    fn encode_png_rgb(img: &RgbImage) -> Vec<u8> {
        let mut out = Vec::new();
        PngEncoder::new(&mut out)
            .write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgb8)
            .unwrap();
        out
    }

    fn encode_webp(img: &RgbaImage) -> Vec<u8> {
        let mut out = Vec::new();
        WebPEncoder::new_lossless(&mut out)
            .encode(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgba8)
            .unwrap();
        out
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    fn assert_no_metadata(bytes: &[u8]) {
        assert!(!contains(bytes, b"Exif"), "output still has Exif");
        assert!(!contains(bytes, b"GPS"), "output still has GPS");
        assert!(!contains(bytes, SECRET), "output still has the secret marker");
    }

    /// APP1 Exif segment, big endian TIFF, IFD0 with ImageDescription (the
    /// secret marker) and Orientation = 6.
    fn exif_app1() -> Vec<u8> {
        let mut text = SECRET.to_vec();
        text.push(0);
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"MM\0\x2a");
        tiff.extend_from_slice(&8u32.to_be_bytes());
        tiff.extend_from_slice(&2u16.to_be_bytes());
        // 0x010E ImageDescription, ASCII, points past the IFD.
        tiff.extend_from_slice(&0x010Eu16.to_be_bytes());
        tiff.extend_from_slice(&2u16.to_be_bytes());
        tiff.extend_from_slice(&(text.len() as u32).to_be_bytes());
        tiff.extend_from_slice(&38u32.to_be_bytes());
        // 0x0112 Orientation, SHORT, value 6 (rotate 90 clockwise).
        tiff.extend_from_slice(&0x0112u16.to_be_bytes());
        tiff.extend_from_slice(&3u16.to_be_bytes());
        tiff.extend_from_slice(&1u32.to_be_bytes());
        tiff.extend_from_slice(&[0, 6, 0, 0]);
        tiff.extend_from_slice(&0u32.to_be_bytes());
        assert_eq!(tiff.len(), 38);
        tiff.extend_from_slice(&text);

        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&tiff);
        let mut seg = vec![0xFF, 0xE1];
        seg.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        seg.extend_from_slice(&payload);
        seg
    }

    fn jpeg_with_exif(img: &RgbImage) -> Vec<u8> {
        let plain = encode_jpeg(img, 90);
        assert_eq!(&plain[..2], &[0xFF, 0xD8]);
        let mut out = plain[..2].to_vec();
        out.extend_from_slice(&exif_app1());
        out.extend_from_slice(&plain[2..]);
        out
    }

    fn riff_chunk(fourcc: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = fourcc.to_vec();
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(data);
        if data.len() % 2 == 1 {
            out.push(0);
        }
        out
    }

    fn u24(v: u32) -> [u8; 3] {
        let b = v.to_le_bytes();
        [b[0], b[1], b[2]]
    }

    /// Two frame animated WebP built from a real lossless frame.
    fn animated_webp() -> Vec<u8> {
        let frame = encode_webp(&RgbaImage::from_pixel(16, 16, Rgba([200, 10, 10, 255])));
        // Lossless file: RIFF, size, WEBP, then the VP8L chunk.
        let vp8l = &frame[12..];
        assert_eq!(&vp8l[..4], b"VP8L");

        let mut vp8x = vec![0b0001_0010, 0, 0, 0];
        vp8x.extend_from_slice(&u24(15));
        vp8x.extend_from_slice(&u24(15));
        let anim = [0, 0, 0, 0, 0, 0];
        let mut anmf = Vec::new();
        anmf.extend_from_slice(&u24(0));
        anmf.extend_from_slice(&u24(0));
        anmf.extend_from_slice(&u24(15));
        anmf.extend_from_slice(&u24(15));
        anmf.extend_from_slice(&u24(100));
        anmf.push(0);
        anmf.extend_from_slice(vp8l);

        let mut body = b"WEBP".to_vec();
        body.extend_from_slice(&riff_chunk(b"VP8X", &vp8x));
        body.extend_from_slice(&riff_chunk(b"ANIM", &anim));
        body.extend_from_slice(&riff_chunk(b"ANMF", &anmf));
        body.extend_from_slice(&riff_chunk(b"ANMF", &anmf));
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(&body);
        out
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &b in data {
            crc ^= u32::from(b);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = (data.len() as u32).to_be_bytes().to_vec();
        let mut crc_input = kind.to_vec();
        crc_input.extend_from_slice(data);
        out.extend_from_slice(&crc_input);
        out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
        out
    }

    /// PNG with a valid IHDR claiming `w`x`h` and almost no pixel data.
    fn fake_png_header(w: u32, h: u32) -> Vec<u8> {
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&w.to_be_bytes());
        ihdr.extend_from_slice(&h.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        out.extend_from_slice(&png_chunk(b"IHDR", &ihdr));
        out.extend_from_slice(&png_chunk(
            b"IDAT",
            &[0x78, 0x9C, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01],
        ));
        out.extend_from_slice(&png_chunk(b"IEND", &[]));
        out
    }

    fn decode_jpeg(bytes: &[u8]) -> ::image::DynamicImage {
        ::image::load_from_memory_with_format(bytes, ::image::ImageFormat::Jpeg).unwrap()
    }

    #[test]
    fn sniff_reads_magic_bytes() {
        let png = encode_png_rgb(&gradient(16, 16));
        let jpeg = encode_jpeg(&gradient(16, 16), 90);
        let webp = encode_webp(&RgbaImage::from_pixel(16, 16, Rgba([1, 2, 3, 255])));
        assert_eq!(sniff(&png), Some(SourceFormat::Png));
        assert_eq!(sniff(&jpeg), Some(SourceFormat::Jpeg));
        assert_eq!(sniff(&webp), Some(SourceFormat::WebP));
        assert_eq!(sniff(b"GIF89a\x10\x00\x10\x00\x00\x00\x00;"), None);
        assert_eq!(
            sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
            None
        );
        assert_eq!(sniff(b"BM\0\0\0\0garbage"), None);
        assert_eq!(sniff(b"RIFF\0\0\0\0WAVEfmt "), None);
        assert_eq!(sniff(&[]), None);
        assert_eq!(sniff(&[0xFF, 0xD8]), None);
    }

    #[test]
    fn load_source_decodes_each_format() {
        let png = encode_png_rgb(&gradient(40, 30));
        let jpeg = encode_jpeg(&gradient(40, 30), 90);
        let webp = encode_webp(&RgbaImage::from_pixel(40, 30, Rgba([1, 2, 3, 255])));
        for (bytes, format) in [
            (png, SourceFormat::Png),
            (jpeg, SourceFormat::Jpeg),
            (webp, SourceFormat::WebP),
        ] {
            let src = load_source(&bytes).unwrap();
            assert_eq!(src.format, format);
            assert_eq!((src.width(), src.height()), (40, 30));
        }
    }

    #[test]
    fn load_source_rejects_unsupported_and_oversized_files() {
        assert_eq!(
            load_err(b"GIF89a\x10\x00\x10\x00\x00\x00\x00;"),
            PHOTO_FORMAT
        );
        assert_eq!(load_err(b"<svg></svg>"), PHOTO_FORMAT);
        let mut big = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        big.resize(20 * 1024 * 1024 + 1, 0);
        assert_eq!(load_err(&big), PHOTO_TOO_BIG);
    }

    #[test]
    fn load_source_rejects_bad_dimensions_from_header() {
        // 9000x9000 RGBA would need about 324 MB; only the header is read.
        assert_eq!(load_err(&fake_png_header(9000, 9000)), PHOTO_DIMENSIONS);
        assert_eq!(load_err(&fake_png_header(100, 9000)), PHOTO_DIMENSIONS);
        // 7000x7000 and 5000x5000 fit each side but exceed the pixel budget.
        assert_eq!(load_err(&fake_png_header(7000, 7000)), PHOTO_DIMENSIONS);
        assert_eq!(load_err(&fake_png_header(5000, 5000)), PHOTO_DIMENSIONS);
        assert_eq!(
            load_err(&encode_png_rgb(&gradient(15, 40))),
            PHOTO_DIMENSIONS
        );
        assert_eq!(
            load_err(&encode_jpeg(&gradient(40, 8), 90)),
            PHOTO_DIMENSIONS
        );
    }

    #[test]
    fn load_source_rejects_animated_webp() {
        assert_eq!(load_err(&animated_webp()), PHOTO_ANIMATED);
    }

    #[test]
    fn exif_orientation_is_applied_and_metadata_dropped() {
        let bytes = jpeg_with_exif(&gradient(64, 32));
        assert!(contains(&bytes, SECRET));
        let src = load_source(&bytes).unwrap();
        assert_eq!(src.format, SourceFormat::Jpeg);
        assert_eq!(
            (src.width(), src.height()),
            (32, 64),
            "orientation 6 must rotate"
        );

        let photo = crop_to_photo(&src, Crop { x: 0, y: 0, size: 32 }).unwrap();
        assert_no_metadata(&photo);
        assert!(is_valid_photo(&photo));

        let preview = preview_jpeg(&src).unwrap();
        assert_no_metadata(&preview);
        assert_eq!(decode_jpeg(&preview).dimensions(), (32, 64));
    }

    #[test]
    fn noise_photo_is_256_square_and_under_target() {
        let src = load_source(&encode_png_rgb(&noise(2000, 1500, 7))).unwrap();
        let photo = crop_to_photo(
            &src,
            Crop {
                x: 250,
                y: 0,
                size: 1500,
            },
        )
        .unwrap();
        assert!(photo.len() <= TARGET_PHOTO_BYTES, "{} bytes", photo.len());
        assert_eq!(decode_jpeg(&photo).dimensions(), (PHOTO_SIZE, PHOTO_SIZE));
        assert!(is_valid_photo(&photo));

        // Pure noise at the final size forces the quality to step down.
        let small = load_source(&encode_png_rgb(&noise(256, 256, 11))).unwrap();
        let photo = crop_to_photo(&small, Crop { x: 0, y: 0, size: 256 }).unwrap();
        assert!(photo.len() <= TARGET_PHOTO_BYTES, "{} bytes", photo.len());
        assert!(is_valid_photo(&photo));
    }

    #[test]
    fn alpha_png_is_flattened_on_white() {
        let img = RgbaImage::from_fn(100, 100, |x, _| {
            if x < 50 {
                Rgba([0, 0, 0, 0])
            } else {
                Rgba([0, 0, 255, 255])
            }
        });
        let src = load_source(&encode_png_rgba(&img)).unwrap();
        let photo = crop_to_photo(&src, Crop { x: 0, y: 0, size: 100 }).unwrap();
        assert!(is_valid_photo(&photo));
        let out = decode_jpeg(&photo).to_rgb8();
        let left = out.get_pixel(10, 128);
        assert!(
            left.0.iter().all(|&c| c >= 240),
            "transparent area must be white: {left:?}"
        );
        let right = out.get_pixel(240, 128);
        assert!(
            right[2] >= 200 && right[0] <= 60,
            "opaque area keeps its color: {right:?}"
        );
    }

    #[test]
    fn crop_is_clamped_or_rejected() {
        let src = load_source(&encode_png_rgb(&gradient(100, 60))).unwrap();
        // Too large and past the edge: clamped to the largest square inside.
        let photo = crop_to_photo(
            &src,
            Crop {
                x: 90,
                y: 50,
                size: 500,
            },
        )
        .unwrap();
        assert!(is_valid_photo(&photo));
        let photo = crop_to_photo(
            &src,
            Crop {
                x: 0,
                y: 0,
                size: u32::MAX,
            },
        )
        .unwrap();
        assert!(is_valid_photo(&photo));

        let err = |crop| message(crop_to_photo(&src, crop).unwrap_err());
        assert_eq!(err(Crop { x: 0, y: 0, size: 15 }), PHOTO_CROP);
        assert_eq!(err(Crop { x: 100, y: 0, size: 20 }), PHOTO_CROP);
        assert_eq!(err(Crop { x: 0, y: 60, size: 20 }), PHOTO_CROP);
        assert_eq!(
            err(Crop {
                x: u32::MAX,
                y: u32::MAX,
                size: u32::MAX
            }),
            PHOTO_CROP
        );
    }

    #[test]
    fn preview_is_bounded_and_keeps_aspect() {
        let src = load_source(&encode_jpeg(&gradient(3000, 1500), 80)).unwrap();
        let preview = preview_jpeg(&src).unwrap();
        assert_eq!(&preview[..3], &[0xFF, 0xD8, 0xFF]);
        assert_eq!(
            decode_jpeg(&preview).dimensions(),
            (PREVIEW_SIDE, PREVIEW_SIDE / 2)
        );

        let alpha = RgbaImage::from_pixel(40, 20, Rgba([0, 0, 0, 0]));
        let src = load_source(&encode_png_rgba(&alpha)).unwrap();
        let preview = decode_jpeg(&preview_jpeg(&src).unwrap()).to_rgb8();
        assert_eq!(preview.dimensions(), (40, 20));
        assert!(preview.get_pixel(5, 5).0.iter().all(|&c| c >= 240));
    }

    #[test]
    fn is_valid_photo_checks_format_size_and_dimensions() {
        let src = load_source(&encode_png_rgb(&gradient(300, 300))).unwrap();
        let photo = crop_to_photo(
            &src,
            Crop {
                x: 0,
                y: 0,
                size: 300,
            },
        )
        .unwrap();
        assert!(is_valid_photo(&photo));

        assert!(!is_valid_photo(&encode_png_rgb(&gradient(256, 256))));
        assert!(!is_valid_photo(&encode_jpeg(&gradient(300, 300), 90)));
        assert!(!is_valid_photo(&encode_jpeg(&gradient(256, 255), 90)));

        let mut padded = photo.clone();
        padded.resize(MAX_PHOTO_BYTES as usize + 1, 0);
        assert!(!is_valid_photo(&padded));

        assert!(!is_valid_photo(&photo[..photo.len() / 2]));
        assert!(!is_valid_photo(&[0xFF, 0xD8, 0xFF]));
        assert!(!is_valid_photo(&[]));
    }

    /// `jpeg` with a segment `marker` + `payload` inserted after APP0.
    fn with_segment(jpeg: &[u8], marker: u8, payload: &[u8]) -> Vec<u8> {
        assert_eq!(&jpeg[2..4], &[0xFF, 0xE0]);
        let app0_end = 4 + usize::from(u16::from_be_bytes([jpeg[4], jpeg[5]]));
        let mut out = jpeg[..app0_end].to_vec();
        out.extend_from_slice(&[0xFF, marker]);
        out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        out.extend_from_slice(payload);
        out.extend_from_slice(&jpeg[app0_end..]);
        out
    }

    fn photo_256() -> Vec<u8> {
        let src = load_source(&encode_png_rgb(&gradient(300, 300))).unwrap();
        crop_to_photo(
            &src,
            Crop {
                x: 0,
                y: 0,
                size: 300,
            },
        )
        .unwrap()
    }

    #[test]
    fn own_photos_pass_the_strict_structure_check() {
        let photo = photo_256();
        assert!(jpeg_is_plain(&photo));
        assert!(is_valid_photo(&photo));
        // Any plain 256x256 JPEG from this encoder, also at other qualities.
        for q in [50, 75, 95] {
            assert!(is_valid_photo(&encode_jpeg(&gradient(256, 256), q)), "{q}");
        }
    }

    #[test]
    fn photos_with_extra_segments_or_trailing_data_are_refused() {
        let photo = photo_256();
        let mut exif = b"Exif\0\0".to_vec();
        exif.extend_from_slice(SECRET);
        let mut icc = b"ICC_PROFILE\0\x01\x01".to_vec();
        icc.extend_from_slice(&[0; 32]);
        let refused = [
            ("APP1 Exif", with_segment(&photo, 0xE1, &exif)),
            ("APP2 ICC", with_segment(&photo, 0xE2, &icc)),
            ("APP13", with_segment(&photo, 0xED, b"Photoshop 3.0\0")),
            (
                "APP14 Adobe",
                with_segment(&photo, 0xEE, b"Adobe\0\x64\0\0\0\0\x01"),
            ),
            ("COM", with_segment(&photo, 0xFE, SECRET)),
            (
                "SOF1",
                with_segment(&photo, 0xC1, &[8, 0, 16, 0, 16, 1, 1, 0x11, 0]),
            ),
            ("after EOI", [photo.as_slice(), SECRET].concat()),
            ("zero after EOI", [photo.as_slice(), &[0u8][..]].concat()),
            ("second EOI", [photo.as_slice(), &[0xFFu8, 0xD9][..]].concat()),
        ];
        for (what, bytes) in &refused {
            assert!(!jpeg_is_plain(bytes), "{what}");
            assert!(!is_valid_photo(bytes), "{what}");
        }
        // JFIF APP0 carrying a 1x1 thumbnail.
        assert_eq!(&photo[6..11], b"JFIF\0");
        let mut app0 = photo[6..20].to_vec();
        app0[12] = 1;
        app0[13] = 1;
        app0.extend_from_slice(&[1, 2, 3]);
        let mut thumb = photo[..4].to_vec();
        thumb.extend_from_slice(&((app0.len() + 2) as u16).to_be_bytes());
        thumb.extend_from_slice(&app0);
        thumb.extend_from_slice(&photo[20..]);
        assert!(!is_valid_photo(&thumb));
        // Without the JFIF segment it still passes; JFIF after SOF0 does not.
        let bare = [&photo[..2], &photo[20..]].concat();
        assert!(jpeg_is_plain(&bare));
        let seg_len = 2 + usize::from(u16::from_be_bytes([photo[22], photo[23]]));
        assert_eq!(&photo[20..22], &[0xFF, 0xC0]);
        let late = [
            &photo[..2],
            &photo[20..20 + seg_len],
            &photo[2..20],
            &photo[20 + seg_len..],
        ]
        .concat();
        assert!(!jpeg_is_plain(&late));
    }

    #[test]
    fn picked_files_may_have_metadata_and_trailing_data() {
        let jpeg = [jpeg_with_exif(&gradient(40, 30)).as_slice(), &b"trailer"[..]].concat();
        let src = load_source(&jpeg).unwrap();
        assert_eq!((src.width(), src.height()), (30, 40));
    }

    #[test]
    fn broken_and_random_input_returns_errors() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        let samples = [
            encode_png_rgb(&gradient(48, 40)),
            encode_jpeg(&gradient(48, 40), 85),
            encode_webp(&RgbaImage::from_pixel(48, 40, Rgba([9, 9, 9, 255]))),
            jpeg_with_exif(&gradient(48, 40)),
            animated_webp(),
        ];

        // Truncated files never decode into a picture.
        for sample in &samples[..3] {
            for cut in [0, 1, 4, 8, 12, 16, 24, 33, 50, sample.len() / 3, sample.len() / 2] {
                let err = load_err(&sample[..cut.min(sample.len() - 1)]);
                assert!(
                    [PHOTO_BROKEN, PHOTO_FORMAT].contains(&err.as_str()),
                    "cut {cut}: {err}"
                );
            }
        }

        // Every prefix and random mutations: must not panic.
        for sample in &samples {
            for cut in 0..sample.len().min(400) {
                let _ = load_source(&sample[..cut]);
                let _ = is_valid_photo(&sample[..cut]);
            }
            for _ in 0..200 {
                let mut bytes = sample.clone();
                for _ in 0..1 + rng.below(8) {
                    let i = rng.below(bytes.len());
                    bytes[i] = rng.byte();
                }
                if let Ok(src) = load_source(&bytes) {
                    let _ = preview_jpeg(&src);
                    let _ = crop_to_photo(&src, Crop { x: 0, y: 0, size: 16 });
                }
                let _ = is_valid_photo(&bytes);
            }
        }

        // Random bytes behind each magic number.
        let magics: [&[u8]; 4] = [
            &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A],
            &[0xFF, 0xD8, 0xFF],
            b"RIFF\x40\0\0\0WEBP",
            b"",
        ];
        for magic in magics {
            for _ in 0..200 {
                let mut bytes = magic.to_vec();
                for _ in 0..rng.below(300) {
                    bytes.push(rng.byte());
                }
                assert!(load_source(&bytes).is_err());
                assert!(!is_valid_photo(&bytes));
            }
        }
    }
}
