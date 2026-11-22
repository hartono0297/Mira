# Laporan Tahap 5 bagian lokal: Tanda tangan PDF

Tanggal: 22 November 2026. Branch: `claude/tahap-5-ttd-lokal-5fbb29`, dibuat dari `8d2023a`. Rencana: `docs/plans/tahap-5-lokal.md`.

## Ringkasan

Tanda tangan PDF sudah bisa dipakai penuh di satu laptop. Alurnya: buat tanda tangan, buka PDF, tempatkan tanda tangan dengan mouse atau keyboard, masukkan PIN, lalu simpan PDF bertanda tangan. Mira mengunci hasilnya dan langsung memberi peringatan kalau satu karakter saja di file itu berubah.

Hasil uji:
- 298 tes Rust lulus.
- 288 tes Vitest lulus.
- 15 dari 15 pemeriksaan uji ujung ke ujung lulus di aplikasi sungguhan.

Semua sudah di-commit di branch ini, tanpa push dan tanpa merge.

Belum termasuk: mengirim permintaan dan file ke laptop rekan, karena itu butuh jaringan. Titik sambungnya sudah disiapkan (lihat bagian "Titik sambung jaringan").

## Yang dibuat

**Tanda tangan tersimpan (F-SIGN-01)**
- Tanda tangan dibuat dengan menggambar (mouse, pena dengan tekanan, atau layar sentuh), atau dengan mengimpor foto atau hasil pindai. Latar putih pada gambar impor dibuang otomatis.
- Gambar disimpan terenkripsi dan hanya bisa dipakai dengan PIN 6 sampai 12 angka. PIN diminta setiap kali menandatangani.
- Batas percobaan:
  - 5 kali salah: terkunci 1 menit.
  - 10 kali salah: terkunci 5 menit.
  - 15 kali salah: terkunci 15 menit.
  - Setelah itu: terkunci 60 menit setiap 5 kesalahan.
  - PIN benar mereset hitungan.
- Menghapus tanda tangan ada dua jalan:
  - Dengan PIN lama: tanda tangan baru langsung bisa dipakai.
  - Lewat "Lupa PIN?" (tanpa PIN): tanda tangan baru baru bisa dipakai 24 jam kemudian.

**Penampil PDF yang bisa dipakai ulang** (`src/components/pdf/`)
- pdf.js 6.5.438. Worker, font, cMap, dan wasm dibundel di aplikasi, jadi tetap jalan tanpa internet.
- Bisa pindah halaman, zoom, dan "Sesuai lebar", dengan keadaan memuat dan error.
- `PlacementBox`: kotak yang bisa digeser dan diubah ukurannya dengan mouse atau keyboard.
  - Panah memindah kotak; Shift+panah memindah lebih jauh.
  - Alt+panah atau plus/minus mengubah ukuran.
- `coords.ts` mengubah koordinat layar ke koordinat PDF, termasuk halaman berotasi dan halaman dengan offset. Hasilnya dicocokkan dengan pdf.js asli.
- Tahap 4 bisa memakai komponen ini untuk komentar, stabilo, dan kotak teks.

**Menandatangani (F-SIGN-03, F-SIGN-05)**
- Kotak tanda tangan ditempatkan dulu, lalu PIN dimasukkan.
- Untuk pemakai keyboard ada tombol posisi cepat (Kiri bawah, Tengah bawah, Kanan bawah) serta Kecilkan dan Besarkan.
- Stempel ditulis dengan pdf-lib 1.17.1: gambar tanda tangan, lalu nama dan waktu di bawahnya, misalnya "22 November 2026, 14.46 WIB". Stempel tetap tegak di halaman berotasi.
- Penanda tangan terakhir menambahkan halaman catatan di akhir dokumen, berisi:
  - nama dokumen, kode dokumen, dan sidik file asli;
  - mode urutan;
  - tabel penanda tangan (nama, Anggota atau Tamu, waktu, sidik jari kunci laptop);
  - keterangan jujur bahwa ini tanda tangan visual, bukan sertifikat.

**Penguncian dan deteksi perubahan (F-SIGN-04)**
- Setiap versi dihitung hash BLAKE3-nya. Setiap kejadian dicatat di jejak audit dan ditandatangani kunci laptop (Ed25519): dibuat, ditandatangani, selesai, dibatalkan, salinan disimpan, tanda tangan dibuat, tanda tangan dihapus.
- Dokumen yang selesai dianggap terkunci hanya kalau rantai catatannya utuh dari file asli sampai versi akhir.
- Peringatan muncul di daftar dan di layar dokumen kalau:
  - file di penyimpanan Mira berubah, atau
  - salinan yang disimpan lewat "Simpan salinan PDF" berubah.
