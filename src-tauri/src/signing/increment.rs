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
//!   (lihat [`check_stamp_ops`]). Larik `/Contents` tidak langsung milik
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
//!   banyak [`MAX_ADDED_PAGES`]). Isinya bebas.
//! - Tidak ada aksi aktif (`/JS`, `/JavaScript`, `/AA`, `/OpenAction`,
//!   `/Launch`, `/EmbeddedFile(s)`, `/URI`, `/SubmitForm`, ...) di objek
//!   baru atau berubah.

use std::collections::{BTreeMap, BTreeSet, HashSet};

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
/// Batas ukuran huruf efektif teks stempel (keterangan memakai 6 sampai 10 pt).
pub const MAX_FONT_SIZE: f64 = 24.0;
/// Batas jumlah karakter teks stempel per halaman per versi.
pub const MAX_GLYPHS_PER_PAGE: usize = 400;
/// Batas halaman baru per versi. Halaman catatan untuk 20 penanda tangan
/// (batas `request::MAX_SIGNERS`) dengan nama panjang bisa lebih dari satu
/// halaman.
pub const MAX_ADDED_PAGES: usize = 10;

const MAX_SECTIONS: usize = 16;
const MAX_XREF_ENTRIES: usize = 100_000;
const MAX_DECODED_STREAM: usize = 32 * 1024 * 1024;
const MAX_SCAN_BYTES: usize = 256 * 1024 * 1024;
const MAX_DEPTH: usize = 64;
const MAX_GSTATE_STACK: usize = 4096;
/// Toleransi pembulatan untuk batas luas dan ukuran.
const EPS: f64 = 1e-6;

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

fn invalid(detail: impl AsRef<str>) -> IncrementError {
    IncrementError {
        code: "pdf_invalid",
        message: format!("PDF versi baru tidak bisa diperiksa ({}).", detail.as_ref()),
    }
}

type Res<T> = Result<T, IncrementError>;

/// Memeriksa bahwa `new` = `old` + incremental update yang hanya menambah
/// stempel. Murni (tanpa IO); pemanggil menyimpan hasilnya.
pub fn check_increment(old: &[u8], new: &[u8]) -> Result<IncrementInfo, IncrementError> {
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

    Checker::new(&old_doc, &new_doc)?.run()
}

// ---------------------------------------------------------------------------
// Pemuatan dan struktur incremental update

fn load(bytes: &[u8]) -> Result<Document, String> {
    let options = LoadOptions {
        max_decompressed_size: Some(MAX_DECODED_STREAM),
        ..Default::default()
    };
    let doc = Document::load_mem_with_options(bytes, options).map_err(|e| e.to_string())?;
    if doc.xref_recovery.is_some() {
        return Err("tabel xref rusak".into());
    }
    if doc.encryption_state.is_some() || doc.trailer.has(b"Encrypt") {
        return Err("PDF terenkripsi".into());
    }
    Ok(doc)
}

