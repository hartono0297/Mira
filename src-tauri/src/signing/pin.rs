//! PIN tanda tangan: aturan PIN, kunci turunan PIN, enkripsi gambar tanda
//! tangan, dan kebijakan batas percobaan. Semua fungsi di sini murni (tanpa
//! database); penyimpanan ada di `vault`.
//!
//! Kunci gambar = BLAKE3 `derive_key("mira signature key v1",
//! argon2id(PIN, salt) ‖ pepper)`. `pepper` diturunkan dari tanda tangan
//! Ed25519 kunci laptop atas `mira-signature-pepper-v1` ‖ salt, jadi pepper
//! bergantung pada salt. Karena itu `seal_image` dan `open_image` menerima
//! pepper sebagai fungsi dari salt: `seal_image` membuat salt acak lalu
//! memanggil fungsi itu, `open_image` memanggilnya dengan salt yang tersimpan.
//! Pemanggil biasanya memberi `|salt| pepper_from_identity(identity, salt)`;
//! tes bisa memberi closure tetap tanpa `Identity`.
//!
//! Gambar dienkripsi XChaCha20-Poly1305. Tag AEAD sekaligus menjadi pemeriksa
//! PIN, jadi tidak ada hash PIN terpisah yang bisa ditebak lepas.

use std::fmt;
use std::str::FromStr;

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::Aead;
use chacha20poly1305::aead::Payload;
use chacha20poly1305::{KeyInit, XChaCha20Poly1305};
use rand_core::{OsRng, RngCore};
use time::{Duration, OffsetDateTime};
use zeroize::Zeroizing;

use super::err;
use crate::error::{AppError, AppResult};
use crate::identity::Identity;

pub const PIN_MIN_LEN: usize = 6;
pub const PIN_MAX_LEN: usize = 12;

const PEPPER_MESSAGE_PREFIX: &[u8] = b"mira-signature-pepper-v1";
const PEPPER_CONTEXT: &str = "mira signature pepper v1";
const KEY_CONTEXT: &str = "mira signature key v1";
const AAD_PREFIX: &[u8] = b"mira-signature-v1\n";

/// Batas ukuran file PNG tanda tangan (1 MiB).
pub const MAX_PNG_BYTES: usize = 1024 * 1024;
/// Batas lebar dan tinggi gambar tanda tangan dalam piksel.
pub const MAX_PNG_SIDE: u32 = 2000;

/// Jumlah salah berturut-turut per tingkat kunci.
pub const ATTEMPTS_PER_LOCK: u32 = 5;

/// PIN hanya angka ASCII, 6 sampai 12 karakter.
pub fn validate_pin(pin: &str) -> AppResult<()> {
    let ok =
        (PIN_MIN_LEN..=PIN_MAX_LEN).contains(&pin.len()) && pin.bytes().all(|b| b.is_ascii_digit());
    if ok {
        Ok(())
    } else {
        Err(err("pin_invalid", "PIN harus 6 sampai 12 angka."))
    }
}

fn corrupt() -> AppError {
    AppError::Internal(
        "Data tanda tangan tersimpan rusak. Hapus tanda tangan lalu buat lagi.".into(),
    )
}

/// Parameter Argon2id. Disimpan sebagai teks di kolom `kdf`, misalnya
/// `argon2id;v=19;m=65536;t=3;p=1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    /// Memori dalam KiB.
    pub m_cost_kib: u32,
    /// Jumlah putaran.
    pub t_cost: u32,
    /// Jumlah jalur paralel.
    pub p_cost: u32,
}

impl KdfParams {
    /// 64 MiB, 3 putaran, 1 jalur.
    pub const DEFAULT: KdfParams = KdfParams {
        m_cost_kib: 65536,
        t_cost: 3,
        p_cost: 1,
    };

    /// Sangat murah, hanya untuk tes.
    pub const TEST: KdfParams = KdfParams {
        m_cost_kib: 8,
        t_cost: 1,
        p_cost: 1,
    };

