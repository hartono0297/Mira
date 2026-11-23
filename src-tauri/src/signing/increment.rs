//! Bukti stempel: versi bertanda tangan baru harus berupa incremental update
//! dari versi sebelumnya yang hanya menambah stempel (dan paling banyak satu
//! halaman catatan di akhir). Lihat `docs/plans/sinkron-dokumen-ttd.md`
//! bagian "Bukti stempel".
//!
//! Pemeriksaan dalam tiga lapis:
//!
//! 1. Byte: `old` awalan persis dari `new`, tambahannya paling besar
//!    [`MAX_APPENDED_BYTES`].
//! 2. Struktur: tambahan berupa satu atau beberapa bagian xref klasik
//!    (bukan xref stream) yang berantai lewat `/Prev` sampai `startxref`
//!    versi lama. Setiap entri menunjuk objek di bagian tambahan dengan
//!    nomor yang cocok, tanpa entri bebas (menghapus objek lama), tanpa
//!    `/Encrypt`, `/XRefStm`, atau `/Root` lain. Kedua versi lalu diurai
//!    lopdf tanpa perbaikan xref.
//! 3. Isi: setiap objek yang nilainya berbeda dari versi lama harus salah
//!    satu dari yang diizinkan di bawah. Objek lain yang berubah, atau objek
//!    lama yang hilang, ditolak sebagai `version_changes_content`.
//!
//! Perubahan yang diizinkan (bentuk keluaran pdf-lib 1.17.1, lihat
//! `src/screens/sign/stamp.ts`):
//!
//! - Kamus halaman lama: hanya `/Contents` dan `/Resources`. Daftar isi lama
//!   tetap utuh dan bersambung; di depannya hanya stream baru berisi `q`,
//!   di belakangnya hanya stream baru dengan operator gambar dan teks
//!   (lihat `StampCheck`). Larik `/Contents` tidak langsung milik
//!   halaman boleh berubah dengan aturan yang sama.
//! - `/Resources` (milik halaman atau warisan, langsung atau tidak
//!   langsung, termasuk sub-kamus `/Font`, `/XObject`, dan seterusnya):
//!   hanya bertambah. Entri lama tidak berubah, nama baru menunjuk objek
//!   baru, dan nama baru tidak boleh sudah dipakai isi lama (kalau tidak,
//!   nama yang dulu tidak menunjuk apa pun tiba-tiba menggambar sesuatu).
//! - Simpul `/Pages`: `/Kids` hanya bertambah di akhir dengan objek baru,
//!   `/Count` naik sebanyak halaman baru di bawahnya, `/Resources` hanya
//!   bertambah (pdf-lib memakai kamus warisan yang sama).
//! - Kamus Info (yang ditunjuk trailer baru): bebas.
//! - Katalog tidak boleh berubah; pdf-lib tidak menyentuhnya saat menstempel
//!   atau menambah halaman.
//! - Halaman baru hanya di urutan terakhir dan berupa objek baru (halaman
//!   catatan; lebih dari satu kalau daftar penanda tangan panjang, paling
//!   banyak [`MAX_ADDED_PAGES`]), dan hanya kalau [`IncrementRules`]
//!   mengizinkannya (penanda tangan terakhir). Isinya hanya teks font
//!   standar dan garis tipis seperti `appendAuditPage`: tanpa gambar,
//!   XObject, shading, `cm`, atau bidang terisi (lihat `Checker::check_new_page`).
//! - Tidak ada aksi aktif baru (`/JS`, `/JavaScript`, `/AA`, `/OpenAction`,
//!   `/Launch`, `/EmbeddedFile(s)`, `/URI`, `/SubmitForm`, ...) di objek
//!   baru atau berubah. Aksi yang sama persis dengan versi lama (misalnya
//!   `/AA` halaman, tautan URI langsung di `/Annots`) ikut tertulis ulang
//!   bersama kamus halaman dan tidak dihitung.
//!
//! Gagal membuka isi lama yang perlu dipindai (filter yang tidak didukung,
//! terlalu besar) atau membaca MediaBox halaman adalah batas pemeriksa, bukan
//! bukti perubahan: ditolak sebagai `pdf_invalid`. Gambar lama (JPEG, JBIG2,
//! CCITT, JPX) tidak dipindai karena tidak memakai nama sumber daya.
//!
//! Stempel di halaman lama tidak boleh bisa menutup isi lama (misalnya
//! menimpa "Rp 10.000.000" dengan bidang putih lalu menulis angka lain):
//!
//! - Setiap gambar berbentuk keluaran `embedPng` pdf-lib: RGB 8 bit dengan
//!   SMask abu-abu 8 bit seukuran. Gambar tanpa SMask ditolak. Rata-rata
//!   alpha paling besar [`MAX_IMAGE_MEAN_ALPHA`] dari luas gambar sendiri,
//!   dan tidak ada piksel yang legap (alpha >= 128) sekaligus terang
//!   (kecerahan >= 216 dari 255). Tanda tangan gambar tangan bertinta gelap;
//!   impor foto membuang piksel kertas (lihat `pad/image.ts`), jadi piksel
//!   ber-alpha 128 ke atas paling terang sekitar 207.
//! - Semua tanda stempel satu versi di satu halaman (gambar dan kotak huruf
//!   keterangan, diperkirakan dari Tm, Td, ukuran font, dan lebar huruf
//!   Helvetica atau Courier) muat dalam satu persegi yang luasnya paling
//!   besar [`MAX_STAMP_RECT_FRACTION`] dari MediaBox (paling sedikit
//!   [`MIN_STAMP_RECT_AREA`] pt persegi untuk halaman kecil).
//! - Teks keterangan paling banyak [`MAX_GLYPHS_PER_PAGE`] huruf per halaman,
//!   paling besar [`MAX_FONT_SIZE`] pt, font Helvetica atau Courier.
//!
//! Batas sumber daya: jumlah objek kedua versi (paling banyak
//! [`MAX_OBJECTS`]), perkiraan byte objek yang diurai lopdf termasuk isi
//! object stream ([`MAX_LOADED_BYTES`]), dan total byte hasil dekompresi
//! selama pemeriksaan ([`MAX_TOTAL_DECODED`]). Melewati batas ditolak sebagai
//! `pdf_invalid`.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use lopdf::{Dictionary, Document, LoadOptions, Object, ObjectId, Stream};

/// Hasil pemeriksaan yang lolos.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncrementInfo {
    /// Halaman baru di akhir: 0, atau halaman catatan (biasanya 1; lebih
    /// kalau daftar penanda tangan panjang, paling banyak [`MAX_ADDED_PAGES`]).
    pub added_pages: usize,
}

/// Alasan penolakan. `code`: `version_not_prefix`, `version_changes_content`,
/// atau `pdf_invalid`. `message` dalam bahasa Indonesia, untuk layar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncrementError {
    pub code: &'static str,
    pub message: String,
}

/// Batas byte tambahan satu versi (stempel gambar biasanya < 1 MB).
pub const MAX_APPENDED_BYTES: usize = 20 * 1024 * 1024;
/// Batas luas gambar stempel terhadap luas MediaBox halaman. Kotak penempatan
/// (`PlacementBox`) boleh selebar halaman, jadi batasnya seluruh halaman.
pub const MAX_IMAGE_AREA_FRACTION: f64 = 1.0;
/// Batas "tinta" gambar: luas gambar x rata-rata kelegapan (alpha) gambar,
/// terhadap luas halaman. Tanda tangan bergaris di atas latar transparan
/// jauh di bawah ini; gambar legap yang menutup isi tidak.
pub const MAX_IMAGE_INK_FRACTION: f64 = 0.25;
/// Batas rata-rata alpha (dari SMask) satu gambar stempel, terhadap luas
/// gambar itu sendiri. Goresan tanda tangan di atas latar transparan
/// biasanya 5 sampai 30 persen (garis lurus tebal dengan margin pangkas
/// stamp.ts sekitar 25 persen); gambar yang sebagian besar legap ditolak.
pub const MAX_IMAGE_MEAN_ALPHA: f64 = 0.5;
/// Piksel penutup: alpha paling sedikit ini (dari 255) ...
pub const COVER_MIN_ALPHA: u8 = 128;
/// ... dan kecerahan (0,299 R + 0,587 G + 0,114 B) paling sedikit ini.
/// Tidak satu pun piksel penutup boleh ada.
pub const COVER_MIN_LUMA: u32 = 216;
/// Batas piksel gambar stempel (inti menolak PNG di atas 2000 x 2000).
pub const MAX_IMAGE_PIXELS: usize = 2000 * 2000;
/// Batas ukuran huruf efektif teks stempel (keterangan memakai 6 sampai 10 pt).
pub const MAX_FONT_SIZE: f64 = 12.0;
/// Batas jumlah karakter teks stempel per halaman per versi. stamp.ts
/// membatasi keterangan (nama dan waktu) 100 karakter, ditambah "..." dari
/// pemotongan per baris.
pub const MAX_GLYPHS_PER_PAGE: usize = 120;
/// Batas luas persegi yang memuat semua tanda stempel satu versi di satu
/// halaman, terhadap luas MediaBox. stamp.ts mengecilkan kotak yang lebih
/// besar dari 12 persen (kotak bawaan 160 x 80 pt dengan keterangan sekitar
/// 3,4 persen A4), jadi sisa 3 persen menampung perbedaan perkiraan.
pub const MAX_STAMP_RECT_FRACTION: f64 = 0.15;
/// Luas persegi stempel yang selalu boleh (pt persegi), untuk halaman kecil:
/// kotak bawaan 160 x 80 pt dengan keterangan dua baris sekitar 17.000.
pub const MIN_STAMP_RECT_AREA: f64 = 20_000.0;
/// Batas halaman baru per versi. Halaman catatan untuk 20 penanda tangan
/// (batas `request::MAX_SIGNERS`) dengan nama panjang bisa lebih dari satu
/// halaman.
pub const MAX_ADDED_PAGES: usize = 10;
/// Batas ukuran huruf di halaman baru (judul halaman catatan 18 pt).
pub const MAX_NEW_PAGE_FONT_SIZE: f64 = 24.0;
/// Batas karakter per halaman baru.
pub const MAX_NEW_PAGE_GLYPHS: usize = 10_000;
/// Batas segmen garis per halaman baru (halaman catatan: satu per baris tabel).
pub const MAX_NEW_PAGE_LINES: usize = 200;
/// Batas tebal garis di halaman baru (halaman catatan memakai 0,5 dan 0,8 pt).
pub const MAX_LINE_WIDTH: f64 = 2.0;
/// Batas jumlah objek kedua versi bersama.
pub const MAX_OBJECTS: usize = 400_000;
/// Batas perkiraan byte objek bukan stream yang diurai lopdf dari kedua versi
/// (termasuk isi object stream setelah dekompresi).
pub const MAX_LOADED_BYTES: usize = 256 * 1024 * 1024;
/// Batas total byte hasil dekompresi stream selama satu pemeriksaan.
pub const MAX_TOTAL_DECODED: usize = 256 * 1024 * 1024;

const MAX_SECTIONS: usize = 16;
const MAX_XREF_ENTRIES: usize = 100_000;
const MAX_DECODED_STREAM: usize = 32 * 1024 * 1024;
const MAX_SCAN_BYTES: usize = 256 * 1024 * 1024;
const MAX_DEPTH: usize = 64;
const MAX_GSTATE_STACK: usize = 4096;
/// Toleransi pembulatan untuk batas luas dan ukuran.
const EPS: f64 = 1e-6;

/// Aturan yang bergantung pada posisi penanda tangan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IncrementRules {
    /// Halaman baru (halaman catatan) boleh ditambah. Hanya untuk penanda
    /// tangan terakhir.
    pub allow_new_pages: bool,
}

const NOT_PREFIX_MESSAGE: &str = "Versi baru tidak dibangun di atas versi sebelumnya.";

fn not_prefix() -> IncrementError {
    IncrementError {
        code: "version_not_prefix",
        message: NOT_PREFIX_MESSAGE.into(),
    }
}

fn changes(detail: impl AsRef<str>) -> IncrementError {
    IncrementError {
        code: "version_changes_content",
        message: format!(
            "Versi baru mengubah isi dokumen, bukan hanya menambah tanda tangan ({}).",
            detail.as_ref()
        ),
    }
}

/// Batas pemeriksa (format yang tidak bisa dibuka, file terlalu besar), bukan
/// bukti perubahan isi. Pesannya tampil apa adanya di layar penanda tangan.
fn invalid(detail: impl AsRef<str>) -> IncrementError {
    IncrementError {
        code: "pdf_invalid",
        message: format!(
            "Mira belum bisa memeriksa hasil tanda tangan pada PDF ini, jadi tanda tangan belum disimpan. Ini masalah format file, bukan tanda isi dokumen diubah. Minta pengirim menyimpan ulang PDF dari aplikasi asalnya, lalu membuat permintaan baru. Rincian: {}.",
            detail.as_ref()
        ),
    }
}

type Res<T> = Result<T, IncrementError>;

/// Memeriksa bahwa `new` = `old` + incremental update yang hanya menambah
/// stempel, halaman baru diizinkan. Sama dengan [`check_increment_with`]
/// dengan `allow_new_pages: true`.
pub fn check_increment(old: &[u8], new: &[u8]) -> Result<IncrementInfo, IncrementError> {
    check_increment_with(
        old,
        new,
        &IncrementRules {
            allow_new_pages: true,
        },
    )
}

/// Memeriksa bahwa `new` = `old` + incremental update yang hanya menambah
/// stempel (dan halaman catatan kalau `rules` mengizinkan). Murni (tanpa
/// IO); pemanggil menyimpan hasilnya. Batas tanda stempel berlaku per
/// panggilan: memeriksa beberapa versi sekaligus menggabungkan stempel
/// semua versi itu.
pub fn check_increment_with(
    old: &[u8],
    new: &[u8],
    rules: &IncrementRules,
) -> Result<IncrementInfo, IncrementError> {
    check_with_caps(old, new, rules, Caps::DEFAULT)
}

fn check_with_caps(
    old: &[u8],
    new: &[u8],
    rules: &IncrementRules,
    caps: Caps,
) -> Result<IncrementInfo, IncrementError> {
    BUDGET.with(|b| *b.borrow_mut() = Budget::new(caps));
    let result = check_inner(old, new, rules);
    let exceeded = BUDGET.with(|b| {
        let mut b = b.borrow_mut();
        let exceeded = b.exceeded;
        *b = Budget::new(Caps::DEFAULT);
        exceeded
    });
    if exceeded {
        return Err(invalid("PDF terlalu besar untuk diperiksa"));
    }
    result
}

fn check_inner(
    old: &[u8],
    new: &[u8],
    rules: &IncrementRules,
) -> Result<IncrementInfo, IncrementError> {
    if new.len() <= old.len() || !new.starts_with(old) {
        return Err(not_prefix());
    }
    if new.len() - old.len() > MAX_APPENDED_BYTES {
        return Err(changes("tambahan lebih dari 20 MB"));
    }

    let old_startxref = last_startxref(old, 0)
        .map(|(_, v)| v)
        .ok_or_else(|| invalid("versi sebelumnya tidak punya startxref"))?;
    let sections = parse_sections(new, old.len(), old_startxref)?;

    let new_doc = load(new).map_err(|e| invalid(format!("versi baru: {e}")))?;
    let mut old_buf = Vec::with_capacity(old.len() + 40);
    old_buf.extend_from_slice(old);
    old_buf.extend_from_slice(format!("\nstartxref\n{old_startxref}\n%%EOF\n").as_bytes());
    let old_doc = load(&old_buf).map_err(|e| invalid(format!("versi sebelumnya: {e}")))?;
    if old_doc
        .objects
        .len()
        .checked_add(new_doc.objects.len())
        .is_none_or(|n| n > MAX_OBJECTS)
    {
        return Err(invalid("objek terlalu banyak"));
    }

    if new_doc.xref_start != sections.last_xref {
        return Err(invalid("startxref tidak cocok"));
    }
    let old_root =
        trailer_ref(&old_doc.trailer, b"Root").ok_or_else(|| invalid("katalog tidak ada"))?;
    for s in &sections.list {
        if s.root != Some(old_root) {
            return Err(changes("katalog diganti"));
        }
    }
    // Setiap entri bagian tambahan harus terbaca lopdf dari bagian tambahan.
    for (&id, &(offset, generation)) in &sections.entries {
        // Nomor yang dipakai versi lama tapi bukan objek biasa (object
        // stream, xref stream, entri bebas) tidak boleh dipakai ulang: objek
        // lama di dalam object stream itu akan hilang.
        if old_doc.reference_table.entries.contains_key(&id)
            && !old_doc.objects.contains_key(&(id, generation))
        {
            return Err(changes(format!("nomor objek lama {id} dipakai ulang")));
        }
        match new_doc.reference_table.get(id) {
            Some(lopdf::xref::XrefEntry::Normal {
                offset: o,
                generation: g,
            }) if *o as usize == offset && *g == generation => {}
            _ => return Err(invalid("tabel xref tidak terbaca")),
        }
        let Some(obj) = new_doc.objects.get(&(id, generation)) else {
            return Err(invalid(format!("objek {id} tidak terbaca")));
        };
        if let Object::Stream(s) = obj
            && !stream_length_exact(s)
        {
            return Err(invalid(format!("panjang stream objek {id} salah")));
        }
    }

    Checker::new(&old_doc, &new_doc, *rules)?.run()
}

// ---------------------------------------------------------------------------
// Batas sumber daya

#[derive(Debug, Clone, Copy)]
struct Caps {
    objects: usize,
    loaded: usize,
    decoded: usize,
}

impl Caps {
    const DEFAULT: Caps = Caps {
        objects: MAX_OBJECTS,
        loaded: MAX_LOADED_BYTES,
        decoded: MAX_TOTAL_DECODED,
    };
}

/// Sisa anggaran satu pemeriksaan. Disimpan per thread karena filter lopdf
/// berupa `fn` biasa tanpa closure; lopdf di sini tanpa fitur `rayon`, jadi
/// pemuatan berjalan di thread pemanggil. Jumlah objek juga diperiksa lagi
/// setelah pemuatan.
struct Budget {
    objects: usize,
    loaded: usize,
    decoded: usize,
    exceeded: bool,
}

impl Budget {
    fn new(caps: Caps) -> Self {
        Self {
            objects: caps.objects,
            loaded: caps.loaded,
            decoded: caps.decoded,
            exceeded: false,
        }
    }
}

thread_local! {
    static BUDGET: RefCell<Budget> = RefCell::new(Budget::new(Caps::DEFAULT));
}

fn budget_exceeded() -> bool {
    BUDGET.with(|b| b.borrow().exceeded)
}

/// Filter lopdf: menghitung objek dan perkiraan byte-nya. Setelah anggaran
/// habis objek dibuang dan pemeriksaan gagal sebagai `pdf_invalid`.
///
/// lopdf memakai nilai kembalian untuk anggota object stream dan objek yang
/// diberikan (bukan kembalian) untuk objek tingkat atas. Anggota object
/// stream tidak pernah berupa stream, jadi stream dikembalikan sebagai Null
/// supaya isinya tidak disalin.
fn load_filter(id: ObjectId, obj: &mut Object) -> Option<(ObjectId, Object)> {
    let size = approx_size(obj);
    let ok = BUDGET.with(|b| {
        let mut b = b.borrow_mut();
        match (b.objects.checked_sub(1), b.loaded.checked_sub(size)) {
            (Some(o), Some(l)) if !b.exceeded => {
                b.objects = o;
                b.loaded = l;
                true
            }
            _ => {
                b.exceeded = true;
                false
            }
        }
    });
    if !ok {
        return None;
    }
    let returned = match obj {
        Object::Stream(_) => Object::Null,
        other => other.clone(),
    };
    Some((id, returned))
}

/// Perkiraan byte objek di memori, tanpa isi stream (isi stream mentah
/// dibatasi ukuran file). Tanpa rekursi, jadi aman untuk objek yang dalam.
fn approx_size(obj: &Object) -> usize {
    let mut total = 0usize;
    let mut stack: Vec<&Object> = vec![obj];
    while let Some(o) = stack.pop() {
        total = total.saturating_add(24);
        match o {
            Object::Name(n) | Object::String(n, _) => total = total.saturating_add(n.len()),
            Object::Array(a) => stack.extend(a.iter()),
            Object::Dictionary(d) => {
                for (k, v) in d.iter() {
                    total = total.saturating_add(k.len());
                    stack.push(v);
                }
            }
            Object::Stream(s) => {
                for (k, v) in s.dict.iter() {
                    total = total.saturating_add(k.len());
                    stack.push(v);
                }
            }
            _ => {}
        }
    }
    total
}

// ---------------------------------------------------------------------------
// Pemuatan dan struktur incremental update

