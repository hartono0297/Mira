# Rencana: menu klik kanan Chat (v0.4)

Permintaan user: "buat click kanan pada app nya ada fungsinya, seperti kalau di chat, buat delete chat, dll u atur aja yang terbaiknya gimana".

Memakai komponen bersama `src/components/ContextMenu` (cara pakai di `docs/progress/v04-contextmenu.md`). Hanya aksi yang perintahnya sudah ada di `src/api/chat.ts`; tidak ada perintah Rust baru (`chat_mark_read` sudah ada per percakapan).

## Kontrak bersama (ditulis lebih dulu, lalu dikerjakan paralel)

- `menuText.ts`: semua teks menu (satu tempat, bahasa Indonesia).
- `ChatActions.tsx`:
  - `ChatActionsContext` (ChatScreen): `me`, `canMessage(pk)`, `openDm(person)`, `showProfile(person)`.
  - `ConversationActionsContext` (panel percakapan): `mention`, `isMember`, `canRemove`, `removeFromGroup`.
  - `usePersonMenu(person, { onRemove? })`: Kirim pesan pribadi, Sebut, Lihat profil, Keluarkan dari grup.
  - `ConvRequest`: permintaan dari sidebar (Ganti nama, Tambah orang) yang dijalankan kepala percakapan setelah percakapan dibuka.
- `useGroupView` dipindah dari kepala percakapan ke panel percakapan supaya menu orang di pesan memakai data grup yang sama.

## Pembagian kerja (file terpisah, paralel)

| Bagian | File |
|---|---|
| Pesan dan lampiran | `MessageItem`, `MessageList`, `Conversation`, `Composer`, `DeliveryStatus`, `FileCard`, `conversation.css` (bagian pesan) |
| Sidebar dan kepala percakapan | `ConversationList`, `ConversationHeader`, `ChatScreen`, `chat.css` |
| Orang | `ProfileDialog`, `GroupMembers`, `ProjectMembers` |
| Uji e2e | `scripts/chat-e2e.mjs` (setelah tiga bagian di atas selesai) |

## Isi menu

- **Pesan**: Balas, Salin teks, Sebut pengirim, Lihat status baca (pesan sendiri: daftar per orang), Hapus pesan (pesan sendiri atau admin yang berhak; konfirmasi; hasil "Pesan dihapus"). Jalan tanpa klik kanan: tombol "..." di bilah aksi pesan, Shift+F10, tombol Menu.
- **Percakapan di sidebar**: Buka, Tandai sudah dibaca (kalau ada yang belum dibaca), Bisukan/Bunyikan. Grup: Ganti nama, Tambah orang, Keluar dari grup (konfirmasi). Channel: Jadikan hanya-baca (superadmin), Arsipkan/Kembalikan, Hapus channel (konfirmasi), sesuai `canArchive`/`canDelete`. Chat proyek: tanpa arsip dan hapus. Pesan pribadi: tanpa "hapus dari daftar" (perintahnya tidak ada). Jalan tanpa klik kanan: Shift+F10 di baris, dan menu "..." di kepala percakapan berisi aksi yang sama.
- **Lampiran**: Buka, Simpan salinan, Unduh dari rekan (file besar), Salin nama file.
- **Orang**: Kirim pesan pribadi, Sebut, Lihat profil, Keluarkan dari grup (pemilik grup).

## Selesai berarti

Vitest dan `tsc` lulus (termasuk tes keyboard menu), `chat-e2e` lulus ditambah klik kanan sungguhan untuk hapus pesan, balas, bisukan, dan keluar grup, `e2e-fitur-multi` tetap lulus, laporan di `docs/progress/v04-ctx-chat.md`.