- Mira memeriksa ulang setiap kali daftar dimuat dan setiap kali jendela Mira kembali aktif.
- "Periksa file PDF" mencocokkan file mana pun dan memberi salah satu dari empat hasil:
  - asli (sama dengan versi final);
  - sama dengan salah satu versi tengah;
  - berubah setelah ditandatangani;
  - tidak dikenal.

**Permintaan tanda tangan (F-SIGN-02)**
- Pengirim memilih penanda tangan dari daftar anggota organisasi dan mengatur urutannya dengan tombol Naikkan/Turunkan.
- Mode bisa berurutan atau bebas.
- Status setiap orang tercatat: menunggu, giliran, atau sudah.
- Aturan Tamu:
  - Tamu boleh menandatangani kalau ada di daftar.
  - Tamu tidak bisa meminta tanda tangan; inti Rust menolaknya.
- Nama dan peran penanda tangan diambil dari tabel anggota, bukan dari tampilan.
- Permintaan bisa dibatalkan oleh pengirimnya.

**Layar**
- Menu baru "Tanda tangan" di sidebar.
- Daftar dokumen: "Giliran Anda" di atas, peringatan menonjol.
- Bagian "Tanda tangan saya".
- Dialog permintaan baru, dialog Periksa file PDF, dan layar dokumen. Layar dokumen berisi penampil di kiri; di kanan: urutan penanda tangan, tombol menandatangani, keaslian file, salinan PDF, dan jejak audit.

## Keputusan yang saya ambil sendiri

| Keputusan | Alasan |
|---|---|
| Kunci gambar tanda tangan = Argon2id(PIN, garam acak; 64 MiB, 3 putaran) digabung dengan "pepper" dari kunci laptop, lalu BLAKE3. Gambar dienkripsi XChaCha20-Poly1305. | PIN tidak pernah disimpan. Mencuri `mira.db` saja tidak cukup untuk menebak PIN di komputer lain, karena pepper butuh kunci laptop di Windows Credential Manager. |
| PIN 6 sampai 12 angka. | Cukup pendek untuk diketik setiap tanda tangan, tapi lebih kuat dari 4 angka. |
| Hapus tanpa PIN memberi masa tunggu 24 jam. | Ditemukan di review keamanan. Tanpa masa tunggu, orang lain di laptop yang tidak terkunci bisa menghapus tanda tangan Anda, membuat yang baru dengan PIN buatannya, lalu menandatangani atas nama Anda. Kejadian hapus dan buat ulang selama permintaan berjalan juga tampil di jejak audit permintaan itu. |
| Setelah PIN benar, inti Rust memberi token sekali pakai berumur 5 menit. Penyimpanan versi bertanda tangan wajib membawa token itu. | Stempel dikerjakan pdf-lib di tampilan, jadi inti Rust butuh bukti bahwa PIN baru saja dimasukkan. |
| Teks stempel dan halaman catatan memakai Helvetica bawaan pdf-lib. Huruf di luar Latin diganti `?`. | Tidak perlu menambah pustaka font. Nama Indonesia umumnya huruf Latin. |
| PDF bertanda tangan menyimpan kode `mira-doc:<id>` di metadata dan disimpan tanpa object stream. | Supaya inti Rust bisa mengenali file Mira hanya dengan membaca byte, juga setelah file diubah aplikasi lain. |
| Batas ukuran: 50 MB saat impor, 100 MB untuk versi bertanda tangan. | pdf-lib menyimpan ulang seluruh file, jadi hasilnya bisa sekitar dua kali lebih besar. |
| PDF yang dilindungi kata sandi pemilik ditolak sebelum permintaan dibuat. | Ditemukan di review kode. Sebelumnya file seperti ini baru ditolak setelah PIN dimasukkan. |
| Salinan disimpan ke folder Unduhan Windows tanpa menimpa file lain, misalnya `kontrak (ditandatangani).pdf`. Folder bisa diganti lewat `MIRA_EXPORT_DIR` (dipakai uji). | Tidak perlu plugin dialog. Salinan itu ikut dijaga: kalau berubah, Mira memberi peringatan. |
| Penyimpanan PDF lewat trait `DocumentStore`. Implementasi sementaranya menyimpan file di `<folder data>/ttd-berkas/`. | Blob store BLAKE3 Tahap 4 ada di branch lain. Saat merge, cukup ganti implementasinya. |
| Satu varian error baru `AppError::Signing { code, message }`. | Hanya dua baris di `error.rs`, jadi merge dengan tahap lain mudah. |
| Layar tanda tangan berdiri sendiri (`src/screens/sign/`), bukan di dalam layar Dokumen. | Layar Dokumen milik Tahap 4. Setelah merge, daftar "menunggu tanda tangan" bisa dipindah ke sana. |
| CSP ditambah `'wasm-unsafe-eval'` dan `connect-src 'self'`. | pdf.js mengambil font, cMap, dan wasm dari aplikasi sendiri. `'wasm-unsafe-eval'` hanya mengizinkan WebAssembly, bukan `eval`. Kalau ditolak tim keamanan, penampil tetap jalan, hanya warna ICC/CMYK hilang. |
| Uji ujung ke ujung memakai build debug tanpa installer (`npx tauri build --debug --no-bundle`). | Jauh lebih cepat dari build release. |

