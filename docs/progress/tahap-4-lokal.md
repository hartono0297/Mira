# Laporan Tahap 4 (bagian lokal): Dokumen dan edit file

Tanggal: 22 November 2026. Branch: `claude/tahap-4-dokumen-lokal-e47711`. Rencana: `docs/plans/tahap-4-lokal.md`.

## Ringkasan

Pustaka dokumen lokal sudah jalan di satu laptop: tambah file, Edit di Word/Excel, tanda "Sedang diedit", versi baru otomatis setiap simpan, riwayat versi, pulihkan, dan model "bentrok" (dua versi berdampingan) beserta tampilannya. Belum ada jaringan; titik sambungnya sudah disiapkan.

## Yang dibuat

- `src-tauri/src/blobs/`: penyimpanan isi file beralamat hash BLAKE3 (`<data>/blobs/<2 hex>/<hash>`), tulis lewat file sementara lalu rename, read-only, bisa dipakai tahap lain (chat, Tahap 5).
- `src-tauri/src/documents/`: skema (satu entri migrasi), jenis file, graf versi (kepala, bentrok, pulihkan, selesaikan bentrok), izin per aksi, titik sambung sinkron, pemantau simpan Office (`notify`), alur edit (salinan kerja, versi dari simpanan, selesai otomatis saat kunci `~$` hilang, pemulihan saat start), 9 command Tauri.
- `src/screens/docs/` dan `src/api/documents.ts`: layar Dokumen (daftar, status, riwayat versi, kotak bentrok, konfirmasi pulihkan), dialog pilih file lewat plugin dialog.
- `scripts/smoke-docs-e2e.mjs` (`npm run test:e2e:docs`, butuh `npx tauri build --debug --no-bundle`), `scripts/excel-save.ps1`, file uji di `test-files/docs/`.

## Keputusan penting

Semua tercatat di rencana bagian "Keputusan". Singkatnya: versi dibuat setiap simpanan yang isinya berubah (tenang 1,5 detik); "Sedang diedit" berakhir saat Office menutup file; pulihkan dan selesaikan bentrok selalu membuat versi baru; nomor versi lokal; proyek belum ada sehingga semua file masuk "Pustaka Umum" (`project_id` NULL); nama sama diberi akhiran " (2)"; file jenis program (.exe, .bat, dan sejenisnya) tidak pernah dibuka dari Mira; nama salinan kerja dipendekkan supaya path maksimal 200 karakter; menghapus dokumen belum ada (butuh tombstone saat sinkron).

## Hasil uji (apa adanya)

- `cargo test`: 273 lulus, 0 gagal, 6 diabaikan (diabaikan berasal dari Tahap 1). `cargo clippy --all-targets`: tanpa peringatan.
- Vitest: 13 file, 127 tes lulus. `tsc`: tanpa error.
- Uji ujung ke ujung `npm run test:e2e:docs`: 15/15 lulus (tambah file, nama ganda, Edit di Excel, versi 2, tanda hilang setelah file ditutup, folder kerja dibersihkan, pulihkan versi 1 menjadi versi 3 dengan isi sama, pola simpan Word, Selesai mengedit ditolak selama file terbuka, simpanan saat Mira tertutup menjadi versi 4 setelah start, riwayat tetap setelah restart).
- Screenshot: `docs/progress/screenshots/12` sampai `18` (terang dan gelap).
- **Microsoft Office:** Word dan Excel terpasang, tetapi belum berlisensi. Beberapa detik setelah start, Office membuka dialog "Enter your product key" yang menahan otomatisasi COM. Satu kali Excel asli sempat membuka salinan kerja: Mira melihat kunci `~$` dan mengakhiri sesi dengan benar setelah Excel ditutup, tetapi penyimpanan lewat COM tertahan dialog itu. Karena itu uji memakai urutan file yang meniru pola simpan Excel dan Word (file sementara, rename, kunci `~$`); tes unit pemantau juga menguji pola itu. Di laptop dengan Office berlisensi, jalankan dengan `MIRA_E2E_REAL_EXCEL=1` untuk memakai Excel asli. Excel otomatisasi yang saya jalankan sudah saya tutup, dan catatan pemulihan dokumen Excel yang muncul dari uji saya (hanya menunjuk file uji) sudah saya hapus. Office milik user tidak disentuh.
- Bentrok belum bisa dibuat lewat aplikasi di satu laptop (butuh versi dari rekan); diuji lewat tes unit Rust (`apply_remote_version` saat sedang mengedit) dan Vitest untuk tampilannya. Belum ada screenshot bentrok dari aplikasi.

## Titik sambung jaringan dan izin

- `documents::sync::DocumentSync` (keluar): `document_added`, `version_added`, `editing_changed`. Sekarang `NoSync`.
- Masuk: `apply_remote_document`, `apply_remote_version` (idempoten, divalidasi, jenis file diturunkan dari nama), `set_remote_editing` (tanda kedaluwarsa setelah 10 menit). Versi dari rekan saat sedang mengedit otomatis menjadi bentrok saat disimpan.
- `blob_fetch_policy`: file sampai 20 MB disalin otomatis, lebih besar diunduh saat diklik (`blobs::should_auto_replicate`).
- Izin: `documents::access::DocumentAccess` + `RoleAccess` (Tamu hanya lihat dan simpan salinan). Batas tim dan proyek tamu masih kait kosong `scope_allows`, untuk disambung ke `permissions::OrgState`.

## Catatan merge

- Migrasi dokumen = satu entri terakhir di `MIGRATIONS` (`crate::documents::schema::MIGRATION`), v3 di branch ini. Nomor final saat merge dengan Tahap 3 dan 5. Tes migrasi di `documents/schema.rs` menganggap entri dokumen yang terakhir; sesuaikan kalau ada migrasi sesudahnya.
- `lib.rs`: tambah `pub mod blobs; pub mod documents;`, plugin dialog, runtime dokumen di `setup`, 9 baris di `generate_handler!`. `error.rs`: 4 kode baru (`storage`, `invalid_input`, `document_editing`, `open_failed`). Capability: `dialog:allow-open`, `dialog:allow-save`. Dependensi baru: `notify` 9, `tauri-plugin-dialog`, `@tauri-apps/plugin-dialog`.
- Di branch ini command jaringan Tahap 1 belum terdaftar di `lib.rs`, jadi panel jaringan dan langkah firewall di onboarding menampilkan error "Command ... not found". Itu bagian Tahap 1, bukan Tahap 4.

## Yang belum dan saran lanjutan

- `ConfirmDialog` bersama (Tahap 0) memakai `disabled` saat sibuk: fokus bisa hilang dan label tombol sibuk di mode terang kontrasnya 3,42:1. Perlu diperbaiki di komponen bersama.
- Pemantau tidak memasang ulang pengawasan kalau folder kerja dihapus lalu dibuat ulang di path yang sama (jarang; polling kunci 5 detik tetap jalan).
- Catatan/coretan PDF menunggu Tahap 5.
