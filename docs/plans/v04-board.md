# Rencana Board v0.4: subtask, pelacakan waktu, dialog task baru

Tanggal: 23 November 2026. Branch `claude/v04-board-85c86b`, dari `main` e7def11.

Permintaan user:
- "board, setiap task, bisa tambahin sub task kecil"
- "setiap task di board, ada tracking berapa lama dikerjakannya dll"
- "ubah ui ux tampilan task, bikin lebih minimalist dan modern, tapi mudah dibaca user"

## 1. Bentuk dokumen (tambahan di setiap task)

Dua kunci baru di map task. Task baru (v0.4) langsung membuat keduanya sebagai map kosong. Task lama mendapatkannya saat subtask atau catatan waktu pertama ditambahkan.

```text
subtasks: Map<subtask_id> {
  nonce, title: str, done: bool, rank: str, assignee: str|null,
  done_by: str|null, done_at: str|null,
  created_by, created_at, deleted: bool
}
time: Map<entry_id> {
  nonce, by, start: str (RFC 3339 UTC), end: str|null, manual: bool,
  note: str, deleted: bool
}
```

- Id subtask terikat ke pembuat: `derive_subtask_id(author, nonce)`, BLAKE3 dengan domain `mira-subtask-v1`. Id catatan waktu: `derive_time_id`, domain `mira-time-v1`. Sama dengan pola task dan komentar.
- Judul subtask berupa string biasa (yang terakhir menang), bukan teks Automerge. Judul pendek, jadi gabung per karakter tidak perlu.
- Urutan subtask memakai rank pecahan (`rank.rs`), jadi pindah satu subtask biasanya hanya menulis satu nilai.
- Hapus subtask dan hapus catatan waktu = `deleted: true`. Tidak pernah dihidupkan lagi.
- Timer berjalan = catatan dengan `end: null`. Berhenti = mengisi `end`. Catatan manual: `end` = saat dicatat, `start` = `end` dikurangi durasi, `manual: true`.
- **Konflik pembuatan map.** Kalau dua laptop sama-sama membuat map `subtasks` (atau `time`) di task lama saat offline, Automerge menyimpan keduanya sebagai konflik dan hanya satu yang "menang". Pembacaan menggabungkan isi semua nilai konflik (`get_all`), jadi subtask dari kedua laptop tetap tampil dan bisa diubah. Tulisan baru masuk ke map yang menang.

## 2. Aturan change dari rekan (`rules.rs`)

| Objek | Boleh |
|---|---|
| task yang sudah ada | buat map `subtasks` atau `time` kalau belum ada **pada dependensi change** (`get_at`, bukan keadaan sekarang, supaya hasilnya sama di semua laptop) |
| task baru | `subtasks`/`time` dilacak sebagai objek baru, jadi subtask dan catatan di dalamnya ikut diperiksa kepemilikannya |
| `subtasks` | buat map di kunci baru (subtask baru, id terikat ke penulis) |
| subtask yang sudah ada | put `title` (str), `done` (bool), `rank` (str), `assignee` (str/null), `done_by`, `done_at` (str/null), `deleted = true`; hapus nilai yang kalah konflik untuk kunci-kunci itu (kecuali `deleted`) |
| `time` | buat map di kunci baru (catatan baru, id terikat ke penulis, `by` = penulis) |
| catatan waktu yang sudah ada | hanya pemiliknya (`by` = penulis change): put `start`, `end`, `note` (str/null untuk `end`), `deleted = true`; hapus nilai yang kalah konflik |

Selain itu ditolak permanen, misalnya mengubah `created_by`, `by`, `nonce`, menghidupkan lagi yang terhapus, atau mengubah catatan waktu orang lain.

`check_shape`: kalau ada, `subtasks` dan `time` harus map, dan setiap isinya map dengan jenis kolom yang benar. `check_new_authorship`: subtask baru `created_by` = penulis, catatan baru `by` = penulis, dan id terikat.

## 3. Kompatibilitas dengan laptop v0.3

Laptop v0.3 menolak permanen change yang menambah `subtasks` atau `time` ke task lama (aturan lamanya tidak mengenal kunci itu), lalu menyimpan id record-nya di `board_rejected`. Change berikutnya dari penulis yang sama di proyek itu menunggu di `board_pending` karena induknya tidak ada. Task baru dari v0.4 tidak ditolak, karena isi task baru bebas di aturan lama.

Supaya laptop itu menyusul setelah diperbarui: saat aplikasi v0.4 pertama kali jalan, `board_rejected` dikosongkan sekali (penanda `board.rules_version = 2` di tabel `settings`). Rekan menawarkan lagi record-nya, aturan baru menilainya ulang, dan change yang tertahan ikut masuk. Record yang memang rusak ditolak lagi. Biayanya hanya unduhan ulang.

