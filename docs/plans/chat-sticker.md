# Rencana: reaksi, emoji, dan sticker di Chat (v0.5.1)

Permintaan user: "gw mau ada fitur kirim sticker, emote di chat". Reputasi "Kopi" bukan bagian sesi ini.

Branch `claude/chat-sticker-eac793`, dari `main` a45d1b3 (v0.5.0). Laporan: `docs/progress/chat-sticker.md`.

## 1. Ringkasan

- **Reaksi** di pesan: chip emoji dengan jumlah, klik untuk menambah atau menghapus reaksi sendiri, arahkan atau fokus untuk melihat siapa saja. Satu orang boleh beberapa emoji berbeda per pesan, satu kali per emoji. Tanpa notifikasi.
- **Pemilih emoji** di kolom pesan: tombol, pencarian (Indonesia dan Inggris), kategori, "Sering dipakai" per laptop, saran saat mengetik `:nama`. Emoji Unicode bawaan sistem, data nama dibuat sendiri (tanpa pustaka).
- **Sticker dan emote kantor**: dikelola superadmin di Organisasi, tab baru Sticker. Satu sticker kantor dipakai dua cara: dikirim sebagai pesan sticker (besar, tanpa gelembung) dan sebagai emote `:nama:` di teks (gambar kecil sebaris).
- **Sticker pribadi**: koleksi per laptop. Unggah sendiri, atau "Simpan sticker" dari pesan.
- **Admin menyembunyikan** pesan sticker lewat alur "Hapus pesan" yang sudah ada (pengirim, superadmin, dan admin departemen di channel departemennya; aturan `judge::message_delete` dan `ctx.is_admin` tidak diubah).
- Tanpa paket sticker bawaan.
- **Tambahan dari session utama** (permintaan user: "gw mau di chat, muncul semua label yang user itu punya"): di Chat, semua label keahlian orang tampil (bukan maksimal 3) di baris penulis pesan (termasuk pesan saya), kepala pesan pribadi, daftar anggota grup dan proyek, dan profil. Chip boleh turun baris. Sidebar tetap ringkas dengan "+N" yang bisa difokus. Layar di luar Chat tetap maksimal 3. Reaksi bisa diberikan ke pesan siapa pun.

## 2. Record baru (topik `chat`, `model::Body`)

```text
reaction    { conv, message: 64 hex, emoji, on: bool }
sticker_set { sticker: 32 hex, pack, name, keywords: [..], file: FileRef, state: active|hidden|deleted }
```

- `reaction`: `conv` adalah percakapan pesannya. Per `(message, author, emoji)` record dengan `(at, id)` terbesar menang (`on` true = aktif). Deterministik di semua laptop, apa pun urutan datangnya. Pesan yang belum ada di laptop ini tidak menghalangi: barisnya disimpan dan tampil begitu pesannya datang. Reaksi di pesan yang dihapus tidak ditampilkan. Isi record yang di-purge mengikuti channel yang dihapus (seperti pesan).
- `emoji`: emoji Unicode (1 sampai 16 karakter Unicode, paling banyak 64 byte, tanpa spasi, karakter kontrol, atau bidi; boleh ZWJ U+200D, VS16 U+FE0F, keycap U+20E3, tag U+E0020 sampai U+E007F, pengubah warna kulit; tanpa huruf ASCII), atau emote kantor `:nama:` dengan `nama` mengikuti aturan nama sticker.
- Judge reaksi: pembuat anggota percakapan pada waktu record (`judge::may_post` untuk grup, pribadi, dan proyek), **termasuk channel Umum yang dikunci** (pengumuman boleh diberi 👍). Ditolak di channel yang diarsipkan atau percakapan yang `former`. Channel terhapus: diterima lalu di-purge (sudah dilakukan `store::apply`).
- `sticker_set`: hanya superadmin pada waktu record (`audience::was_superadmin_at`). Per sticker record dengan `(at, id)` terbesar menang untuk semua kolom; `created_at` dan `created_record` dari record paling awal. Nama: `[a-z0-9_]{2,32}`. Paket: 1 sampai 30 karakter seperti nama grup (`model::is_group_name` sebagai patokan). Kata kunci: paling banyak 8, masing-masing 1 sampai 24 karakter, huruf kecil, tanpa spasi dan karakter kontrol, tanpa duplikat. `file.mime` salah satu `image/png`, `image/webp`, `image/gif`; `file.size` paling besar 512 KB; `file.name` = `<name>.sticker.<png|webp|gif>` sesuai mime.
- Dua sticker aktif bernama sama (dibuat bersamaan di dua laptop): pemilik `:nama:` adalah yang `(created_at, created_record)`-nya terkecil; yang lain `nameTaken` di panel superadmin dan tidak dipakai sebagai emote.
- `apply_rank`: `sticker_set` 2, `reaction` 3.

