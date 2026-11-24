# Laporan: detail task berbingkai (desain A)

Tanggal 24 November 2026. Branch `claude/task-detail-bingkai-eab6fe`, dari `main` 50d5656 (v0.4.0). Rencana di [task-detail-bingkai.md](../plans/task-detail-bingkai.md). Target rilis kecil v0.4.1.

Permintaan user setelah memakai v0.4.0: "kalau ini terlalu minimalist, bikin lebih jelas mana yang bisa dipilih dan tidak bisa". Dari tiga contoh visual user memilih **A. Kolom berbingkai**.

## Hasilnya

Satu aturan untuk seluruh dialog: **yang bisa diubah berbingkai, yang tidak bisa diubah teks biasa, tombol tetap tombol.**

| Bagian | Bisa diubah | Hanya dibaca (Tamu, task hilang) |
|---|---|---|
| Status, Prioritas, Penanggung jawab | Kolom berbingkai lebar penuh, ikon panah bawah di kanan | Teks biasa |
| Tenggat | Kolom berbingkai, ikon kalender. Di kolom sempit "Sabtu, 28 Nov" dan "4 hari lagi" turun baris tanpa titik pemisah menggantung | Teks "Sabtu, 28 Nov · 4 hari lagi" |
| Label | Kolom berbingkai, ikon plus, chip label di dalam bingkai | Chip label |
| Judul task | Garis bawah putus-putus selalu terlihat, bingkai penuh saat disorot atau difokus | Teks besar tanpa garis |
| "Dibuat oleh ..., tanggal" | Teks `--text-sec` dengan ikon gembok, tanpa bingkai | Sama |
| Deskripsi | Kotak berbingkai, placeholder baru kalau kosong | Teks biasa |
| Subtask | Judul bergaris bawah putus-putus (bingkai penuh saat disorot atau difokus), penanggung jawab jadi kolom ringkas berbingkai dengan avatar dan panah, isian subtask baru berbingkai | Teks dan avatar tanpa bingkai |
| Waktu dan timer | "Catat waktu manual" jadi tombol garis seperti "Mulai timer". Isian durasi, catatan, dan catatan saat timer dihentikan berbingkai. Total, per orang, per status, jam timer tetap teks | Tanpa tombol catat, tanpa Mulai |
| Komentar | Kolom tulis komentar berbingkai, Kirim tetap tombol | Tanpa kolom tulis |
| Catatan hanya-baca | Diberi ikon gembok | |

Placeholder deskripsi baru:
- Indonesia: "Tulis deskripsi: tujuan, langkah, atau tautan yang perlu diketahui tim"
- Inggris: "Write a description: the goal, the steps, or links the team should know about"

## Cara kerjanya

- `src/screens/board/field.css` (baru): kelas bersama `.td-box` (garis 1px `--border-strong`, sudut 6px, padding 4px 8px, tinggi 34px, 44px di layar sentuh), `.td-box-ic` (ikon aksi di kanan), `.td-box-text` (varian kolom teks), `.td-ro` (keterangan hanya-baca).
- Token baru `field-hover` di `src/theme/tokens.ts`: `#FBF4F0` terang, `#2A201C` gelap. Nilai token lain tidak berubah.
- `PropertyRow` punya prop `icon` (`chevron`, `calendar`, `plus`). Ikon selalu terlihat, tidak lagi hanya saat disorot. Nama aksesibel tombol tetap "label lalu nilai", ikon `aria-hidden`.
- Kolom ketik bersama `.td-input` dan `.td-textarea` diselaraskan ke sudut, tinggi, padding, sorot, dan fokus yang sama dengan `.td-box`. Teks di semua kolom masuk 9 px dari tepi (garis 1px ditambah padding 8px).
- Kelas lama yang dipakai skrip e2e dan tes tetap ada (`td-pv`, `td-title`, `td-desc`, `td-sub-title`, `td-link-btn`, `td-log-open`, `td-input`). Yang dihapus hanya `td-pv-caret` dan `td-who-empty`, keduanya tidak dipakai di mana pun.
- Penimpaan gaya lama memakai selektor ganda (`.td-pv.td-box`, `.td-desc.td-box`, `.td-input.td-box`), karena `task.css` ikut diimpor `MyTasks` dan `ReminderSettings` sehingga urutan muat CSS tidak bisa diandalkan.

## Keputusan yang saya ambil sendiri