fn stream_length_exact(s: &Stream) -> bool {
    matches!(s.dict.get(b"Length"), Ok(Object::Integer(n)) if *n >= 0 && *n as usize == s.content.len())
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
    loop {
        if x == old_startxref {
            break;
        }
        if x < old_len || x >= limit || list.len() >= MAX_SECTIONS {
            return Err(not_prefix());
        }
        let (section_entries, trailer) = parse_xref_table(new, x)?;
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
                if start < 0.0 || count < 0.0 || out.len() + count as usize > MAX_XREF_ENTRIES {
                    return Err(bad());
                }
                for k in 0..count as u64 {
                    let id = u32::try_from(start as u64 + k).map_err(|_| bad())?;
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
                    if !(0.0..=65535.0).contains(&g) || off < 0.0 {
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
}

impl<'a> Checker<'a> {
    fn new(old: &'a Document, new: &'a Document) -> Res<Self> {
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
        })
    }

    fn run(mut self) -> Res<IncrementInfo> {
        // Aksi aktif di objek baru atau berubah.
        for id in self.added.iter().chain(self.changed.iter()) {
            if let Some(obj) = self.new.objects.get(id) {
                check_no_active(obj, 0)?;
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
                .ok_or_else(|| changes(format!("ukuran halaman {number} tidak terbaca")))?;
            let mut stamp = StampCheck {
                doc: self.new,
                added: &self.added,
                resources,
                page_area,
                ink: 0.0,
                glyphs: 0,
                number,
            };
            for r in suffix {
                let bytes = self.stamp_stream(*r, number)?;
                stamp.check_stream(&bytes, &mut sim)?;
            }
        }
        self.covered.insert(id);
        Ok(())
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
        let filters_ok = match s.dict.get(b"Filter") {
            Err(_) => true,
            Ok(Object::Name(n)) => n == b"FlateDecode",
            Ok(Object::Array(a)) => a
                .iter()
                .all(|f| matches!(f, Object::Name(n) if n == b"FlateDecode")),
            _ => false,
        };
        if !filters_ok || s.dict.has(b"DecodeParms") || s.dict.has(b"F") {
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
            for (_, v) in category(b"XObject").map(|d| d.iter()).into_iter().flatten() {
                if let Object::Reference(r) = v
                    && let Some(Object::Stream(s)) = self.old.objects.get(r)
                    && !s.dict.has(b"Resources")
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
            let bytes = decode(s)
                .map_err(|_| changes(format!("isi lama halaman {number} tidak bisa diperiksa")))?;
            budget = budget.checked_sub(bytes.len()).ok_or_else(|| {
                changes(format!(
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

fn decode(s: &Stream) -> Result<Vec<u8>, ()> {
    if s.dict.has(b"F") {
        return Err(());
    }
    s.decompressed_content_with_limit(MAX_DECODED_STREAM)
        .map_err(|_| ())
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

fn check_no_active(obj: &Object, depth: usize) -> Res<()> {
    if depth > MAX_DEPTH {
        return Err(changes("objek terlalu dalam"));
    }
    match obj {
        Object::Array(a) => a.iter().try_for_each(|o| check_no_active(o, depth + 1)),
        Object::Dictionary(d) => check_dict_active(d, depth),
        Object::Stream(s) => check_dict_active(&s.dict, depth),
        _ => Ok(()),
    }
}

fn check_dict_active(d: &Dictionary, depth: usize) -> Res<()> {
    for (k, v) in d.iter() {
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
        check_no_active(v, depth + 1)?;
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

#[derive(Clone)]
struct GState {
    ctm: Mat,
    font_size: f64,
    /// Font dipilih lewat `Tf` yang sudah diperiksa (bukan bocoran isi lama).
    font_ok: bool,
    h_scale: f64,
    rise: f64,
    leading: f64,
    render: i64,
}

/// Simulasi keadaan grafis secukupnya: matriks, keadaan teks.
struct Sim {
    gs: GState,
    stack: Vec<GState>,
    tm: Mat,
    tlm: Mat,
    in_text: bool,
}

impl Sim {
    fn new() -> Self {
        Self {
            gs: GState {
                ctm: IDENTITY,
                font_size: 0.0,
                font_ok: false,
                h_scale: 1.0,
                rise: 0.0,
                leading: 0.0,
                render: 0,
            },
            stack: Vec::new(),
            tm: IDENTITY,
            tlm: IDENTITY,
            in_text: false,
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
                self.tm = IDENTITY;
                self.tlm = IDENTITY;
            }
            b"ET" => self.in_text = false,
            b"Tf" => {
                if let Some(s) = nums.last() {
                    self.gs.font_size = *s;
                }
                self.gs.font_ok = false;
            }
            b"Tz" if nums.len() == 1 => self.gs.h_scale = nums[0] / 100.0,
            b"Ts" if nums.len() == 1 => self.gs.rise = nums[0],
            b"TL" if nums.len() == 1 => self.gs.leading = nums[0],
            b"Tr" if nums.len() == 1 => self.gs.render = nums[0] as i64,
            b"Tm" if nums.len() == 6 => {
                self.tm = [nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]];
                self.tlm = self.tm;
            }
            b"Td" if nums.len() == 2 => self.td(nums[0], nums[1]),
            b"TD" if nums.len() == 2 => {
                self.gs.leading = -nums[1];
                self.td(nums[0], nums[1]);
            }
            b"T*" | b"'" | b"\"" => self.td(0.0, -self.gs.leading),
            _ => {}
        }
    }

    fn td(&mut self, tx: f64, ty: f64) {
        self.tlm = mul(&[1.0, 0.0, 0.0, 1.0, tx, ty], &self.tlm);
        self.tm = self.tlm;
    }
}

struct StampCheck<'d> {
    doc: &'d Document,
    added: &'d BTreeSet<ObjectId>,
    resources: Option<&'d Dictionary>,
    page_area: f64,
    ink: f64,
    glyphs: usize,
    number: usize,
}

impl StampCheck<'_> {
    fn err(&self, what: &str) -> IncrementError {
        changes(format!("stempel halaman {} {what}", self.number))
    }

    fn resource(&self, category: &[u8], name: &[u8]) -> Option<(ObjectId, &Object)> {
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

    fn check_op(&mut self, op: &[u8], args: &[Operand], sim: &mut Sim) -> Res<()> {
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
            b"cm" => {
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
            b"Do" => {
                text_only(false)?;
                let [Operand::Name(name)] = args else {
                    return Err(self.err("berisi operand tidak sah"));
                };
                self.check_image(name, &sim.gs.ctm)?;
            }
            b"Tf" => {
                let [Operand::Name(name), Operand::Num(size)] = args else {
                    return Err(self.err("berisi operand tidak sah"));
                };
                if !size.is_finite() {
                    return Err(self.err("berisi operand tidak sah"));
                }
                self.check_font(name)?;
                sim.op(op, args);
                sim.gs.font_ok = true;
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
                let text = match (op, args) {
                    (b"\"", [Operand::Num(_), Operand::Num(_), Operand::Str(s)]) => s.len(),
                    (b"Tj" | b"'", [Operand::Str(s)]) => s.len(),
                    _ => return Err(self.err("berisi operand tidak sah")),
                };
                sim.op(op, args);
                self.show_text(text, sim)?;
            }
            b"TJ" => {
                text_only(true)?;
                let [Operand::Array(items)] = args else {
                    return Err(self.err("berisi operand tidak sah"));
                };
                let mut len = 0;
                for item in items {
                    match item {
                        Operand::Str(s) => len += s.len(),
                        Operand::Num(n) if n.is_finite() => {}
                        _ => return Err(self.err("berisi operand tidak sah")),
                    }
                }
                self.show_text(len, sim)?;
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
            b"gs" => {
                let [Operand::Name(name)] = args else {
                    return Err(self.err("berisi operand tidak sah"));
                };
                self.check_ext_gstate(name)?;
            }
            _ => return Err(self.err("memakai operator terlarang")),
        }
        Ok(())
    }

    fn show_text(&mut self, len: usize, sim: &Sim) -> Res<()> {
        if !sim.gs.font_ok {
            return Err(self.err("memakai font yang tidak diperiksa"));
        }
        if !matches!(sim.gs.render, 0 | 3 | 4 | 7) {
            return Err(self.err("memakai mode teks terlarang"));
        }
        self.glyphs = self.glyphs.saturating_add(len);
        if self.glyphs > MAX_GLYPHS_PER_PAGE {
            return Err(self.err("berisi teks terlalu panjang"));
        }
        let m = mul(&sim.tm, &sim.gs.ctm);
        let fs = sim.gs.font_size.abs();
        let x = fs * sim.gs.h_scale.abs() * m[0].hypot(m[1]);
        let y = fs * m[2].hypot(m[3]);
        if !(x.is_finite() && y.is_finite()) || x > MAX_FONT_SIZE + EPS || y > MAX_FONT_SIZE + EPS {
            return Err(self.err("memakai huruf terlalu besar"));
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
        self.ink += area * opacity(self.doc, s);
        if self.ink > self.page_area * MAX_IMAGE_INK_FRACTION + EPS {
            return Err(self.err("menutup terlalu banyak bagian halaman"));
        }
        Ok(())
    }

    fn check_font(&self, name: &[u8]) -> Res<()> {
        let (_, obj) = self
            .resource(b"Font", name)
            .ok_or_else(|| self.err("memakai font yang tidak ada"))?;
        let Object::Dictionary(d) = obj else {
            return Err(self.err("memakai font tidak sah"));
        };
        let standard = matches!(d.get(b"Subtype"), Ok(Object::Name(n)) if n == b"Type1")
            && matches!(d.get(b"BaseFont"), Ok(Object::Name(n)) if STANDARD_FONTS.contains(&n.as_slice()))
            && d.iter().all(|(k, v)| match k.as_slice() {
                b"Type" | b"Subtype" | b"BaseFont" | b"Name" => true,
                b"Encoding" => matches!(v, Object::Name(_)),
                _ => false,
            });
        if standard {
            Ok(())
        } else {
            Err(self.err("memakai font selain font standar"))
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

/// Rata-rata kelegapan gambar (0 sampai 1) dari SMask 8 bit abu-abu. Tanpa
/// SMask yang bisa dibaca, gambar dianggap legap penuh.
fn opacity(doc: &Document, image: &Stream) -> f64 {
    let Ok(Object::Reference(mask_id)) = image.dict.get(b"SMask") else {
        return 1.0;
    };
    let Some(Object::Stream(mask)) = doc.objects.get(mask_id) else {
        return 1.0;
    };
    let int = |k: &[u8]| match mask.dict.get(k) {
        Ok(Object::Integer(n)) => Some(*n),
        _ => None,
    };
    let gray = matches!(mask.dict.get(b"ColorSpace"), Ok(Object::Name(n)) if n == b"DeviceGray");
    // pdf-lib menulis /Decode [0 1] (identitas); Decode lain bisa membalik alpha.
    let identity_decode = match mask.dict.get(b"Decode") {
        Err(_) => true,
        Ok(Object::Array(d)) => d.len() == 2 && num(&d[0]) == Some(0.0) && num(&d[1]) == Some(1.0),
        Ok(_) => false,
    };
    if !gray || int(b"BitsPerComponent") != Some(8) || !identity_decode || mask.dict.has(b"Matte") {
        return 1.0;
    }
    let (Some(w), Some(h)) = (int(b"Width"), int(b"Height")) else {
        return 1.0;
    };
    let Some(pixels) = usize::try_from(w)
        .ok()
        .zip(usize::try_from(h).ok())
        .and_then(|(w, h)| w.checked_mul(h))
    else {
        return 1.0;
    };
    match decode(mask) {
        Ok(alpha) if pixels > 0 && alpha.len() >= pixels => {
            let sum: u64 = alpha[..pixels].iter().map(|&a| u64::from(a)).sum();
            sum as f64 / (pixels as f64 * 255.0)
        }
        _ => 1.0,
    }
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

        fn add(&mut self, obj: Object) -> ObjectId {
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

        fn current(&self, id: ObjectId) -> Object {
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
            let smask = self.add(Object::Stream(Stream::new(
                lopdf::dictionary! {
                    "Type" => "XObject", "Subtype" => "Image", "Width" => 2, "Height" => 1,
                    "BitsPerComponent" => 8, "ColorSpace" => "DeviceGray",
                    "Decode" => vec![0.into(), 1.into()],
                },
                vec![255, 0],
            )));
            let mut image_dict = lopdf::dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => 2, "Height" => 1,
                "BitsPerComponent" => 8, "ColorSpace" => "DeviceRGB",
            };
            if !opaque {
                image_dict.set("SMask", smask);
            }
            let image = self.add(Object::Stream(Stream::new(
                image_dict,
                vec![255, 0, 0, 0, 0, 0],
            )));
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
            let font = self.add(Object::Dictionary(lopdf::dictionary! {
                "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
            }));
            let content =
                format!("0 0 0 RG 56 700 m 539 700 l S\nBT /F1 18 Tf 56 760 Td ({text}) Tj ET\n");
            let content = self.add(Object::Stream(Stream::new(
                Dictionary::new(),
                content.into_bytes(),
            )));
            let page = self.add(Object::Dictionary(lopdf::dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 595.28.into(), 841.89.into()],
                "Contents" => content,
                "Resources" => lopdf::dictionary! { "Font" => lopdf::dictionary! { "F1" => font } },
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
    use super::testing::{Increment, sample_pdf, stamp, stamp_with_audit_page, tamper};
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
        // Gambar legap kecil boleh (20% halaman).
        let new = custom(&old, true, &|img, _| {
            format!("q 306 0 0 316 0 0 cm /{img} Do Q\n")
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
        // Gambar PNG pdf-lib (SMask dengan /Decode [0 1]) seluas 50% halaman,
        // tinta jauh di bawah batas.
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
        ] {
            let err = check_increment(original, tampered).expect_err(name);
            assert_eq!(
                err.code, "version_changes_content",
                "{name}: {}",
                err.message
            );
        }
    }

    #[test]
    fn kelegapan_dari_smask() {
        let mut doc = Document::with_version("1.7");
        let mut image_with = |decode: Option<Object>, alpha: Vec<u8>| {
            let mut d = dictionary! {
                "Width" => 4, "Height" => 1, "BitsPerComponent" => 8, "ColorSpace" => "DeviceGray",
            };
            if let Some(decode) = decode {
                d.set("Decode", decode);
            }
            let mask = doc.add_object(Stream::new(d, alpha));
            Stream::new(
                dictionary! { "Subtype" => "Image", "SMask" => mask },
                vec![],
            )
        };
        let plain = image_with(None, vec![255, 0, 0, 0]);
        let identity = image_with(Some(vec![0.into(), 1.into()].into()), vec![255, 255, 0, 0]);
        let inverted = image_with(Some(vec![1.into(), 0.into()].into()), vec![0, 0, 0, 0]);
        let short = image_with(None, vec![0]);
        assert!((opacity(&doc, &plain) - 0.25).abs() < 1e-9);
        assert!((opacity(&doc, &identity) - 0.5).abs() < 1e-9);
        assert_eq!(opacity(&doc, &inverted), 1.0);
        assert_eq!(opacity(&doc, &short), 1.0);
        assert_eq!(opacity(&doc, &Stream::new(dictionary! {}, vec![])), 1.0);
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
}