## Hasil uji (apa adanya)

| Pemeriksaan | Hasil |
|---|---|
| `cargo test` | 298 lulus, 6 diabaikan (tes lama yang butuh firewall, keyring, dan jaringan sungguhan) |
| `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` | Bersih |
| `npx vitest run` | 288 lulus |
| `npx tsc --noEmit` | Tanpa error |
| `node scripts/sign-e2e.mjs` (`npm run test:e2e-ttd`) | 15 dari 15 lulus |

Pemeriksaan uji ujung ke ujung, di aplikasi hasil build dengan folder data dan folder ekspor sendiri:
1. Membuat organisasi uji, lalu layar Tanda tangan terbuka.
2. Tanda tangan digambar dengan mouse dan disimpan dengan PIN.
3. PDF uji 3 halaman (dibuat skrip) terbuka di penampil.
4. Kotak tanda tangan digeser dan dibesarkan hanya dengan keyboard, di halaman 3.
5. PIN salah ditolak dengan sisa percobaan.
6. PIN benar: PDF ditandatangani, dikunci, dan halaman catatan ditambahkan.
7. Salinan tersimpan di folder ekspor.
8. Salinan punya 4 halaman (3 + halaman catatan).
9. Periksa file: salinan asli dikenali.
10. Satu karakter di salinan diubah: peringatan muncul di daftar.
11. Periksa file: salinan yang diubah ditandai berubah.
12. File final ditemukan di penyimpanan Mira.
13. Satu karakter di file penyimpanan Mira diubah: peringatan muncul.
14. Mode gelap diterapkan di layar tanda tangan.
15. Hapus tanpa PIN, lalu tanda tangan baru: masa tunggu 24 jam tampil.

Screenshot ada di `docs/progress/screenshots/t5-*.png` (14 gambar):
- Terang: daftar kosong, menggambar tanda tangan, permintaan baru, penempatan, PIN salah, selesai dan terkunci, stempel di halaman 3, halaman catatan, periksa file asli, periksa file berubah, daftar dengan peringatan.
- Gelap: daftar dengan peringatan, dokumen yang filenya berubah, masa tunggu.
- Nama "Rina Uji", "Kantor Uji", dan isi kontrak di gambar adalah data uji.

Review dilakukan oleh tiga subagen terpisah: keamanan Rust, tampilan dan aksesibilitas, dan kode frontend. Temuan yang sudah diperbaiki:
- PIN bisa dilewati dengan hapus lalu buat ulang (TINGGI).
- Segel menerima catatan "selesai" dari kunci siapa pun.
- Kode dokumen lama di metadata XMP membuat tanda tangan selalu ditolak.
- Versi dasar yang berubah masih bisa ditandatangani.
- Hasil stempel bisa melewati batas ukuran.
- PDF berkata sandi pemilik baru ditolak setelah PIN.
- Fokus keyboard jatuh ke halaman kosong di beberapa tombol.
- Teks yang menyesatkan untuk file yang berubah.
- Tata letak di zoom 200%.
- Label dan istilah yang tidak konsisten. Hash BLAKE3 sekarang disebut "sidik file" di layar.

**Belum dicek atau masih terbatas:**
- Panel status jaringan di sidebar menampilkan "Command get_network_status not found" di semua screenshot. Ini bukan dari tahap ini: commit dasar branch (`8d2023a`) sudah memuat tampilan Tahap 1, tetapi perintah jaringannya belum didaftarkan di `lib.rs`. Akan hilang setelah Tahap 1 selesai digabung.
- Layar HiDPI (skala Windows 150%) belum dicoba di aplikasi sungguhan.
- PDF dengan gambar JPX/JBIG2/ICC, PDF dari Word atau Acrobat sungguhan, dan PDF berkata sandi hanya dicek lewat tes, belum di aplikasi.
- Pena sungguhan belum dicoba; tekanan pena dicek dengan event buatan.
- Inti Rust belum bisa membuktikan bahwa versi baru = versi sebelumnya + stempel. Penanda tangan berikutnya secara teknis bisa mengubah isi lalu menandatangani. Catatan penanda tangan sebelumnya tetap menunjuk versi lamanya, jadi perubahan bisa dilacak, tapi belum ada tampilan "bandingkan dengan versi sebelumnya". Ini perlu dipikirkan sebelum jaringan aktif.
- Kalau kunci laptop di Credential Manager DAN `mira.db` sama-sama dicuri oleh program yang berjalan dengan akun Windows Anda, PIN 6 angka bisa ditebak dalam hitungan jam. Pilihan perbaikan: PIN minimal 8 angka, atau Windows Hello.
- Daftar tanda tangan meng-hash ulang setiap file setiap kali dimuat. Dengan puluhan PDF besar ini bisa terasa lambat. Cache sengaja tidak dibuat, karena waktu ubah file bisa dipalsukan.
- Masa tunggu 24 jam dan kunci PIN memakai jam laptop. Memajukan jam Windows (butuh hak admin) bisa memperpendeknya.