Kesimpulan untuk kantor: semua laptop sebaiknya diperbarui ke v0.4 bersamaan (pembaruan dalam aplikasi sudah ada). Selama masih campur, laptop v0.3 tidak melihat subtask dan catatan waktu di task lama, dan bisa tertinggal perubahan lain dari orang yang sama di proyek itu.

## 4. Pelacakan waktu

**Durasi per status** dihitung dari riwayat yang sudah ada: entri `created` (detail = nama kolom awal) dan `moved` (detail = nama kolom tujuan), diurutkan menurut waktu `at`. Tiap selang dihitung ke kolom sebelumnya. Selang terakhir (sampai sekarang) dihitung ke kolom task yang sebenarnya. Cycle time = dari dibuat sampai terakhir masuk Selesai, hanya kalau task sekarang di Selesai.

**Timer manual per orang**: Mulai, Berhenti (dengan catatan opsional), dan Catat waktu (durasi 1 menit sampai 24 jam, catatan opsional). Satu timer berjalan per orang per task; Mulai di task lain dalam proyek yang sama menghentikan timer saya yang masih berjalan di proyek itu, dalam change yang sama. Total per orang dan per task.

**Jam laptop yang berbeda.**
- Setiap waktu di riwayat ditulis dengan jam laptop yang membuat perubahan. Kalau jam laptop Budi 10 menit lebih cepat, perpindahan yang ia lakukan tercatat 10 menit lebih lambat, jadi durasi per status bisa bergeser sebesar selisih jam itu. Urutan menurut `at` juga bisa salah kalau dua orang memindah task berdekatan. Kalau terdeteksi waktu di masa depan atau urutan riwayat tidak cocok dengan urutan waktu, detail task menampilkan catatan bahwa angka bisa meleset.
- Timer tidak terpengaruh selisih jam antar laptop: mulai dan berhenti ditulis oleh laptop yang sama (satu orang = satu laptop). Yang bisa merusaknya hanya jam laptop itu sendiri diubah saat timer berjalan.
- Timer yang berjalan ditampilkan dengan jam laptop yang melihat. Kalau jam laptop yang melihat lebih lambat dari laptop pemilik timer, durasi berjalan dibatasi minimal 0.

## 5. Command Tauri baru

Semua mengembalikan `TaskDetail`, dan butuh hak ubah task (Tamu tidak bisa).

| Command | Argumen |
|---|---|
| `board_add_subtask` | `projectId, taskId, title, assignee: string \| null` |
| `board_update_subtask` | `projectId, taskId, subtaskId, patch: { title?, done?, assignee? (null = kosongkan) }` |
| `board_move_subtask` | `projectId, taskId, subtaskId, index` |
| `board_delete_subtask` | `projectId, taskId, subtaskId` |
| `board_start_timer` | `projectId, taskId` |
| `board_stop_timer` | `projectId, taskId, note: string \| null` |
| `board_log_time` | `projectId, taskId, minutes, note: string \| null` |
| `board_delete_time_entry` | `projectId, taskId, entryId` (hanya catatan sendiri) |

Batas: judul subtask 1 sampai 200 karakter satu baris, paling banyak 100 subtask hidup per task, catatan waktu paling banyak 200 karakter satu baris, catatan manual 1 sampai 1440 menit, paling banyak 2000 catatan waktu per task.

Riwayat baru: `subtask_added`, `subtask_done`, `subtask_reopened`, `subtask_deleted` (detail = judul subtask), `time_logged` (detail = jumlah detik, saat timer berhenti atau catatan manual).

Tipe TypeScript ada di `src/api/board.ts` (`Subtask`, `TimeEntry`, `TimeTotal`, `StatusTime`, tambahan di `TaskCard` dan `TaskDetail`).

## 6. Dialog detail task

Dua mockup di `design/v04-detail-task.html`, pilih satu, catat alasannya di laporan. Ketentuan:
- Judul besar yang bisa diedit langsung.
- Properti ringkas sebagai baris "label: nilai" yang bisa diklik.
- Urutan: judul, properti, subtask, deskripsi, waktu, lalu tab Komentar dan Aktivitas.
- Sedikit garis kotak. Hapus task pindah ke menu "Lainnya" dengan konfirmasi.
- Token tema Bata terang dan gelap, kontras AA, fokus terlihat.
- Teks baru dalam bahasa Indonesia dan dikumpulkan di `src/screens/board/teks.ts`.

## 7. Kartu board

Progres subtask "2/5" dan total waktu tercatat ("3j 20m") dengan titik kalau ada timer berjalan. Seret kartu tidak berubah.

## 8. Pembagian kerja

- Subagent inti Rust: `doc.rs`, `rules.rs`, `model.rs`, `view.rs`, `timing.rs` (baru), `commands.rs`, tes, baris registrasi di `lib.rs`.
- Subagent mockup: `design/v04-detail-task.html`.
- Setelah mockup dipilih: subagent tampilan dialog (TaskDetail dan komponen baru) dan subagent kartu serta format waktu, file terpisah.
- Uji ujung ke ujung, screenshot, review keamanan dan tampilan terpisah.