    pub const M_RANGE: std::ops::RangeInclusive<u32> = 8..=1_048_576;
    pub const T_RANGE: std::ops::RangeInclusive<u32> = 1..=10;
    pub const P_RANGE: std::ops::RangeInclusive<u32> = 1..=4;

    /// Menolak nilai di luar batas wajar, supaya database yang dirusak tidak
    /// bisa membuat Argon2 memakan memori atau waktu tak terbatas.
    pub fn validate(&self) -> AppResult<()> {
        let ok = Self::M_RANGE.contains(&self.m_cost_kib)
            && Self::T_RANGE.contains(&self.t_cost)
            && Self::P_RANGE.contains(&self.p_cost)
            && self.m_cost_kib >= 8 * self.p_cost;
        if ok { Ok(()) } else { Err(corrupt()) }
    }

    /// Parse ketat: hanya bentuk persis seperti hasil `to_string()`.
    pub fn parse(s: &str) -> AppResult<KdfParams> {
        let rest = s.strip_prefix("argon2id;v=19;m=").ok_or_else(corrupt)?;
        let (m, rest) = rest.split_once(";t=").ok_or_else(corrupt)?;
        let (t, p) = rest.split_once(";p=").ok_or_else(corrupt)?;
        let num = |v: &str| -> AppResult<u32> {
            if v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()) {
                return Err(corrupt());
            }
            v.parse::<u32>().map_err(|_| corrupt())
        };
        let params = KdfParams {
            m_cost_kib: num(m)?,
            t_cost: num(t)?,
            p_cost: num(p)?,
        };
        params.validate()?;
        // Tolak nol di depan dan bentuk lain yang tidak kanonis.
        if params.to_string() != s {
            return Err(corrupt());
        }
        Ok(params)
    }
}

impl fmt::Display for KdfParams {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "argon2id;v=19;m={};t={};p={}",
            self.m_cost_kib, self.t_cost, self.p_cost
        )
    }
}

impl FromStr for KdfParams {
    type Err = AppError;

    fn from_str(s: &str) -> AppResult<Self> {
        KdfParams::parse(s)
    }
}

/// Pesan yang ditandatangani kunci laptop untuk membuat pepper.
pub fn pepper_message(salt: &[u8; 16]) -> Vec<u8> {
    let mut msg = Vec::with_capacity(PEPPER_MESSAGE_PREFIX.len() + salt.len());
    msg.extend_from_slice(PEPPER_MESSAGE_PREFIX);
    msg.extend_from_slice(salt);
    msg
}

/// Pepper dari tanda tangan Ed25519 atas `pepper_message(salt)`.
pub fn pepper_from_signature(signature: &[u8; 64]) -> Zeroizing<[u8; 32]> {
    Zeroizing::new(blake3::derive_key(PEPPER_CONTEXT, signature))
}

/// Pepper yang butuh kunci laptop. Ed25519 deterministik, jadi hasilnya stabil
/// untuk laptop dan salt yang sama.
pub fn pepper_from_identity(identity: &Identity, salt: &[u8; 16]) -> Zeroizing<[u8; 32]> {
    let signature = Zeroizing::new(identity.sign(&pepper_message(salt)).to_bytes());
    pepper_from_signature(&signature)
}

/// Kunci enkripsi gambar dari PIN, salt, pepper, dan parameter Argon2id.
pub fn derive_key(
    pin: &str,
    salt: &[u8; 16],
    pepper: &[u8; 32],
    params: &KdfParams,
) -> AppResult<Zeroizing<[u8; 32]>> {
    params.validate()?;
    let argon_params = Params::new(params.m_cost_kib, params.t_cost, params.p_cost, Some(32))
        .map_err(|_| corrupt())?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);
    let mut argon_out = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(pin.as_bytes(), salt, argon_out.as_mut())
        .map_err(|e| {
            AppError::Internal(format!(
                "Kunci tanda tangan tidak bisa dihitung. Detail: {e}"
            ))
        })?;
    let mut material = Zeroizing::new([0u8; 64]);
    material[..32].copy_from_slice(argon_out.as_ref());
    material[32..].copy_from_slice(pepper);
    Ok(Zeroizing::new(blake3::derive_key(
        KEY_CONTEXT,
        material.as_ref(),
    )))
}