fn load(bytes: &[u8]) -> Result<Document, String> {
    let options = LoadOptions {
        max_decompressed_size: Some(MAX_DECODED_STREAM),
        filter: Some(load_filter),
        ..Default::default()
    };
    let doc = Document::load_mem_with_options(bytes, options);
    if budget_exceeded() {
        return Err("terlalu besar".into());
    }
    let doc = doc.map_err(|e| e.to_string())?;
    if doc.xref_recovery.is_some() {
        return Err("tabel xref rusak".into());
    }
    if doc.encryption_state.is_some() || doc.trailer.has(b"Encrypt") {
        return Err("PDF terenkripsi".into());
    }
    Ok(doc)
}

fn stream_length_exact(s: &Stream) -> bool {
    matches!(s.dict.get(b"Length"), Ok(Object::Integer(n)) if usize::try_from(*n) == Ok(s.content.len()))
}

fn trailer_ref(dict: &Dictionary, key: &[u8]) -> Option<ObjectId> {
    match dict.get(key) {
        Ok(Object::Reference(id)) => Some(*id),
        _ => None,
    }
}

/// Posisi dan nilai `startxref` terakhir (di atau setelah `from`), seperti
/// pembaca PDF mencari dari belakang.
fn last_startxref(buf: &[u8], from: usize) -> Option<(usize, usize)> {
    let hay = buf.get(from..)?;
    let pos = hay.windows(9).rposition(|w| w == b"startxref")? + from;
    let mut i = pos + 9;
    while buf.get(i).is_some_and(|c| is_ws(*c)) {
        i += 1;
    }
    let start = i;
    let mut value: usize = 0;
    while let Some(c) = buf.get(i).filter(|c| c.is_ascii_digit()) {
        value = value.checked_mul(10)?.checked_add(usize::from(c - b'0'))?;
        i += 1;
    }
    (i > start).then_some((pos, value))
}

struct Section {
    root: Option<ObjectId>,
}

struct Sections {
    list: Vec<Section>,
    /// Entri dari semua bagian tambahan; bagian yang lebih baru menang.
    entries: BTreeMap<u32, (usize, u16)>,
    last_xref: usize,
}

fn parse_sections(new: &[u8], old_len: usize, old_startxref: usize) -> Res<Sections> {
    let (pos, last_xref) =
        last_startxref(new, old_len).ok_or_else(|| invalid("startxref tidak ada"))?;
    // Setelah startxref hanya angka, %%EOF, dan spasi.
    let mut i = pos + 9;
    while new.get(i).is_some_and(|c| is_ws(*c) || c.is_ascii_digit()) {
        i += 1;
    }
    if new.get(i..i + 5) != Some(b"%%EOF") || !new[i + 5..].iter().all(|c| is_ws(*c)) {
        return Err(invalid("akhir file tidak berupa %%EOF"));
    }

    let mut list = Vec::new();
    let mut entries: BTreeMap<u32, (usize, u16)> = BTreeMap::new();
    let mut x = last_xref;
    let mut limit = new.len();
    let mut rows = 0usize;
    loop {
        if x == old_startxref {
            break;
        }
        if x < old_len || x >= limit || list.len() >= MAX_SECTIONS {
            return Err(not_prefix());
        }
        let (section_entries, trailer) = parse_xref_table(new, x)?;
        rows = rows.saturating_add(section_entries.len());
        if rows > MAX_XREF_ENTRIES {
            return Err(invalid("tabel xref tambahan terlalu besar"));
        }
        for (id, offset, generation) in section_entries {
            if offset < old_len || offset >= x {
                return Err(invalid("entri xref menunjuk ke luar bagian tambahan"));
            }
            if !object_header_at(new, offset, id, generation) {
                return Err(invalid("entri xref tidak menunjuk objeknya"));
            }
            entries.entry(id).or_insert((offset, generation));
        }
        if trailer.has(b"Encrypt") || trailer.has(b"XRefStm") {
            return Err(invalid("trailer tidak didukung"));
        }
        list.push(Section {
            root: trailer_ref(&trailer, b"Root"),
        });
        let prev = match trailer.get(b"Prev") {
            Ok(Object::Integer(p)) if *p >= 0 => usize::try_from(*p).map_err(|_| not_prefix())?,
            _ => return Err(not_prefix()),
        };
        limit = x;
        x = prev;
    }
    if list.is_empty() {
        return Err(not_prefix());
    }
    Ok(Sections {
        list,
        entries,
        last_xref,
    })
}

/// Entri xref `n`: (id, offset, generasi).
type XrefRow = (u32, usize, u16);

/// Tabel xref klasik di `at`: entri `n` (id, offset, generasi) dan trailer.
/// Entri bebas hanya boleh untuk objek 0.
fn parse_xref_table(buf: &[u8], at: usize) -> Res<(Vec<XrefRow>, Dictionary)> {
    let bad = || invalid("bagian xref tambahan bukan tabel xref klasik");
    let mut lx = Lexer::new(buf, at);
    if lx.next_tok().map_err(|_| bad())? != Some(Tok::Kw(b"xref".to_vec())) {
        return Err(bad());
    }
    let mut out = Vec::new();
    loop {
        match lx.next_tok().map_err(|_| bad())? {
            Some(Tok::Kw(k)) if k == b"trailer" => break,
            Some(Tok::Num {
                value: start,
                int: true,
            }) => {
                let Some(Tok::Num {
                    value: count,
                    int: true,
                }) = lx.next_tok().map_err(|_| bad())?
                else {
                    return Err(bad());
                };
                // Batas diperiksa sebagai f64 sebelum cast: angka raksasa
                // tidak boleh jenuh lalu meluap saat dijumlah.
                if !(0.0..=f64::from(u32::MAX)).contains(&start)
                    || !(0.0..=MAX_XREF_ENTRIES as f64).contains(&count)
                {
                    return Err(bad());
                }
                let (start, count) = (start as u64, count as u64);
                if usize::try_from(count)
                    .ok()
                    .and_then(|c| out.len().checked_add(c))
                    .is_none_or(|n| n > MAX_XREF_ENTRIES)
                {
                    return Err(bad());
                }
                for k in 0..count {
                    let id = start
                        .checked_add(k)
                        .and_then(|v| u32::try_from(v).ok())
                        .ok_or_else(bad)?;
                    let (
                        Some(Tok::Num {
                            value: off,
                            int: true,
                        }),
                        Some(Tok::Num {
                            value: g,
                            int: true,
                        }),
                        Some(Tok::Kw(kind)),
                    ) = (
                        lx.next_tok().map_err(|_| bad())?,
                        lx.next_tok().map_err(|_| bad())?,
                        lx.next_tok().map_err(|_| bad())?,
                    )
                    else {
                        return Err(bad());
                    };
                    if !(0.0..=65535.0).contains(&g) || !(0.0..=buf.len() as f64).contains(&off) {
                        return Err(bad());
                    }
                    match kind.as_slice() {
                        b"n" => out.push((id, off as usize, g as u16)),
                        b"f" if id == 0 => {}
                        b"f" => return Err(changes("objek lama dihapus")),
                        _ => return Err(bad()),
                    }
                }
            }
            _ => return Err(bad()),
        }
    }
    let trailer = match parse_value(&mut lx, 0).map_err(|_| bad())? {
        Object::Dictionary(d) => d,
        _ => return Err(bad()),
    };
    Ok((out, trailer))
}

/// `id gen obj` tepat di `offset` (bukan di tengah token lain).
fn object_header_at(buf: &[u8], offset: usize, id: u32, generation: u16) -> bool {
    if !buf.get(offset).is_some_and(u8::is_ascii_digit) {
        return false;
    }
    if offset > 0
        && !buf
            .get(offset - 1)
            .is_some_and(|c| is_ws(*c) || is_delim(*c))
    {
        return false;
    }
    let mut lx = Lexer::new(buf, offset);
    matches!(
        (lx.next_tok(), lx.next_tok(), lx.next_tok()),
        (
            Ok(Some(Tok::Num { value: a, int: true })),
            Ok(Some(Tok::Num { value: b, int: true })),
            Ok(Some(Tok::Kw(k))),
        ) if a == f64::from(id) && b == f64::from(generation) && k == b"obj"
    )
}

// ---------------------------------------------------------------------------
// Pemeriksaan isi

struct Checker<'a> {
    old: &'a Document,
    new: &'a Document,
    /// Objek baru (tidak ada di versi lama).
    added: BTreeSet<ObjectId>,
    /// Objek lama yang nilainya berubah.
    changed: BTreeSet<ObjectId>,
    /// Objek berubah yang sudah dibuktikan sah.
    covered: BTreeSet<ObjectId>,
    rules: IncrementRules,
}

impl<'a> Checker<'a> {
    fn new(old: &'a Document, new: &'a Document, rules: IncrementRules) -> Res<Self> {
        let mut added = BTreeSet::new();
        let mut changed = BTreeSet::new();
        for (id, obj) in &new.objects {
            match old.objects.get(id) {
                Some(o) if same(o, obj, 0) => {}
                Some(_) => {
                    changed.insert(*id);
                }
                None => {
                    added.insert(*id);
                }
            }
        }
        if old.objects.keys().any(|id| !new.objects.contains_key(id)) {
            return Err(changes("objek lama dihapus"));
        }
        Ok(Self {
            old,
            new,
            added,
            changed,
            covered: BTreeSet::new(),
            rules,
        })
    }

    fn run(mut self) -> Res<IncrementInfo> {
        // Aksi aktif baru di objek baru atau berubah. Objek yang berubah
        // dibandingkan dengan versi lamanya: aksi yang sudah ada sebelumnya
        // (misalnya /AA halaman atau tautan URI langsung di /Annots) ikut
        // tertulis ulang saat kamus halaman diubah dan tidak dihitung menambah.
        for id in self.added.iter().chain(self.changed.iter()) {
            if let Some(obj) = self.new.objects.get(id) {
                check_no_active(self.old.objects.get(id), obj, 0)?;
            }
        }

        let old_tree = walk_pages(self.old).map_err(invalid)?;
        let new_tree = walk_pages(self.new).map_err(invalid)?;
        if old_tree.root != new_tree.root {
            return Err(changes("pohon halaman diganti"));
        }
        let n_old = old_tree.leaves.len();
        if new_tree.leaves.len() < n_old
            || new_tree.leaves[..n_old]
                .iter()
                .map(|l| l.id)
                .ne(old_tree.leaves.iter().map(|l| l.id))
        {
            return Err(changes("urutan halaman berubah"));
        }
        let extra = &new_tree.leaves[n_old..];
        if extra.len() > MAX_ADDED_PAGES {
            return Err(changes("terlalu banyak halaman baru"));
        }
        if extra.iter().any(|leaf| !self.added.contains(&leaf.id)) {
            return Err(changes("halaman tambahan bukan halaman baru"));
        }
        if !extra.is_empty() && !self.rules.allow_new_pages {
            return Err(changes(
                "menambah halaman, padahal hanya penanda tangan terakhir yang menambah halaman catatan",
            ));
        }
        let mut seen_new = HashSet::new();
        for (i, leaf) in extra.iter().enumerate() {
            if seen_new.insert(leaf.id) {
                self.check_new_page(leaf.id, n_old + i + 1)?;
            }
        }

        // Simpul /Pages lama yang berubah: Count naik sebanyak halaman baru
        // di bawahnya.
        for &node in &old_tree.nodes {
            if self.changed.contains(&node) {
                let delta = extra.iter().filter(|l| l.ancestors.contains(&node)).count() as i64;
                self.check_pages_node(node, delta)?;
            }
        }

        // Halaman lama.
        let mut seen = HashSet::new();
        for (index, leaf) in old_tree.leaves.iter().enumerate() {
            if seen.insert(leaf.id) {
                self.check_page(leaf, index + 1)?;
            }
        }

        // Kamus Info.
        if let Some(info) = trailer_ref(&self.new.trailer, b"Info")
            && self.changed.contains(&info)
            && trailer_ref(&self.old.trailer, b"Info") == Some(info)
        {
            self.covered.insert(info);
        }

        if let Some(id) = self.changed.iter().find(|id| !self.covered.contains(id)) {
            return Err(changes(format!("objek {} {} berubah", id.0, id.1)));
        }

        Ok(IncrementInfo {
            added_pages: extra.len(),
        })
    }

    fn check_pages_node(&mut self, node: ObjectId, delta: i64) -> Res<()> {
        let (Ok(od), Ok(nd)) = (self.old.get_dictionary(node), self.new.get_dictionary(node))
        else {
            return Err(changes("pohon halaman berubah"));
        };
        for key in keys_union(od, nd) {
            if matches!(key.as_slice(), b"Kids" | b"Count" | b"Resources") {
                continue;
            }
            if !same_opt(od.get(&key).ok(), nd.get(&key).ok()) {
                return Err(changes("pohon halaman berubah"));
            }
        }
        // Kids: lama tetap, yang baru di akhir dan berupa objek baru.
        let (old_kids, old_kids_id) = resolve_array(self.old, od.get(b"Kids").ok());
        let (new_kids, new_kids_id) = resolve_array(self.new, nd.get(b"Kids").ok());
        let (Some(old_kids), Some(new_kids)) = (old_kids, new_kids) else {
            return Err(changes("pohon halaman berubah"));
        };
        if new_kids.len() < old_kids.len()
            || !old_kids.iter().zip(new_kids).all(|(a, b)| same(a, b, 0))
            || !new_kids[old_kids.len()..]
                .iter()
                .all(|k| matches!(k, Object::Reference(id) if self.added.contains(id)))
        {
            return Err(changes("pohon halaman berubah"));
        }
        if let Some(kids_id) = old_kids_id {
            if new_kids_id != Some(kids_id)
                && new_kids_id.is_some_and(|id| !self.added.contains(&id))
            {
                return Err(changes("pohon halaman berubah"));
            }
            if new_kids_id == Some(kids_id) {
                self.covered.insert(kids_id);
            }
        }
        let count = |d: &Dictionary, doc: &Document| match d.get(b"Count").map(|o| resolve(doc, o))
        {
            Ok(Object::Integer(n)) => Some(*n),
            _ => None,
        };
        match (count(od, self.old), count(nd, self.new)) {
            (Some(a), Some(b)) if b.checked_sub(a) == Some(delta) => {}
            (None, None) if delta == 0 => {}
            _ => return Err(changes("jumlah halaman tidak cocok")),
        }
        self.check_resources_pair(od.get(b"Resources").ok(), nd.get(b"Resources").ok())?;
        self.covered.insert(node);
        Ok(())
    }

    fn check_page(&mut self, leaf: &Leaf, number: usize) -> Res<()> {
        let id = leaf.id;
        let (Ok(od), Ok(nd)) = (self.old.get_dictionary(id), self.new.get_dictionary(id)) else {
            return Err(changes(format!("halaman {number} berubah")));
        };
        let contents_changed = self.changed.contains(&id)
            || matches!(od.get(b"Contents"), Ok(Object::Reference(c)) if self.changed.contains(c));
        let old_res = inherited(self.old, id, b"Resources");
        let new_res = inherited(self.new, id, b"Resources");
        let res_ids = resource_ids(self.old, old_res);
        let res_changed = self.changed.contains(&id)
            || res_ids.iter().any(|r| self.changed.contains(r))
            || !match (old_res, new_res) {
                (None, None) => true,
                (Some(o), Some(n)) => same_resolved(self.old, self.new, o, n),
                _ => false,
            };
        if !contents_changed && !res_changed {
            return Ok(());
        }

        for key in keys_union(od, nd) {
            if matches!(key.as_slice(), b"Contents" | b"Resources") {
                continue;
            }
            if !same_opt(od.get(&key).ok(), nd.get(&key).ok()) {
                return Err(changes(format!("halaman {number} berubah")));
            }
        }

        // Resources hanya bertambah; objek tak langsung di dalamnya juga.
        self.check_resources_pair(old_res, new_res)?;
        for rid in res_ids {
            if self.changed.contains(&rid) {
                let (Some(o), Some(n)) = (self.old.objects.get(&rid), self.new.objects.get(&rid))
                else {
                    return Err(changes(format!("sumber daya halaman {number} berubah")));
                };
                // Kamus Resources atau sub-kamusnya (Font, XObject, ...).
                let level = if matches!(old_res, Some(Object::Reference(r)) if *r == rid) {
                    0
                } else {
                    1
                };
                self.check_additive(o, n, level)?;
                self.covered.insert(rid);
            }
        }

        // Contents.
        let (old_list, old_arr) = content_refs(self.old, od.get(b"Contents").ok())
            .ok_or_else(|| changes(format!("isi halaman {number} berubah")))?;
        let (new_list, new_arr) = content_refs(self.new, nd.get(b"Contents").ok())
            .ok_or_else(|| changes(format!("isi halaman {number} berubah")))?;
        // Larik /Contents tak langsung yang berubah: pdf-lib mengubah larik
        // itu lalu menyalinnya langsung ke halaman, jadi larik lama tidak
        // dipakai halaman lagi. Isinya tetap harus berupa daftar lama yang
        // utuh dengan hanya stream baru di sekitarnya. Halaman lain yang
        // masih memakainya diperiksa sendiri (isinya ikut berubah).
        if let Some(arr) = old_arr
            && self.changed.contains(&arr)
        {
            let ok = match self.new.objects.get(&arr).and_then(|o| match o {
                Object::Array(a) => refs_of(a),
                _ => None,
            }) {
                Some(list) if new_arr == Some(arr) => list == new_list,
                Some(list) => self.wraps(&old_list, &list).is_some(),
                None => false,
            };
            if !ok {
                return Err(changes(format!("isi halaman {number} berubah")));
            }
            self.covered.insert(arr);
        }
        let names = self.added_resource_names(old_res, new_res);
        if !names.is_empty() {
            self.check_names_unused(&names, &old_list, old_res, number)?;
        }
        if let Some(arr) = new_arr
            && arr != old_arr.unwrap_or(arr)
            && !self.added.contains(&arr)
        {
            return Err(changes(format!("isi halaman {number} berubah")));
        }
        if old_list == new_list {
            self.covered.insert(id);
            return Ok(());
        }
        let start = self
            .wraps(&old_list, &new_list)
            .ok_or_else(|| changes(format!("isi lama halaman {number} berubah")))?;
        let prefix = &new_list[..start];
        let suffix = &new_list[start + old_list.len()..];
        for r in prefix {
            let bytes = self.stamp_stream(*r, number)?;
            if !only_q(&bytes) {
                return Err(changes(format!(
                    "stream baru di depan isi halaman {number}"
                )));
            }
        }
        if !suffix.is_empty() {
            let mut sim = Sim::new();
            // Keadaan grafis setelah isi lama (dibungkus q ... Q) menentukan
            // ukuran stempel, jadi isi lama ikut dijalankan secara longgar.
            for _ in prefix {
                sim.op(b"q", &[]);
            }
            for r in &old_list {
                if let Some(Object::Stream(s)) = self.old.objects.get(r)
                    && let Ok(bytes) = decode(s)
                {
                    let _ = for_each_op(&bytes, false, &mut |op, args| {
                        sim.op(op, args);
                        Ok(())
                    });
                }
            }
            let resources = new_res.map(|r| resolve(self.new, r)).and_then(|r| match r {
                Object::Dictionary(d) => Some(d),
                _ => None,
            });
            let page_area = media_box_area(self.new, id)
                .ok_or_else(|| invalid(format!("ukuran halaman {number} tidak terbaca")))?;
            let mut stamp = StampCheck::new(
                Mode::Stamp,
                self.new,
                &self.added,
                resources,
                page_area,
                number,
            );
            for r in suffix {
                let bytes = self.stamp_stream(*r, number)?;
                stamp.check_stream(&bytes, &mut sim)?;
            }
            stamp.finish()?;
        }
        self.covered.insert(id);
        Ok(())
    }

    /// Halaman baru (halaman catatan): kamus seperti `PDFDocument.addPage`
    /// pdf-lib, sumber daya hanya font standar, isi hanya teks dan garis.
    fn check_new_page(&mut self, id: ObjectId, number: usize) -> Res<()> {
        let bad = |what: &str| changes(format!("halaman baru {number} {what}"));
        let d = self
            .new
            .get_dictionary(id)
            .map_err(|_| bad("tidak terbaca"))?;
        for (k, v) in d.iter() {
            match k.as_slice() {
                b"Type" | b"Parent" | b"Contents" | b"Resources" | b"MediaBox" | b"CropBox" => {}
                b"Annots" => {
                    if !matches!(resolve(self.new, v), Object::Array(a) if a.is_empty()) {
                        return Err(bad("berisi anotasi"));
                    }
                }
                _ => return Err(bad("memakai kunci halaman yang tidak didukung")),
            }
        }
        let area = media_box_area(self.new, id).ok_or_else(|| bad("tanpa ukuran halaman"))?;
        if area > 14_400.0 * 14_400.0 {
            return Err(bad("terlalu besar"));
        }

        // Sumber daya sendiri: hanya Font (objek font baru atau lama, diperiksa
        // saat dipakai Tf), kategori lain harus kosong.
        let own = d.get(b"Resources").ok();
        if let Some(res) = own {
            if let Object::Reference(r) = res
                && !self.added.contains(r)
            {
                return Err(bad("memakai sumber daya lama"));
            }
            let Object::Dictionary(rd) = resolve(self.new, res) else {
                return Err(bad("sumber dayanya tidak terbaca"));
            };
            for (k, v) in rd.iter() {
                match k.as_slice() {
                    b"Font" | b"ProcSet" => {}
                    k if is_category(k) => {
                        if !matches!(resolve(self.new, v), Object::Dictionary(c) if c.is_empty()) {
                            return Err(bad("memakai gambar atau sumber daya lain selain font"));
                        }
                    }
                    _ => return Err(bad("memakai sumber daya yang tidak didukung")),
                }
            }
        }
        let resources = inherited(self.new, id, b"Resources")
            .map(|r| resolve(self.new, r))
            .and_then(|r| match r {
                Object::Dictionary(d) => Some(d),
                _ => None,
            });

        let (list, arr) = content_refs(self.new, d.get(b"Contents").ok())
            .ok_or_else(|| bad("isinya tidak terbaca"))?;
        if arr.is_some_and(|a| !self.added.contains(&a))
            || list.iter().any(|r| !self.added.contains(r))
        {
            return Err(bad("memakai isi halaman lama"));
        }
        let mut sim = Sim::new();
        let mut check = StampCheck::new(
            Mode::NewPage,
            self.new,
            &self.added,
            resources,
            area,
            number,
        );
        for r in list {
            let bytes = self.stamp_stream(r, number)?;
            check.check_stream(&bytes, &mut sim)?;
        }
        check.finish()
    }