### Pesan sticker (record `message` biasa)

Pesan sticker adalah `message` dengan `text` = `:nama:` dan tepat satu file bernama `<nama>.sticker.<png|webp|gif>`, mime gambar yang sama, ukuran paling besar 512 KB. Tidak ada field baru, jadi laptop 0.5.0 menerimanya dan menampilkan `:nama:` dengan gambarnya sebagai lampiran biasa. Laptop baru mengenali bentuk ini (`stickers::message_sticker`) dan menampilkannya besar tanpa gelembung, setelah byte gambarnya lolos `sticker_file::inspect` (hasil disimpan di `chat_sticker_checks`). Kalau gagal, pesan tampil sebagai lampiran biasa.

Sticker kantor dan pribadi dikirim dengan cara yang sama; file dilampirkan dari blob store dengan hash yang sudah ada (`chat_send_sticker`), sehingga tersebar lewat jalur lampiran yang sudah ada (salinan otomatis, titipan untuk pesan pribadi).

## 3. Tabel baru

- Migrasi v10 `chat/reaction_schema.rs`: `chat_reactions (message_id, author, emoji, conv, active, at, record_id)`, kunci `(message_id, author, emoji)`.
- Migrasi v11 `chat/sticker_schema.rs`: `chat_office_stickers` (turunan `sticker_set`), `chat_my_stickers` (lokal), `chat_sticker_checks` (cache pemeriksaan gambar per hash, lokal).
- Emoji "Sering dipakai": tabel `settings` yang sudah ada, kunci `chat.emoji_recent`, JSON paling banyak 24 emoji terbaru dulu.

Catatan merge: sesi perbaikan bergabung mungkin juga menambah migrasi. Urutannya diatur saat digabung; belum ada yang dirilis.

## 4. Keamanan file sticker (`chat/sticker_file.rs`)

- Jenis ditentukan dari byte file, bukan nama atau klaim rekan: PNG (termasuk APNG), GIF87a/89a, WebP (VP8, VP8L, VP8X). Selain itu ditolak, termasuk SVG dan JPEG. SVG dari pengguna tidak pernah dirender.
- Ukuran file paling besar 512 KB. Lebar dan tinggi 1 sampai 1024 piksel. Animasi paling banyak 120 frame (GIF: hitung image descriptor dengan menelusuri blok; APNG: `acTL.num_frames`; WebP: hitung chunk `ANMF`). Header terpotong atau tidak konsisten ditolak.
- Diperiksa saat unggah (kantor dan pribadi), saat menyimpan dari pesan, dan sebelum gambar diberikan ke WebView (`chat_sticker_image`). Gambar dikirim ke WebView sebagai URL `data:` dengan mime hasil pemeriksaan; CSP tetap `'self'` (sudah mengizinkan `data:` untuk `img-src`). Ukuran tampil dibatasi CSS (160 px, 64 px, 1.5em).
- Path unggahan hanya dari dialog milik Mira (`chat_sticker_pick`, `ChatRuntime::remember_picked`), sama dengan lampiran.
- `chat_sticker_image(hash)` hanya untuk hash yang sticker kantor aktif atau tersembunyi, sticker pribadi saya, atau lampiran pesan sticker di percakapan yang boleh saya baca.

