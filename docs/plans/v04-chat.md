# Rencana Chat v0.4: lipat sidebar, grup satu orang, chat proyek sebagai grup

Tanggal: 23 November 2026. Branch `claude/v04-chat-f21661`, dari `main` e7def11.

## 1. Bug lipat sidebar

Temuan: `ConversationList.tsx` sudah memasang atribut `hidden` di badan bagian yang terlipat, dan panah sudah berputar (`aria-expanded=false`). Tetapi `chat.css` memberi `.chat-sec-body { display: flex }`, dan aturan penulis itu menimpa `display: none` bawaan browser untuk `[hidden]`. Akibatnya bagian yang dilipat tidak pernah tersembunyi di aplikasi sungguhan. Tes Vitest hanya memeriksa atribut `hidden` di jsdom, yang tidak menerapkan CSS, jadi bug ini lolos.

Perubahan:
- `.chat-sec-body[hidden] { display: none; }`.
- Aturan "bagian yang berisi percakapan terbuka tidak bisa dilipat" dihapus. Melipat selalu menyembunyikan semua baris bagian itu, termasuk percakapan yang sedang dibuka (percakapannya tetap terbuka di panel kanan). Ini satu aturan yang sama untuk semua bagian.
- Kalau percakapan baru dari dialog (grup baru, pesan pribadi baru) ada di bagian yang terlipat, bagian itu dibuka otomatis dan disimpan. Pindah otomatis (kembali ke `#umum`) tidak membuka apa pun.
- State lipat disimpan per laptop di database Mira (pengaturan `chat.folded`, command `chat_set_folded`, field `ChatOverview.folded`). Rencana awal memakai `localStorage`, tetapi e2e menunjukkan nilainya hilang saat aplikasi dihentikan paksa.
- Tes: Vitest memeriksa `hidden` dan aturan CSS (`.chat-sec-body[hidden]`), juga bahwa bagian dengan percakapan aktif tetap bisa dilipat; e2e memeriksa `getComputedStyle(...).display === "none"` di aplikasi sungguhan dan lipatan bertahan setelah muat ulang.

## 2. Grup tanpa anggota lain

- Model dan judge sudah menerima `group_create` dengan `members` kosong; fold memasukkan pembuat sebagai anggota dan pemilik. Yang menolak hanya `service::create_group` (lewat `group_targets`) dan dialog.
- Inti: `create_group` menerima daftar kosong. `group_add` tetap butuh minimal satu orang baru.
- Dialog: tombol "Buat grup" tidak dikunci karena belum memilih orang. Petunjuk: "Belum ada yang dipilih. Grup bisa dibuat berisi Anda saja, lalu tambah orang belakangan."
- Tes: tes unit fold, tes service (grup satu orang lalu tambah orang dan orang itu menerima riwayat), Vitest dialog, e2e.

## 3. Chat proyek sebagai grup

Temuan: saat proyek dibuat di board, chat tidak membuat record apa pun. Channel proyek adalah channel bawaan `ch:<id proyek>` yang diturunkan dari `board_projects` (`audience.rs`, `Ctx::resolve`), audiensnya anggota proyek menurut `board::access`, dan bagiannya Proyek. Jadi letaknya sudah benar dan anggotanya sudah ikut anggota proyek. Tetapi tampilannya sama persis dengan channel umum: `kind: "channel"`, nama dinormalkan jadi `#test`, kepala menulis "Proyek test" tanpa jumlah atau daftar anggota, dan pengelola proyek bisa mengarsipkan atau menghapusnya seperti channel. Ditambah bug lipat, `# test` tampak berada di luar bagian Proyek.

Perubahan (kontrak di `src/api/chat.ts`):
- `ConversationSummary.kind` mendapat nilai `"project"` untuk chat bawaan proyek (bukan channel `channel_create` lama dengan cakupan proyek, yang tetap `"channel"`). `name` adalah nama proyek apa adanya.
- `section` selalu `"proyek"`.
- Command baru `chat_project` mengembalikan `ProjectChatView` (anggota proyek sekarang, pengelola, `canManage`, `former`).
- `canArchive` dan `canDelete` false untuk chat proyek; service menolak arsip dan hapus (mengembalikan dari arsip tetap boleh untuk data lama). Pengelola proyek tetap bisa menghapus pesan orang lain.
- Notifikasi: "Sari di Proyek Alfa".
- Tampilan: ikon grup di daftar dan kepala, judul nama proyek tanpa `#`, tombol "Proyek · N anggota" yang membuka daftar anggota (hanya baca) dengan catatan bahwa anggota diatur di Board. Tidak ada tombol tambah, keluar, atau ganti nama.
- Record dan id percakapan tidak berubah, jadi tidak ada migrasi dan laptop v0.3 tetap bisa bertukar pesan.

## Pembagian kerja

| Bagian | File | Dikerjakan |
|---|---|---|
| Inti Rust | `src-tauri/src/chat/**`, satu baris di `lib.rs` | sesi utama |
| Sidebar dan dialog grup | `ConversationList.tsx`, `ListFormat.ts`, `chat.css`, `NewGroupDialog.tsx`, tesnya | subagen A |
| Kepala dan anggota chat proyek | `ConversationHeader.tsx`, `ProjectMembers.tsx` (baru), `text.ts`, `Composer.tsx`, `conversation.css`, tesnya | subagen B |
| e2e | `scripts/chat-e2e.mjs`, `scripts/e2e-fitur-multi.mjs` | sesi utama, setelah semuanya |
