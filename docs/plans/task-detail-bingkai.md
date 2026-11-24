# Rencana: detail task berbingkai (desain A)

Tanggal 24 November 2026. Branch `claude/task-detail-bingkai-eab6fe`. Target rilis kecil v0.4.1.

Permintaan user setelah memakai v0.4.0: "kalau ini terlalu minimalist, bikin lebih jelas mana yang bisa dipilih dan tidak bisa". Dari tiga contoh visual user memilih **A. Kolom berbingkai**.

## Aturan tampilan

Satu aturan untuk seluruh dialog: **yang bisa diubah berbingkai, yang tidak bisa diubah teks biasa.**

| Jenis | Tampilan |
|---|---|
| Nilai pilihan (Status, Prioritas, Penanggung jawab) | `.td-box`: garis 1px `--border-strong`, sudut 6px, padding 4px 8px, lebar penuh sel nilai, ikon panah bawah di kanan |
| Tenggat | `.td-box` dengan ikon kalender |
| Label | `.td-box` dengan ikon plus, chip label tetap di dalam bingkai |
| Judul task | Judul besar tetap tenang: garis bawah putus-putus 1px `--border-strong` selalu terlihat saat bisa diedit, bingkai penuh dan latar `--field-hover` saat disorot atau difokus. Judul hanya-baca tanpa garis |
| Deskripsi | Kotak berbingkai `.td-box .td-box-text`, placeholder yang mengajak menulis kalau kosong |
| Hanya dibaca ("Dibuat oleh") | `.td-ro`: teks `--text-sec`, ikon gembok kecil, tanpa bingkai |
| Orang tanpa hak ubah (Tamu, bukan anggota) | Semua nilai teks biasa, tanpa bingkai, tanpa ikon aksi |
| Tombol aksi | Tetap `.btn` |

Hover: latar `--field-hover` (token baru: `#FBF4F0` terang, `#2A201C` gelap) dan garis berganti `--text-sec`, karena `--border-strong` di atas `--field-hover` hanya 2,93:1. Fokus keyboard: garis 2px `--focus`, offset 1px.

Kelas bersama ada di `src/screens/board/field.css` (diimpor `TaskDetail.tsx`).

## Pembagian kerja (subagent paralel, file tidak bertumpuk)

| Tugas | File |
|---|---|
| Fondasi (sesi utama) | `src/theme/tokens.ts` (token `field-hover`), `field.css`, rencana ini |
| A. Properti, judul, keterangan dibuat, deskripsi, tab Komentar, mode hanya-baca | `TaskDetail.tsx`, `PropertyRow.tsx`, `DetailTabs.tsx`, `task.css`, `board-dialog.*.ts` (kamus teks dialog), `TaskDetail.test.tsx`, `BoardDetailEnglish.test.tsx` |
| B. Subtask (judul subtask yang bisa diedit, penanggung jawab subtask) | `Subtasks.tsx`, `subtasks.css`, `board-subtask.*.ts`, `Subtasks.test.tsx` |
| C. Waktu (Catat waktu manual, timer, isian catatan) | `TimeSection.tsx`, `TimerMini.tsx`, `time.css`, `board-time.*.ts`, `TimeSection.test.tsx`, `TimerMini.test.tsx` |
| D. Review tampilan dan aksesibilitas | baca saja, laporan ke sesi utama |
| E. E2E (satu per satu) dan screenshot | `scripts/board-e2e.mjs`, `scripts/board-v04-multi-e2e.mjs`, skrip screenshot di scratchpad |

Setiap tugas memakai TDD: tulis tes dulu (misalnya "Tamu tidak melihat `.td-box`", "Status punya ikon panah", "Dibuat oleh punya ikon gembok dan tanpa bingkai"), lihat gagal, lalu ubah kode.

Kelas lama yang dipakai skrip e2e (`.td-pv`, `.td-title`, `.td-desc`, dan seterusnya) dipertahankan di samping kelas baru supaya selektor tidak perlu berubah.

## Selesai berarti

- `npx tsc --noEmit` dan `npx vitest run` lulus.
- `board-e2e.mjs`, `board-v04-multi-e2e.mjs`, `english-e2e.mjs` lulus satu per satu dengan build debug.
- Screenshot terang, gelap, Indonesia, Inggris, dan hanya-baca di `docs/progress/screenshots/task-detail-bingkai/`.
- Laporan `docs/progress/task-detail-bingkai.md`.