## 5. Kompatibilitas dengan 0.5.0 (`chat/compat.rs`)

- `reaction` dan `sticker_set` hanya ditawarkan ke rekan yang melaporkan versi Mira paling rendah `CHAT_STICKER_SINCE` = 0.5.1 (`members.app_version` dari profil laptop, aturan `min` sama dengan `JOIN_AD_SINCE`). Laptop 0.5.0 menolak jenis record yang tidak dikenal dan mencatatnya di log penolakan setiap sinkron, jadi record itu tidak dikirim ke sana sama sekali.
- Konsekuensi: laptop 0.5.0 tidak melihat reaksi dan tidak punya katalog sticker kantor. Pesan sticker tetap sampai sebagai `:nama:` plus gambar lampiran. Emote `:nama:` di teks tampil sebagai teks.
- Rilis yang membawa fitur ini harus bernomor 0.5.1 atau lebih. Selama build bernomor 0.5.0, ambangnya 0.5.0.

## 6. Perintah Tauri (sudah didaftarkan di `lib.rs`, kontrak di `src/api/chat.ts`)

| Perintah | Metode `ChatSync` | File |
|---|---|---|
| `chat_react(conv, messageId, emoji, on)` | `react` | `reactions.rs` |
| `chat_emoji_used(emoji)` | `emoji_used` | `reactions.rs` |
| `chat_stickers()` → `StickerCatalog` | `stickers` | `stickers.rs` |
| `chat_sticker_image(hash)` → URL `data:` | `sticker_image` | `stickers.rs` |
| `chat_sticker_pick()` → `PickedSticker` atau null | `inspect_picked` | `stickers.rs` |
| `chat_my_sticker_add(path, name, keywords)` | `my_sticker_add` | `stickers.rs` |
| `chat_my_sticker_save(messageId)` | `my_sticker_save` | `stickers.rs` |
| `chat_my_sticker_remove(id)` | `my_sticker_remove` | `stickers.rs` |
| `chat_office_sticker_add(path, pack, name, keywords)` | `office_sticker_add` | `stickers.rs` |
| `chat_office_sticker_update(id, pack, name, keywords, state)` | `office_sticker_update` | `stickers.rs` |
| `chat_send_sticker(conv, source, replyTo)` | `send_sticker` | `stickers.rs` |

Data baru di layar: `MessageView.reactions`, `MessageView.sticker`, `ConversationView.canReact`. Bentuknya di `chat/view.rs` dan `src/api/chat.ts`.

## 7. Layar

- `src/screens/chat/stickerCatalog.ts`: satu salinan katalog untuk semua layar (`useStickerCatalog`, `reloadStickerCatalog`, `officeEmoteMap`).
- `src/screens/chat/StickerImage.tsx`: gambar sticker atau emote dengan cache per hash; `size` `large`, `thumb`, `inline`.
- `src/components/emoji/`: `EmojiPicker` dan data emoji (komponen umum, tidak tahu soal Chat). Kontrak:

```ts
// src/components/emoji/EmojiPicker.tsx
type EmojiPickerProps = {
  onPick: (emoji: string) => void;     // emoji Unicode, atau ":nama:" untuk emote kantor
  onClose: () => void;                 // Esc, klik di luar, atau setelah memilih kalau closeOnPick
  recent: string[];                    // dari StickerCatalog.recentEmoji
  emotes?: { name: string; render: () => React.ReactNode }[]; // emote kantor, tab "Kantor"
  closeOnPick?: boolean;               // bawaan true
  labelledBy?: string;
};
// src/components/emoji/emojiData.ts
export type EmojiEntry = { char: string; id: string; en: string; keywords: string[]; category: EmojiCategory };
export function searchEmoji(query: string, limit?: number): EmojiEntry[]; // id dan en
// src/components/emoji/emojiSuggest.ts
export function emojiQueryAt(text: string, caret: number): { start: number; query: string } | null; // ":nam" sebelum kursor, minimal 2 huruf
```