/// Gambar tanda tangan terenkripsi beserta bahan untuk membukanya lagi.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedImage {
    /// `KdfParams` dalam bentuk teks.
    pub kdf: String,
    pub salt: [u8; 16],
    pub nonce: [u8; 24],
    /// Ciphertext diikuti tag Poly1305 16 byte.
    pub ciphertext: Vec<u8>,
}

/// AAD untuk gambar milik kunci publik `owner_pk_hex`.
pub fn aad_for(owner_pk_hex: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(AAD_PREFIX.len() + owner_pk_hex.len());
    aad.extend_from_slice(AAD_PREFIX);
    aad.extend_from_slice(owner_pk_hex.as_bytes());
    aad
}

/// Mengenkripsi `png` dengan salt dan nonce acak. `pepper` dipanggil sekali
/// dengan salt yang baru dibuat.
pub fn seal_image<F>(
    pin: &str,
    pepper: F,
    png: &[u8],
    aad: &[u8],
    params: &KdfParams,
) -> AppResult<SealedImage>
where
    F: FnOnce(&[u8; 16]) -> Zeroizing<[u8; 32]>,
{
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let pepper = pepper(&salt);
    seal_image_with_salt(pin, &salt, &pepper, png, aad, params)
}

/// Seperti `seal_image`, tetapi salt dan pepper sudah ditentukan pemanggil.
/// Nonce tetap acak.
pub fn seal_image_with_salt(
    pin: &str,
    salt: &[u8; 16],
    pepper: &[u8; 32],
    png: &[u8],
    aad: &[u8],
    params: &KdfParams,
) -> AppResult<SealedImage> {
    validate_pin(pin)?;
    let key = derive_key(pin, salt, pepper, params)?;
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let cipher = XChaCha20Poly1305::new((&*key).into());
    let ciphertext = cipher
        .encrypt((&nonce).into(), Payload { msg: png, aad })
        .map_err(|_| AppError::Internal("Gambar tanda tangan tidak bisa dienkripsi.".into()))?;
    Ok(SealedImage {
        kdf: params.to_string(),
        salt: *salt,
        nonce,
        ciphertext,
    })
}

/// Membuka gambar. `Ok(None)` kalau tag AEAD gagal (PIN salah, pepper lain,
/// atau AAD lain). Error hanya untuk data rusak, misalnya `kdf` tidak valid.
pub fn open_image<F>(
    pin: &str,
    pepper: F,
    sealed: &SealedImage,
    aad: &[u8],
) -> AppResult<Option<Zeroizing<Vec<u8>>>>
where
    F: FnOnce(&[u8; 16]) -> Zeroizing<[u8; 32]>,
{
    let params = KdfParams::parse(&sealed.kdf)?;
    let pepper = pepper(&sealed.salt);
    let key = derive_key(pin, &sealed.salt, &pepper, &params)?;
    let cipher = XChaCha20Poly1305::new((&*key).into());
    match cipher.decrypt(
        (&sealed.nonce).into(),
        Payload {
            msg: &sealed.ciphertext,
            aad,
        },
    ) {
        Ok(png) => Ok(Some(Zeroizing::new(png))),
        Err(_) => Ok(None),
    }
}

const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];

/// Memeriksa header PNG dan membalas `(lebar, tinggi)`.
pub fn validate_png(bytes: &[u8]) -> AppResult<(u32, u32)> {
    if bytes.len() > MAX_PNG_BYTES {
        return Err(err(
            "image_invalid",
            "Gambar tanda tangan terlalu besar. Batasnya 1 MB.",
        ));
    }
    let not_png = || {
        err(
            "image_invalid",
            "Gambar tanda tangan harus berupa file PNG.",
        )
    };
    // Magic (8) + panjang chunk (4) + "IHDR" (4) + data IHDR (13) + CRC (4).
    if bytes.len() < 33 || bytes[..8] != PNG_MAGIC {
        return Err(not_png());
    }
    let be = |i: usize| u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    if be(8) != 13 || &bytes[12..16] != b"IHDR" {
        return Err(not_png());
    }
    let (width, height) = (be(16), be(20));
    let side = 1..=MAX_PNG_SIDE;
    if !side.contains(&width) || !side.contains(&height) {
        return Err(err(
            "image_invalid",
            "Lebar dan tinggi gambar tanda tangan harus 1 sampai 2000 piksel.",
        ));
    }
    Ok((width, height))
}

