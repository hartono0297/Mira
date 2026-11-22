//! Tanda tangan tersimpan di SQLite (`sign_saved_signature`), satu baris per
//! `owner` (kunci publik laptop). Gambar PNG terenkripsi dengan kunci turunan
//! PIN (lihat `pin`); lebar dan tinggi disimpan tanpa enkripsi supaya kotak
//! tanda tangan bisa ditempatkan sebelum PIN diminta.
//!
//! Menghapus tanda tangan punya dua jalur:
//!
//! - Dengan PIN (`delete_with_pin`): PIN diperiksa seperti `unlock` (ikut
//!   batas percobaan, pesan sama). Tanda tangan baru bisa langsung dipakai.
//! - Tanpa PIN (`delete_forgot_pin`, jalur lupa PIN): waktu penghapusan
//!   dicatat di `sign_pin_resets`. Tanda tangan yang dibuat dalam 24 jam
//!   sesudahnya mendapat `usable_after` = waktu hapus + 24 jam dan baru bisa
//!   dibuka mulai saat itu (`signature_cooling`).
//!
//! Masa tunggu menutup celah "hapus lalu buat ulang": rekan di laptop yang
//! tidak terkunci bisa menghapus tanda tangan pemilik dan membuat yang baru
//! dengan PIN-nya sendiri, tetapi baru bisa memakainya 24 jam kemudian, dan
//! pemilik melihat `usableAfter` di layarnya serta catatan
//! `signature_deleted` di jejak audit setiap permintaan yang berjalan.
//!
//! Catatan reset TIDAK dihapus oleh penghapusan berikutnya yang memakai PIN.
//! Kalau dihapus, celah bisa diakali: hapus tanpa PIN, buat tanda tangan
//! baru dengan PIN sendiri, hapus lagi dengan PIN itu, lalu buat lagi tanpa
//! masa tunggu. Jadi masa tunggu tetap berlaku sampai habis, siapa pun yang
//! menghapus sesudahnya. Hapus tanpa PIN lagi selama masa tunggu memulai
//! masa tunggu dari awal.
//!
//! Waktu memakai jam laptop. Jam yang dimundurkan memperpanjang masa tunggu
//! (arah yang aman); memajukan jam Windows butuh hak admin.

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use zeroize::Zeroizing;

use super::err;
use super::pin::{self, Attempts, KdfParams, SealedImage};
use crate::clock;
use crate::error::{AppError, AppResult};
use crate::identity::Identity;

/// Masa tunggu tanda tangan baru setelah tanda tangan lama dihapus tanpa PIN.
pub const RESET_COOLDOWN: Duration = Duration::hours(24);

/// Yang dilihat frontend tentang tanda tangan tersimpan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSignatureInfo {
    pub width: u32,
    pub height: u32,
    pub created_at: String,
    pub failed_attempts: u32,
    pub locked_until: Option<String>,
    pub attempts_left: u32,
    /// Diisi kalau tanda tangan dibuat dalam 24 jam setelah tanda tangan lama
    /// dihapus tanpa PIN: baru bisa dipakai mulai waktu ini. Dibalas apa
    /// adanya (juga setelah lewat); frontend membandingkan dengan jam
    /// sekarang.
    pub usable_after: Option<String>,
}

/// Gambar tanda tangan yang sudah dibuka dengan PIN.
pub struct Unlocked {
    pub png: Zeroizing<Vec<u8>>,
    pub width: u32,
    pub height: u32,
}

impl std::fmt::Debug for Unlocked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Unlocked")
            .field("png_len", &self.png.len())
            .field("width", &self.width)
            .field("height", &self.height)
            .finish()
    }
}

fn corrupt() -> AppError {
    AppError::Internal(
        "Data tanda tangan tersimpan rusak. Hapus tanda tangan lalu buat lagi.".into(),
    )
}

fn parse_time(s: &str) -> AppResult<OffsetDateTime> {
    OffsetDateTime::parse(s, &Rfc3339).map_err(|_| corrupt())
}

fn to_u32(v: i64) -> AppResult<u32> {
    u32::try_from(v).map_err(|_| corrupt())
}

fn attempts_from_row(failed: i64, locked_until: Option<&str>) -> AppResult<Attempts> {
    Ok(Attempts {
        failed: to_u32(failed)?,
        locked_until: locked_until.map(parse_time).transpose()?,
    })
}