- Kolom pesan (`Composer.tsx`): tombol Emoji, tombol Sticker (pemilih tab Kantor dan Punya saya, unggah sticker pribadi), saran `:nama` (emoji dan emote kantor) dengan panah, Enter, Tab, Esc.
- Pesan (`MessageItem.tsx`): chip reaksi, tombol reaksi cepat (👍 ❤️ 😂 🙏 😮, lalu "Lainnya"), pesan sticker tanpa gelembung, emote sebaris di teks. Menu pesan: "Beri reaksi" dan "Simpan sticker".
- Organisasi: tab Sticker (`src/screens/org/StickersPanel.tsx`), khusus superadmin: unggah, nama, kata kunci, paket, sembunyikan, tampilkan, hapus.
- Semua bisa dipakai penuh dengan keyboard, fokus terlihat, teks di kamus `.id` dan `.en`.

## 8. Pembagian tugas (file tidak tumpang tindih)

| Tugas | Milik |
|---|---|
| Kerangka (selesai, session utama) | `model.rs`, `judge.rs`, `store/mod.rs`, `audience.rs`, `view.rs`, `read.rs`, `compat.rs`, `commands.rs`, `mod.rs`, `tests/mod.rs`, `lib.rs`, `db/migrations.rs`, `src/api/chat.ts`, `stickerCatalog.ts`, `StickerImage.tsx`, `sticker-image.css` |
| R1 reaksi (Rust) | `chat/reactions.rs`, `chat/reaction_schema.rs`, `chat/tests/reactions.rs` |
| R2 sticker (Rust) | `chat/stickers.rs`, `chat/sticker_schema.rs`, `chat/sync.rs` (bagian blob), `chat/fetch.rs`, `chat/service.rs`, `chat/files.rs`, `chat/tests/stickers.rs`, `src/i18n/errors-rust.{id,en}.ts` |
| V validasi file (Rust) | `chat/sticker_file.rs` |
| U1 pemilih emoji | `src/components/emoji/*`, `src/i18n/emoji.{id,en,}.ts` |
| U2 kolom pesan dan pemilih sticker | `Composer.tsx`, `Composer.test.tsx`, `StickerPicker.tsx`, `sticker-picker.css`, `src/i18n/chat-sticker.{id,en}.ts` |
| U3 reaksi dan pesan sticker | `MessageItem.tsx`, `MessageList.tsx`, `Conversation.tsx`, `ReactionBar.tsx`, `reactions.css`, `menuText.ts`, `src/i18n/chat-menu.{id,en}.ts`, `src/i18n/chat-reaction.{id,en}.ts`, tes pesan |
| U4 panel sticker kantor | `src/screens/org/StickersPanel.tsx` (+ tes, css), `src/i18n/org-stickers.{id,en}.ts`, baris pendaftaran tab di `OrgScreen.tsx` |
| U5 semua label di Chat | `NameWithLabels.tsx` (+css, tes), `PersonName.tsx`, `ConversationHeader.tsx`, `GroupMembers.tsx`, `ProjectMembers.tsx`, `ProfileDialog.tsx`, `ConversationList.tsx` |
| E2E | `scripts/sticker-e2e.mjs` |

## 9. Selesai berarti

`cargo test`, `cargo clippy --all-targets -- -D warnings`, `npx tsc --noEmit`, `npx vitest run` lulus; tes sinkron reaksi bersamaan dan validasi file; `scripts/sticker-e2e.mjs` (beberapa instance); `chat-e2e`, `e2e-fitur-multi`, `english-e2e`, `contextmenu-e2e` tetap lulus; screenshot terang/gelap, Indonesia/Inggris di `docs/progress/screenshots/chat-sticker/`; laporan.