| Keputusan | Alasan |
|---|---|
| Saat disorot, garis bingkai berganti `--text-sec`, bukan tetap `--border-strong`. | `--border-strong` di atas `--field-hover` hanya 2,93:1 di tema terang (gagal 3:1). Pergantian garis juga jadi tanda sorot yang lebih jelas daripada latar, yang selisihnya tipis. |
| Judul task tidak berbingkai penuh saat diam, hanya garis bawah putus-putus. | Judul 24px dengan bingkai penuh terasa seperti formulir. Garis bawah cukup memberi tanda bisa diubah, dan bingkai penuh muncul saat disorot atau difokus. |
| Judul subtask memakai gaya yang sama dengan judul task (garis bawah). | Daftar subtask tetap ringan dibaca, dan tanda "bisa diubah" konsisten dengan judul task. |
| Penanggung jawab subtask: avatar dan panah tanpa nama. | Baris subtask sempit. Nama orang ada di nama aksesibel dan di `title`. |
| Tombol penanggung jawab subtask yang kosong selalu terlihat. | Dulu tersembunyi sampai disorot. Sekarang nilainya bisa diubah, jadi harus terlihat. |
| "Catat waktu manual" jadi tombol garis, bukan tautan teks. | Konsisten dengan "Mulai timer". Bedanya dengan kolom berbingkai: tombol bersudut 10px, huruf tebal, ikon di kiri; kolom bersudut 6px, ikon aksi di kanan. |
| Prioritas "Tidak ada" di mode baca tampil sebagai teks `--text-sec`, bukan pil bergaris. | Dulu Tamu melihat pil bergaris untuk nilai kosong, kebalikan dari aturan bingkai. |
| Salinan draf hanya-baca (saat task hilang) tanpa bingkai, latar `--col`. | Tidak bisa diubah, hanya disalin. Tetap textarea supaya mudah dipilih dan disalin. |
| Isian yang sedang difokus tidak berganti garis saat disorot. | Garis `--focus` tetap terlihat selama mengetik. |
| Teks tidak ditambah untuk pembaca layar di "Dibuat oleh". | Bukan kontrol, jadi tidak ada yang perlu dijelaskan. |
| Chip label dan prioritas di mode baca tetap bergaris tipis. | Bentuknya pil kecil (sudut 10px, huruf 12px), jelas berbeda dari kolom isian. |

## Kontras (check_contrast)

| Pasangan | Terang | Gelap |
|---|---|---|
| Garis `--border-strong` di atas `--bg` | 3,19 | 4,18 |
| Garis saat disorot `--text-sec` di atas `--field-hover` | 5,61 | 7,61 |
| Garis saat disorot `--text-sec` di atas `--hover` (baris subtask) | 5,03 | 6,93 |
| Cincin fokus `--focus` di atas `--bg` | 5,42 | 7,18 |
| Cincin fokus `--focus` di atas `--field-hover` | 4,98 | 6,45 |
| Teks `--text` di atas `--field-hover` | 14,74 | 13,45 |
| Placeholder dan "Dibuat oleh" `--text-sec` di atas `--bg` | 6,11 | 8,46 |
| `--danger` (isian salah) di atas `--field-hover` | 6,89 | 7,77 |
| `--state` ("terlambat") di atas `--field-hover` | 5,65 | 7,89 |

Pasangan yang gagal dan karena itu tidak pernah tampil: `--border-strong` di atas `--field-hover` (2,93), `--hover` (2,63), dan `--col` (2,95) di tema terang. Setiap sorotan mengganti garis ke `--text-sec`, dan tidak ada `.td-box` di atas `--col`.

## Review

Reviewer tampilan dan aksesibilitas terpisah (subagent, hanya membaca) menemukan 8 hal. Yang sudah diperbaiki:

1. (medium) Di layar sentuh tombol properti turun dari 44px ke 34px, karena `.td-box` dimuat setelah aturan lama. Sekarang `field.css` dan `subtasks.css` punya aturan `pointer: coarse` sendiri, termasuk untuk judul subtask, penanggung jawab subtask, dan isian subtask baru.
2. (medium) Salinan draf hanya-baca masih berbingkai. Sekarang tanpa bingkai.
3. (low) Tinggi dan padding kolom berbeda-beda (34 sampai 38px, inset 9 sampai 11px). Sekarang seragam: 34px, padding 4px 8px untuk satu baris, 6px 8px untuk teks panjang.
4. (low) Isian yang difokus kehilangan garis fokus saat disorot. Sudah diperbaiki.
5. (low) Prioritas "Tidak ada" di mode baca berupa pil bergaris. Sekarang teks.
6. (low) Kelas mati `td-who-empty` dihapus.

Yang sengaja tidak diubah:

- Tombol garis dan kolom berbingkai mirip bentuknya. Pembedanya sudut, tebal huruf, dan letak ikon (lihat Keputusan).
- Teks judul bergeser 9px saat dialog pindah dari mode ubah ke mode baca (hanya terjadi kalau hak ubah dicabut saat dialog terbuka). Dengan begitu teks judul sejajar dengan teks deskripsi di mode ubah.

## Tes

TDD per bagian: tes ditulis dulu dan gagal, lalu kode diubah.