    /// Posisi `old` di dalam `new` kalau `new` = stream baru + `old` utuh +
    /// stream baru.
    fn wraps(&self, old: &[ObjectId], new: &[ObjectId]) -> Option<usize> {
        let n = old.len();
        let start = (0..=new.len().checked_sub(n)?).find(|&s| {
            new.get(s..s + n) == Some(old) && new[..s].iter().all(|r| self.added.contains(r))
        })?;
        new[start + n..]
            .iter()
            .all(|r| self.added.contains(r))
            .then_some(start)
    }

    /// Isi stream baru (stempel) setelah dekompresi. Hanya tanpa filter atau
    /// FlateDecode.
    fn stamp_stream(&self, id: ObjectId, number: usize) -> Res<Vec<u8>> {
        let Some(Object::Stream(s)) = self.new.objects.get(&id) else {
            return Err(changes(format!("isi halaman {number} bukan stream")));
        };
        if !flate_only(&s.dict) {
            return Err(changes(format!(
                "stream stempel halaman {number} memakai filter lain"
            )));
        }
        decode(s).map_err(|_| changes(format!("stream stempel halaman {number} tidak terbaca")))
    }

    fn check_resources_pair(&mut self, old: Option<&Object>, new: Option<&Object>) -> Res<()> {
        match (old, new) {
            (None, None) => Ok(()),
            (None, Some(n)) => self.check_additive(&Object::Dictionary(Dictionary::new()), n, 0),
            (Some(_), None) => Err(changes("sumber daya halaman dihapus")),
            (Some(o), Some(n)) => self.check_additive(o, n, 0),
        }
    }

    /// `level` 0: kamus Resources; 1: sub-kamus kategori (Font, XObject, ...).
    fn check_additive(&mut self, old: &Object, new: &Object, level: u8) -> Res<()> {
        let od = match resolve(self.old, old) {
            Object::Dictionary(d) => d,
            other => {
                // Bukan kamus di versi lama: harus tetap sama persis.
                return if same_resolved(self.old, self.new, other, new) {
                    Ok(())
                } else {
                    Err(changes("sumber daya halaman berubah"))
                };
            }
        };
        let Object::Dictionary(nd) = resolve(self.new, new) else {
            return Err(changes("sumber daya halaman berubah"));
        };
        for (k, ov) in od.iter() {
            let Ok(nv) = nd.get(k) else {
                return Err(changes("sumber daya halaman dihapus"));
            };
            if level == 0 && is_category(k) {
                self.check_additive(ov, nv, 1)?;
            } else if !same_resolved(self.old, self.new, ov, nv) {
                return Err(changes("sumber daya lama diganti"));
            }
        }
        for (k, nv) in nd.iter() {
            if od.has(k) {
                continue;
            }
            if level == 0 {
                if !is_category(k) {
                    return Err(changes("sumber daya baru tidak dikenal"));
                }
                let Object::Dictionary(cat) = resolve(self.new, nv) else {
                    return Err(changes("sumber daya baru tidak dikenal"));
                };
                if let Object::Reference(id) = nv
                    && !self.added.contains(id)
                {
                    return Err(changes("sumber daya baru menunjuk objek lama"));
                }
                for (name, v) in cat.iter() {
                    self.add_name(name, v)?;
                }
            } else {
                self.add_name(k, nv)?;
            }
        }
        Ok(())
    }

    fn add_name(&self, _name: &[u8], value: &Object) -> Res<()> {
        if !matches!(value, Object::Reference(id) if self.added.contains(id)) {
            return Err(changes("sumber daya baru menunjuk objek lama"));
        }
        Ok(())
    }

    /// Nama di kategori sumber daya (Font, XObject, ...) halaman yang baru
    /// muncul di versi baru.
    fn added_resource_names(
        &self,
        old_res: Option<&'a Object>,
        new_res: Option<&'a Object>,
    ) -> BTreeSet<Vec<u8>> {
        let empty = Dictionary::new();
        let dict = |doc: &'a Document, o: Option<&'a Object>| match o.map(|o| resolve(doc, o)) {
            Some(Object::Dictionary(d)) => Some(d),
            _ => None,
        };
        let mut names = BTreeSet::new();
        let (od, Some(nd)) = (
            dict(self.old, old_res).unwrap_or(&empty),
            dict(self.new, new_res),
        ) else {
            return names;
        };
        for (k, nv) in nd.iter() {
            if !is_category(k) {
                continue;
            }
            let Object::Dictionary(ncat) = resolve(self.new, nv) else {
                continue;
            };
            let ocat = match od.get(k).map(|o| resolve(self.old, o)) {
                Ok(Object::Dictionary(d)) => Some(d),
                _ => None,
            };
            for (name, _) in ncat.iter() {
                if !ocat.is_some_and(|c| c.has(name)) {
                    names.insert(name.clone());
                }
            }
        }
        names
    }

    /// Nama sumber daya baru tidak boleh sudah dipakai isi lama yang memakai
    /// sumber daya halaman ini: isi halaman, Form XObject tanpa Resources
    /// sendiri, dan glyph font Type3 tanpa Resources sendiri. Kalau dipakai,
    /// nama yang dulu tidak menunjuk apa pun tiba-tiba menggambar sesuatu.
    fn check_names_unused(
        &self,
        names: &BTreeSet<Vec<u8>>,
        contents: &[ObjectId],
        old_res: Option<&Object>,
        number: usize,
    ) -> Res<()> {
        let mut targets: Vec<ObjectId> = contents.to_vec();
        if let Some(Object::Dictionary(res)) = old_res.map(|r| resolve(self.old, r)) {
            let category = |k: &[u8]| match res.get(k).map(|o| resolve(self.old, o)) {
                Ok(Object::Dictionary(d)) => Some(d),
                _ => None,
            };
            // Hanya Form XObject yang berisi operator. Gambar (JPEG, JBIG2,
            // CCITT dari pindaian, foto dari Word atau Chrome) tidak memakai
            // nama sumber daya, dan filternya sering tidak bisa dibuka lopdf.
            for (_, v) in category(b"XObject").map(|d| d.iter()).into_iter().flatten() {
                if let Object::Reference(r) = v
                    && let Some(Object::Stream(s)) = self.old.objects.get(r)
                    && !s.dict.has(b"Resources")
                    && !matches!(s.dict.get(b"Subtype"), Ok(Object::Name(n)) if n == b"Image")
                {
                    targets.push(*r);
                }
            }
            for (_, v) in category(b"Font").map(|d| d.iter()).into_iter().flatten() {
                if let Object::Dictionary(f) = resolve(self.old, v)
                    && matches!(f.get(b"Subtype"), Ok(Object::Name(n)) if n == b"Type3")
                    && !f.has(b"Resources")
                    && let Ok(Object::Dictionary(procs)) =
                        f.get(b"CharProcs").map(|o| resolve(self.old, o))
                {
                    targets.extend(procs.iter().filter_map(|(_, p)| match p {
                        Object::Reference(r) => Some(*r),
                        _ => None,
                    }));
                }
            }
        }
        let mut budget = MAX_SCAN_BYTES;
        for id in targets {
            let Some(Object::Stream(s)) = self.old.objects.get(&id) else {
                continue;
            };
            // Gagal membuka isi lama adalah batas pemeriksa, bukan bukti
            // perubahan: tetap ditolak, tetapi sebagai `pdf_invalid`.
            let bytes = decode(s)
                .map_err(|_| invalid(format!("isi lama halaman {number} tidak bisa dibuka")))?;
            budget = budget.checked_sub(bytes.len()).ok_or_else(|| {
                invalid(format!(
                    "isi lama halaman {number} terlalu besar untuk diperiksa"
                ))
            })?;
            let mut hit = false;
            let _ = for_each_names(&bytes, &mut |name| hit |= names.contains(name));
            if hit {
                return Err(changes(format!(
                    "nama sumber daya baru di halaman {number} sudah dipakai isi lama"
                )));
            }
        }
        Ok(())
    }
}

fn is_category(k: &[u8]) -> bool {
    matches!(
        k,
        b"Font"
            | b"XObject"
            | b"ExtGState"
            | b"ColorSpace"
            | b"Pattern"
            | b"Shading"
            | b"Properties"
    )
}

fn keys_union(a: &Dictionary, b: &Dictionary) -> Vec<Vec<u8>> {
    let mut keys: BTreeSet<Vec<u8>> = a.iter().map(|(k, _)| k.clone()).collect();
    keys.extend(b.iter().map(|(k, _)| k.clone()));
    keys.into_iter().collect()
}

fn resolve<'d>(doc: &'d Document, obj: &'d Object) -> &'d Object {
    let mut cur = obj;
    for _ in 0..8 {
        match cur {
            Object::Reference(id) => match doc.objects.get(id) {
                Some(o) => cur = o,
                None => return &Object::Null,
            },
            _ => return cur,
        }
    }
    &Object::Null
}

fn resolve_array<'d>(
    doc: &'d Document,
    obj: Option<&'d Object>,
) -> (Option<&'d [Object]>, Option<ObjectId>) {
    match obj {
        Some(Object::Array(a)) => (Some(a), None),
        Some(Object::Reference(id)) => match doc.objects.get(id) {
            Some(Object::Array(a)) => (Some(a), Some(*id)),
            _ => (None, None),
        },
        _ => (None, None),
    }
}

/// Nilai atribut yang bisa diwarisi dari simpul induk (`/Resources`,
/// `/MediaBox`, ...).
fn inherited<'d>(doc: &'d Document, page: ObjectId, key: &[u8]) -> Option<&'d Object> {
    let mut id = page;
    for _ in 0..MAX_DEPTH {
        let d = doc.get_dictionary(id).ok()?;
        if let Ok(v) = d.get(key) {
            return Some(v);
        }
        match d.get(b"Parent") {
            Ok(Object::Reference(p)) => id = *p,
            _ => return None,
        }
    }
    None
}

/// Objek tak langsung yang membentuk Resources: kamusnya dan sub-kamus kategori.
fn resource_ids(doc: &Document, res: Option<&Object>) -> Vec<ObjectId> {
    let mut ids = Vec::new();
    let Some(res) = res else { return ids };
    if let Object::Reference(id) = res {
        ids.push(*id);
    }
    if let Object::Dictionary(d) = resolve(doc, res) {
        for (k, v) in d.iter() {
            if is_category(k)
                && let Object::Reference(id) = v
            {
                ids.push(*id);
            }
        }
    }
    ids
}

/// Daftar stream isi halaman dan id larik tak langsungnya (kalau ada).
fn content_refs(
    doc: &Document,
    contents: Option<&Object>,
) -> Option<(Vec<ObjectId>, Option<ObjectId>)> {
    match contents {
        None | Some(Object::Null) => Some((Vec::new(), None)),
        Some(Object::Reference(id)) => match doc.objects.get(id) {
            Some(Object::Stream(_)) => Some((vec![*id], None)),
            Some(Object::Array(a)) => refs_of(a).map(|l| (l, Some(*id))),
            _ => None,
        },
        Some(Object::Array(a)) => refs_of(a).map(|l| (l, None)),
        _ => None,
    }
}

fn refs_of(a: &[Object]) -> Option<Vec<ObjectId>> {
    a.iter()
        .map(|o| match o {
            Object::Reference(id) => Some(*id),
            _ => None,
        })
        .collect()
}

fn media_box_area(doc: &Document, page: ObjectId) -> Option<f64> {
    let Object::Array(b) = resolve(doc, inherited(doc, page, b"MediaBox")?) else {
        return None;
    };
    let n: Vec<f64> = b.iter().filter_map(|o| num(resolve(doc, o))).collect();
    if n.len() != 4 {
        return None;
    }
    let area = ((n[2] - n[0]) * (n[3] - n[1])).abs();
    (area.is_finite() && area > 0.0).then_some(area)
}

fn num(o: &Object) -> Option<f64> {
    match o {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(f64::from(*r)),
        _ => None,
    }
}

/// Isi stream setelah dekompresi, dibatasi per stream dan dari anggaran total
/// satu pemeriksaan. Anggaran yang habis menandai pemeriksaan gagal sebagai
/// `pdf_invalid` (lihat [`check_increment_with`]).
fn decode(s: &Stream) -> Result<Vec<u8>, ()> {
    if s.dict.has(b"F") {
        return Err(());
    }
    let remaining = BUDGET.with(|b| {
        let b = b.borrow();
        if b.exceeded { 0 } else { b.decoded }
    });
    let limit = remaining.min(MAX_DECODED_STREAM);
    match s.decompressed_content_with_limit(limit) {
        Ok(bytes) => {
            BUDGET.with(|b| {
                let mut b = b.borrow_mut();
                b.decoded = b.decoded.saturating_sub(bytes.len());
            });
            Ok(bytes)
        }
        Err(lopdf::Error::Decompress(lopdf::DecompressError::MemoryLimitExceeded { .. }))
            if limit < MAX_DECODED_STREAM =>
        {
            BUDGET.with(|b| b.borrow_mut().exceeded = true);
            Err(())
        }
        Err(_) => Err(()),
    }
}

// ---------------------------------------------------------------------------
// Kesamaan objek

/// Sama secara isi: angka dibandingkan nilainya (612 sama dengan 612.0),
/// string dibandingkan byte-nya (literal atau hex), referensi menurut id.
fn same(a: &Object, b: &Object, depth: usize) -> bool {
    if depth > MAX_DEPTH {
        return false;
    }
    match (a, b) {
        (Object::Null, Object::Null) => true,
        (Object::Boolean(x), Object::Boolean(y)) => x == y,
        (Object::Integer(x), Object::Integer(y)) => x == y,
        (Object::Integer(_) | Object::Real(_), Object::Integer(_) | Object::Real(_)) => {
            num(a) == num(b)
        }
        (Object::Name(x), Object::Name(y)) => x == y,
        (Object::String(x, _), Object::String(y, _)) => x == y,
        (Object::Reference(x), Object::Reference(y)) => x == y,
        (Object::Array(x), Object::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q, depth + 1))
        }
        (Object::Dictionary(x), Object::Dictionary(y)) => same_dict(x, y, depth),
        (Object::Stream(x), Object::Stream(y)) => {
            same_dict(&x.dict, &y.dict, depth) && x.content == y.content
        }
        _ => false,
    }
}

fn same_dict(x: &Dictionary, y: &Dictionary, depth: usize) -> bool {
    x.len() == y.len()
        && x.iter()
            .all(|(k, v)| y.get(k).is_ok_and(|w| same(v, w, depth + 1)))
}

fn same_opt(a: Option<&Object>, b: Option<&Object>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => same(x, y, 0),
        _ => false,
    }
}

/// Sama setelah referensi diikuti (satu sisi langsung, sisi lain tak
/// langsung). Referensi ke id yang sama selalu sama: perubahan objek itu
/// sendiri diperiksa terpisah.
fn same_resolved(old: &Document, new: &Document, a: &Object, b: &Object) -> bool {
    if let (Object::Reference(x), Object::Reference(y)) = (a, b) {
        return x == y;
    }
    same(resolve(old, a), resolve(new, b), 0)
}

// ---------------------------------------------------------------------------
// Aksi aktif

/// Menolak aksi aktif di `obj` yang tidak ada di `old` (nilai objek yang
/// sama di versi lama, `None` untuk objek baru). Bagian yang sama persis
/// dengan versi lama dilewati; larik dibandingkan per posisi. Referensi
/// tidak diikuti: objek yang ditunjuk diperiksa sendiri kalau baru atau
/// berubah.
fn check_no_active(old: Option<&Object>, obj: &Object, depth: usize) -> Res<()> {
    if depth > MAX_DEPTH {
        return Err(changes("objek terlalu dalam"));
    }
    match obj {
        Object::Array(a) => {
            let old = match old {
                Some(Object::Array(o)) => Some(o),
                _ => None,
            };
            a.iter().enumerate().try_for_each(|(i, o)| {
                let prev = old.and_then(|p| p.get(i));
                if prev.is_some_and(|p| same(p, o, 0)) {
                    return Ok(());
                }
                check_no_active(prev, o, depth + 1)
            })
        }
        Object::Dictionary(d) => check_dict_active(old_dict(old), d, depth),
        Object::Stream(s) => check_dict_active(old_dict(old), &s.dict, depth),
        _ => Ok(()),
    }
}

fn old_dict(old: Option<&Object>) -> Option<&Dictionary> {
    match old {
        Some(Object::Dictionary(d)) => Some(d),
        Some(Object::Stream(s)) => Some(&s.dict),
        _ => None,
    }
}

fn check_dict_active(old: Option<&Dictionary>, d: &Dictionary, depth: usize) -> Res<()> {
    for (k, v) in d.iter() {
        let prev = old.and_then(|o| o.get(k).ok());
        if prev.is_some_and(|p| same(p, v, 0)) {
            continue;
        }
        if matches!(
            k.as_slice(),
            b"JS"
                | b"JavaScript"
                | b"AA"
                | b"OpenAction"
                | b"Launch"
                | b"EmbeddedFile"
                | b"EmbeddedFiles"
                | b"URI"
                | b"RichMedia"
                | b"XFA"
        ) {
            return Err(changes("menambah aksi aktif"));
        }
        if k == b"S"
            && let Object::Name(n) = v
            && matches!(
                n.as_slice(),
                b"JavaScript"
                    | b"Launch"
                    | b"SubmitForm"
                    | b"ImportData"
                    | b"URI"
                    | b"GoToR"
                    | b"GoToE"
                    | b"Rendition"
                    | b"ResetForm"
                    | b"RichMediaExecute"
            )
        {
            return Err(changes("menambah aksi aktif"));
        }
        check_no_active(prev, v, depth + 1)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Pohon halaman

struct Leaf {
    id: ObjectId,
    ancestors: Vec<ObjectId>,
}

struct PageTree {
    root: ObjectId,
    leaves: Vec<Leaf>,
    nodes: Vec<ObjectId>,
}

fn walk_pages(doc: &Document) -> Result<PageTree, String> {
    let root_id = trailer_ref(&doc.trailer, b"Root").ok_or("katalog tidak ada")?;
    let catalog = doc
        .get_dictionary(root_id)
        .map_err(|_| "katalog tidak terbaca")?;
    let Ok(Object::Reference(pages)) = catalog.get(b"Pages") else {
        return Err("pohon halaman tidak ada".into());
    };
    let mut tree = PageTree {
        root: *pages,
        leaves: Vec::new(),
        nodes: Vec::new(),
    };
    let mut visited = HashSet::new();
    let mut path = Vec::new();
    walk_node(doc, *pages, &mut path, &mut visited, &mut tree)?;
    Ok(tree)
}

fn walk_node(
    doc: &Document,
    id: ObjectId,
    path: &mut Vec<ObjectId>,
    visited: &mut HashSet<ObjectId>,
    tree: &mut PageTree,
) -> Result<(), String> {
    if path.len() > MAX_DEPTH || !visited.insert(id) {
        return Err("pohon halaman berputar".into());
    }
    let d = doc
        .get_dictionary(id)
        .map_err(|_| "simpul halaman tidak terbaca")?;
    let is_node = d.has_type(b"Pages") || (!d.has_type(b"Page") && d.has(b"Kids"));
    if !is_node {
        tree.leaves.push(Leaf {
            id,
            ancestors: path.clone(),
        });
        return Ok(());
    }
    tree.nodes.push(id);
    let (Some(kids), _) = resolve_array(doc, d.get(b"Kids").ok()) else {
        return Err("simpul halaman tanpa Kids".into());
    };
    path.push(id);
    for kid in kids {
        let Object::Reference(k) = kid else {
            return Err("isi Kids bukan referensi".into());
        };
        walk_node(doc, *k, path, visited, tree)?;
    }
    path.pop();
    Ok(())
}

// ---------------------------------------------------------------------------
// Isi stempel

/// Stream baru di depan isi lama hanya boleh berisi `q` (masing-masing
/// diikuti spasi, supaya tidak menempel ke token pertama isi lama).
fn only_q(bytes: &[u8]) -> bool {
    let mut prev_ws = true;
    let mut i = 0;
    while let Some(&c) = bytes.get(i) {
        if is_ws(c) {
            prev_ws = true;
        } else if c == b'q' && prev_ws && bytes.get(i + 1).is_some_and(|n| is_ws(*n)) {
            prev_ws = false;
        } else {
            return false;
        }
        i += 1;
    }
    true
}

type Mat = [f64; 6];
const IDENTITY: Mat = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

fn mul(m1: &Mat, m2: &Mat) -> Mat {
    let [a, b, c, d, e, f] = *m1;
    let [aa, bb, cc, dd, ee, ff] = *m2;
    [
        a * aa + b * cc,
        a * bb + b * dd,
        c * aa + d * cc,
        c * bb + d * dd,
        e * aa + f * cc + ee,
        e * bb + f * dd + ff,
    ]
}

fn apply(m: &Mat, x: f64, y: f64) -> (f64, f64) {
    (x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5])
}

/// Persegi sejajar sumbu `[x0, y0, x1, y1]`.
type Rect = [f64; 4];

/// Persegi sejajar sumbu yang memuat persegi `[x0, x1] x [y0, y1]` setelah
/// dikali `m`.
fn bounds_of(m: &Mat, x0: f64, y0: f64, x1: f64, y1: f64) -> Rect {
    let mut r = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    for (x, y) in [
        apply(m, x0, y0),
        apply(m, x1, y0),
        apply(m, x0, y1),
        apply(m, x1, y1),
    ] {
        r[0] = r[0].min(x);
        r[1] = r[1].min(y);
        r[2] = r[2].max(x);
        r[3] = r[3].max(y);
    }
    r
}

fn union(a: Option<Rect>, b: Rect) -> Rect {
    match a {
        None => b,
        Some(a) => [
            a[0].min(b[0]),
            a[1].min(b[1]),
            a[2].max(b[2]),
            a[3].max(b[3]),
        ],
    }
}

// ---------------------------------------------------------------------------
// Metrik font standar

/// Font teks yang sudah diperiksa `Tf`. Stempel hanya memakai Helvetica dan
/// Courier, yang lebar hurufnya diketahui, supaya letak keterangan bisa
/// diperkirakan. Halaman baru boleh memakai font standar lain.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Metrics {
    Helvetica { win_ansi: bool },
    Courier { win_ansi: bool },
    Unmeasured,
}