/// Hitungan PIN salah berturut-turut dan kunci waktu yang sedang berlaku.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Attempts {
    pub failed: u32,
    pub locked_until: Option<OffsetDateTime>,
}

/// `Err(sampai)` kalau masih terkunci pada waktu `now`.
pub fn check_locked(attempts: &Attempts, now: OffsetDateTime) -> Result<(), OffsetDateTime> {
    match attempts.locked_until {
        Some(until) if until > now => Err(until),
        _ => Ok(()),
    }
}

/// Lama kunci setelah `failed` kesalahan berturut-turut, kalau ada.
/// 5 salah: 1 menit, 10: 5 menit, 15: 15 menit, 20 ke atas: 60 menit setiap
/// kelipatan 5.
pub fn lock_duration(failed: u32) -> Option<Duration> {
    if failed == 0 || !failed.is_multiple_of(ATTEMPTS_PER_LOCK) {
        return None;
    }
    Some(match failed {
        5 => Duration::minutes(1),
        10 => Duration::minutes(5),
        15 => Duration::minutes(15),
        _ => Duration::minutes(60),
    })
}

/// Kunci waktu terlama yang masuk akal untuk `failed` kesalahan.
fn max_lock(failed: u32) -> Duration {
    lock_duration(failed).unwrap_or(Duration::minutes(60))
}

/// Kunci waktu bergantung jam laptop. Kalau jam dimundurkan, `locked_until`
/// bisa jauh di depan dan pemilik terkunci sangat lama. Kalau sisa kunci
/// lebih panjang dari lama kunci untuk `failed` kesalahan, sisa itu dibatasi
/// menjadi `now + lama kunci`. Membalas `true` kalau ada yang dibatasi
/// (pemanggil sebaiknya menyimpan nilai barunya, supaya kunci tetap habis
/// walau jam tetap mundur).
pub fn clamp_lock(attempts: &mut Attempts, now: OffsetDateTime) -> bool {
    let limit = max_lock(attempts.failed);
    match attempts.locked_until {
        Some(until) if until - now > limit => {
            attempts.locked_until = Some(now + limit);
            true
        }
        _ => false,
    }
}

/// Lama tunggu sampai `until` untuk pesan: "2 jam 5 menit", "3 jam", atau
/// "15 menit" (dibulatkan ke atas, minimal 1 menit).
pub fn wait_text(until: OffsetDateTime, now: OffsetDateTime) -> String {
    let minutes = minutes_until(until, now);
    let (hours, rest) = (minutes / 60, minutes % 60);
    match (hours, rest) {
        (0, m) => format!("{m} menit"),
        (h, 0) => format!("{h} jam"),
        (h, m) => format!("{h} jam {m} menit"),
    }
}

/// Mencatat satu PIN salah pada waktu `now`.
pub fn register_failure(attempts: Attempts, now: OffsetDateTime) -> Attempts {
    let failed = attempts.failed.saturating_add(1);
    Attempts {
        failed,
        locked_until: lock_duration(failed).map(|d| now + d),
    }
}

/// Sisa percobaan sampai kunci berikutnya (1 sampai 5).
pub fn attempts_left(attempts: &Attempts) -> u32 {
    ATTEMPTS_PER_LOCK - attempts.failed % ATTEMPTS_PER_LOCK
}

/// Hitungan setelah PIN benar.
pub fn reset() -> Attempts {
    Attempts::default()
}