- `TaskDetail.test.tsx`: blok "Detail task: kolom berbingkai" (5 tes): ikon panah, kalender, dan plus; mode Tamu tanpa `.td-box` dan tanpa ikon aksi; "Dibuat oleh" di `.td-ro` dengan gembok; deskripsi kosong dengan placeholder baru.
- `BoardDetailEnglish.test.tsx`: placeholder dan teks bahasa Inggris (1 tes).
- `Subtasks.test.tsx`: blok "Subtask: kolom berbingkai" (5 tes).
- `TimeSection.test.tsx` (4 tes) dan `TimerMini.test.tsx` (3 tes): tombol catat, isian berbingkai, hasil hitung tanpa bingkai, mode tanpa hak ubah.

| Pemeriksaan | Hasil |
|---|---|
| `npx tsc --noEmit` | bersih |
| `npx vitest run` | 113 berkas, 1650 tes lulus |
| `board-e2e.mjs` (build debug) | 43/43 |
| `board-v04-multi-e2e.mjs` | 29/29 |
| `english-e2e.mjs` | 38/38 |

Ketiga e2e dijalankan satu per satu dengan `E2E_PORT_OFFSET=700`, lulus pada percobaan pertama, tanpa perubahan skrip.

Catatan lingkungan Vitest (sama dengan laporan v0.4 board): worktree memakai junction `node_modules` ke checkout utama. Di run penuh dengan konfigurasi biasa, `App.test.tsx`, `components.en.test.tsx`, dan `UpdateContext.test.tsx` gagal dimuat karena Vite menolak `pdfjs-dist/.../pdf.worker.min.mjs?url` di luar root worktree. Angka 1650 di atas memakai konfigurasi sementara yang mengizinkan folder itu (`server.fs.allow`), lalu dihapus. Di checkout utama masalah ini tidak muncul. Satu kali "menolak subtask ke-101" kena batas waktu 5 detik saat CPU dipakai build dan screenshot bersamaan; dijalankan ulang sendiri lulus.

## Screenshot

`docs/progress/screenshots/task-detail-bingkai/`, build debug, 1366x768:

- `01-terang-id.png`, `02-gelap-id.png`: task lengkap, bahasa Indonesia.
- `03-terang-en.png`, `04-gelap-en.png`: bahasa Inggris.
- `01` sampai `04` versi `-penuh.png`: dialog setinggi isinya (Waktu dan Komentar ikut terlihat).
- `05-deskripsi-kosong-terang.png`: deskripsi kosong dengan placeholder, tanpa label dan tenggat.
- `06-hover-fokus-terang.png`: fokus keyboard di Status dan mouse di atas Prioritas.
- `07-hanya-baca-terang.png`, `08-hanya-baca-gelap.png`: laptop kedua yang bergabung sebagai Tamu membuka task yang sama. Tidak ada bingkai maupun ikon aksi.
- `09-sempit-terang.png`: jendela 900px.

Screenshot diambil skrip sementara (dua instance, Tamu lewat undangan peran `guest`). Salinannya disimpan di folder catatan bersama sesi sebagai `task-detail-bingkai-shots.mjs`, tidak di-commit.

## Batasan dan yang belum dicek

- Belum dicek di macOS dan di layar sentuh sungguhan. Aturan `pointer: coarse` hanya diperiksa lewat kode.
- Tenggat yang turun dua baris membuat kotaknya lebih tinggi dari kotak lain di baris yang sama.
- Di bahasa Inggris "Dibuat oleh" untuk diri sendiri terbaca "Created by You, ..." dengan Y besar. Ini sudah ada sejak v0.4.0, karena kunci `anda: "You"` dipakai juga di tempat lain.
- Petunjuk keyboard subtask disembunyikan dengan `visibility: hidden` sampai bagian Subtask difokus, jadi tetap memakan ruang di bawah daftar. Ini sudah ada sejak v0.4.0 dan sengaja, supaya tata letak tidak meloncat saat petunjuk muncul.
- `.btn-ghost` global (di luar dialog ini) masih memakai garis `--border-strong` saat disorot di atas `--hover` (2,63:1). Di bagian Waktu dan timer sudah diganti `--text-sec`. Perbaikan global di luar lingkup sesi ini.

## Untuk penggabung

- File di luar `src/screens/board/`: `src/theme/tokens.ts` (token baru `field-hover`), `src/i18n/board-dialog.id.ts` dan `.en.ts` (satu kunci `deskripsiPlaceholder`).
- Tidak ada perubahan data, sinkron, atau Rust.
- Akhir baris semua berkas yang diubah tetap CRLF seperti di `main`.

## Cara kerja sesi

Fondasi (token, `field.css`, rencana) ditulis sesi utama. Lalu tiga subagent paralel dengan file terpisah: properti, judul, deskripsi, dan komentar; subtask; waktu dan timer. Satu subagent lagi menyiapkan skrip screenshot. Setelah itu reviewer tampilan dan aksesibilitas, dua subagent perbaikan temuan review, dan satu subagent e2e yang menjalankan ketiga skrip berurutan.