/// Lebar Helvetica (per 1000 em) untuk WinAnsiEncoding, dari AFM yang sama
/// dengan pdf-lib (`widthOfTextAtSize`). 0: kode tanpa huruf.
#[rustfmt::skip]
static HELVETICA_WIN_ANSI: [u16; 256] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 0,
    556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
    0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 500,
    278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
    400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
    667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
    722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
    556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];
/// Lebar terbesar Helvetica (`@`), dipakai untuk kode yang tidak pasti.
const HELVETICA_MAX_WIDTH: f64 = 1.015;
const COURIER_WIDTH: f64 = 0.6;
/// Batas tinta huruf di sekitar lebarnya (em): kiri dan kanan, bawah, atas.
/// FontBBox Helvetica [-166 -225 1000 931], Courier [-23 -250 715 805].
const GLYPH_PAD_X: f64 = 0.2;
const GLYPH_BOTTOM: f64 = -0.3;
const GLYPH_TOP: f64 = 1.0;

impl Metrics {
    /// Rentang lebar satu kode (em). Kode yang hurufnya tidak pasti (tanpa
    /// huruf di WinAnsi, atau di luar ASCII untuk encoding lain) bisa selebar
    /// apa pun sampai lebar terbesar.
    fn width(self, code: u8) -> (f64, f64) {
        let table = HELVETICA_WIN_ANSI[usize::from(code)];
        // Di StandardEncoding 0x27 dan 0x60 adalah tanda kutip lain.
        let known = |win_ansi: bool| {
            table != 0
                && (win_ansi || ((0x20..=0x7e).contains(&code) && code != 0x27 && code != 0x60))
        };
        match self {
            Metrics::Helvetica { win_ansi } if known(win_ansi) => {
                let w = f64::from(table) / 1000.0;
                (w, w)
            }
            Metrics::Helvetica { .. } => (0.0, HELVETICA_MAX_WIDTH),
            Metrics::Courier { win_ansi } if known(win_ansi) => (COURIER_WIDTH, COURIER_WIDTH),
            Metrics::Courier { .. } => (0.0, COURIER_WIDTH),
            Metrics::Unmeasured => (0.0, HELVETICA_MAX_WIDTH),
        }
    }
}

// ---------------------------------------------------------------------------
// Keadaan grafis

#[derive(Clone)]
struct GState {
    ctm: Mat,
    font_size: f64,
    /// Font dipilih lewat `Tf` yang sudah diperiksa (bukan bocoran isi lama).
    font: Option<Metrics>,
    h_scale: f64,
    rise: f64,
    leading: f64,
    render: i64,
    char_spacing: f64,
    word_spacing: f64,
}

/// Simulasi keadaan grafis secukupnya: matriks, keadaan teks.
struct Sim {
    gs: GState,
    stack: Vec<GState>,
    tm: Mat,
    tlm: Mat,
    in_text: bool,
    /// Geseran teks (ruang teks, sudah dikali ukuran dan Tz) sejak `tm`
    /// terakhir ditetapkan: rentang bawah dan atas, karena lebar sebagian
    /// kode hanya diketahui batasnya.
    text_lo: f64,
    text_hi: f64,
}

impl Sim {
    fn new() -> Self {
        Self {
            gs: GState {
                ctm: IDENTITY,
                font_size: 0.0,
                font: None,
                h_scale: 1.0,
                rise: 0.0,
                leading: 0.0,
                render: 0,
                char_spacing: 0.0,
                word_spacing: 0.0,
            },
            stack: Vec::new(),
            tm: IDENTITY,
            tlm: IDENTITY,
            in_text: false,
            text_lo: 0.0,
            text_hi: 0.0,
        }
    }

    /// Operator isi lama (longgar): hanya yang mengubah keadaan.
    fn op(&mut self, op: &[u8], args: &[Operand]) {
        let nums: Vec<f64> = args.iter().filter_map(Operand::num).collect();
        match op {
            b"q" => {
                if self.stack.len() < MAX_GSTATE_STACK {
                    self.stack.push(self.gs.clone());
                }
            }
            b"Q" => {
                if let Some(g) = self.stack.pop() {
                    self.gs = g;
                }
            }
            b"cm" if nums.len() == 6 => {
                let m = [nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]];
                self.gs.ctm = mul(&m, &self.gs.ctm);
            }
            b"BT" => {
                self.in_text = true;
                self.set_tm(IDENTITY);
            }
            b"ET" => self.in_text = false,
            b"Tf" => {
                if let Some(s) = nums.last() {
                    self.gs.font_size = *s;
                }
                self.gs.font = None;
            }
            b"Tz" if nums.len() == 1 => self.gs.h_scale = nums[0] / 100.0,
            b"Ts" if nums.len() == 1 => self.gs.rise = nums[0],
            b"TL" if nums.len() == 1 => self.gs.leading = nums[0],
            b"Tc" if nums.len() == 1 => self.gs.char_spacing = nums[0],
            b"Tw" if nums.len() == 1 => self.gs.word_spacing = nums[0],
            b"Tr" if nums.len() == 1 => self.gs.render = nums[0] as i64,
            b"Tm" if nums.len() == 6 => {
                self.set_tm([nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]]);
            }
            b"Td" if nums.len() == 2 => self.td(nums[0], nums[1]),
            b"TD" if nums.len() == 2 => {
                self.gs.leading = -nums[1];
                self.td(nums[0], nums[1]);
            }
            b"\"" => {
                if nums.len() >= 2 {
                    self.gs.word_spacing = nums[0];
                    self.gs.char_spacing = nums[1];
                }
                self.td(0.0, -self.gs.leading);
            }
            b"T*" | b"'" => self.td(0.0, -self.gs.leading),
            _ => {}
        }
    }

    fn set_tm(&mut self, m: Mat) {
        self.tm = m;
        self.tlm = m;
        self.text_lo = 0.0;
        self.text_hi = 0.0;
    }

    fn td(&mut self, tx: f64, ty: f64) {
        let m = mul(&[1.0, 0.0, 0.0, 1.0, tx, ty], &self.tlm);
        self.set_tm(m);
    }
}

// ---------------------------------------------------------------------------
// Isi stempel dan halaman baru

/// Apa yang diperiksa [`StampCheck`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Stream baru di belakang isi halaman lama: gambar tanda tangan dan
    /// keterangan.
    Stamp,
    /// Isi halaman baru (halaman catatan): teks dan garis.
    NewPage,
}

/// Potongan teks yang digambar: string, atau geseran angka di larik `TJ`.
enum TextItem<'a> {
    Str(&'a [u8]),
    Adjust(f64),
}

#[derive(Debug, Clone, Copy)]
struct ImageInfo {
    mean_alpha: f64,
    /// Piksel legap dan terang: bisa menutup isi halaman seperti tip-ex.
    cover_pixels: usize,
}

struct StampCheck<'d> {
    mode: Mode,
    doc: &'d Document,
    added: &'d BTreeSet<ObjectId>,
    resources: Option<&'d Dictionary>,
    page_area: f64,
    ink: f64,
    glyphs: usize,
    number: usize,
    /// Persegi yang memuat semua tanda stempel sejauh ini.
    rect: Option<Rect>,
    images: HashMap<ObjectId, ImageInfo>,
    lines: usize,
    path_open: bool,
}

impl<'d> StampCheck<'d> {
    fn new(
        mode: Mode,
        doc: &'d Document,
        added: &'d BTreeSet<ObjectId>,
        resources: Option<&'d Dictionary>,
        page_area: f64,
        number: usize,
    ) -> Self {
        Self {
            mode,
            doc,
            added,
            resources,
            page_area,
            ink: 0.0,
            glyphs: 0,
            number,
            rect: None,
            images: HashMap::new(),
            lines: 0,
            path_open: false,
        }
    }

    fn err(&self, what: &str) -> IncrementError {
        match self.mode {
            Mode::Stamp => changes(format!("stempel halaman {} {what}", self.number)),
            Mode::NewPage => changes(format!("halaman baru {} {what}", self.number)),
        }
    }

    fn resource(&self, category: &[u8], name: &[u8]) -> Option<(ObjectId, &'d Object)> {
        let cat = self.resources?.get(category).ok()?;
        let Object::Dictionary(cat) = resolve(self.doc, cat) else {
            return None;
        };
        match cat.get(name).ok()? {
            Object::Reference(id) => Some((*id, self.doc.objects.get(id)?)),
            _ => None,
        }
    }

    fn check_stream(&mut self, bytes: &[u8], sim: &mut Sim) -> Res<()> {
        let mut result = Ok(());
        let parsed = for_each_op(bytes, true, &mut |op, args| {
            if let Err(e) = self.check_op(op, args, sim) {
                result = Err(e);
                return Err(());
            }
            Ok(())
        });
        result?;
        parsed.map_err(|_| self.err("tidak terbaca atau memakai operator terlarang"))?;
        Ok(())
    }

    /// Pemeriksaan setelah semua stream halaman ini.
    fn finish(&self) -> Res<()> {
        if self.path_open {
            return Err(self.err("berisi garis yang tidak selesai"));
        }
        if let Some(r) = self.rect {
            let area = (r[2] - r[0]) * (r[3] - r[1]);
            let limit = (self.page_area * MAX_STAMP_RECT_FRACTION).max(MIN_STAMP_RECT_AREA);
            if !area.is_finite() || area > limit + EPS {
                return Err(self.err(
                    "tersebar terlalu luas (gambar tanda tangan dan keterangannya harus berdekatan)",
                ));
            }
        }
        Ok(())
    }

    fn check_op(&mut self, op: &[u8], args: &[Operand], sim: &mut Sim) -> Res<()> {
        let stamp = self.mode == Mode::Stamp;
        let new_page = self.mode == Mode::NewPage;
        if self.path_open && !matches!(op, b"m" | b"l" | b"S") {
            return Err(self.err("berisi garis tidak sah"));
        }
        let nums: Option<Vec<f64>> = args.iter().map(Operand::num).collect();
        let n_args = |n: usize| -> Res<Vec<f64>> {
            match &nums {
                Some(v) if v.len() == n && v.iter().all(|x| x.is_finite() && x.abs() <= 1e7) => {
                    Ok(v.clone())
                }
                _ => Err(self.err("berisi operand tidak sah")),
            }
        };
        let text_only = |inside: bool| -> Res<()> {
            if sim.in_text == inside {
                Ok(())
            } else {
                Err(self.err("berisi urutan teks tidak sah"))
            }
        };
        match op {
            b"q" | b"Q" => {
                n_args(0)?;
                text_only(false)?;
                sim.op(op, args);
            }
            b"cm" if stamp => {
                n_args(6)?;
                text_only(false)?;
                sim.op(op, args);
            }
            b"BT" => {
                n_args(0)?;
                text_only(false)?;
                sim.op(op, args);
            }
            b"ET" => {
                n_args(0)?;
                text_only(true)?;
                sim.op(op, args);
            }
            b"Do" if stamp => {
                text_only(false)?;
                let [Operand::Name(name)] = args else {
                    return Err(self.err("berisi operand tidak sah"));
                };
                let ctm = sim.gs.ctm;
                self.check_image(name, &ctm)?;
            }
            b"Tf" => {
                let [Operand::Name(name), Operand::Num(size)] = args else {
                    return Err(self.err("berisi operand tidak sah"));
                };
                if !size.is_finite() {
                    return Err(self.err("berisi operand tidak sah"));
                }
                let metrics = self.check_font(name)?;
                sim.op(op, args);
                sim.gs.font = Some(metrics);
            }
            b"Td" | b"TD" => {
                n_args(2)?;
                text_only(true)?;
                sim.op(op, args);
            }
            b"Tm" => {
                n_args(6)?;
                text_only(true)?;
                sim.op(op, args);
            }
            b"T*" => {
                n_args(0)?;
                text_only(true)?;
                sim.op(op, args);
            }
            b"Tc" | b"Tw" | b"Tz" | b"TL" | b"Ts" => {
                n_args(1)?;
                sim.op(op, args);
            }
            b"Tr" => {
                if n_args(1)? != [0.0] {
                    return Err(self.err("memakai mode teks terlarang"));
                }
                sim.op(op, args);
            }
            b"Tj" | b"'" | b"\"" => {
                text_only(true)?;
                let text: &[u8] = match (op, args) {
                    (b"\"", [Operand::Num(aw), Operand::Num(ac), Operand::Str(s)])
                        if aw.is_finite()
                            && ac.is_finite()
                            && aw.abs() <= 1e7
                            && ac.abs() <= 1e7 =>
                    {
                        s
                    }
                    (b"Tj" | b"'", [Operand::Str(s)]) => s,
                    _ => return Err(self.err("berisi operand tidak sah")),
                };
                sim.op(op, args);
                self.show_text(&[TextItem::Str(text)], sim)?;
            }
            b"TJ" => {
                text_only(true)?;
                let [Operand::Array(raw)] = args else {
                    return Err(self.err("berisi operand tidak sah"));
                };
                let mut items = Vec::with_capacity(raw.len());
                for item in raw {
                    match item {
                        Operand::Str(s) => items.push(TextItem::Str(s)),
                        Operand::Num(n) if n.is_finite() && n.abs() <= 1e7 => {
                            items.push(TextItem::Adjust(*n));
                        }
                        _ => return Err(self.err("berisi operand tidak sah")),
                    }
                }
                self.show_text(&items, sim)?;
            }
            b"g" | b"G" => {
                n_args(1)?;
            }
            b"rg" | b"RG" => {
                n_args(3)?;
            }
            b"k" | b"K" => {
                n_args(4)?;
            }
            b"cs" | b"CS" => {
                let [Operand::Name(n)] = args else {
                    return Err(self.err("berisi operand tidak sah"));
                };
                if !matches!(n.as_slice(), b"DeviceGray" | b"DeviceRGB" | b"DeviceCMYK") {
                    return Err(self.err("memakai ruang warna lain"));
                }
            }
            b"sc" | b"SC" | b"scn" | b"SCN" => {
                if !matches!(&nums, Some(v) if (1..=4).contains(&v.len()) && v.iter().all(|x| x.is_finite()))
                {
                    return Err(self.err("berisi operand tidak sah"));
                }
            }
            b"gs" if stamp => {
                let [Operand::Name(name)] = args else {
                    return Err(self.err("berisi operand tidak sah"));
                };
                self.check_ext_gstate(name)?;
            }
            // Garis halaman catatan (pdf-lib `drawLine`): w, d, m, l, S.
            b"w" if new_page => {
                let w = n_args(1)?[0];
                text_only(false)?;
                if !(0.0..=MAX_LINE_WIDTH).contains(&w) {
                    return Err(self.err("memakai garis terlalu tebal"));
                }
            }
            b"J" | b"j" if new_page => {
                if ![0.0, 1.0, 2.0].contains(&n_args(1)?[0]) {
                    return Err(self.err("berisi operand tidak sah"));
                }
            }
            b"M" if new_page => {
                n_args(1)?;
            }
            b"d" if new_page => {
                let [Operand::Array(dash), Operand::Num(phase)] = args else {
                    return Err(self.err("berisi operand tidak sah"));
                };
                if dash.len() > 16
                    || !phase.is_finite()
                    || !dash
                        .iter()
                        .all(|d| matches!(d, Operand::Num(n) if n.is_finite() && *n >= 0.0))
                {
                    return Err(self.err("berisi operand tidak sah"));
                }
            }
            b"m" if new_page => {
                n_args(2)?;
                text_only(false)?;
                self.path_open = true;
            }
            b"l" if new_page => {
                n_args(2)?;
                if !self.path_open {
                    return Err(self.err("berisi garis tidak sah"));
                }
                self.lines += 1;
                if self.lines > MAX_NEW_PAGE_LINES {
                    return Err(self.err("berisi terlalu banyak garis"));
                }
            }
            b"S" if new_page => {
                n_args(0)?;
                if !self.path_open {
                    return Err(self.err("berisi garis tidak sah"));
                }
                self.path_open = false;
            }
            _ => return Err(self.err("memakai operator terlarang")),
        }
        Ok(())
    }

    fn show_text(&mut self, items: &[TextItem], sim: &mut Sim) -> Res<()> {
        let Some(font) = sim.gs.font else {
            return Err(self.err("memakai font yang tidak diperiksa"));
        };
        if !matches!(sim.gs.render, 0 | 3 | 4 | 7) {
            return Err(self.err("memakai mode teks terlarang"));
        }
        let (max_glyphs, max_size) = match self.mode {
            Mode::Stamp => (MAX_GLYPHS_PER_PAGE, MAX_FONT_SIZE),
            Mode::NewPage => (MAX_NEW_PAGE_GLYPHS, MAX_NEW_PAGE_FONT_SIZE),
        };
        let len = items.iter().fold(0usize, |n, i| match i {
            TextItem::Str(s) => n.saturating_add(s.len()),
            TextItem::Adjust(_) => n,
        });
        self.glyphs = self.glyphs.saturating_add(len);
        if self.glyphs > max_glyphs {
            return Err(self.err("berisi teks terlalu panjang"));
        }
        let m = mul(&sim.tm, &sim.gs.ctm);
        let fs = sim.gs.font_size;
        let th = sim.gs.h_scale;
        let x = fs.abs() * th.abs() * m[0].hypot(m[1]);
        let y = fs.abs() * m[2].hypot(m[3]);
        if !(x.is_finite() && y.is_finite()) || x > max_size + EPS || y > max_size + EPS {
            return Err(self.err("memakai huruf terlalu besar"));
        }
        if self.mode != Mode::Stamp {
            return Ok(());
        }
        if font == Metrics::Unmeasured {
            return Err(self.err("memakai font selain Helvetica atau Courier"));
        }

        // Kotak tinta setiap huruf di ruang teks, lalu ke ruang halaman.
        let k = fs * th;
        let (mut lo, mut hi) = (sim.text_lo, sim.text_hi);
        let (mut x0, mut x1) = (f64::INFINITY, f64::NEG_INFINITY);
        for item in items {
            match *item {
                TextItem::Adjust(n) => {
                    let d = -n / 1000.0 * k;
                    lo += d;
                    hi += d;
                }
                TextItem::Str(bytes) => {
                    for &code in bytes {
                        let (wa, wb) = font.width(code);
                        let p = -GLYPH_PAD_X * k;
                        let q = (wb + GLYPH_PAD_X) * k;
                        x0 = x0.min(lo + p.min(q));
                        x1 = x1.max(hi + p.max(q));
                        let extra = sim.gs.char_spacing
                            + if code == b' ' {
                                sim.gs.word_spacing
                            } else {
                                0.0
                            };
                        let d1 = (wa * fs + extra) * th;
                        let d2 = (wb * fs + extra) * th;
                        lo += d1.min(d2);
                        hi += d1.max(d2);
                    }
                }
            }
        }
        sim.text_lo = lo;
        sim.text_hi = hi;
        if x0 <= x1 {
            let a = sim.gs.rise + GLYPH_BOTTOM * fs;
            let b = sim.gs.rise + GLYPH_TOP * fs;
            let r = bounds_of(&m, x0, a.min(b), x1, a.max(b));
            if !r.iter().all(|v| v.is_finite()) {
                return Err(self.err("berisi teks di luar jangkauan"));
            }
            self.rect = Some(union(self.rect, r));
        }
        Ok(())
    }