/// Kira-kira berapa menit lagi sampai `until`, dibulatkan ke atas, minimal 1.
pub fn minutes_until(until: OffsetDateTime, now: OffsetDateTime) -> i64 {
    let secs = (until - now).whole_seconds().max(0);
    ((secs + 59) / 60).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn fixed_pepper(byte: u8) -> impl FnOnce(&[u8; 16]) -> Zeroizing<[u8; 32]> {
        move |_| Zeroizing::new([byte; 32])
    }

    /// PNG minimal: magic, IHDR, IEND. CRC tidak diperiksa `validate_png`.
    fn tiny_png(width: u32, height: u32) -> Vec<u8> {
        let mut v = PNG_MAGIC.to_vec();
        v.extend_from_slice(&13u32.to_be_bytes());
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&width.to_be_bytes());
        v.extend_from_slice(&height.to_be_bytes());
        v.extend_from_slice(&[8, 6, 0, 0, 0]);
        v.extend_from_slice(&[0; 4]);
        v.extend_from_slice(&0u32.to_be_bytes());
        v.extend_from_slice(b"IEND");
        v.extend_from_slice(&[0xae, 0x42, 0x60, 0x82]);
        v
    }

    fn at(secs: i64) -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(1_795_000_000 + secs).unwrap()
    }

    #[test]
    fn pin_length_bounds() {
        assert!(validate_pin("12345").is_err());
        assert!(validate_pin("123456").is_ok());
        assert!(validate_pin("123456789012").is_ok());
        assert!(validate_pin("1234567890123").is_err());
        assert!(validate_pin("").is_err());
    }

    #[test]
    fn pin_rejects_non_digits() {
        for pin in [
            "12345a",
            "123 456",
            " 123456",
            "123456 ",
            "１２３４５６",
            "12-3456",
        ] {
            let e = validate_pin(pin).unwrap_err();
            assert_eq!(e.code(), "pin_invalid", "{pin:?}");
            assert_eq!(e.to_string(), "PIN harus 6 sampai 12 angka.");
        }
    }

    proptest! {
        #[test]
        fn pin_valid_iff_6_to_12_ascii_digits(pin in "\\PC{0,14}") {
            let expected = (6..=12).contains(&pin.len()) && pin.bytes().all(|b| b.is_ascii_digit());
            prop_assert_eq!(validate_pin(&pin).is_ok(), expected);
        }

        #[test]
        fn attempts_policy_invariants(failed in 0u32..200) {
            let a = register_failure(Attempts { failed, locked_until: None }, at(0));
            prop_assert_eq!(a.failed, failed + 1);
            prop_assert!((1..=5).contains(&attempts_left(&a)));
            prop_assert_eq!(a.locked_until.is_some(), (failed + 1).is_multiple_of(5));
        }
    }

    #[test]
    fn kdf_string_round_trip() {
        assert_eq!(
            KdfParams::DEFAULT.to_string(),
            "argon2id;v=19;m=65536;t=3;p=1"
        );
        assert_eq!(
            "argon2id;v=19;m=65536;t=3;p=1"
                .parse::<KdfParams>()
                .unwrap(),
            KdfParams::DEFAULT
        );
        assert_eq!(
            KdfParams::parse(&KdfParams::TEST.to_string()).unwrap(),
            KdfParams::TEST
        );
    }

    #[test]
    fn kdf_string_rejects_bad_or_out_of_range() {
        for s in [
            "",
            "argon2i;v=19;m=65536;t=3;p=1",
            "argon2id;v=16;m=65536;t=3;p=1",
            "argon2id;v=19;m=4;t=3;p=1",
            "argon2id;v=19;m=1048577;t=3;p=1",
            "argon2id;v=19;m=4294967295;t=3;p=1",
            "argon2id;v=19;m=65536;t=0;p=1",
            "argon2id;v=19;m=65536;t=11;p=1",
            "argon2id;v=19;m=65536;t=3;p=0",
            "argon2id;v=19;m=65536;t=3;p=5",
            "argon2id;v=19;m=8;t=1;p=4",
            "argon2id;v=19;m=065536;t=3;p=1",
            "argon2id;v=19;m=+65536;t=3;p=1",
            "argon2id;v=19;m=65536;t=3;p=1;",
            "argon2id;v=19;t=3;m=65536;p=1",
            "argon2id;v=19;m=;t=3;p=1",
            "argon2id;v=19;m=99999999999;t=3;p=1",
        ] {
            assert!(KdfParams::parse(s).is_err(), "{s:?}");
        }
    }

    #[test]
    fn derive_key_is_deterministic_and_depends_on_every_input() {
        let p = KdfParams::TEST;
        let k = derive_key("123456", &[1; 16], &[2; 32], &p).unwrap();
        assert_eq!(*k, *derive_key("123456", &[1; 16], &[2; 32], &p).unwrap());
        assert_ne!(*k, *derive_key("123457", &[1; 16], &[2; 32], &p).unwrap());
        assert_ne!(*k, *derive_key("123456", &[9; 16], &[2; 32], &p).unwrap());
        assert_ne!(*k, *derive_key("123456", &[1; 16], &[9; 32], &p).unwrap());
        let p2 = KdfParams { t_cost: 2, ..p };
        assert_ne!(*k, *derive_key("123456", &[1; 16], &[2; 32], &p2).unwrap());
    }

    #[test]
    fn derive_key_accepts_default_params() {
        let k = derive_key("123456", &[1; 16], &[2; 32], &KdfParams::DEFAULT).unwrap();
        assert_ne!(*k, [0; 32]);
    }

    #[test]
    fn seal_open_round_trip() {
        let png = tiny_png(10, 20);
        let aad = aad_for(&"ab".repeat(32));
        let sealed = seal_image("123456", fixed_pepper(7), &png, &aad, &KdfParams::TEST).unwrap();
        assert_eq!(sealed.kdf, KdfParams::TEST.to_string());
        assert_eq!(sealed.ciphertext.len(), png.len() + 16);
        assert_ne!(&sealed.ciphertext[..png.len()], &png[..]);
        let opened = open_image("123456", fixed_pepper(7), &sealed, &aad).unwrap();
        assert_eq!(
            opened.as_deref().map(|v| v.as_slice()),
            Some(png.as_slice())
        );
    }

    #[test]
    fn seal_uses_fresh_salt_and_nonce_and_passes_salt_to_pepper() {
        let png = tiny_png(1, 1);
        let mut seen = None;
        let a = seal_image(
            "123456",
            |salt| {
                seen = Some(*salt);
                Zeroizing::new([7; 32])
            },
            &png,
            b"x",
            &KdfParams::TEST,
        )
        .unwrap();
        assert_eq!(seen, Some(a.salt));
        let b = seal_image("123456", fixed_pepper(7), &png, b"x", &KdfParams::TEST).unwrap();
        assert_ne!(a.salt, b.salt);
        assert_ne!(a.nonce, b.nonce);
    }

    #[test]
    fn wrong_pin_aad_or_pepper_gives_none() {
        let png = tiny_png(3, 3);
        let aad = aad_for(&"ab".repeat(32));
        let sealed = seal_image("123456", fixed_pepper(7), &png, &aad, &KdfParams::TEST).unwrap();
        assert!(
            open_image("654321", fixed_pepper(7), &sealed, &aad)
                .unwrap()
                .is_none()
        );
        assert!(
            open_image("1234567", fixed_pepper(7), &sealed, &aad)
                .unwrap()
                .is_none()
        );
        let other_aad = aad_for(&"cd".repeat(32));
        assert!(
            open_image("123456", fixed_pepper(7), &sealed, &other_aad)
                .unwrap()
                .is_none()
        );
        assert!(
            open_image("123456", fixed_pepper(8), &sealed, &aad)
                .unwrap()
                .is_none()
        );

        let mut tampered = sealed.clone();
        tampered.ciphertext[0] ^= 1;
        assert!(
            open_image("123456", fixed_pepper(7), &tampered, &aad)
                .unwrap()
                .is_none()
        );
        let mut short = sealed.clone();
        short.ciphertext.truncate(4);
        assert!(
            open_image("123456", fixed_pepper(7), &short, &aad)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn open_with_corrupt_kdf_is_an_error() {
        let png = tiny_png(3, 3);
        let mut sealed =
            seal_image("123456", fixed_pepper(7), &png, b"x", &KdfParams::TEST).unwrap();
        sealed.kdf = "argon2id;v=19;m=4294967295;t=3;p=1".into();
        let e = open_image("123456", fixed_pepper(7), &sealed, b"x").unwrap_err();
        assert_eq!(e.code(), "internal");
    }

    #[test]
    fn seal_rejects_invalid_pin() {
        let e = seal_image("12ab56", fixed_pepper(7), b"x", b"x", &KdfParams::TEST).unwrap_err();
        assert_eq!(e.code(), "pin_invalid");
    }

    #[test]
    fn aad_has_prefix_and_key() {
        let pk = "ab".repeat(32);
        let aad = aad_for(&pk);
        assert_eq!(
            aad,
            [b"mira-signature-v1\n".as_slice(), pk.as_bytes()].concat()
        );
    }

    #[test]
    fn pepper_from_signature_is_stable_and_salt_bound() {
        assert_eq!(
            *pepper_from_signature(&[1; 64]),
            *pepper_from_signature(&[1; 64])
        );
        assert_ne!(
            *pepper_from_signature(&[1; 64]),
            *pepper_from_signature(&[2; 64])
        );
        assert_eq!(
            pepper_message(&[5; 16]),
            [b"mira-signature-pepper-v1".as_slice(), &[5; 16]].concat()
        );
    }

    #[test]
    fn pepper_from_identity_is_deterministic() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(dir.path()).unwrap();
        let id = crate::identity::ensure_identity(&conn, &crate::identity::MemoryKeyStore::new())
            .unwrap();
        let a = pepper_from_identity(&id, &[1; 16]);
        assert_eq!(*a, *pepper_from_identity(&id, &[1; 16]));
        assert_ne!(*a, *pepper_from_identity(&id, &[2; 16]));
        let sig = id.sign(&pepper_message(&[1; 16])).to_bytes();
        assert_eq!(*a, *pepper_from_signature(&sig));
    }

    #[test]
    fn png_valid_small() {
        assert_eq!(validate_png(&tiny_png(1, 1)).unwrap(), (1, 1));
        assert_eq!(validate_png(&tiny_png(400, 150)).unwrap(), (400, 150));
        assert_eq!(validate_png(&tiny_png(2000, 2000)).unwrap(), (2000, 2000));
    }

    #[test]
    fn png_invalid() {
        let mut bad_magic = tiny_png(10, 10);
        bad_magic[1] = b'X';
        let mut bad_chunk = tiny_png(10, 10);
        bad_chunk[12..16].copy_from_slice(b"IDAT");
        let mut bad_len = tiny_png(10, 10);
        bad_len[11] = 12;
        let mut too_big = tiny_png(10, 10);
        too_big.resize(MAX_PNG_BYTES + 1, 0);
        let cases = [
            Vec::new(),
            b"GIF89a".to_vec(),
            tiny_png(10, 10)[..30].to_vec(),
            bad_magic,
            bad_chunk,
            bad_len,
            tiny_png(0, 10),
            tiny_png(10, 0),
            tiny_png(2001, 10),
            tiny_png(10, 2001),
            tiny_png(u32::MAX, 10),
            too_big,
        ];
        for (i, bytes) in cases.iter().enumerate() {
            let e = validate_png(bytes).unwrap_err();
            assert_eq!(e.code(), "image_invalid", "case {i}");
            assert!(!e.to_string().contains('\u{2014}'));
        }
        let mut max_ok = tiny_png(10, 10);
        max_ok.resize(MAX_PNG_BYTES, 0);
        assert!(validate_png(&max_ok).is_ok());
    }

    fn fail_n(n: u32, now: OffsetDateTime) -> Attempts {
        (0..n).fold(Attempts::default(), |a, _| register_failure(a, now))
    }

    #[test]
    fn lock_policy_at_4_5_9_10_20() {
        let now = at(0);
        let a4 = fail_n(4, now);
        assert_eq!(a4.locked_until, None);
        assert_eq!(attempts_left(&a4), 1);
        assert!(check_locked(&a4, now).is_ok());

        let a5 = fail_n(5, now);
        assert_eq!(a5.locked_until, Some(now + Duration::minutes(1)));
        assert_eq!(check_locked(&a5, now), Err(now + Duration::minutes(1)));
        assert_eq!(
            check_locked(&a5, now + Duration::seconds(59)),
            Err(now + Duration::minutes(1))
        );
        assert!(check_locked(&a5, now + Duration::minutes(1)).is_ok());
        assert_eq!(attempts_left(&a5), 5);

        let a6 = register_failure(a5, now + Duration::minutes(2));
        assert_eq!(a6.locked_until, None);
        assert_eq!(attempts_left(&a6), 4);

        let a9 = fail_n(9, now);
        assert_eq!(a9.locked_until, None);
        assert_eq!(attempts_left(&a9), 1);

        assert_eq!(
            fail_n(10, now).locked_until,
            Some(now + Duration::minutes(5))
        );
        assert_eq!(
            fail_n(15, now).locked_until,
            Some(now + Duration::minutes(15))
        );
        assert_eq!(
            fail_n(20, now).locked_until,
            Some(now + Duration::minutes(60))
        );
        assert_eq!(fail_n(21, now).locked_until, None);
        assert_eq!(
            fail_n(25, now).locked_until,
            Some(now + Duration::minutes(60))
        );
        assert_eq!(
            fail_n(100, now).locked_until,
            Some(now + Duration::minutes(60))
        );
    }

    #[test]
    fn reset_clears_everything() {
        assert_eq!(
            reset(),
            Attempts {
                failed: 0,
                locked_until: None
            }
        );
        assert_eq!(attempts_left(&reset()), 5);
    }

    #[test]
    fn clamp_lock_limits_lock_after_clock_moved_back() {
        let now = at(0);
        // Kunci 1 menit tercatat, lalu jam dimundurkan 1 hari.
        let mut a = fail_n(5, now + Duration::days(1));
        assert!(clamp_lock(&mut a, now));
        assert_eq!(a.locked_until, Some(now + Duration::minutes(1)));
        // Nilai yang sudah dibatasi tidak berubah lagi.
        assert!(!clamp_lock(&mut a, now));

        // Kunci normal tidak disentuh.
        let mut b = fail_n(10, now);
        assert!(!clamp_lock(&mut b, now + Duration::seconds(30)));
        assert_eq!(b.locked_until, Some(now + Duration::minutes(5)));

        // Data tidak konsisten (bukan kelipatan 5) dibatasi 60 menit.
        let mut c = Attempts {
            failed: 3,
            locked_until: Some(now + Duration::days(30)),
        };
        assert!(clamp_lock(&mut c, now));
        assert_eq!(c.locked_until, Some(now + Duration::minutes(60)));

        let mut none = Attempts::default();
        assert!(!clamp_lock(&mut none, now));
    }

    #[test]
    fn wait_text_hours_and_minutes() {
        let now = at(0);
        assert_eq!(wait_text(now + Duration::seconds(30), now), "1 menit");
        assert_eq!(wait_text(now + Duration::minutes(59), now), "59 menit");
        assert_eq!(wait_text(now + Duration::minutes(60), now), "1 jam");
        assert_eq!(
            wait_text(now + Duration::hours(23) + Duration::seconds(61), now),
            "23 jam 2 menit"
        );
        assert_eq!(wait_text(now + Duration::hours(24), now), "24 jam");
    }

    #[test]
    fn minutes_until_rounds_up() {
        let now = at(0);
        assert_eq!(minutes_until(now + Duration::seconds(1), now), 1);
        assert_eq!(minutes_until(now + Duration::seconds(60), now), 1);
        assert_eq!(minutes_until(now + Duration::seconds(61), now), 2);
        assert_eq!(minutes_until(now + Duration::minutes(60), now), 60);
        assert_eq!(minutes_until(now - Duration::seconds(5), now), 1);
    }
}
