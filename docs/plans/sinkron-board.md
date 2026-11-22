# Rencana: sinkron board antar laptop (sisa Tahap 3)

Tanggal: 22 November 2026. Branch `claude/sinkron-board-e01670`. Dasar: `main` 63eb72b.

## Tujuan

Change Automerge board yang sudah ditandatangani (Tahap 3 lokal) dikirim ke rekan lewat kontrak `network/feature.rs` (`FeatureSync`, topik `board`). Setiap laptop hanya mengirim data proyek ke orang yang boleh melihatnya, dan setiap laptop memeriksa sendiri change yang datang. Hasil akhir sama di semua laptop yang memegang change yang sama.

## Batasan dari brief

- `network/feature.rs`, `network/node.rs`, `network/wire.rs` tidak diubah.
- `permissions/` hanya untuk Tamu per proyek. Ternyata log keanggotaan Tahap 1 sudah punya undangan Tamu dengan daftar proyek (`InviteCreate { role: guest, projects }`, tabel `guest_access`). Jadi `permissions/` tidak perlu diubah sama sekali.
- `lib.rs`: hanya baris registrasi.
- Migrasi: satu entri di akhir `MIGRATIONS` (v6 di branch ini, nomor final saat merge).

## Aturan akses (dari tabel izin PRD)

Sumber: tabel `members`, `teams`, `team_members`, `guest_access` hasil fold Tahap 1 (keadaan sekarang), plus putar ulang op yang diterima untuk riwayat (lihat "Izin pada saat change dibuat").

| Hak | Proyek milik tim T | Proyek tanpa tim |
|---|---|---|
| Lihat (menerima change) | anggota aktif tim T (peran apa pun, termasuk superadmin yang sudah masuk T), atau punya `guest_access(pk, T, proyek)` | semua anggota aktif bukan Tamu |
| Tulis (buat, edit, pindah, komentar) | yang boleh lihat dan jenisnya Anggota (bukan Tamu) | semua anggota aktif bukan Tamu |
| Hapus task | pembuat task (kalau boleh tulis), admin tim T, superadmin anggota T | pembuat task, superadmin |
| Atur proyek (ganti nama) | admin tim T, superadmin anggota T, pembuat proyek kalau masih boleh tulis | pembuat proyek, superadmin |
| Buat proyek | admin tim T, superadmin yang anggota T | superadmin, admin tim mana pun |

- `guest_access` hanya berlaku kalau tim di undangan sama dengan tim proyek. Undangan Tamu ke proyek tim lain tidak memberi akses apa pun.
- Anggota (bukan Tamu) yang menerima undangan Tamu ke proyek tim lain jadi peserta proyek itu dan boleh menulis (F-ROLE-10).
- Superadmin tidak otomatis membaca proyek tim (F-ROLE-11). Ia harus masuk tim dulu, dan tindakan itu tercatat di log keanggotaan.
- `team_id` proyek tidak boleh diubah oleh change dari rekan (memindah proyek ke tim lain = mengubah siapa yang menerima data).

Fungsi publik untuk chat dan dokumen: `board::access::projects_accessible_by(conn, peer)` dan `board::access::may_access_project(conn, peer, project_id)`.

## Izin pada saat change dibuat

Change diterima kalau pembuatnya punya hak itu sekarang, atau pernah punya dan kehilangannya sesudah waktu change. Waktu kehilangan = `at` op keanggotaan yang mencabut hak itu, didapat dengan memutar ulang op yang diterima fold, satu per satu dari genesis. Awal hak tidak diperiksa terhadap jam change, supaya laptop yang jamnya mundur tidak ditolak.

Akibatnya, change yang dibuat anggota sebelum ia dikeluarkan tapi baru sampai sesudahnya tetap diterima di semua laptop, jadi dokumen tidak bercabang. Change sesudah dikeluarkan ditolak. Orang yang sudah dikeluarkan tidak bisa mengirim langsung (transport hanya bicara dengan anggota aktif), jadi ia butuh laptop yang belum tahu soal pengeluarannya untuk meneruskan change.

## Bentuk record

`FeatureRecord.body` = JSON `{"v":1,"project_id","hash","author","seq","bytes","sig"}` (urutan field tetap, `bytes` hex). Id = BLAKE3 body, disimpan di `board_changes.record_id`. Semua laptop menyusun body yang sama dari change yang sama, jadi id-nya sama.

## Status change yang datang