    fn check_image(&mut self, name: &[u8], ctm: &Mat) -> Res<()> {
        let (id, obj) = self
            .resource(b"XObject", name)
            .ok_or_else(|| self.err("menggambar objek yang tidak ada"))?;
        if !self.added.contains(&id) {
            return Err(self.err("menggambar objek lama"));
        }
        let Object::Stream(s) = obj else {
            return Err(self.err("menggambar objek yang bukan gambar"));
        };
        if !matches!(s.dict.get(b"Subtype"), Ok(Object::Name(n)) if n == b"Image") {
            return Err(self.err("menggambar objek yang bukan gambar"));
        }
        let area = (ctm[0] * ctm[3] - ctm[1] * ctm[2]).abs();
        if !area.is_finite() || area > self.page_area * MAX_IMAGE_AREA_FRACTION + EPS {
            return Err(self.err("berisi gambar terlalu besar"));
        }
        let info = match self.images.get(&id) {
            Some(info) => *info,
            None => {
                let info = image_info(self.doc, self.added, s).map_err(|what| self.err(what))?;
                self.images.insert(id, info);
                info
            }
        };
        if info.mean_alpha > MAX_IMAGE_MEAN_ALPHA + EPS {
            return Err(self.err("berisi gambar yang sebagian besar legap"));
        }
        if info.cover_pixels > 0 {
            return Err(self.err(
                "berisi gambar dengan bidang terang yang legap, yang bisa menutup isi halaman",
            ));
        }
        self.ink += area * info.mean_alpha;
        if self.ink > self.page_area * MAX_IMAGE_INK_FRACTION + EPS {
            return Err(self.err("menutup terlalu banyak bagian halaman"));
        }
        let r = bounds_of(ctm, 0.0, 0.0, 1.0, 1.0);
        if !r.iter().all(|v| v.is_finite()) {
            return Err(self.err("berisi gambar di luar jangkauan"));
        }
        self.rect = Some(union(self.rect, r));
        Ok(())
    }

    fn check_font(&self, name: &[u8]) -> Res<Metrics> {
        let (_, obj) = self
            .resource(b"Font", name)
            .ok_or_else(|| self.err("memakai font yang tidak ada"))?;
        let Object::Dictionary(d) = obj else {
            return Err(self.err("memakai font tidak sah"));
        };
        let base = match d.get(b"BaseFont") {
            Ok(Object::Name(n)) if STANDARD_FONTS.contains(&n.as_slice()) => n.as_slice(),
            _ => return Err(self.err("memakai font selain font standar")),
        };
        let standard = matches!(d.get(b"Subtype"), Ok(Object::Name(n)) if n == b"Type1")
            && d.iter().all(|(k, v)| match k.as_slice() {
                b"Type" | b"Subtype" | b"BaseFont" | b"Name" => true,
                b"Encoding" => matches!(v, Object::Name(_)),
                _ => false,
            });
        if !standard {
            return Err(self.err("memakai font selain font standar"));
        }
        let win_ansi = matches!(d.get(b"Encoding"), Ok(Object::Name(n)) if n == b"WinAnsiEncoding");
        match (self.mode, base) {
            (Mode::Stamp, b"Helvetica" | b"Helvetica-Oblique") => {
                Ok(Metrics::Helvetica { win_ansi })
            }
            (
                Mode::Stamp,
                b"Courier" | b"Courier-Bold" | b"Courier-Oblique" | b"Courier-BoldOblique",
            ) => Ok(Metrics::Courier { win_ansi }),
            (Mode::Stamp, _) => Err(self.err("memakai font selain Helvetica atau Courier")),
            (Mode::NewPage, b"Symbol" | b"ZapfDingbats") => Err(self.err("memakai font simbol")),
            (Mode::NewPage, _) => Ok(Metrics::Unmeasured),
        }
    }

    fn check_ext_gstate(&self, name: &[u8]) -> Res<()> {
        let (_, obj) = self
            .resource(b"ExtGState", name)
            .ok_or_else(|| self.err("memakai keadaan grafis yang tidak ada"))?;
        let Object::Dictionary(d) = obj else {
            return Err(self.err("memakai keadaan grafis tidak sah"));
        };
        let ok = d.iter().all(|(k, v)| match k.as_slice() {
            b"Type" => true,
            b"CA" | b"ca" => num(v).is_some(),
            b"BM" => matches!(v, Object::Name(n) if n == b"Normal" || n == b"Compatible"),
            _ => false,
        });
        if ok {
            Ok(())
        } else {
            Err(self.err("memakai keadaan grafis terlarang"))
        }
    }
}

const STANDARD_FONTS: [&[u8]; 14] = [
    b"Helvetica",
    b"Helvetica-Bold",
    b"Helvetica-Oblique",
    b"Helvetica-BoldOblique",
    b"Times-Roman",
    b"Times-Bold",
    b"Times-Italic",
    b"Times-BoldItalic",
    b"Courier",
    b"Courier-Bold",
    b"Courier-Oblique",
    b"Courier-BoldOblique",
    b"Symbol",
    b"ZapfDingbats",
];

/// Hanya tanpa filter atau FlateDecode tanpa parameter (keluaran pdf-lib).
fn flate_only(d: &Dictionary) -> bool {
    let filters_ok = match d.get(b"Filter") {
        Err(_) => true,
        Ok(Object::Name(n)) => n == b"FlateDecode",
        Ok(Object::Array(a)) => a
            .iter()
            .all(|f| matches!(f, Object::Name(n) if n == b"FlateDecode")),
        _ => false,
    };
    filters_ok && !d.has(b"DecodeParms") && !d.has(b"F")
}

fn dims(d: &Dictionary) -> Option<(usize, usize)> {
    let int = |k: &[u8]| match d.get(k) {
        Ok(Object::Integer(n)) if *n > 0 => usize::try_from(*n).ok(),
        _ => None,
    };
    Some((int(b"Width")?, int(b"Height")?))
}

const IMAGE_FORMAT: &str = "berisi gambar dengan format yang tidak didukung";
const IMAGE_NO_MASK: &str = "berisi gambar tanpa latar transparan (SMask)";

/// Rata-rata alpha dan jumlah piksel penutup gambar stempel. Gambar harus
/// berbentuk keluaran `embedPng` pdf-lib: RGB 8 bit, SMask abu-abu 8 bit
/// seukuran dengan Decode identitas.
fn image_info(
    doc: &Document,
    added: &BTreeSet<ObjectId>,
    image: &Stream,
) -> Result<ImageInfo, &'static str> {
    let d = &image.dict;
    let name_is =
        |d: &Dictionary, k: &[u8], v: &[u8]| matches!(d.get(k), Ok(Object::Name(n)) if n == v);
    let int_is =
        |d: &Dictionary, k: &[u8], v: i64| matches!(d.get(k), Ok(Object::Integer(n)) if *n == v);
    let keys_ok = d.iter().all(|(k, _)| {
        matches!(
            k.as_slice(),
            b"Type"
                | b"Subtype"
                | b"Width"
                | b"Height"
                | b"BitsPerComponent"
                | b"ColorSpace"
                | b"SMask"
                | b"Filter"
                | b"Length"
        )
    });
    if !keys_ok
        || !name_is(d, b"ColorSpace", b"DeviceRGB")
        || !int_is(d, b"BitsPerComponent", 8)
        || !flate_only(d)
    {
        return Err(IMAGE_FORMAT);
    }
    let (w, h) = dims(d).ok_or(IMAGE_FORMAT)?;
    let pixels = w
        .checked_mul(h)
        .filter(|p| *p <= MAX_IMAGE_PIXELS)
        .ok_or("berisi gambar terlalu besar")?;

    let Ok(Object::Reference(mask_id)) = d.get(b"SMask") else {
        return Err(IMAGE_NO_MASK);
    };
    let Some(Object::Stream(mask)) = doc.objects.get(mask_id).filter(|_| added.contains(mask_id))
    else {
        return Err(IMAGE_NO_MASK);
    };
    let md = &mask.dict;
    let mask_keys_ok = md.iter().all(|(k, _)| {
        matches!(
            k.as_slice(),
            b"Type"
                | b"Subtype"
                | b"Width"
                | b"Height"
                | b"BitsPerComponent"
                | b"ColorSpace"
                | b"Decode"
                | b"Filter"
                | b"Length"
        )
    });
    // pdf-lib menulis /Decode [0 1] (identitas); Decode lain bisa membalik alpha.
    let identity_decode = match md.get(b"Decode") {
        Err(_) => true,
        Ok(Object::Array(a)) => a.len() == 2 && num(&a[0]) == Some(0.0) && num(&a[1]) == Some(1.0),
        Ok(_) => false,
    };
    if !mask_keys_ok
        || !name_is(md, b"ColorSpace", b"DeviceGray")
        || !int_is(md, b"BitsPerComponent", 8)
        || !identity_decode
        || !flate_only(md)
        || dims(md) != Some((w, h))
    {
        return Err(IMAGE_NO_MASK);
    }

    let alpha = decode(mask).map_err(|_| IMAGE_FORMAT)?;
    let color = decode(image).map_err(|_| IMAGE_FORMAT)?;
    let rgb_len = pixels.checked_mul(3).ok_or(IMAGE_FORMAT)?;
    if alpha.len() < pixels || color.len() < rgb_len {
        return Err(IMAGE_FORMAT);
    }
    let mut sum: u64 = 0;
    let mut cover = 0usize;
    let (rgb_pixels, _) = color[..rgb_len].as_chunks::<3>();
    for (a, rgb) in alpha[..pixels].iter().zip(rgb_pixels) {
        sum += u64::from(*a);
        if *a >= COVER_MIN_ALPHA {
            let luma =
                (299 * u32::from(rgb[0]) + 587 * u32::from(rgb[1]) + 114 * u32::from(rgb[2]))
                    / 1000;
            if luma >= COVER_MIN_LUMA {
                cover += 1;
            }
        }
    }
    Ok(ImageInfo {
        mean_alpha: sum as f64 / (pixels as f64 * 255.0),
        cover_pixels: cover,
    })
}

// ---------------------------------------------------------------------------
// Lexer PDF kecil (isi halaman, tabel xref, trailer)

fn is_ws(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r' | b'\x0c' | b'\0')
}

fn is_delim(c: u8) -> bool {
    matches!(
        c,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
    )
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num { value: f64, int: bool },
    Name(Vec<u8>),
    Str(Vec<u8>),
    ArrOpen,
    ArrClose,
    DictOpen,
    DictClose,
    Kw(Vec<u8>),
}

struct Lexer<'a> {
    b: &'a [u8],
    pos: usize,
}

impl<'a> Lexer<'a> {
    fn new(b: &'a [u8], pos: usize) -> Self {
        Self { b, pos }
    }

    fn peek(&self) -> Option<u8> {
        self.b.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while let Some(c) = self.peek() {
            if is_ws(c) {
                self.pos += 1;
            } else if c == b'%' {
                while self.peek().is_some_and(|c| c != b'\n' && c != b'\r') {
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
    }

    fn next_tok(&mut self) -> Result<Option<Tok>, ()> {
        self.skip_ws();
        let Some(c) = self.peek() else {
            return Ok(None);
        };
        match c {
            b'[' => {
                self.pos += 1;
                Ok(Some(Tok::ArrOpen))
            }
            b']' => {
                self.pos += 1;
                Ok(Some(Tok::ArrClose))
            }
            b'<' if self.b.get(self.pos + 1) == Some(&b'<') => {
                self.pos += 2;
                Ok(Some(Tok::DictOpen))
            }
            b'>' if self.b.get(self.pos + 1) == Some(&b'>') => {
                self.pos += 2;
                Ok(Some(Tok::DictClose))
            }
            b'<' => self.hex_string().map(Some),
            b'(' => self.literal_string().map(Some),
            b'/' => {
                self.pos += 1;
                Ok(Some(Tok::Name(self.name())))
            }
            b'{' | b'}' => {
                self.pos += 1;
                Ok(Some(Tok::Kw(vec![c])))
            }
            b')' | b'>' => Err(()),
            b'0'..=b'9' | b'+' | b'-' | b'.' => self.number().map(Some),
            _ => {
                let start = self.pos;
                while self.peek().is_some_and(|c| !is_ws(c) && !is_delim(c)) {
                    self.pos += 1;
                }
                Ok(Some(Tok::Kw(self.b[start..self.pos].to_vec())))
            }
        }
    }

    fn number(&mut self) -> Result<Tok, ()> {
        let start = self.pos;
        while self.peek().is_some_and(|c| !is_ws(c) && !is_delim(c)) {
            self.pos += 1;
        }
        let text = std::str::from_utf8(&self.b[start..self.pos]).map_err(|_| ())?;
        let int = !text.contains('.');
        let body = text.strip_prefix(['+', '-']).unwrap_or(text);
        if body.is_empty()
            || body == "."
            || !body.bytes().all(|c| c.is_ascii_digit() || c == b'.')
            || body.matches('.').count() > 1
        {
            return Err(());
        }
        let value: f64 = if body.starts_with('.') {
            format!("{}0{body}", if text.starts_with('-') { "-" } else { "" })
                .parse()
                .map_err(|_| ())?
        } else {
            text.trim_start_matches('+').parse().map_err(|_| ())?
        };
        Ok(Tok::Num { value, int })
    }

    fn name(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        while let Some(c) = self.peek().filter(|c| !is_ws(*c) && !is_delim(*c)) {
            self.pos += 1;
            if c == b'#'
                && let Some(v) = self
                    .b
                    .get(self.pos..self.pos + 2)
                    .and_then(|h| std::str::from_utf8(h).ok())
                    .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                self.pos += 2;
                out.push(v);
                continue;
            }
            out.push(c);
        }
        out
    }

    fn hex_string(&mut self) -> Result<Tok, ()> {
        self.pos += 1;
        let mut digits = Vec::new();
        loop {
            let c = self.peek().ok_or(())?;
            self.pos += 1;
            match c {
                b'>' => break,
                c if is_ws(c) => {}
                c if c.is_ascii_hexdigit() => digits.push(c),
                _ => return Err(()),
            }
        }
        if digits.len() % 2 == 1 {
            digits.push(b'0');
        }
        let out = digits
            .chunks(2)
            .map(|p| {
                let hi = (p[0] as char).to_digit(16).unwrap_or(0);
                let lo = (p[1] as char).to_digit(16).unwrap_or(0);
                (hi * 16 + lo) as u8
            })
            .collect();
        Ok(Tok::Str(out))
    }

    fn literal_string(&mut self) -> Result<Tok, ()> {
        self.pos += 1;
        let mut depth = 1usize;
        let mut out = Vec::new();
        loop {
            let c = self.peek().ok_or(())?;
            self.pos += 1;
            match c {
                b'\\' => {
                    let e = self.peek().ok_or(())?;
                    self.pos += 1;
                    match e {
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'\r' => {
                            if self.peek() == Some(b'\n') {
                                self.pos += 1;
                            }
                        }
                        b'\n' => {}
                        b'0'..=b'7' => {
                            let mut v = u32::from(e - b'0');
                            for _ in 0..2 {
                                match self.peek() {
                                    Some(d @ b'0'..=b'7') => {
                                        v = v * 8 + u32::from(d - b'0');
                                        self.pos += 1;
                                    }
                                    _ => break,
                                }
                            }
                            out.push((v & 0xff) as u8);
                        }
                        other => out.push(other),
                    }
                }
                b'(' => {
                    depth += 1;
                    out.push(c);
                }
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    out.push(c);
                }
                _ => out.push(c),
            }
        }
        Ok(Tok::Str(out))
    }

    /// Melewati data gambar inline setelah `ID`: berakhir di `EI` yang diapit
    /// spasi (cara yang sama dengan pdf.js dan lopdf).
    fn skip_inline_image_data(&mut self) {
        self.pos += 1; // satu spasi pemisah
        let rest = self.b.get(self.pos..).unwrap_or(&[]);
        let found = rest.windows(3).enumerate().find(|(i, w)| {
            is_ws(w[0])
                && w[1] == b'E'
                && w[2] == b'I'
                && rest.get(i + 3).is_none_or(|c| is_ws(*c) || is_delim(*c))
        });
        self.pos = match found {
            Some((i, _)) => self.pos + i + 3,
            None => self.b.len(),
        };
    }
}

/// Nilai objek (untuk trailer). Referensi `n g R` dikenali.
fn parse_value(lx: &mut Lexer, depth: usize) -> Result<Object, ()> {
    let tok = lx.next_tok()?.ok_or(())?;
    parse_value_from(lx, tok, depth)
}

fn parse_value_from(lx: &mut Lexer, tok: Tok, depth: usize) -> Result<Object, ()> {
    if depth > MAX_DEPTH {
        return Err(());
    }
    Ok(match tok {
        Tok::Num { value, int: true } => {
            // Mungkin referensi: lihat dua token berikutnya tanpa memakannya.
            let save = lx.pos;
            if let (
                Ok(Some(Tok::Num {
                    value: g,
                    int: true,
                })),
                Ok(Some(Tok::Kw(k))),
            ) = (lx.next_tok(), lx.next_tok())
                && k == b"R"
                && (0.0..=f64::from(u32::MAX)).contains(&value)
                && (0.0..=65535.0).contains(&g)
            {
                return Ok(Object::Reference((value as u32, g as u16)));
            }
            lx.pos = save;
            Object::Integer(value as i64)
        }
        Tok::Num { value, .. } => Object::Real(value as f32),
        Tok::Name(n) => Object::Name(n),
        Tok::Str(s) => Object::String(s, lopdf::StringFormat::Literal),
        Tok::ArrOpen => {
            let mut items = Vec::new();
            loop {
                match lx.next_tok()?.ok_or(())? {
                    Tok::ArrClose => break,
                    t => items.push(parse_value_from(lx, t, depth + 1)?),
                }
            }
            Object::Array(items)
        }
        Tok::DictOpen => {
            let mut d = Dictionary::new();
            loop {
                match lx.next_tok()?.ok_or(())? {
                    Tok::DictClose => break,
                    Tok::Name(k) => {
                        let v = parse_value(lx, depth + 1)?;
                        d.set(k, v);
                    }
                    _ => return Err(()),
                }
            }
            Object::Dictionary(d)
        }
        Tok::Kw(k) if k == b"true" => Object::Boolean(true),
        Tok::Kw(k) if k == b"false" => Object::Boolean(false),
        Tok::Kw(k) if k == b"null" => Object::Null,
        _ => return Err(()),
    })
}

#[derive(Debug, Clone)]
enum Operand {
    Num(f64),
    Name(Vec<u8>),
    Str(Vec<u8>),
    Array(Vec<Operand>),
    Other,
}

impl Operand {
    fn num(&self) -> Option<f64> {
        match self {
            Operand::Num(n) => Some(*n),
            _ => None,
        }
    }
}

/// Penerima operator isi halaman: (operator, operand).
type OpVisitor<'f> = dyn FnMut(&[u8], &[Operand]) -> Result<(), ()> + 'f;

/// Menjalankan `f` untuk setiap operator isi halaman. `strict`: token aneh,
/// kamus, gambar inline, atau operand tersisa di akhir membuat gagal;
/// longgar: dilewati seperti pembaca PDF.
fn for_each_op(bytes: &[u8], strict: bool, f: &mut OpVisitor) -> Result<(), ()> {
    let mut lx = Lexer::new(bytes, 0);
    let mut args: Vec<Operand> = Vec::new();
    loop {
        let tok = match lx.next_tok() {
            Ok(Some(t)) => t,
            Ok(None) => break,
            Err(()) if strict => return Err(()),
            Err(()) => {
                lx.pos += 1;
                continue;
            }
        };
        match tok {
            Tok::Num { value, .. } => args.push(Operand::Num(value)),
            Tok::Name(n) => args.push(Operand::Name(n)),
            Tok::Str(s) => args.push(Operand::Str(s)),
            Tok::ArrOpen => {
                let mut items = Vec::new();
                let mut nesting = 0usize;
                loop {
                    match lx.next_tok() {
                        Ok(Some(Tok::ArrClose)) if nesting == 0 => break,
                        Ok(Some(Tok::ArrClose)) => nesting -= 1,
                        Ok(Some(Tok::ArrOpen)) if !strict => nesting += 1,
                        Ok(Some(Tok::Num { value, .. })) => items.push(Operand::Num(value)),
                        Ok(Some(Tok::Str(s))) => items.push(Operand::Str(s)),
                        Ok(Some(_)) if !strict => items.push(Operand::Other),
                        Ok(None) => break,
                        Err(()) if !strict => lx.pos += 1,
                        _ => return Err(()),
                    }
                }
                args.push(Operand::Array(items));
            }
            Tok::DictOpen if !strict => {
                let mut nesting = 0usize;
                loop {
                    match lx.next_tok() {
                        Ok(Some(Tok::DictClose)) if nesting == 0 => break,
                        Ok(Some(Tok::DictClose)) => nesting -= 1,
                        Ok(Some(Tok::DictOpen)) => nesting += 1,
                        Ok(None) => break,
                        Err(()) => lx.pos += 1,
                        Ok(Some(_)) => {}
                    }
                }
                args.push(Operand::Other);
            }
            Tok::Kw(k) if k == b"BI" => {
                if strict {
                    return Err(());
                }
                // Lewati kamus gambar sampai ID, lalu datanya.
                loop {
                    match lx.next_tok() {
                        Ok(Some(Tok::Kw(k))) if k == b"ID" => {
                            lx.skip_inline_image_data();
                            break;
                        }
                        Ok(None) => break,
                        Err(()) => lx.pos += 1,
                        Ok(Some(_)) => {}
                    }
                }
                args.clear();
            }
            Tok::Kw(k) if k == b"true" || k == b"false" || k == b"null" => {
                args.push(Operand::Other)
            }
            Tok::Kw(k) => {
                f(&k, &args)?;
                args.clear();
            }
            _ if strict => return Err(()),
            _ => args.clear(),
        }
    }
    if strict && !args.is_empty() {
        return Err(());
    }
    Ok(())
}

/// Semua nama (`/Nama`) di isi halaman, termasuk di dalam larik dan kamus.
fn for_each_names(bytes: &[u8], f: &mut dyn FnMut(&[u8])) -> Result<(), ()> {
    let mut lx = Lexer::new(bytes, 0);
    loop {
        match lx.next_tok() {
            Ok(Some(Tok::Name(n))) => f(&n),
            Ok(Some(Tok::Kw(k))) if k == b"ID" => lx.skip_inline_image_data(),
            Ok(Some(_)) => {}
            Ok(None) => return Ok(()),
            Err(()) => lx.pos += 1,
        }
    }
}

/// Pembuat PDF untuk tes (dipakai juga oleh tes sinkron tanda tangan).
#[cfg(test)]
pub mod testing {
    use lopdf::{Dictionary, Document, Object, ObjectId, Stream, dictionary};

