# Rencana: menu klik kanan Board (v0.4)

Permintaan user: "buat click kanan pada app nya ada fungsinya ... u atur aja yang terbaiknya gimana untuk modul2 lain". Dasar: komponen bersama `src/components/ContextMenu` (`docs/progress/v04-contextmenu.md`).

## Keputusan dasar

- **Sub-menu tanpa mengubah komponen bersama.** Komponen bersama hanya punya daftar datar dan bukan milik sesi ini. `src/screens/board/useBoardMenu.tsx` membungkus `useContextMenu`: item `submenu(...)` bertanda ›, dan memilihnya mengganti isi menu di tempat yang sama (memakai `MenuPopup` bersama) dengan baris Kembali di atas. Panah kanan membuka, panah kiri kembali, Esc menutup semua.
- **Hak dari inti Rust.** Kartu (`TaskCard`) mendapat `canDelete` dan `myTimerRunning`. `canDelete` dipindah dari `TaskDetail` ke kartu (JSON detail tetap sama karena `flatten`). Di `board()` dihitung murah: `canCreate && (pembuat == saya || canManage)`, setara `can_delete_task`.
- **Teks** di `src/screens/board/teksMenu.ts`.
- Klik kanan tidak memulai seret: `useCardDrag` hanya menerima tombol utama (`button === 0`).

## Isi menu

**Kartu task** (`Aksi untuk TES-1`)
- Buka task
- Pindahkan ke › To do, Dikerjakan, Selesai (kolom sekarang nonaktif), Naik satu posisi, Turun satu posisi. Hanya kalau boleh memindah.
- Tugaskan ke › anggota yang bisa ditugaskan (saya paling atas, "(Anda)"), Tanpa penanggung jawab. Penanggung jawab sekarang nonaktif.
- Ubah prioritas › Tinggi, Sedang, Rendah, Tanpa prioritas.
- Atur tenggat › Hari ini, Besok, Hapus tenggat, Tanggal lain di detail task (membuka task).
- Mulai timer saya / Hentikan timer saya.
- Salin kode TES-1.
- Hapus task (merah, konfirmasi), hanya kalau `canDelete`.
- Tanpa hak ubah (Tamu): Buka task dan Salin kode.

**Kolom** (`Aksi untuk kolom To do`): Task baru di To do. Tanpa hak ubah: tidak ada menu.

**Subtask** di dialog task (yang boleh mengubah): Tandai selesai / belum selesai, Ganti nama, Tugaskan ke ›, Pindah naik, Pindah turun, Hapus subtask. Klik kanan di kolom judul tetap memberi menu teks (aturan komponen bersama).

**Proyek** di daftar kiri: Buka board, Anggota proyek, Ubah nama proyek (pengelola). Buka chat proyek tidak dibuat: navigasi ke Chat lewat `Shell` dan `ChatScreen`, di luar milik sesi ini.

**Task saya**: Buka task, Pindahkan ke › tiga kolom, Salin kode.

## Jalan tanpa klik kanan

Shift+F10 dan tombol Menu membuka menu yang sama. Semua aksi juga ada di detail task, tombol Pindahkan di kartu, tombol di kepala board, dan baris subtask.

## Pembagian kerja (subagent paralel, file terpisah)

1. Rust: `src-tauri/src/board/{model,view}.rs` dan tesnya.
2. Kartu dan kolom: `BoardCard.tsx`, `ProjectBoard.tsx`, tes baru.
3. Subtask: `Subtasks.tsx`, tes baru.
4. Proyek dan Task saya: `BoardScreen.tsx`, `MyTasks.tsx`, tes baru.
5. Tes keyboard `useBoardMenu`.
6. Setelah itu: `scripts/board-e2e.mjs` (klik kanan sungguhan), `board-sync-e2e`, review terpisah, laporan.