## Titik sambung jaringan

- `src-tauri/src/signing/outbox.rs`: trait `SignOutbox` dengan `request_created`, `version_signed`, dan `request_cancelled`. Sekarang dipakai `LocalOnlyOutbox`, yang tidak mengirim apa pun. Implementasi jaringan sebaiknya hanya mengantre di SQLite lalu mengirim di latar belakang, karena outbox dipanggil setelah perubahan lokal tersimpan.
- Yang harus diperiksa laptop penerima:
  - setiap catatan audit dengan `seal::verify_event`;
  - rantai versi (`seal_chain_valid` di `service.rs`);
  - hash file;
  - giliran (`request::can_sign`) dan aturan pengirim (`request::validate_new`), termasuk aturan Tamu;
  - nanti pembatasan Tamu per proyek dari Tahap 4.
- F-SIGN-06 (kartu task tanda tangan pindah ke Selesai otomatis) belum dikerjakan. Butuh board Tahap 3. Pemicunya: catatan `completed` di `service::complete`.
- Di layar, dokumen yang menunggu orang lain sudah memberi tahu dengan jujur bahwa pengiriman lewat jaringan belum tersedia.

## Catatan merge

- **Migrasi:** SQL tanda tangan ada di `src-tauri/src/signing/schema.rs` (`SIGNING_SCHEMA`). Satu entri ditambah di akhir `MIGRATIONS` di `src-tauri/src/db/migrations.rs`, sekarang versi 3. Tahap 3 (board) dan Tahap 4 (dokumen) juga memakai indeks itu, jadi nomor final ditentukan saat merge. Tabel: `sign_saved_signature`, `sign_pin_resets`, `sign_requests`, `sign_signers`, `sign_events`, `sign_exports`.
- **Folder data uji:** folder data dari build branch mana pun sudah bernomor skema 3 dengan isi yang berbeda. Hapus folder data uji sebelum mencoba hasil merge.
- **Rust:**
  - `lib.rs`: `pub mod signing;`, 13 baris `signing::commands::*` di `generate_handler!`, dan satu `app.manage(SignSessions::default())`.
  - `error.rs`: varian `Signing` dan satu baris di `code()`.
  - `Cargo.toml`:
    - `argon2` 0.6.0 dan `chacha20poly1305` 0.11.0;
    - `proptest` 1.12.0 di dev-dependencies;
    - optimasi `argon2` dan `blake2` di profil dev, supaya tes dan `tauri dev` tidak lambat.
- **Penyimpanan:** ganti `FolderStore` di `signing/commands.rs` dengan blob store Tahap 4 yang memenuhi trait `DocumentStore` (`put`, `get`, `contains`). `get` sengaja tidak memverifikasi hash, karena pemanggil yang melaporkan perubahan.
- **Frontend:**
  - `Shell.tsx`: satu menu "Tanda tangan" dan `Section` `"sign"`.
  - `package.json`: `pdfjs-dist` 6.5.438, `pdf-lib` 1.17.1, dan skrip `test:e2e-ttd`.
  - `vite.config.ts`: plugin kecil untuk aset pdf.js.
  - `tauri.conf.json`: CSP.
  - `src/styles/global.css`: aturan kursor untuk tombol nonaktif.
- **Tidak disentuh:** `design/`, layar Dokumen Tahap 4, dan folder `D:\GitHub\ChatCompany`.

## Cara menjalankan

```
npm install
npm test                                   # Vitest
cd src-tauri; cargo test                   # inti Rust
npx tauri build --debug --no-bundle        # build untuk uji ujung ke ujung
npm run test:e2e-ttd                       # uji tanda tangan, screenshot ke docs/progress/screenshots
```

Uji ujung ke ujung memakai folder sementara Windows untuk data dan ekspor. Kunci uji yang dibuatnya di Credential Manager dihapus lagi di akhir.