    use super::last_startxref;

    /// PDF kecil yang sah dengan `pages` halaman berisi teks.
    pub fn sample_pdf(pages: usize) -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        });
        let mut kids = Vec::new();
        for i in 0..pages {
            let text = format!(
                "BT /F1 18 Tf 72 720 Td (Halaman {} isi asli) Tj ET\n",
                i + 1
            );
            let content_id = doc.add_object(Stream::new(Dictionary::new(), text.into_bytes()));
            let page_id = doc.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
                "Contents" => content_id,
                "Resources" => dictionary! { "Font" => dictionary! { "F1" => font_id } },
            });
            kids.push(Object::Reference(page_id));
        }
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => kids,
                "Count" => pages as i64,
            }),
        );
        let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        let info_id = doc.add_object(dictionary! { "Producer" => Object::string_literal("tes") });
        doc.trailer.set("Root", catalog_id);
        doc.trailer.set("Info", info_id);
        let mut out = Vec::new();
        doc.save_to(&mut out).expect("simpan PDF contoh");
        out
    }

    /// Incremental update sah: stempel di halaman 1 dan `doc_tag` di Info.
    pub fn stamp(old: &[u8], doc_tag: &str) -> Vec<u8> {
        let mut inc = Increment::open(old);
        inc.stamp_page(0, doc_tag);
        inc.finish()
    }

    /// Seperti `stamp`, ditambah satu halaman catatan di akhir (incremental
    /// update kedua, seperti penanda tangan terakhir di aplikasi).
    pub fn stamp_with_audit_page(old: &[u8], doc_tag: &str) -> Vec<u8> {
        let stamped = stamp(old, doc_tag);
        let mut inc = Increment::open(&stamped);
        inc.add_page("Halaman catatan tanda tangan");
        inc.set_info(doc_tag);
        inc.finish()
    }

    /// Incremental update yang juga mengganti isi halaman lama: harus ditolak.
    pub fn tamper(old: &[u8], doc_tag: &str) -> Vec<u8> {
        let mut inc = Increment::open(old);
        inc.stamp_page(0, doc_tag);
        // Definisi ulang stream isi lama halaman 1 dengan teks lain.
        let page = inc.page_ids()[0];
        let first = inc.old_contents(page)[0];
        inc.put(
            first,
            Object::Stream(Stream::new(
                Dictionary::new(),
                b"BT /F1 18 Tf 72 720 Td (Isi sudah diganti) Tj ET\n".to_vec(),
            )),
        );
        inc.finish()
    }

    /// Gambar stempel untuk tes: RGB 8 bit dan SMask (None: tanpa SMask).
    #[derive(Clone)]
    pub struct TestImage {
        pub width: usize,
        pub height: usize,
        pub rgb: Vec<u8>,
        pub alpha: Option<Vec<u8>>,
    }

    impl TestImage {
        /// 2 x 1: kiri merah legap, kanan transparan (rata-rata alpha 0,5).
        pub fn signature() -> Self {
            Self {
                width: 2,
                height: 1,
                rgb: vec![255, 0, 0, 0, 0, 0],
                alpha: Some(vec![255, 0]),
            }
        }

        /// Satu warna dengan alpha yang sama di semua piksel.
        pub fn solid(width: usize, height: usize, rgb: [u8; 3], alpha: Option<u8>) -> Self {
            Self {
                width,
                height,
                rgb: rgb.repeat(width * height),
                alpha: alpha.map(|a| vec![a; width * height]),
            }
        }
    }

    /// Penulis incremental update untuk tes, meniru bentuk keluaran pdf-lib.
    pub struct Increment {
        old: Vec<u8>,
        doc: Document,
        next_id: u32,
        objects: Vec<(ObjectId, Object)>,
    }

    impl Increment {
        pub fn open(old: &[u8]) -> Self {
            let doc = Document::load_mem(old).expect("PDF lama terbaca");
            let next_id = doc.max_id.max(doc.reference_table.size.saturating_sub(1)) + 1;
            Self {
                old: old.to_vec(),
                doc,
                next_id,
                objects: Vec::new(),
            }
        }

        pub fn page_ids(&self) -> Vec<ObjectId> {
            self.doc.get_pages().into_values().collect()
        }

        pub fn old_contents(&self, page: ObjectId) -> Vec<ObjectId> {
            self.doc.get_page_contents(page)
        }

        pub fn add(&mut self, obj: Object) -> ObjectId {
            let id = (self.next_id, 0);
            self.next_id += 1;
            self.objects.push((id, obj));
            id
        }

        /// Objek (baru atau definisi ulang) yang ikut ditulis.
        pub fn put(&mut self, id: ObjectId, obj: Object) {
            self.objects.retain(|(i, _)| *i != id);
            self.objects.push((id, obj));
        }

        /// Nilai objek yang akan ditulis (atau dari versi lama).
        pub fn current(&self, id: ObjectId) -> Object {
            self.objects
                .iter()
                .rev()
                .find(|(i, _)| *i == id)
                .map(|(_, o)| o.clone())
                .or_else(|| self.doc.objects.get(&id).cloned())
                .expect("objek ada")
        }

        pub fn stamp_page(&mut self, index: usize, doc_tag: &str) {
            self.stamp_page_with(index, doc_tag, false, &|img, font| {
                format!(
                    "q\n1 0 0 1 72 100 cm\n120 0 0 60 0 0 cm\n/{img} Do\nQ\n\
                     q\nBT\n0.2 0.2 0.2 rg\n/{font} 10 Tf\n1 0 0 1 72 88 Tm\n<4E616D61> Tj\nET\nQ\n"
                )
            });
        }

        /// Stempel dengan isi stream sendiri (`draw(nama gambar, nama font)`).
        /// `opaque`: gambar tanpa SMask.
        pub fn stamp_page_with(
            &mut self,
            index: usize,
            doc_tag: &str,
            opaque: bool,
            draw: &dyn Fn(&str, &str) -> String,
        ) {
            let mut image = TestImage::signature();
            if opaque {
                image.alpha = None;
            }
            self.stamp_page_image(index, doc_tag, &image, draw);
        }

        /// Seperti `stamp_page_with` dengan gambar sendiri.
        pub fn stamp_page_image(
            &mut self,
            index: usize,
            doc_tag: &str,
            img: &TestImage,
            draw: &dyn Fn(&str, &str) -> String,
        ) {
            let page_id = self.page_ids()[index];
            let mut page = match self.current(page_id) {
                Object::Dictionary(d) => d,
                _ => panic!("halaman bukan kamus"),
            };
            let q = self.add(Object::Stream(Stream::new(
                Dictionary::new(),
                b"q\n".to_vec(),
            )));
            let big_q = self.add(Object::Stream(Stream::new(
                Dictionary::new(),
                b"Q\n".to_vec(),
            )));
            let (w, h) = (img.width as i64, img.height as i64);
            let mut image_dict = lopdf::dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => w, "Height" => h,
                "BitsPerComponent" => 8, "ColorSpace" => "DeviceRGB",
            };
            if let Some(alpha) = &img.alpha {
                let smask = self.add(Object::Stream(Stream::new(
                    lopdf::dictionary! {
                        "Type" => "XObject", "Subtype" => "Image", "Width" => w, "Height" => h,
                        "BitsPerComponent" => 8, "ColorSpace" => "DeviceGray",
                        "Decode" => vec![0.into(), 1.into()],
                    },
                    alpha.clone(),
                )));
                image_dict.set("SMask", smask);
            }
            let image = self.add(Object::Stream(Stream::new(image_dict, img.rgb.clone())));
            let font = self.add(Object::Dictionary(lopdf::dictionary! {
                "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
                "Encoding" => "WinAnsiEncoding",
            }));
            let img_name = format!("Image-{}", image.0);
            let font_name = format!("Helvetica-{}", font.0);
            let draw = draw(&img_name, &font_name);
            let draw = self.add(Object::Stream(Stream::new(
                Dictionary::new(),
                draw.into_bytes(),
            )));

            // Contents: [q, isi lama..., Q, stempel].
            let mut contents = vec![Object::Reference(q)];
            contents.extend(
                self.old_contents(page_id)
                    .into_iter()
                    .map(Object::Reference),
            );
            contents.push(Object::Reference(big_q));
            contents.push(Object::Reference(draw));
            page.set("Contents", contents);

            // Resources efektif (langsung atau warisan) disalin lalu ditambah.
            let mut res = self.effective_resources(page_id);
            let mut add_entry = |cat: &[u8], name: &str, id: ObjectId, doc: &Document| {
                let mut d = match res.get(cat).map(|o| resolve_clone(doc, o)) {
                    Ok(Object::Dictionary(d)) => d,
                    _ => Dictionary::new(),
                };
                d.set(name, id);
                res.set(cat.to_vec(), d);
            };
            add_entry(b"XObject", &img_name, image, &self.doc);
            add_entry(b"Font", &font_name, font, &self.doc);
            page.set("Resources", res);
            self.put(page_id, Object::Dictionary(page));
            self.set_info(doc_tag);
        }

        fn effective_resources(&self, page: ObjectId) -> Dictionary {
            let mut id = page;
            for _ in 0..32 {
                let Object::Dictionary(d) = self.current(id) else {
                    break;
                };
                if let Ok(r) = d.get(b"Resources") {
                    return match resolve_clone(&self.doc, r) {
                        Object::Dictionary(d) => d,
                        _ => Dictionary::new(),
                    };
                }
                match d.get(b"Parent") {
                    Ok(Object::Reference(p)) => id = *p,
                    _ => break,
                }
            }
            Dictionary::new()
        }

        pub fn add_page(&mut self, text: &str) {
            self.add_page_at(text, usize::MAX);
        }

        /// Halaman baru di posisi `index` pada /Kids akar (dijepit ke akhir).
        pub fn add_page_at(&mut self, text: &str, index: usize) {
            let font = self.add(Object::Dictionary(lopdf::dictionary! {
                "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
            }));
            let content =
                format!("0 0 0 RG 56 700 m 539 700 l S\nBT /F1 18 Tf 56 760 Td ({text}) Tj ET\n");
            let resources = lopdf::dictionary! { "Font" => lopdf::dictionary! { "F1" => font } };
            self.add_page_raw(&content, resources, index);
        }

        /// Halaman baru dengan isi dan sumber daya sendiri, di posisi `index`
        /// pada /Kids akar (dijepit ke akhir).
        pub fn add_page_raw(&mut self, content: &str, resources: Dictionary, index: usize) {
            let root = self
                .doc
                .trailer
                .get(b"Root")
                .and_then(Object::as_reference)
                .expect("Root");
            let pages_id = self
                .doc
                .get_dictionary(root)
                .and_then(|c| c.get(b"Pages"))
                .and_then(Object::as_reference)
                .expect("Pages");
            let content = self.add(Object::Stream(Stream::new(
                Dictionary::new(),
                content.as_bytes().to_vec(),
            )));
            let page = self.add(Object::Dictionary(lopdf::dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 595.28.into(), 841.89.into()],
                "Contents" => content,
                "Resources" => resources,
            }));
            let Object::Dictionary(mut pages) = self.current(pages_id) else {
                panic!("Pages bukan kamus")
            };
            let mut kids = pages
                .get(b"Kids")
                .and_then(Object::as_array)
                .cloned()
                .unwrap_or_default();
            kids.insert(index.min(kids.len()), Object::Reference(page));
            let count = pages.get(b"Count").and_then(Object::as_i64).unwrap_or(0);
            pages.set("Kids", kids);
            pages.set("Count", count + 1);
            self.put(pages_id, Object::Dictionary(pages));
        }

        pub fn set_info(&mut self, doc_tag: &str) {
            let info = match self.doc.trailer.get(b"Info") {
                Ok(Object::Reference(id)) => *id,
                _ => {
                    let id = (self.next_id, 0);
                    self.next_id += 1;
                    id
                }
            };
            self.put(
                info,
                Object::Dictionary(lopdf::dictionary! {
                    "Producer" => Object::string_literal("Mira"),
                    "Keywords" => Object::string_literal(doc_tag),
                    "MiraDocTag" => Object::string_literal(doc_tag),
                }),
            );
            self.doc.trailer.set("Info", info);
        }

        pub fn finish(self) -> Vec<u8> {
            let mut out = self.old.clone();
            if !matches!(out.last(), Some(b'\n' | b'\r')) {
                out.push(b'\n');
            }
            let mut offsets: Vec<(ObjectId, usize)> = Vec::new();
            for (id, obj) in &self.objects {
                offsets.push((*id, out.len()));
                out.extend_from_slice(format!("{} {} obj\n", id.0, id.1).as_bytes());
                write_object(&mut out, obj);
                out.extend_from_slice(b"\nendobj\n");
            }
            offsets.sort();
            let xref = out.len();
            out.extend_from_slice(b"xref\n");
            let mut i = 0;
            while i < offsets.len() {
                let mut j = i + 1;
                while j < offsets.len() && offsets[j].0.0 == offsets[j - 1].0.0 + 1 {
                    j += 1;
                }
                out.extend_from_slice(format!("{} {}\n", offsets[i].0.0, j - i).as_bytes());
                for (id, off) in &offsets[i..j] {
                    out.extend_from_slice(format!("{off:010} {:05} n\r\n", id.1).as_bytes());
                }
                i = j;
            }
            let prev = last_startxref(&self.old, 0).expect("startxref lama").1;
            let size = self
                .next_id
                .max(offsets.iter().map(|(id, _)| id.0 + 1).max().unwrap_or(0));
            let mut trailer = format!("trailer\n<< /Size {size} /Prev {prev}");
            for key in ["Root", "Info"] {
                if let Ok(Object::Reference(id)) = self.doc.trailer.get(key.as_bytes()) {
                    trailer.push_str(&format!(" /{key} {} {} R", id.0, id.1));
                }
            }
            trailer.push_str(" >>\n");
            out.extend_from_slice(trailer.as_bytes());
            out.extend_from_slice(format!("startxref\n{xref}\n%%EOF\n").as_bytes());
            out
        }
    }

    fn resolve_clone(doc: &Document, obj: &Object) -> Object {
        match obj {
            Object::Reference(id) => doc.objects.get(id).cloned().unwrap_or(Object::Null),
            o => o.clone(),
        }
    }

    /// Penulis objek PDF sederhana (tanpa kompresi).
    pub fn write_object(out: &mut Vec<u8>, obj: &Object) {
        match obj {
            Object::Null => out.extend_from_slice(b"null"),
            Object::Boolean(b) => out.extend_from_slice(if *b { b"true" } else { b"false" }),
            Object::Integer(i) => out.extend_from_slice(i.to_string().as_bytes()),
            Object::Real(r) => out.extend_from_slice(format!("{r}").as_bytes()),
            Object::Name(n) => {
                out.push(b'/');
                out.extend_from_slice(n);
            }
            Object::String(s, _) => {
                out.push(b'(');
                for &c in s {
                    if matches!(c, b'(' | b')' | b'\\') {
                        out.push(b'\\');
                    }
                    out.push(c);
                }
                out.push(b')');
            }
            Object::Array(a) => {
                out.push(b'[');
                for (i, o) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(b' ');
                    }
                    write_object(out, o);
                }
                out.push(b']');
            }
            Object::Dictionary(d) => write_dict(out, d),
            Object::Stream(s) => {
                let mut dict = s.dict.clone();
                dict.set("Length", s.content.len() as i64);
                write_dict(out, &dict);
                out.extend_from_slice(b"\nstream\n");
                out.extend_from_slice(&s.content);
                out.extend_from_slice(b"\nendstream");
            }
            Object::Reference(id) => {
                out.extend_from_slice(format!("{} {} R", id.0, id.1).as_bytes())
            }
        }
    }

    fn write_dict(out: &mut Vec<u8>, d: &Dictionary) {
        out.extend_from_slice(b"<<");
        for (k, v) in d.iter() {
            out.push(b'/');
            out.extend_from_slice(k);
            out.push(b' ');
            write_object(out, v);
            out.push(b' ');
        }
        out.extend_from_slice(b">>");
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{Increment, TestImage, sample_pdf, stamp, stamp_with_audit_page, tamper};
    use super::*;
    use lopdf::dictionary;

    const TAG: &str = "mira-doc:0123456789abcdef0123456789abcdef";

    fn code(old: &[u8], new: &[u8]) -> &'static str {
        match check_increment(old, new) {
            Ok(_) => "ok",
            Err(e) => {
                assert!(!e.message.is_empty());
                e.code
            }
        }
    }

    fn custom(old: &[u8], opaque: bool, draw: &dyn Fn(&str, &str) -> String) -> Vec<u8> {
        let mut inc = Increment::open(old);
        inc.stamp_page_with(0, TAG, opaque, draw);
        inc.finish()
    }

    #[test]
    fn sample_pdf_terbaca() {
        let pdf = sample_pdf(3);
        let doc = Document::load_mem(&pdf).unwrap();
        assert_eq!(doc.get_pages().len(), 3);
    }

    #[test]
    fn stempel_sah_lolos() {
        let old = sample_pdf(2);
        let new = stamp(&old, TAG);
        assert!(new.starts_with(&old));
        assert_eq!(
            check_increment(&old, &new),
            Ok(IncrementInfo { added_pages: 0 })
        );
        assert!(new.windows(TAG.len()).any(|w| w == TAG.as_bytes()));
    }

    #[test]
    fn dua_penanda_tangan_berantai() {
        let v0 = sample_pdf(1);
        let v1 = stamp(&v0, TAG);
        let v2 = stamp(&v1, TAG);
        assert_eq!(code(&v1, &v2), "ok");
        // Dua incremental update sekaligus juga diperiksa sebagai satu.
        assert_eq!(code(&v0, &v2), "ok");
    }

    #[test]
    fn halaman_catatan_di_akhir() {
        let old = sample_pdf(2);
        let new = stamp_with_audit_page(&old, TAG);
        assert_eq!(
            check_increment(&old, &new),
            Ok(IncrementInfo { added_pages: 1 })
        );
        // Halaman catatan bisa lebih dari satu halaman.
        let mut inc = Increment::open(&new);
        inc.add_page("lanjutan");
        let three = inc.finish();
        assert_eq!(
            check_increment(&old, &three),
            Ok(IncrementInfo { added_pages: 2 })
        );
        // Halaman baru di depan halaman lama ditolak.
        let mut inc = Increment::open(&old);
        inc.add_page_at("sisipan", 0);
        assert_eq!(code(&old, &inc.finish()), "version_changes_content");
        // Terlalu banyak halaman baru.
        let mut many = old.clone();
        for i in 0..=MAX_ADDED_PAGES {
            let mut inc = Increment::open(&many);
            inc.add_page(&format!("halaman {i}"));
            many = inc.finish();
        }
        assert_eq!(code(&old, &many), "version_changes_content");
    }

    #[test]
    fn mengubah_isi_ditolak() {
        let old = sample_pdf(2);
        let err = check_increment(&old, &tamper(&old, TAG)).unwrap_err();
        assert_eq!(err.code, "version_changes_content");
    }

    #[test]
    fn bukan_awalan_ditolak() {
        let old = sample_pdf(1);
        let mut new = stamp(&old, TAG);
        new[20] ^= 1;
        assert_eq!(code(&old, &new), "version_not_prefix");
        assert_eq!(code(&old, &old), "version_not_prefix");
        assert_eq!(code(&old, &old[..old.len() - 1]), "version_not_prefix");
    }

    #[test]
    fn lama_tanpa_baris_baru_atau_dengan_sampah_di_akhir() {
        let base = sample_pdf(1);
        let trimmed = base.trim_ascii_end().to_vec();
        assert_eq!(code(&trimmed, &stamp(&trimmed, TAG)), "ok");
        let mut junk = base.clone();
        junk.extend_from_slice(b"\r\n\0\0sampah setelah EOF");
        assert_eq!(code(&junk, &stamp(&junk, TAG)), "ok");
    }

    #[test]
    fn ekor_rusak_tidak_panik() {
        let old = sample_pdf(1);
        let new = stamp(&old, TAG);
        for cut in old.len() + 1..new.len() {
            if new[cut..].iter().all(|c| is_ws(*c)) {
                continue; // hanya baris baru setelah %%EOF yang terpotong
            }
            assert_ne!(code(&old, &new[..cut]), "ok", "potong di {cut}");
        }
        let mut state = 0x1234_5678u32;
        for len in [1usize, 7, 64, 500, 5000] {
            let mut garbage = old.clone();
            for _ in 0..len {
                state = state.wrapping_mul(1_103_515_245).wrapping_add(12345);
                garbage.push((state >> 16) as u8);
            }
            assert_ne!(code(&old, &garbage), "ok");
            // Sampah di tengah incremental update yang sah.
            let mut mixed = new.clone();
            let at = old.len() + (state as usize % (new.len() - old.len()));
            mixed[at] = (state >> 8) as u8;
            let _ = check_increment(&old, &mixed);
        }
        assert_eq!(code(b"", b"%PDF"), "pdf_invalid");
        assert_ne!(code(b"%PDF-1.7\n", b"%PDF-1.7\nstartxref\n9\n%%EOF"), "ok");
    }

    #[test]
    fn operator_bidang_ditolak() {
        let old = sample_pdf(1);
        let new = custom(&old, false, &|_, _| {
            "q 1 1 1 rg 0 0 612 792 re f Q\n".into()
        });
        assert_eq!(code(&old, &new), "version_changes_content");
        let new = custom(&old, false, &|_, _| {
            "q BI /W 1 /H 1 /CS /G /BPC 8 ID \x00 EI Q\n".into()
        });
        assert_eq!(code(&old, &new), "version_changes_content");
        let new = custom(&old, false, &|_, _| "q 10 10 m 20 20 l S Q\n".into());
        assert_eq!(code(&old, &new), "version_changes_content");
        let new = custom(&old, false, &|_, _| "q 0 0 10 10 re W n Q\n".into());
        assert_eq!(code(&old, &new), "version_changes_content");
    }

    #[test]
    fn gambar_dan_huruf_dibatasi() {
        let old = sample_pdf(1);
        // Gambar legap selebar halaman.
        let new = custom(&old, true, &|img, _| {
            format!("q 612 0 0 792 0 0 cm /{img} Do Q\n")
        });
        assert_eq!(code(&old, &new), "version_changes_content");
        // Gambar legap kecil (tanpa SMask) juga ditolak.
        let new = custom(&old, true, &|img, _| {
            format!("q 30 0 0 15 72 715 cm /{img} Do Q\n")
        });
        assert_eq!(code(&old, &new), "version_changes_content");
        // Gambar setengah transparan seluas 10% halaman boleh.
        let new = custom(&old, false, &|img, _| {
            format!("q 220 0 0 220 0 0 cm /{img} Do Q\n")
        });
        assert_eq!(code(&old, &new), "ok");
        // Gambar setengah transparan selebar halaman: tinta 50%.
        let new = custom(&old, false, &|img, _| {
            format!("q 612 0 0 792 0 0 cm /{img} Do Q\n")
        });
        assert_eq!(code(&old, &new), "version_changes_content");
        // Gambar lebih besar dari halaman.
        let new = custom(&old, false, &|img, _| {
            format!("q 2000 0 0 2000 0 0 cm /{img} Do Q\n")
        });
        assert_eq!(code(&old, &new), "version_changes_content");
        // Huruf 100 pt, langsung atau lewat matriks.
        let new = custom(&old, false, &|_, f| {
            format!("BT /{f} 100 Tf 1 0 0 1 72 72 Tm (X) Tj ET\n")
        });
        assert_eq!(code(&old, &new), "version_changes_content");
        let new = custom(&old, false, &|_, f| {
            format!("q 10 0 0 10 0 0 cm BT /{f} 10 Tf (X) Tj ET Q\n")
        });
        assert_eq!(code(&old, &new), "version_changes_content");
        let new = custom(&old, false, &|_, f| {
            format!("BT /{f} 10 Tf 1000 Tz (X) Tj ET\n")
        });
        assert_eq!(code(&old, &new), "version_changes_content");
        let new = custom(&old, false, &|_, f| {
            format!("BT /{f} 10 Tf 2 Tr (X) Tj ET\n")
        });
        assert_eq!(code(&old, &new), "version_changes_content");
        let long = "A".repeat(MAX_GLYPHS_PER_PAGE + 1);
        let new = custom(&old, false, &|_, f| {
            format!("BT /{f} 10 Tf ({long}) Tj ET\n")
        });
        assert_eq!(code(&old, &new), "version_changes_content");
        // Teks tanpa Tf memakai font isi lama yang tidak diperiksa.
        let new = custom(&old, false, &|_, _| "BT (X) Tj ET\n".into());
        assert_eq!(code(&old, &new), "version_changes_content");
    }

    #[test]
    fn gambar_lama_dan_font_lama_tidak_sah() {
        let old = sample_pdf(1);
        // F1 font lama: Helvetica standar, boleh.
        let new = custom(&old, false, &|_, _| "BT /F1 10 Tf (X) Tj ET\n".into());
        assert_eq!(code(&old, &new), "ok");
        // XObject yang tidak ada.
        let new = custom(&old, false, &|_, _| "q /Lain Do Q\n".into());
        assert_eq!(code(&old, &new), "version_changes_content");
    }

    #[test]
    fn stream_di_depan_isi_lama_hanya_q() {
        let old = sample_pdf(1);
        let mut inc = Increment::open(&old);
        inc.stamp_page(0, TAG);
        let page = inc.page_ids()[0];
        // Ganti stream q di depan dengan pemotong (clip) seluruh halaman.
        let new = inc.finish();
        let doc = Document::load_mem(&new).unwrap();
        let first = doc.get_page_contents(page)[0];
        let mut inc = Increment::open(&old);
        inc.stamp_page(0, TAG);
        inc.put(
            first,
            Object::Stream(Stream::new(
                Dictionary::new(),
                b"q 0 0 1 1 re W n\n".to_vec(),
            )),
        );
        assert_eq!(code(&old, &inc.finish()), "version_changes_content");
        assert!(only_q(b"q\n"));
        assert!(only_q(b" q q\r\n"));
        assert!(!only_q(b"q"));
        assert!(!only_q(b"qQ\n"));
        assert!(!only_q(b"q 3 Tr\n"));
    }

    #[test]
    fn halaman_lama_lain_berubah_ditolak() {
        let old = sample_pdf(2);
        let mut inc = Increment::open(&old);
        inc.stamp_page(0, TAG);
        let page2 = inc.page_ids()[1];
        let Ok(Object::Dictionary(mut d)) =
            Document::load_mem(&old).map(|d| d.objects[&page2].clone())
        else {
            panic!()
        };
        d.set("MediaBox", vec![0.into(), 0.into(), 100.into(), 100.into()]);
        inc.put(page2, Object::Dictionary(d.clone()));
        assert_eq!(code(&old, &inc.finish()), "version_changes_content");

        // Rotate di halaman yang distempel.
        let mut inc = Increment::open(&old);
        let page1 = inc.page_ids()[0];
        inc.stamp_page(0, TAG);
        let new = inc.finish();
        let doc = Document::load_mem(&new).unwrap();
        let Object::Dictionary(mut d) = doc.objects[&page1].clone() else {
            panic!()
        };
        d.set("Rotate", 90);
        let mut inc = Increment::open(&new);
        inc.put(page1, Object::Dictionary(d));
        assert_eq!(code(&old, &inc.finish()), "version_changes_content");
    }

    #[test]
    fn katalog_dan_aksi_aktif_ditolak() {
        let old = sample_pdf(1);
        let doc = Document::load_mem(&old).unwrap();
        let root = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
        let Object::Dictionary(mut cat) = doc.objects[&root].clone() else {
            panic!()
        };
        cat.set("OpenAction", lopdf::dictionary! { "S" => "JavaScript", "JS" => Object::string_literal("app.alert(1)") });
        let mut inc = Increment::open(&old);
        inc.stamp_page(0, TAG);
        inc.put(root, Object::Dictionary(cat));
        assert_eq!(code(&old, &inc.finish()), "version_changes_content");

        // JavaScript di Info (boleh berubah, tapi tidak boleh aksi aktif).
        let mut inc = Increment::open(&old);
        inc.stamp_page(0, TAG);
        let info = doc.trailer.get(b"Info").unwrap().as_reference().unwrap();
        inc.put(
            info,
            Object::Dictionary(lopdf::dictionary! { "AA" => lopdf::dictionary! {} }),
        );
        assert_eq!(code(&old, &inc.finish()), "version_changes_content");
    }

    #[test]
    fn nama_baru_yang_sudah_dipakai_isi_lama_ditolak() {
        // Isi lama memanggil /Image-1 sampai /Image-39 yang belum ada; stempel tidak boleh
        // mengisinya.
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let calls: String = (1..40).map(|i| format!("/Image-{i} Do\n")).collect();
        let content = doc.add_object(Stream::new(
            Dictionary::new(),
            format!("q\n{calls}Q\n").into_bytes(),
        ));
        let page = doc.add_object(lopdf::dictionary! {
            "Type" => "Page", "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Contents" => content,
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(
                lopdf::dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 },
            ),
        );
        let cat = doc.add_object(lopdf::dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", cat);
        let mut old = Vec::new();
        doc.save_to(&mut old).unwrap();
        let mut inc = Increment::open(&old);
        inc.stamp_page_with(0, TAG, false, &|img, _| {
            format!("q 10 0 0 10 0 0 cm /{img} Do Q\n")
        });
        let new = inc.finish();
        assert_eq!(code(&old, &new), "version_changes_content");
    }

    #[test]
    fn entri_bebas_dan_prev_lain_ditolak() {
        let old = sample_pdf(1);
        let new = stamp(&old, TAG);
        let text = String::from_utf8_lossy(&new).into_owned();
        // /Prev menunjuk tempat lain.
        let prev = last_startxref(&old, 0).unwrap().1;
        let bad = text.replacen(&format!("/Prev {prev}"), &format!("/Prev {}", prev + 1), 1);
        assert_ne!(code(&old, bad.as_bytes()), "ok");
        // Entri bebas untuk objek lama (menghapus).
        let xref_at = text.rfind("\nxref\n").unwrap() + 1;
        let mut bad = new[..xref_at].to_vec();
        bad.extend_from_slice(
            text[xref_at..]
                .replacen("xref\n", "xref\n3 1\n0000000000 00001 f\r\n", 1)
                .as_bytes(),
        );
        assert_ne!(code(&old, &bad), "ok");
    }

    #[test]
    fn lexer_angka_dan_string() {
        let mut lx = Lexer::new(b"-.5 +3 12. (a\\(b\\)c\\101) <41 4> /A#42", 0);
        assert_eq!(
            lx.next_tok(),
            Ok(Some(Tok::Num {
                value: -0.5,
                int: false
            }))
        );
        assert_eq!(
            lx.next_tok(),
            Ok(Some(Tok::Num {
                value: 3.0,
                int: true
            }))
        );
        assert_eq!(
            lx.next_tok(),
            Ok(Some(Tok::Num {
                value: 12.0,
                int: false
            }))
        );
        assert_eq!(lx.next_tok(), Ok(Some(Tok::Str(b"a(b)cA".to_vec()))));
        assert_eq!(lx.next_tok(), Ok(Some(Tok::Str(vec![0x41, 0x40]))));
        assert_eq!(lx.next_tok(), Ok(Some(Tok::Name(b"AB".to_vec()))));
        assert_eq!(lx.next_tok(), Ok(None));
    }

    // Fixture dari pdf-lib sungguhan (`npm run fixtures:sign`, memakai
    // src/screens/sign/stamp.ts yang sama dengan aplikasi).
    macro_rules! fixture {
        ($name:literal) => {
            include_bytes!(concat!("../../tests/fixtures/sign/", $name, ".pdf")).as_slice()
        };
    }

    fn chain(v0: &[u8], v1: &[u8], v2: &[u8], v3: &[u8]) {
        assert_eq!(
            check_increment(v0, v1),
            Ok(IncrementInfo { added_pages: 0 })
        );
        assert_eq!(
            check_increment(v1, v2),
            Ok(IncrementInfo { added_pages: 0 })
        );
        assert_eq!(
            check_increment(v2, v3),
            Ok(IncrementInfo { added_pages: 1 })
        );
        // Lompat beberapa versi sekaligus juga sah.
        assert_eq!(
            check_increment(v0, v3),
            Ok(IncrementInfo { added_pages: 1 })
        );
        // Urutan terbalik atau versi lain bukan awalan.
        assert_eq!(code(v1, v0), "version_not_prefix");
        assert_eq!(code(v1, v1), "version_not_prefix");
    }

    #[test]
    fn pdf_lib_xref_klasik_berantai_lolos() {
        chain(
            fixture!("original-classic"),
            fixture!("original-classic-stamped1"),
            fixture!("original-classic-stamped2"),
            fixture!("original-classic-audit"),
        );
    }

    #[test]
    fn pdf_lib_object_stream_berantai_lolos() {
        chain(
            fixture!("original-objstm"),
            fixture!("original-objstm-stamped1"),
            fixture!("original-objstm-stamped2"),
            fixture!("original-objstm-audit"),
        );
    }

    #[test]
    fn pdf_lib_sumber_daya_warisan_tak_langsung_lolos() {
        chain(
            fixture!("original-indirect"),
            fixture!("original-indirect-stamped1"),
            fixture!("original-indirect-stamped2"),
            fixture!("original-indirect-audit"),
        );
    }

    #[test]
    fn pdf_lib_stempel_selebar_halaman_lolos() {
        // Kotak selebar halaman: stamp.ts mengecilkannya sampai gambar PNG
        // pdf-lib (SMask dengan /Decode [0 1]) dan keterangan muat dalam batas
        // luas stempel.
        assert_eq!(
            check_increment(fixture!("original-objstm"), fixture!("large-stamp")),
            Ok(IncrementInfo { added_pages: 0 })
        );
    }

    #[test]
    fn pdf_lib_yang_mengubah_isi_ditolak() {
        let original = fixture!("original-objstm");
        for (name, tampered) in [
            ("teks", fixture!("tampered-text")),
            ("persegi penutup", fixture!("tampered-cover")),
            ("MediaBox", fixture!("tampered-mediabox")),
            ("bidang terang", fixture!("tampered-whiteout")),
        ] {
            let err = check_increment(original, tampered).expect_err(name);
            assert_eq!(
                err.code, "version_changes_content",
                "{name}: {}",
                err.message
            );
        }
        // Tip-ex lewat pdf-lib sungguhan ditolak karena piksel putih legap.
        let err = check_increment(original, fixture!("tampered-whiteout")).unwrap_err();
        assert!(err.message.contains("bidang terang"), "{}", err.message);
    }

    #[test]
    fn info_gambar_dari_smask() {
        let mut doc = Document::with_version("1.7");
        let mut added = BTreeSet::new();
        let mut image_with = |decode: Option<Object>, rgb: Vec<u8>, alpha: Vec<u8>| {
            let mut d = dictionary! {
                "Type" => "XObject", "Subtype" => "Image",
                "Width" => 4, "Height" => 1, "BitsPerComponent" => 8, "ColorSpace" => "DeviceGray",
            };
            if let Some(decode) = decode {
                d.set("Decode", decode);
            }
            let mask = doc.add_object(Stream::new(d, alpha));
            added.insert(mask);
            Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image", "Width" => 4, "Height" => 1,
                    "BitsPerComponent" => 8, "ColorSpace" => "DeviceRGB", "SMask" => mask,
                },
                rgb,
            )
        };
        let dark = [20u8, 20, 20].repeat(4);
        let mut white_left = vec![255u8, 255, 255];
        white_left.extend([0u8; 9]);
        let plain = image_with(None, dark.clone(), vec![255, 0, 0, 0]);
        let identity = image_with(
            Some(vec![0.into(), 1.into()].into()),
            dark.clone(),
            vec![255, 255, 0, 0],
        );
        let inverted = image_with(
            Some(vec![1.into(), 0.into()].into()),
            dark.clone(),
            vec![0, 0, 0, 0],
        );
        let short = image_with(None, dark.clone(), vec![0]);
        let short_rgb = image_with(None, vec![0; 6], vec![0; 4]);
        let cover = image_with(None, white_left.clone(), vec![255, 0, 0, 0]);
        // Piksel terang tapi hampir transparan bukan penutup.
        let faint = image_with(None, white_left, vec![127, 0, 0, 0]);
        let (doc, added) = (doc, added);
        let info = |s: &Stream| image_info(&doc, &added, s);
        assert!((info(&plain).unwrap().mean_alpha - 0.25).abs() < 1e-9);
        assert_eq!(info(&plain).unwrap().cover_pixels, 0);
        assert!((info(&identity).unwrap().mean_alpha - 0.5).abs() < 1e-9);
        assert_eq!(info(&inverted).unwrap_err(), IMAGE_NO_MASK);
        assert_eq!(info(&short).unwrap_err(), IMAGE_FORMAT);
        assert_eq!(info(&short_rgb).unwrap_err(), IMAGE_FORMAT);
        assert_eq!(info(&cover).unwrap().cover_pixels, 1);
        assert_eq!(info(&faint).unwrap().cover_pixels, 0);
        assert_eq!(
            info(&Stream::new(dictionary! {}, vec![])).unwrap_err(),
            IMAGE_FORMAT
        );
        // SMask yang bukan objek baru tidak dipercaya.
        let mut doc2 = Document::with_version("1.7");
        let mask = doc2.add_object(Stream::new(
            dictionary! { "Width" => 1, "Height" => 1, "BitsPerComponent" => 8, "ColorSpace" => "DeviceGray" },
            vec![0],
        ));
        let img = Stream::new(
            dictionary! { "Width" => 1, "Height" => 1, "BitsPerComponent" => 8, "ColorSpace" => "DeviceRGB", "SMask" => mask },
            vec![0, 0, 0],
        );
        assert_eq!(
            image_info(&doc2, &BTreeSet::new(), &img).unwrap_err(),
            IMAGE_NO_MASK
        );
    }

    #[test]
    fn nomor_object_stream_lama_tidak_boleh_dipakai_ulang() {
        let old = fixture!("original-objstm");
        let text = String::from_utf8_lossy(old);
        let at = text.find("/Type /ObjStm").expect("ada object stream");
        let head = &text[..at];
        let obj = head.rfind(" 0 obj").expect("nomor objek");
        let start = head[..obj]
            .rfind(|c: char| !c.is_ascii_digit())
            .map_or(0, |i| i + 1);
        let container: u32 = head[start..obj].parse().unwrap();
        let mut inc = Increment::open(old);
        inc.stamp_page(0, TAG);
        inc.put(
            (container, 0),
            Object::Dictionary(dictionary! { "Type" => "Lain" }),
        );
        assert_eq!(code(old, &inc.finish()), "version_changes_content");
    }

    #[test]
    fn pdf_lib_ekor_dipotong_atau_diacak_tidak_lolos() {
        let old = fixture!("original-objstm");
        let new = fixture!("original-objstm-stamped1");
        let mut state = 0x9e37_79b9u32;
        for _ in 0..300 {
            state = state.wrapping_mul(1_103_515_245).wrapping_add(12345);
            let span = new.len() - old.len();
            let cut = old.len() + 1 + (state as usize % span);
            if !new[cut..].iter().all(|c| is_ws(*c)) {
                assert_ne!(code(old, &new[..cut]), "ok");
            }
            let mut flipped = new.to_vec();
            flipped[old.len() + (state as usize >> 3) % span] ^= 1 << (state % 8);
            let _ = check_increment(old, &flipped);
        }
    }

    fn with_pages(old: &[u8], new: &[u8], allow_new_pages: bool) -> &'static str {
        match check_increment_with(old, new, &IncrementRules { allow_new_pages }) {
            Ok(_) => "ok",
            Err(e) => e.code,
        }
    }

    fn with_image(old: &[u8], img: &TestImage, draw: &dyn Fn(&str, &str) -> String) -> Vec<u8> {
        let mut inc = Increment::open(old);
        inc.stamp_page_image(0, TAG, img, draw);
        inc.finish()
    }

    #[test]
    fn bidang_putih_lalu_angka_baru_di_atas_isi_lama_ditolak() {
        // Isi lama halaman 1: teks 18 pt di (72, 720). Penyerang menutupnya
        // dengan gambar kecil lalu menulis angka lain sebagai keterangan.
        let old = sample_pdf(1);
        let forge = |img: &str, font: &str| {
            format!(
                "q 200 0 0 24 70 714 cm /{img} Do Q\n\
                 q BT 0 0 0 rg /{font} 10 Tf 1 0 0 1 72 722 Tm (Rp 90.000.000) Tj ET Q\n"
            )
        };
        // Putih legap seluruhnya: terlalu legap.
        let white = TestImage::solid(8, 2, [255, 255, 255], Some(255));
        let err = check_increment(&old, &with_image(&old, &white, &forge)).unwrap_err();
        assert_eq!(err.code, "version_changes_content");
        assert!(err.message.contains("legap"), "{}", err.message);
        // Separuh putih legap, separuh transparan: rata-rata alpha 0,5 lolos
        // batas rata-rata, tetapi piksel putih legap menutup isi.
        let mut half = white.clone();
        half.alpha = Some([[255u8; 8], [0u8; 8]].concat());
        let err = check_increment(&old, &with_image(&old, &half, &forge)).unwrap_err();
        assert_eq!(err.code, "version_changes_content");
        assert!(err.message.contains("bidang terang"), "{}", err.message);
        // Abu-abu sangat muda juga dianggap penutup.
        let mut pale = half.clone();
        pale.rgb = [235u8, 235, 235].repeat(16);
        assert_eq!(
            code(&old, &with_image(&old, &pale, &forge)),
            "version_changes_content"
        );
        // Tanpa SMask sama sekali.
        let mut bare = TestImage::solid(8, 2, [255, 255, 255], None);
        bare.alpha = None;
        let err = check_increment(&old, &with_image(&old, &bare, &forge)).unwrap_err();
        assert!(err.message.contains("SMask"), "{}", err.message);
        // Tinta gelap yang sama di tempat yang sama tidak menutup apa pun:
        // stempel sah boleh menumpuk teks lama.
        let mut ink = half.clone();
        ink.rgb = [35u8, 29, 26].repeat(16);
        assert_eq!(code(&old, &with_image(&old, &ink, &forge)), "ok");
    }

    #[test]
    fn keterangan_dibatasi_jumlah_ukuran_dan_font() {
        let old = sample_pdf(1);
        let sixty = "A".repeat(60);
        let new = custom(&old, false, &|_, f| {
            format!("BT /{f} 6 Tf 1 0 0 1 72 300 Tm ({sixty}) Tj 0 -8 Td ({sixty}) Tj ET\n")
        });
        assert_eq!(code(&old, &new), "ok");
        // 121 huruf, dipecah lewat TJ.
        let new = custom(&old, false, &|_, f| {
            format!("BT /{f} 6 Tf 1 0 0 1 72 300 Tm [({sixty}) -10 ({sixty}) 5 (B)] TJ ET\n")
        });
        assert_eq!(code(&old, &new), "version_changes_content");
        // Banyak Tj kecil tetap dihitung bersama, juga lintas stream.
        let new = custom(&old, false, &|_, f| {
            let one = "(AB) Tj ".repeat(61);
            format!("BT /{f} 6 Tf 1 0 0 1 72 300 Tm {one} ET\n")
        });
        assert_eq!(code(&old, &new), "version_changes_content");
        // 12 pt boleh, 13 pt tidak.
        let new = custom(&old, false, &|_, f| {
            format!("BT /{f} 12 Tf 1 0 0 1 72 300 Tm (Nama) Tj ET\n")
        });
        assert_eq!(code(&old, &new), "ok");
        let new = custom(&old, false, &|_, f| {
            format!("BT /{f} 13 Tf 1 0 0 1 72 300 Tm (Nama) Tj ET\n")
        });
        assert_eq!(code(&old, &new), "version_changes_content");
        // Font standar selain Helvetica dan Courier (misalnya ZapfDingbats
        // yang punya kotak hitam penuh) ditolak di stempel.
        let mut inc = Increment::open(&old);
        let dingbats = inc.add(Object::Dictionary(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "ZapfDingbats",
        }));
        inc.stamp_page_with(0, TAG, false, &|_, _| {
            "BT /Z 10 Tf 1 0 0 1 72 300 Tm (nnnn) Tj ET\n".into()
        });
        let page = inc.page_ids()[0];
        let Object::Dictionary(mut d) = inc.current(page) else {
            panic!()
        };
        let Ok(Object::Dictionary(res)) = d.get_mut(b"Resources") else {
            panic!()
        };
        let Ok(Object::Dictionary(fonts)) = res.get_mut(b"Font") else {
            panic!()
        };
        fonts.set("Z", dingbats);
        inc.put(page, Object::Dictionary(d));
        let err = check_increment(&old, &inc.finish()).unwrap_err();
        assert!(
            err.message.contains("Helvetica atau Courier"),
            "{}",
            err.message
        );
    }

    #[test]
    fn tanda_yang_tersebar_jauh_ditolak() {
        let old = sample_pdf(1); // 612 x 792
        // Gambar di kiri bawah, keterangan di kanan atas.
        let new = custom(&old, false, &|img, f| {
            format!(
                "q 60 0 0 30 20 20 cm /{img} Do Q\n\
                 BT /{f} 8 Tf 1 0 0 1 500 760 Tm (Rina) Tj ET\n"
            )
        });
        let err = check_increment(&old, &new).unwrap_err();
        assert!(err.message.contains("tersebar"), "{}", err.message);
        // Dua gambar di dua sudut.
        let new = custom(&old, false, &|img, _| {
            format!("q 60 0 0 30 20 20 cm /{img} Do Q q 60 0 0 30 530 740 cm /{img} Do Q\n")
        });
        assert_eq!(code(&old, &new), "version_changes_content");
        // Teks dimulai dekat gambar lalu digeser jauh lewat TJ dan Ts.
        let new = custom(&old, false, &|img, f| {
            format!(
                "q 60 0 0 30 20 20 cm /{img} Do Q\n\
                 BT /{f} 8 Tf 700 Ts 1 0 0 1 20 10 Tm [(A) -70000 (B)] TJ ET\n"
            )
        });
        assert_eq!(code(&old, &new), "version_changes_content");
        // Td di antara dua Tj.
        let new = custom(&old, false, &|img, f| {
            format!(
                "q 60 0 0 30 20 20 cm /{img} Do Q\n\
                 BT /{f} 8 Tf 1 0 0 1 20 10 Tm (A) Tj 500 700 Td (B) Tj ET\n"
            )
        });
        assert_eq!(code(&old, &new), "version_changes_content");
        // Spasi huruf (Tc) yang melempar huruf berikutnya jauh.
        let new = custom(&old, false, &|img, f| {
            format!(
                "q 60 0 0 30 20 20 cm /{img} Do Q\n\
                 BT /{f} 8 Tf 5000 Tc 1 0 0 1 20 10 Tm (AB) Tj ET\n"
            )
        });
        assert_eq!(code(&old, &new), "version_changes_content");
        // Gambar dan keterangan berdekatan, kotak 300 x 150: boleh.
        let new = custom(&old, false, &|img, f| {
            format!(
                "q 300 0 0 150 150 120 cm /{img} Do Q\n\
                 BT /{f} 10 Tf 1 0 0 1 200 105 Tm (Rina Wulandari, 22 November 2026) Tj ET\n"
            )
        });
        assert_eq!(code(&old, &new), "ok");
    }

    #[test]
    fn halaman_baru_hanya_untuk_penanda_tangan_terakhir() {
        let old = sample_pdf(1);
        let mut inc = Increment::open(&old);
        inc.add_page("Halaman catatan tanda tangan");
        let with_page = inc.finish();
        assert_eq!(with_pages(&old, &with_page, true), "ok");
        assert_eq!(
            with_pages(&old, &with_page, false),
            "version_changes_content"
        );
        assert_eq!(with_pages(&old, &stamp(&old, TAG), false), "ok");
        assert_eq!(
            with_pages(&old, &stamp_with_audit_page(&old, TAG), false),
            "version_changes_content"
        );
    }

    #[test]
    fn isi_halaman_baru_hanya_teks_dan_garis() {
        let old = sample_pdf(1);
        let font = |inc: &mut Increment| {
            let f = inc.add(Object::Dictionary(dictionary! {
                "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica-Bold",
                "Encoding" => "WinAnsiEncoding",
            }));
            dictionary! { "Font" => dictionary! { "F1" => f } }
        };
        let page = |content: &str| {
            let mut inc = Increment::open(&old);
            let res = font(&mut inc);
            inc.add_page_raw(content, res, usize::MAX);
            inc.finish()
        };
        // Bentuk appendAuditPage: teks, TL, T*, garis tipis.
        let audit = "q BT 0.2 0.2 0.2 rg /F1 18 Tf 24 TL 1 0 0 1 56 767 Tm (Judul) Tj T* ET Q\n\
                     q 0.4 0.4 0.4 RG 0.8 w [] 0 d 56 600 m 56 600 m 539 600 l S Q\n";
        assert_eq!(code(&old, &page(audit)), "ok");
        for bad in [
            "0 0 595 842 re f\n",
            "1 1 1 rg 0 0 m 595 0 l 595 842 l f\n",
            "100 w 0 400 m 595 400 l S\n",
            "q 10 0 0 10 0 0 cm 0.8 w 0 40 m 59 40 l S Q\n",
            "q 595 0 0 842 0 0 cm /Im Do Q\n",
            "BT /F1 40 Tf 1 0 0 1 56 700 Tm (Besar) Tj ET\n",
            "BT /F1 10 Tf 2 Tr 1 0 0 1 56 700 Tm (Garis) Tj ET\n",
            "0 0 m 10 10 l\n",
            "/GS gs\n",
            "0 0 m 10 10 c S\n",
        ] {
            assert_eq!(code(&old, &page(bad)), "version_changes_content", "{bad}");
        }
        let many: String = (0..=MAX_NEW_PAGE_LINES)
            .map(|i| format!("56 {i} m 539 {i} l S\n"))
            .collect();
        assert_eq!(code(&old, &page(&many)), "version_changes_content");

        // Gambar di halaman baru, dengan XObject di sumber dayanya.
        let mut inc = Increment::open(&old);
        let img = inc.add(Object::Stream(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
                "BitsPerComponent" => 8, "ColorSpace" => "DeviceRGB",
            },
            vec![0, 0, 0],
        )));
        inc.add_page_raw(
            "q 595 0 0 842 0 0 cm /Im Do Q\n",
            dictionary! { "XObject" => dictionary! { "Im" => img } },
            usize::MAX,
        );
        let err = check_increment(&old, &inc.finish()).unwrap_err();
        assert_eq!(err.code, "version_changes_content");
        assert!(err.message.contains("halaman baru"), "{}", err.message);
    }

    #[test]
    fn jumlah_xref_raksasa_tidak_panik() {
        let old = sample_pdf(1);
        let new = stamp(&old, TAG);
        let text = String::from_utf8_lossy(&new).into_owned();
        let xref_at = text.rfind("\nxref\n").unwrap() + 1;
        for header in [
            "0 99999999999999999999999\n",
            "0 18446744073709551615\n",
            "18446744073709551615 3\n",
            "4294967295 2\n",
            "0 100001\n",
            "99999999999999999999 1\n",
        ] {
            let mut bad = new[..xref_at].to_vec();
            bad.extend_from_slice(
                text[xref_at..]
                    .replacen("xref\n", &format!("xref\n{header}"), 1)
                    .as_bytes(),
            );
            assert_ne!(code(&old, &bad), "ok", "{header}");
        }
    }

    #[test]
    fn batas_sumber_daya_ditolak_sebagai_pdf_invalid() {
        let old = sample_pdf(2);
        let new = stamp(&old, TAG);
        let rules = IncrementRules {
            allow_new_pages: true,
        };
        assert!(check_with_caps(&old, &new, &rules, Caps::DEFAULT).is_ok());
        for caps in [
            Caps {
                objects: 10,
                ..Caps::DEFAULT
            },
            Caps {
                loaded: 200,
                ..Caps::DEFAULT
            },
            Caps {
                decoded: 10,
                ..Caps::DEFAULT
            },
        ] {
            let err = check_with_caps(&old, &new, &rules, caps).unwrap_err();
            assert_eq!(err.code, "pdf_invalid", "{caps:?}: {}", err.message);
        }
        // Anggaran penuh lagi untuk pemeriksaan berikutnya.
        assert_eq!(code(&old, &new), "ok");
    }

    /// `pdf` dengan satu perubahan di kamus halaman pertama (disimpan ulang
    /// utuh oleh lopdf, jadi menjadi "versi lama" baru).
    fn with_first_page(pdf: &[u8], edit: impl FnOnce(&mut Document, ObjectId)) -> Vec<u8> {
        let mut doc = Document::load_mem(pdf).unwrap();
        let page = *doc.get_pages().get(&1).unwrap();
        edit(&mut doc, page);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    fn add_xobject(doc: &mut Document, page: ObjectId, name: &str, stream: Stream) {
        let id = doc.add_object(stream);
        let res = doc
            .get_dictionary_mut(page)
            .unwrap()
            .get_mut(b"Resources")
            .unwrap()
            .as_dict_mut()
            .unwrap();
        res.set("XObject", dictionary! { name => id });
    }

    #[test]
    fn gambar_lama_yang_tidak_bisa_dibuka_tidak_menolak_stempel() {
        // Pindaian dan foto (DCTDecode, JBIG2, CCITT, JPX) tidak bisa dibuka
        // lopdf dan tidak memakai nama sumber daya, jadi tidak ikut dipindai.
        for filter in ["DCTDecode", "JBIG2Decode", "CCITTFaxDecode", "JPXDecode"] {
            let old = with_first_page(&sample_pdf(2), |doc, page| {
                let image = Stream::new(
                    dictionary! {
                        "Type" => "XObject",
                        "Subtype" => "Image",
                        "Width" => 4,
                        "Height" => 4,
                        "ColorSpace" => "DeviceGray",
                        "BitsPerComponent" => 8,
                        "Filter" => filter,
                    },
                    b"\xff\xd8 bukan data gambar yang bisa dibuka".to_vec(),
                );
                add_xobject(doc, page, "Im0", image);
            });
            assert_eq!(code(&old, &stamp(&old, TAG)), "ok", "{filter}");
        }
    }

    #[test]
    fn isi_lama_yang_tidak_bisa_dibuka_ditolak_sebagai_pdf_invalid() {
        // Form XObject tanpa Resources memakai sumber daya halaman, jadi harus
        // dipindai. Kalau tidak bisa dibuka, versi baru tetap ditolak, tetapi
        // bukan dengan kode perubahan isi.
        let old = with_first_page(&sample_pdf(2), |doc, page| {
            let form = Stream::new(
                dictionary! {
                    "Type" => "XObject",
                    "Subtype" => "Form",
                    "BBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
                    "Filter" => "JBIG2Decode",
                },
                b"tidak bisa dibuka".to_vec(),
            );
            add_xobject(doc, page, "Fm0", form);
        });
        let err = check_increment(&old, &stamp(&old, TAG)).unwrap_err();
        assert_eq!(err.code, "pdf_invalid", "{}", err.message);
        assert!(
            err.message.contains("bukan tanda isi dokumen diubah"),
            "{}",
            err.message
        );
    }

    #[test]
    fn aksi_lama_di_halaman_yang_distempel_tidak_dihitung_menambah() {
        let old = with_first_page(&sample_pdf(2), |doc, page| {
            let d = doc.get_dictionary_mut(page).unwrap();
            d.set(
                "AA",
                dictionary! { "O" => dictionary! { "S" => "GoTo", "D" => vec![Object::Reference(page), "Fit".into()] } },
            );
            d.set(
                "Annots",
                vec![Object::Dictionary(dictionary! {
                    "Type" => "Annot",
                    "Subtype" => "Link",
                    "Rect" => vec![72.into(), 700.into(), 200.into(), 720.into()],
                    "A" => dictionary! { "S" => "URI", "URI" => Object::string_literal("https://example.com/") },
                })],
            );
        });
        assert_eq!(code(&old, &stamp(&old, TAG)), "ok");

        // Aksi halaman yang diganti tetap ditolak.
        let mut inc = Increment::open(&old);
        let page = inc.page_ids()[0];
        let Object::Dictionary(mut d) = inc.current(page) else {
            panic!("halaman bukan kamus")
        };
        d.set(
            "AA",
            dictionary! { "O" => dictionary! { "S" => "JavaScript", "JS" => Object::string_literal("app.alert(1)") } },
        );
        inc.put(page, Object::Dictionary(d));
        inc.stamp_page(0, TAG);
        assert_eq!(code(&old, &inc.finish()), "version_changes_content");

        // Alamat tautan lama yang diganti juga ditolak.
        let mut inc = Increment::open(&old);
        let Object::Dictionary(mut d) = inc.current(page) else {
            panic!("halaman bukan kamus")
        };
        let Ok(Object::Array(annots)) = d.get_mut(b"Annots") else {
            panic!("Annots bukan larik")
        };
        let Some(Object::Dictionary(link)) = annots.first_mut() else {
            panic!("tautan tidak ada")
        };
        link.set(
            "A",
            dictionary! { "S" => "URI", "URI" => Object::string_literal("https://contoh.invalid/") },
        );
        inc.put(page, Object::Dictionary(d));
        inc.stamp_page(0, TAG);
        assert_eq!(code(&old, &inc.finish()), "version_changes_content");
    }

    // Fixture "dunia nyata" (`npm run fixtures:sign-real`): PDF cetak Chrome
    // berfoto JPEG, pindaian, tiruan Word (hybrid xref, bertag), linearized,
    // incremental update lama, AcroForm, /Contents larik, Resources warisan,
    // /AA halaman, anotasi langsung. Dibaca saat tes berjalan supaya fixture
    // baru ikut teruji tanpa mengubah kode.
    fn real_dir() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sign/real")
    }

    fn real_files(filter: impl Fn(&str) -> bool) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(real_dir())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| filter(n))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn pdf_dunia_nyata_dua_penanda_tangan_dan_halaman_catatan_lolos() {
        let chains = real_files(|n| n.ends_with(".signed.txt"));
        assert!(chains.len() >= 11, "fixture kurang: {chains:?}");
        for txt in chains {
            let name = txt.trim_end_matches(".signed.txt");
            let lens: Vec<usize> = std::fs::read_to_string(real_dir().join(&txt))
                .unwrap()
                .split_whitespace()
                .map(|n| n.parse().unwrap())
                .collect();
            let signed = std::fs::read(real_dir().join(format!("{name}.signed.pdf"))).unwrap();
            let original = std::fs::read(real_dir().join(format!("{name}.pdf"))).unwrap();
            assert_eq!(lens.len(), 4, "{name}");
            assert_eq!(lens[3], signed.len(), "{name}");
            assert_eq!(&signed[..lens[0]], original.as_slice(), "{name}");
            // Penanda tangan pertama dan kedua (tanpa halaman baru), lalu
            // penanda tangan terakhir dengan halaman catatan.
            for (step, w) in lens.windows(2).enumerate() {
                let last = step == 2;
                let rules = IncrementRules {
                    allow_new_pages: last,
                };
                match check_increment_with(&signed[..w[0]], &signed[..w[1]], &rules) {
                    Ok(info) => {
                        assert_eq!(info.added_pages, usize::from(last), "{name} langkah {step}");
                    }
                    Err(e) => panic!("{name} langkah {step}: {} {}", e.code, e.message),
                }
            }
            // Dua stempel sekaligus juga lolos.
            assert_eq!(code(&signed[..lens[0]], &signed[..lens[2]]), "ok", "{name}");
        }
    }

    #[test]
    fn pdf_dunia_nyata_yang_isinya_diubah_tetap_ditolak() {
        let tampered = real_files(|n| n.starts_with("tamper-") && n.ends_with(".pdf"));
        let kinds: Vec<&str> = tampered
            .iter()
            .map(|n| n.split('.').next().unwrap())
            .collect();
        for kind in [
            "tamper-content-stream",
            "tamper-remove-page",
            "tamper-replace-image",
            "tamper-remap-image",
            "tamper-form-value",
            "tamper-mediabox",
            "tamper-annot-uri",
            "tamper-page-aa",
        ] {
            assert!(kinds.contains(&kind), "fixture {kind} tidak ada");
        }
        for file in tampered {
            let base = file.split('.').nth(1).unwrap();
            let old = std::fs::read(real_dir().join(format!("{base}.pdf"))).unwrap();
            let new = std::fs::read(real_dir().join(&file)).unwrap();
            assert!(new.starts_with(&old), "{file}");
            assert_eq!(code(&old, &new), "version_changes_content", "{file}");
        }
    }
}