fn read_attempts(conn: &Connection, owner: &str) -> AppResult<Option<Attempts>> {
    let row = conn
        .query_row(
            "SELECT failed_attempts, locked_until FROM sign_saved_signature WHERE owner = ?1",
            params![owner],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    row.map(|(failed, locked)| attempts_from_row(failed, locked.as_deref()))
        .transpose()
}

fn write_attempts(conn: &Connection, owner: &str, attempts: &Attempts) -> AppResult<()> {
    conn.execute(
        "UPDATE sign_saved_signature SET failed_attempts = ?1, locked_until = ?2 WHERE owner = ?3",
        params![
            attempts.failed,
            attempts.locked_until.map(clock::format_rfc3339),
            owner
        ],
    )?;
    Ok(())
}

/// Info tanda tangan tersimpan milik `owner`, atau `None` kalau belum ada.
/// `locked_until` dibatasi seperti `pin::clamp_lock` pada waktu `now` (hanya
/// di hasil; nilai di database dibatasi saat PIN diperiksa).
pub fn status(
    conn: &Connection,
    owner: &str,
    now: OffsetDateTime,
) -> AppResult<Option<SavedSignatureInfo>> {
    let row = conn
        .query_row(
            "SELECT width, height, created_at, failed_attempts, locked_until, usable_after
             FROM sign_saved_signature WHERE owner = ?1",
            params![owner],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((width, height, created_at, failed, locked_until, usable_after)) = row else {
        return Ok(None);
    };
    let mut attempts = attempts_from_row(failed, locked_until.as_deref())?;
    pin::clamp_lock(&mut attempts, now);
    let usable_after = usable_after.as_deref().map(parse_time).transpose()?;
    Ok(Some(SavedSignatureInfo {
        width: to_u32(width)?,
        height: to_u32(height)?,
        created_at,
        failed_attempts: attempts.failed,
        locked_until: attempts.locked_until.map(clock::format_rfc3339),
        attempts_left: pin::attempts_left(&attempts),
        usable_after: usable_after.map(clock::format_rfc3339),
    }))
}

/// Waktu terakhir tanda tangan `owner` dihapus tanpa PIN, kalau pernah.
pub fn last_reset(conn: &Connection, owner: &str) -> AppResult<Option<OffsetDateTime>> {
    let at = conn
        .query_row(
            "SELECT reset_at FROM sign_pin_resets WHERE owner = ?1",
            params![owner],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    at.as_deref().map(parse_time).transpose()
}

/// Mencatat hapus tanpa PIN pada `now`. Kalau catatan lama lebih baru (jam
/// pernah dimundurkan), catatan lama dipertahankan supaya masa tunggu tidak
/// bisa dipendekkan.
fn record_reset(conn: &Connection, owner: &str, now: OffsetDateTime) -> AppResult<()> {
    let at = match last_reset(conn, owner)? {
        Some(prev) if prev > now => prev,
        _ => now,
    };
    conn.execute(
        "INSERT INTO sign_pin_resets (owner, reset_at) VALUES (?1, ?2)
         ON CONFLICT (owner) DO UPDATE SET reset_at = excluded.reset_at",
        params![owner, clock::format_rfc3339(at)],
    )?;
    Ok(())
}

fn exists_error() -> AppError {
    err(
        "signature_exists",
        "Tanda tangan sudah tersimpan. Hapus dulu kalau ingin menggantinya.",
    )
}

/// Menyimpan tanda tangan baru milik laptop ini, dienkripsi dengan PIN.
/// Kalau tanda tangan lama dihapus tanpa PIN kurang dari 24 jam lalu, yang
/// baru mendapat `usable_after` = waktu hapus + 24 jam.
pub fn save(
    conn: &Connection,
    identity: &Identity,
    pin: &str,
    png: &[u8],
    now: OffsetDateTime,
    params: &KdfParams,
) -> AppResult<SavedSignatureInfo> {
    pin::validate_pin(pin)?;
    let (width, height) = pin::validate_png(png)?;
    let owner = identity.public_key_hex();
    // Periksa dulu supaya Argon2 tidak dijalankan sia-sia; `ON CONFLICT` di
    // bawah tetap menjaga kalau ada dua penyimpanan bersamaan.
    if status(conn, owner, now)?.is_some() {
        return Err(exists_error());
    }
    let usable_after = last_reset(conn, owner)?
        .map(|reset| reset + RESET_COOLDOWN)
        .filter(|until| *until > now);
    let sealed = pin::seal_image(
        pin,
        |salt| pin::pepper_from_identity(identity, salt),
        png,
        &pin::aad_for(owner),
        params,
    )?;
    let inserted = conn.execute(
        "INSERT INTO sign_saved_signature
             (owner, kdf, salt, nonce, ciphertext, width, height, created_at, failed_attempts, locked_until, usable_after)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, NULL, ?9)
         ON CONFLICT (owner) DO NOTHING",
        params![
            owner,
            sealed.kdf,
            sealed.salt.as_slice(),
            sealed.nonce.as_slice(),
            sealed.ciphertext,
            width,
            height,
            clock::format_rfc3339(now),
            usable_after.map(clock::format_rfc3339),
        ],
    )?;
    if inserted == 0 {
        return Err(exists_error());
    }
    status(conn, owner, now)?
        .ok_or_else(|| AppError::Internal("Tanda tangan tidak ditemukan setelah disimpan.".into()))
}

/// Menghapus tanda tangan milik `owner` tanpa PIN (jalur lupa PIN) dan
/// mencatat waktu reset. `true` kalau ada yang dihapus; tidak ada yang
/// dihapus berarti tidak ada reset yang dicatat. Panggil di dalam transaksi.
pub fn delete_forgot_pin(conn: &Connection, owner: &str, now: OffsetDateTime) -> AppResult<bool> {
    let n = conn.execute(
        "DELETE FROM sign_saved_signature WHERE owner = ?1",
        params![owner],
    )?;
    if n > 0 {
        record_reset(conn, owner, now)?;
    }
    Ok(n > 0)
}

/// Menghapus tanda tangan milik laptop ini setelah PIN-nya diperiksa seperti
/// `unlock` (format, kunci waktu, hitungan salah, pesan yang sama). Masa
/// tunggu tidak menghalangi hapus dengan PIN, dan catatan reset tidak
/// disentuh (lihat dokumentasi modul). `on_deleted` dijalankan di transaksi
/// yang sama setelah baris dihapus (misalnya untuk jejak audit). `false`
/// kalau belum ada tanda tangan.
pub fn delete_with_pin(
    conn: &mut Connection,
    identity: &Identity,
    pin: &str,
    now: OffsetDateTime,
    on_deleted: impl FnOnce(&Connection) -> AppResult<()>,
) -> AppResult<bool> {
    let owner = identity.public_key_hex();
    let opened = check_pin(conn, identity, pin, now, false, |tx| {
        tx.execute(
            "DELETE FROM sign_saved_signature WHERE owner = ?1",
            params![owner],
        )?;
        on_deleted(tx)
    })?;
    Ok(opened.is_some())
}

fn missing_error() -> AppError {
    err(
        "signature_missing",
        "Belum ada tanda tangan tersimpan. Buat tanda tangan dulu.",
    )
}

fn locked_error(until: OffsetDateTime, now: OffsetDateTime) -> AppError {
    err(
        "pin_locked",
        format!(
            "Terlalu banyak PIN salah. Coba lagi dalam sekitar {} menit.",
            pin::minutes_until(until, now)
        ),
    )
}

fn cooling_error(until: OffsetDateTime, now: OffsetDateTime) -> AppError {
    err(
        "signature_cooling",
        format!(
            "Tanda tangan ini dibuat setelah tanda tangan lama dihapus tanpa PIN, jadi baru bisa dipakai sekitar {} lagi. Masa tunggu ini mencegah orang lain memakai tanda tangan buatannya atas nama Anda. Kalau bukan Anda yang menghapus tanda tangan lama, segera beri tahu admin.",
            pin::wait_text(until, now)
        ),
    )
}

struct SealedRow {
    sealed: SealedImage,
    attempts: Attempts,
    usable_after: Option<OffsetDateTime>,
}

fn load_sealed(conn: &Connection, owner: &str) -> AppResult<Option<SealedRow>> {
    let row = conn
        .query_row(
            "SELECT kdf, salt, nonce, ciphertext, failed_attempts, locked_until, usable_after
             FROM sign_saved_signature WHERE owner = ?1",
            params![owner],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Vec<u8>>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                    r.get::<_, Vec<u8>>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .optional()?;
    let Some((kdf, salt, nonce, ciphertext, failed, locked_until, usable_after)) = row else {
        return Ok(None);
    };
    Ok(Some(SealedRow {
        sealed: SealedImage {
            kdf,
            salt: salt.try_into().map_err(|_| corrupt())?,
            nonce: nonce.try_into().map_err(|_| corrupt())?,
            ciphertext,
        },
        attempts: attempts_from_row(failed, locked_until.as_deref())?,
        usable_after: usable_after.as_deref().map(parse_time).transpose()?,
    }))
}

/// Pemeriksaan PIN bersama `unlock` dan `delete_with_pin`. `Ok(None)` kalau
/// belum ada tanda tangan.
///
/// Urutan: baris harus ada; kalau `enforce_cooling`, masa tunggu harus sudah
/// lewat (`signature_cooling`, sebelum Argon2 dan tidak dihitung salah);
/// format PIN benar (`pin_invalid`, tidak dihitung); tidak sedang terkunci
/// (`pin_locked`; kunci yang terlalu panjang karena jam mundur dibatasi dan
/// disimpan). PIN salah menambah hitungan dalam transaksi lalu membalas
/// `pin_wrong`; PIN benar mereset hitungan lalu menjalankan `on_ok` di
/// transaksi yang sama.
fn check_pin(
    conn: &mut Connection,
    identity: &Identity,
    pin: &str,
    now: OffsetDateTime,
    enforce_cooling: bool,
    on_ok: impl FnOnce(&Connection) -> AppResult<()>,
) -> AppResult<Option<Zeroizing<Vec<u8>>>> {
    let owner = identity.public_key_hex();
    let Some(mut row) = load_sealed(conn, owner)? else {
        return Ok(None);
    };
    if enforce_cooling
        && let Some(until) = row.usable_after
        && until > now
    {
        return Err(cooling_error(until, now));
    }
    pin::validate_pin(pin)?;
    if pin::clamp_lock(&mut row.attempts, now) {
        write_attempts(conn, owner, &row.attempts)?;
    }
    if let Err(until) = pin::check_locked(&row.attempts, now) {
        return Err(locked_error(until, now));
    }
    let opened = pin::open_image(
        pin,
        |salt| pin::pepper_from_identity(identity, salt),
        &row.sealed,
        &pin::aad_for(owner),
    )?;

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // Baca ulang di dalam transaksi: Argon2 butuh waktu, dan percobaan lain
    // bisa sudah menambah hitungan di antaranya.
    let current = read_attempts(&tx, owner)?.ok_or_else(missing_error)?;
    match opened {
        Some(png) => {
            if current != pin::reset() {
                write_attempts(&tx, owner, &pin::reset())?;
            }
            on_ok(&tx)?;
            tx.commit()?;
            Ok(Some(png))
        }
        None => {
            let next = pin::register_failure(current, now);
            write_attempts(&tx, owner, &next)?;
            tx.commit()?;
            let message = match next.locked_until {
                Some(until) => format!(
                    "PIN salah. Tanda tangan dikunci sementara, coba lagi dalam sekitar {} menit.",
                    pin::minutes_until(until, now)
                ),
                None => format!(
                    "PIN salah. Sisa {} kali lagi sebelum dikunci sementara.",
                    pin::attempts_left(&next)
                ),
            };
            Err(err("pin_wrong", message))
        }
    }
}

/// Membuka tanda tangan milik laptop ini dengan PIN.
///
/// Urutan: baris harus ada (`signature_missing`), masa tunggu setelah hapus
/// tanpa PIN sudah lewat (`signature_cooling`), format PIN harus benar
/// (`pin_invalid`, tidak menambah hitungan), tidak sedang terkunci
/// (`pin_locked`). PIN salah menambah hitungan dalam transaksi lalu membalas
/// `pin_wrong`; PIN benar mereset hitungan.
pub fn unlock(
    conn: &mut Connection,
    identity: &Identity,
    pin: &str,
    now: OffsetDateTime,
) -> AppResult<Unlocked> {
    let png = check_pin(conn, identity, pin, now, true, |_| Ok(()))?.ok_or_else(missing_error)?;
    let (width, height) = pin::validate_png(&png).map_err(|_| corrupt())?;
    Ok(Unlocked { png, width, height })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{MemoryKeyStore, ensure_identity};
    use time::Duration;

    const PIN: &str = "123456";

    fn tiny_png(width: u32, height: u32) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
        v.extend_from_slice(&13u32.to_be_bytes());
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&width.to_be_bytes());
        v.extend_from_slice(&height.to_be_bytes());
        v.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        v.extend_from_slice(&0u32.to_be_bytes());
        v.extend_from_slice(b"IEND");
        v.extend_from_slice(&[0xae, 0x42, 0x60, 0x82]);
        v
    }

    struct Env {
        _dir: tempfile::TempDir,
        conn: Connection,
        id: Identity,
    }

    fn env() -> Env {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(dir.path()).unwrap();
        let id = ensure_identity(&conn, &MemoryKeyStore::new()).unwrap();
        Env {
            _dir: dir,
            conn,
            id,
        }
    }

    fn at(secs: i64) -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(1_795_000_000 + secs).unwrap()
    }

    fn save_test(e: &Env, png: &[u8]) -> AppResult<SavedSignatureInfo> {
        save(&e.conn, &e.id, PIN, png, at(0), &KdfParams::TEST)
    }

    fn failed(e: &Env) -> u32 {
        status(&e.conn, e.id.public_key_hex(), at(0))
            .unwrap()
            .unwrap()
            .failed_attempts
    }

    fn no_em_dash(err: &AppError) {
        assert!(!err.to_string().contains('\u{2014}'), "{err}");
    }

    #[test]
    fn save_status_unlock_delete() {
        let mut e = env();
        let owner = e.id.public_key_hex().to_owned();
        assert_eq!(status(&e.conn, &owner, at(0)).unwrap(), None);

        let png = tiny_png(320, 120);
        let info = save_test(&e, &png).unwrap();
        assert_eq!(
            info,
            SavedSignatureInfo {
                width: 320,
                height: 120,
                created_at: clock::format_rfc3339(at(0)),
                failed_attempts: 0,
                locked_until: None,
                attempts_left: 5,
                usable_after: None,
            }
        );
        assert_eq!(status(&e.conn, &owner, at(0)).unwrap(), Some(info));

        let json = serde_json::to_value(status(&e.conn, &owner, at(0)).unwrap()).unwrap();
        assert_eq!(json["createdAt"], clock::format_rfc3339(at(0)));
        assert_eq!(json["failedAttempts"], 0);
        assert_eq!(json["lockedUntil"], serde_json::Value::Null);
        assert_eq!(json["attemptsLeft"], 5);

        let kdf: String = e
            .conn
            .query_row(
                "SELECT kdf FROM sign_saved_signature WHERE owner = ?1",
                params![owner],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kdf, KdfParams::TEST.to_string());

        let u = unlock(&mut e.conn, &e.id, PIN, at(1)).unwrap();
        assert_eq!(u.png.as_slice(), png.as_slice());
        assert_eq!((u.width, u.height), (320, 120));
        assert!(format!("{u:?}").contains("png_len"));

        assert!(delete_forgot_pin(&e.conn, &owner, at(2)).unwrap());
        assert!(!delete_forgot_pin(&e.conn, &owner, at(2)).unwrap());
        assert_eq!(status(&e.conn, &owner, at(0)).unwrap(), None);
    }

    #[test]
    fn save_with_default_params_stores_default_kdf() {
        let e = env();
        save(
            &e.conn,
            &e.id,
            PIN,
            &tiny_png(2, 2),
            at(0),
            &KdfParams::DEFAULT,
        )
        .unwrap();
        let kdf: String = e
            .conn
            .query_row("SELECT kdf FROM sign_saved_signature", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kdf, "argon2id;v=19;m=65536;t=3;p=1");
        assert_eq!(KdfParams::parse(&kdf).unwrap(), KdfParams::DEFAULT);
    }

    #[test]
    fn save_twice_is_rejected_until_deleted() {
        let e = env();
        save_test(&e, &tiny_png(10, 10)).unwrap();
        let err = save_test(&e, &tiny_png(20, 20)).unwrap_err();
        assert_eq!(err.code(), "signature_exists");
        assert_eq!(
            err.to_string(),
            "Tanda tangan sudah tersimpan. Hapus dulu kalau ingin menggantinya."
        );
        assert!(delete_forgot_pin(&e.conn, e.id.public_key_hex(), at(2)).unwrap());
        assert_eq!(save_test(&e, &tiny_png(20, 20)).unwrap().width, 20);
    }

    #[test]
    fn save_validates_pin_and_png() {
        let e = env();
        let err = save(
            &e.conn,
            &e.id,
            "12345",
            &tiny_png(2, 2),
            at(0),
            &KdfParams::TEST,
        )
        .unwrap_err();
        assert_eq!(err.code(), "pin_invalid");
        let err = save_test(&e, b"not a png").unwrap_err();
        assert_eq!(err.code(), "image_invalid");
        let err = save_test(&e, &tiny_png(2001, 2)).unwrap_err();
        assert_eq!(err.code(), "image_invalid");
        assert_eq!(status(&e.conn, e.id.public_key_hex(), at(0)).unwrap(), None);
    }

    #[test]
    fn unlock_without_signature_is_missing() {
        let mut e = env();
        let err = unlock(&mut e.conn, &e.id, PIN, at(0)).unwrap_err();
        assert_eq!(err.code(), "signature_missing");
        no_em_dash(&err);
    }

    #[test]
    fn invalid_pin_format_does_not_count() {
        let mut e = env();
        save_test(&e, &tiny_png(5, 5)).unwrap();
        for bad in ["12345", "abcdef", "1234567890123", "12 3456"] {
            let err = unlock(&mut e.conn, &e.id, bad, at(1)).unwrap_err();
            assert_eq!(err.code(), "pin_invalid");
        }
        assert_eq!(failed(&e), 0);
    }

    #[test]
    fn wrong_pin_counts_down_then_locks_and_resets() {
        let mut e = env();
        let owner = e.id.public_key_hex().to_owned();
        save_test(&e, &tiny_png(5, 5)).unwrap();

        for i in 1..=4u32 {
            let err = unlock(&mut e.conn, &e.id, "000000", at(10)).unwrap_err();
            assert_eq!(err.code(), "pin_wrong");
            assert_eq!(
                err.to_string(),
                format!(
                    "PIN salah. Sisa {} kali lagi sebelum dikunci sementara.",
                    5 - i
                )
            );
            no_em_dash(&err);
            assert_eq!(failed(&e), i);
        }

        let err = unlock(&mut e.conn, &e.id, "000000", at(10)).unwrap_err();
        assert_eq!(err.code(), "pin_wrong");
        assert_eq!(
            err.to_string(),
            "PIN salah. Tanda tangan dikunci sementara, coba lagi dalam sekitar 1 menit."
        );
        let info = status(&e.conn, &owner, at(10)).unwrap().unwrap();
        assert_eq!(info.failed_attempts, 5);
        assert_eq!(info.attempts_left, 5);
        assert_eq!(
            info.locked_until,
            Some(clock::format_rfc3339(at(10) + Duration::minutes(1)))
        );

        // Terkunci: PIN benar pun ditolak, dan hitungan tidak bertambah.
        let err = unlock(&mut e.conn, &e.id, PIN, at(30)).unwrap_err();
        assert_eq!(err.code(), "pin_locked");
        assert_eq!(
            err.to_string(),
            "Terlalu banyak PIN salah. Coba lagi dalam sekitar 1 menit."
        );
        no_em_dash(&err);
        let err = unlock(&mut e.conn, &e.id, "000000", at(30)).unwrap_err();
        assert_eq!(err.code(), "pin_locked");
        assert_eq!(failed(&e), 5);

        // Setelah kunci habis, PIN benar mereset hitungan.
        let u = unlock(&mut e.conn, &e.id, PIN, at(70)).unwrap();
        assert_eq!((u.width, u.height), (5, 5));
        let info = status(&e.conn, &owner, at(0)).unwrap().unwrap();
        assert_eq!(info.failed_attempts, 0);
        assert_eq!(info.locked_until, None);
        assert_eq!(info.attempts_left, 5);
    }

    #[test]
    fn second_lock_is_five_minutes() {
        let mut e = env();
        save_test(&e, &tiny_png(5, 5)).unwrap();
        let mut t = 0;
        for _ in 0..9 {
            // Majukan jam melewati kunci pertama.
            t += 120;
            let _ = unlock(&mut e.conn, &e.id, "999999", at(t));
        }
        assert_eq!(failed(&e), 9);
        let err = unlock(&mut e.conn, &e.id, "999999", at(t + 120)).unwrap_err();
        assert_eq!(err.code(), "pin_wrong");
        assert!(err.to_string().contains("sekitar 5 menit"), "{err}");
        let err = unlock(&mut e.conn, &e.id, PIN, at(t + 120 + 61)).unwrap_err();
        assert_eq!(err.code(), "pin_locked");
        assert!(err.to_string().contains("sekitar 4 menit"), "{err}");
    }

    #[test]
    fn other_laptop_cannot_open_copied_row() {
        let e = env();
        save_test(&e, &tiny_png(5, 5)).unwrap();
        let row: (String, Vec<u8>, Vec<u8>, Vec<u8>) = e
            .conn
            .query_row(
                "SELECT kdf, salt, nonce, ciphertext FROM sign_saved_signature",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();

        // Laptop lain dengan kunci berbeda, tetapi baris disalin apa adanya
        // dengan owner diganti supaya AAD-nya cocok dengan laptop itu.
        let mut other = env();
        other
            .conn
            .execute(
                "INSERT INTO sign_saved_signature
                     (owner, kdf, salt, nonce, ciphertext, width, height, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 5, 5, ?6)",
                params![
                    other.id.public_key_hex(),
                    row.0,
                    row.1,
                    row.2,
                    row.3,
                    clock::format_rfc3339(at(0))
                ],
            )
            .unwrap();
        let err = unlock(&mut other.conn, &other.id, PIN, at(1)).unwrap_err();
        assert_eq!(err.code(), "pin_wrong");
    }

    #[test]
    fn corrupt_kdf_is_an_error_not_a_wrong_pin() {
        let mut e = env();
        save_test(&e, &tiny_png(5, 5)).unwrap();
        e.conn
            .execute(
                "UPDATE sign_saved_signature SET kdf = 'argon2id;v=19;m=4294967295;t=3;p=1'",
                [],
            )
            .unwrap();
        let err = unlock(&mut e.conn, &e.id, PIN, at(1)).unwrap_err();
        assert_eq!(err.code(), "internal");
        assert_eq!(failed(&e), 0);
    }

    fn usable_after(e: &Env, now: OffsetDateTime) -> Option<String> {
        status(&e.conn, e.id.public_key_hex(), now)
            .unwrap()
            .unwrap()
            .usable_after
    }

    fn reset_at(e: &Env) -> Option<OffsetDateTime> {
        last_reset(&e.conn, e.id.public_key_hex()).unwrap()
    }

    fn code_of<T>(r: AppResult<T>) -> &'static str {
        match r {
            Ok(_) => "ok",
            Err(e) => e.code(),
        }
    }

    #[test]
    fn forgot_pin_delete_starts_cooling_for_new_signature() {
        let mut e = env();
        let owner = e.id.public_key_hex().to_owned();
        save_test(&e, &tiny_png(5, 5)).unwrap();
        assert_eq!(usable_after(&e, at(0)), None);

        assert!(delete_forgot_pin(&e.conn, &owner, at(100)).unwrap());
        assert_eq!(reset_at(&e), Some(at(100)));

        // Tanda tangan baru dengan PIN lain (misalnya orang lain).
        let info = save(
            &e.conn,
            &e.id,
            "999999",
            &tiny_png(6, 6),
            at(200),
            &KdfParams::TEST,
        )
        .unwrap();
        let until = at(100) + RESET_COOLDOWN;
        assert_eq!(info.usable_after, Some(clock::format_rfc3339(until)));
        assert_eq!(usable_after(&e, at(300)), info.usable_after);
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["usableAfter"], clock::format_rfc3339(until));

        // Sebelum masa tunggu habis: ditolak dan tidak dihitung salah, juga
        // dengan PIN yang salah.
        for pin in ["999999", "000000"] {
            let err = unlock(&mut e.conn, &e.id, pin, at(200)).unwrap_err();
            assert_eq!(err.code(), "signature_cooling");
            no_em_dash(&err);
            assert!(
                err.to_string().contains("sekitar 23 jam 59 menit lagi"),
                "{err}"
            );
        }
        assert_eq!(failed(&e), 0);
        let err = unlock(&mut e.conn, &e.id, "999999", until - Duration::minutes(30)).unwrap_err();
        assert!(err.to_string().contains("sekitar 30 menit lagi"), "{err}");

        // Tepat saat masa tunggu habis: bisa dipakai.
        let u = unlock(&mut e.conn, &e.id, "999999", until).unwrap();
        assert_eq!((u.width, u.height), (6, 6));
    }

    #[test]
    fn cooling_is_checked_before_argon2() {
        let mut e = env();
        let owner = e.id.public_key_hex().to_owned();
        save_test(&e, &tiny_png(5, 5)).unwrap();
        delete_forgot_pin(&e.conn, &owner, at(1)).unwrap();
        save_test(&e, &tiny_png(5, 5)).unwrap();
        // `kdf` rusak akan gagal sebagai `internal` kalau Argon2 dijalankan.
        e.conn
            .execute(
                "UPDATE sign_saved_signature SET kdf = 'argon2id;v=19;m=4294967295;t=3;p=1'",
                [],
            )
            .unwrap();
        let err = unlock(&mut e.conn, &e.id, "12", at(2)).unwrap_err();
        assert_eq!(err.code(), "signature_cooling");
    }

    #[test]
    fn save_after_cooling_window_has_no_wait() {
        let e = env();
        let owner = e.id.public_key_hex().to_owned();
        save_test(&e, &tiny_png(5, 5)).unwrap();
        delete_forgot_pin(&e.conn, &owner, at(0)).unwrap();
        let later = at(0) + RESET_COOLDOWN;
        let info = save(
            &e.conn,
            &e.id,
            PIN,
            &tiny_png(5, 5),
            later,
            &KdfParams::TEST,
        )
        .unwrap();
        assert_eq!(info.usable_after, None);
    }

    #[test]
    fn delete_with_pin_checks_pin_like_unlock() {
        let mut e = env();
        let owner = e.id.public_key_hex().to_owned();
        // Belum ada tanda tangan: tidak ada yang dihapus.
        assert!(!delete_with_pin(&mut e.conn, &e.id, PIN, at(0), |_| Ok(())).unwrap());

        save_test(&e, &tiny_png(5, 5)).unwrap();
        let err = delete_with_pin(&mut e.conn, &e.id, "12", at(1), |_| Ok(())).unwrap_err();
        assert_eq!(err.code(), "pin_invalid");
        for i in 1..=4u32 {
            let err = delete_with_pin(&mut e.conn, &e.id, "000000", at(1), |_| Ok(())).unwrap_err();
            assert_eq!(err.code(), "pin_wrong");
            assert_eq!(
                err.to_string(),
                format!(
                    "PIN salah. Sisa {} kali lagi sebelum dikunci sementara.",
                    5 - i
                )
            );
        }
        // Salah lewat unlock dan lewat hapus dihitung bersama.
        let err = unlock(&mut e.conn, &e.id, "000000", at(1)).unwrap_err();
        assert!(err.to_string().contains("dikunci sementara"), "{err}");
        let err = delete_with_pin(&mut e.conn, &e.id, PIN, at(2), |_| Ok(())).unwrap_err();
        assert_eq!(err.code(), "pin_locked");
        assert!(status(&e.conn, &owner, at(2)).unwrap().is_some());

        let mut called = false;
        assert!(
            delete_with_pin(&mut e.conn, &e.id, PIN, at(70), |_| {
                called = true;
                Ok(())
            })
            .unwrap()
        );
        assert!(called);
        assert_eq!(status(&e.conn, &owner, at(70)).unwrap(), None);
        // Hapus dengan PIN tidak mencatat reset, jadi tanpa masa tunggu.
        assert_eq!(reset_at(&e), None);
        let info = save_test(&e, &tiny_png(5, 5)).unwrap();
        assert_eq!(info.usable_after, None);
    }

    #[test]
    fn delete_with_pin_rolls_back_when_callback_fails() {
        let mut e = env();
        save_test(&e, &tiny_png(5, 5)).unwrap();
        let err = delete_with_pin(&mut e.conn, &e.id, PIN, at(1), |_| {
            Err(AppError::Internal("gagal".into()))
        })
        .unwrap_err();
        assert_eq!(err.code(), "internal");
        assert!(
            status(&e.conn, e.id.public_key_hex(), at(1))
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn delete_create_delete_with_new_pin_keeps_cooling() {
        let mut e = env();
        let owner = e.id.public_key_hex().to_owned();
        save_test(&e, &tiny_png(5, 5)).unwrap();
        // Rekan menghapus tanpa PIN, membuat tanda tangan dengan PIN sendiri,
        // menghapusnya dengan PIN itu, lalu membuat lagi.
        delete_forgot_pin(&e.conn, &owner, at(10)).unwrap();
        let p = KdfParams::TEST;
        save(&e.conn, &e.id, "777777", &tiny_png(5, 5), at(20), &p).unwrap();
        assert!(delete_with_pin(&mut e.conn, &e.id, "777777", at(30), |_| Ok(())).unwrap());
        let info = save(&e.conn, &e.id, "777777", &tiny_png(5, 5), at(40), &p).unwrap();
        let until = at(10) + RESET_COOLDOWN;
        assert_eq!(info.usable_after, Some(clock::format_rfc3339(until)));
        assert_eq!(
            code_of(unlock(&mut e.conn, &e.id, "777777", at(50))),
            "signature_cooling"
        );

        // Hapus tanpa PIN lagi memulai masa tunggu dari awal.
        delete_forgot_pin(&e.conn, &owner, at(1000)).unwrap();
        let info = save(&e.conn, &e.id, "777777", &tiny_png(5, 5), at(1001), &p).unwrap();
        assert_eq!(
            info.usable_after,
            Some(clock::format_rfc3339(at(1000) + RESET_COOLDOWN))
        );

        // Jam dimundurkan: catatan reset yang lebih baru dipertahankan.
        delete_forgot_pin(&e.conn, &owner, at(5)).unwrap();
        assert_eq!(reset_at(&e), Some(at(1000)));
    }

    #[test]
    fn lock_after_clock_moved_back_is_limited_and_saved() {
        let mut e = env();
        let owner = e.id.public_key_hex().to_owned();
        save_test(&e, &tiny_png(5, 5)).unwrap();
        // 5 salah tercatat sehari "di depan", lalu jam dimundurkan.
        e.conn
            .execute(
                "UPDATE sign_saved_signature SET failed_attempts = 5, locked_until = ?1",
                params![clock::format_rfc3339(at(0) + Duration::days(1))],
            )
            .unwrap();
        let info = status(&e.conn, &owner, at(0)).unwrap().unwrap();
        assert_eq!(
            info.locked_until,
            Some(clock::format_rfc3339(at(0) + Duration::minutes(1)))
        );
        let err = unlock(&mut e.conn, &e.id, PIN, at(0)).unwrap_err();
        assert_eq!(err.code(), "pin_locked");
        assert!(err.to_string().contains("sekitar 1 menit"), "{err}");
        // Nilai yang dibatasi disimpan, jadi kunci habis walau jam tetap mundur.
        let stored: Option<String> = e
            .conn
            .query_row("SELECT locked_until FROM sign_saved_signature", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            stored,
            Some(clock::format_rfc3339(at(0) + Duration::minutes(1)))
        );
        assert!(unlock(&mut e.conn, &e.id, PIN, at(61)).is_ok());
    }
}