| Hasil | Arti | Disimpan di | Dicoba lagi |
|---|---|---|---|
| diterapkan | lolos semua pemeriksaan | `board_changes` | - |
| menunggu dependensi | change induknya belum ada | `board_pending` (reason `deps`) | saat change lain datang |
| menunggu proyek | proyek belum dikenal dan change pertama belum ada | `board_pending` (reason `project`) | saat change lain datang |
| ditahan | pembuat tidak berhak menurut keanggotaan yang diketahui laptop ini | `board_pending` (reason `rights`), dicatat sekali di `rejected_changes` | saat log keanggotaan berubah |
| ditolak | tanda tangan, format, actor, hash, atau bentuk dokumen rusak | `board_rejected` (id record saja), dicatat di `rejected_changes` | tidak |

Change yang ditahan tidak ditolak permanen karena op keanggotaan dan change board datang lewat aliran yang berbeda. Change dari anggota baru bisa tiba sebelum op yang memasukkannya ke tim.

Batas: `board_pending` paling banyak 20.000 baris dan 64 MiB. Lewat dari itu record tidak disimpan (akan ditawarkan lagi oleh rekan).

## Konflik

**Nomor task ganda.** Dua laptop offline sama-sama membuat PA-12. Setelah sinkron, untuk setiap kelompok task hidup dengan nomor sama, task pertama menurut `(created_at, id)` memegang nomornya. Task lain di kelompok itu diberi nomor baru `max(next_number, nomor terbesar + 1)` oleh satu laptop saja: laptop pembuat task itu. Kalau pembuatnya tidak lagi boleh menulis, yang menomori ulang adalah laptop dengan kunci publik terkecil di antara yang boleh menulis proyek itu. Penomoran ulang adalah satu change bertanda tangan dengan riwayat "renumbered" (kode lama di detail). Kalau dua laptop menomori task yang sama bersamaan, Automerge memilih satu nilai yang sama di semua laptop. Kalau nomor baru bentrok lagi, aturan yang sama berjalan lagi.

**Kode proyek ganda.** Dua proyek berbeda dengan kode sama (PA) di satu laptop: proyek pertama menurut `(created_at, id)` memakai kode aslinya, yang lain tampil sebagai `PA2`, `PA3`, dan seterusnya (angka pertama yang belum dipakai). Kode di dokumen tidak diubah, jadi laptop yang hanya melihat salah satu proyek tetap melihat `PA`. Sama di semua laptop yang memegang proyek yang sama.

**Hapus vs edit.** Hapus = tanda `deleted`, task tetap di dokumen. Edit bersamaan tetap tergabung ke task yang sudah terhapus dan tidak memunculkannya lagi. Pemeriksaan bentuk menolak change yang menghidupkan lagi task terhapus.

## Pembagian kerja

| Bagian | File | Siapa |
|---|---|---|
| Skema v6, `access.rs`, `policy.rs`, `assignees.rs`, inti ingest `sync.rs` (hasil per change, tahan vs tolak, cek hapus dan atur proyek per waktu) | `board/schema.rs`, `db/migrations.rs`, `board/access.rs`, `board/policy.rs`, `board/assignees.rs`, `board/sync.rs` | sesi utama |
| `FeatureSync` board, tabel pending/rejected, hook gabungan, registrasi | `board/feature.rs`, `board/feature/tests.rs`, `lib.rs` | subagent B |
| Nomor ganda, kode ganda, ganti nama proyek | `board/doc.rs`, `board/store.rs`, `board/numbers.rs`, `board/commands.rs` | subagent C |
| Tampilan | `src/` | subagent D |
| Proptest konvergensi, pembatasan, change palsu | `board/feature/convergence_tests.rs` | subagent E (sesudah B dan C) |
| Review keamanan dan tampilan | - | subagent reviewer |
| Uji ujung ke ujung satu laptop | `scripts/board-sync-e2e.mjs` | sesi utama |

## Langkah

1. Fondasi: skema, `access.rs` dengan tes, `policy.rs` memakai `access`, `sync.rs` mengembalikan hasil per change. Commit.
2. Paralel: B, C (worktree sendiri), D (folder ini, hanya `src/`).
3. Gabung B dan C, jalankan semua tes.
4. E: proptest dan tes pembatasan. Reviewer keamanan dan tampilan.
5. Perbaikan temuan, uji ujung ke ujung, `cargo clippy`, Vitest, `npm run test:e2e-multi`.
6. Laporan `docs/progress/sinkron-board.md`, commit.
