# Rencana Tahap 2: Chat dasar

Tanggal: 22 November 2026. Branch `claude/tahap-2-chat-f36a9d`, dari `main` 63eb72b.

Sumber: `design/rencana-pembangunan.html` (Tahap 2), `design/prd-mira.html` (F-CHAT-01 sampai 07, F-UI), `design/brainstorming.html` (chat, titipan), `design/tema-c.html`, kontrak `src-tauri/src/network/feature.rs`.

Selesai kalau: pesan ke rekan yang laptopnya mati sampai lewat titipan begitu laptopnya menyala, walaupun laptop pengirim sudah dimatikan. Di branch ini dibuktikan dengan tes in-memory tiga laptop (`network::feature::testing`), karena transport sungguhan dikerjakan sesi lain.

## 1. Gambaran

Semua data chat adalah record `FeatureRecord` di topik `chat`. Setiap record ditandatangani kunci Ed25519 laptop pembuatnya. Laptop menyimpan record di tabel `chat_records` dan menurunkan tabel tampilan (`chat_channels`, `chat_messages`, `chat_receipts`, `chat_envelopes`) secara bertahap saat record diterima.

```
src-tauri/src/chat/
  mod.rs        modul, konstanta, re-export
  model.rs      format record, tanda tangan, id percakapan, validasi (pure)
  seal.rs       titipan: konversi kunci Ed25519 ke X25519, sealed box, enkripsi file (pure)
  schema.rs     migrasi v6
  audience.rs   siapa boleh di percakapan mana (termasuk trait ProjectAudience)
  store.rs      tulis dan baca record, penerapan ke tabel turunan, titipan, tanda terima
  sync.rs       impl FeatureSync dan BlobSource
  hooks.rs      trait ChatHooks (notify jaringan, event UI, notifikasi Windows, antrean unduh)
  fetch.rs      antrean unduh lampiran (lokal) dan pemrosesannya
  view.rs       bentuk data untuk layar (serde camelCase)
  commands.rs   perintah Tauri
  runtime.rs    ChatRuntime: hooks versi Tauri, tugas latar unduh, registrasi ke FeatureHub
  testutil.rs   laptop uji (cfg(test))
  tests/        tes konvergensi tiga laptop dan pembatasan
```

## 2. Format record

Body record adalah JSON `{"payload":"<string JSON>","sig":"<128 hex>"}`. Tanda tangan Ed25519 atas `"mira-chat-v1\n" + payload`. Id record = BLAKE3 body (kontrak). Payload:

```json
{ "v": 1, "org": "<32 hex>", "author": "<64 hex>", "at": "<RFC 3339 UTC>", "nonce": "<32 hex>", "body": { "kind": "...", ... } }
```

Jenis `body`:

| kind | Isi | Siapa boleh membuat |
|---|---|---|
| `channel_create` | `channel` (32 hex), `name`, `scope` (`{"kind":"org"}`, `{"kind":"team","id":..}`, `{"kind":"project","id":..}`) | Anggota aktif bukan Tamu. Tim: anggota tim itu. Proyek: anggota proyek itu. |
| `channel_archive` | `conv`, `archived` (bool) | Admin percakapan (lihat 4) |
| `channel_delete` | `conv` | Admin percakapan |
| `message` | `conv`, `text`, `reply_to` (id pesan, opsional), `mentions` (kunci), `files` (`hash`, `size`, `name`, `mime`) | Anggota percakapan |
| `message_delete` | `conv`, `message`, `message_author`, `message_at` | Pembuat pesan, atau admin percakapan (bukan di chat pribadi) |
| `receipt` | `conv`, `state` (`delivered` atau `read`), `messages` (1 sampai 500 id) | Anggota percakapan, untuk pesan orang lain |
| `envelope` | `to` (kunci penerima), `sealed` (base64), `cipher_files` (`hash`, `size`) | Anggota aktif mana pun; penerima harus anggota aktif |
| `envelope_ack` | `envelope` (id record titipan) | Hanya penerima titipan itu |

Batas: teks pesan 1 sampai 8000 karakter (boleh kosong kalau ada file), nama channel 1 sampai 40 karakter `a-z 0-9 -`, nama file 1 sampai 200 karakter tanpa `\ / : * ? " < > |` dan karakter kontrol, maksimal 10 file per pesan, ukuran file 1 byte sampai 2 GiB, `mentions` maksimal 50, `at` harus bisa dibaca dan tahun 2020 sampai 2100.

## 3. Percakapan (`conv`)

- Channel: `ch:<32 hex>`. Sumbernya tiga: tabel `channels` dari log keanggotaan (`#umum` dengan `team_id` NULL dan channel tim), channel proyek otomatis (`ch:<id proyek board>`), dan record `channel_create`.
- Chat pribadi: `dm:<kunci kecil>:<kunci besar>` (dua kunci 64 hex diurutkan). Keduanya harus anggota aktif bukan Tamu, dan tidak boleh sama.

## 4. Siapa boleh menerima dan siapa admin

Anggota percakapan (audience), selalu hanya anggota organisasi yang `status = active`:

| Percakapan | Audience | Admin (arsip, hapus channel, hapus pesan orang lain) |
|---|---|---|
| `#umum` | semua anggota aktif bukan Tamu | tidak bisa diarsip atau dihapus; hapus pesan: superadmin |
| channel org buatan anggota | semua anggota aktif bukan Tamu | superadmin |
| channel tim | anggota tim itu (`team_members`, tim tidak dihapus) | superadmin yang anggota tim, atau admin tim itu |
| channel proyek | `ProjectAudience::is_member` | superadmin, atau admin tim pemilik proyek |
| chat pribadi | dua orang itu | tidak ada; hapus pesan hanya pembuatnya |

`ProjectAudience` (titik sambung, `audience.rs`): implementasi sementara `BoardTeamAudience` membaca `board_projects.team_id`. Proyek dengan tim: anggota tim itu ditambah Tamu dari `guest_access` untuk proyek itu. Proyek tanpa tim: semua anggota aktif bukan Tamu ditambah Tamu dari `guest_access`. Sesi sinkron board yang menambah akses Tamu per proyek tinggal mengganti implementasinya.

`record_ids_for(peer)` dan `records_for(peer, ids)`:
- peer bukan anggota aktif: kosong.
- record percakapan (`channel_*`, `message`, `message_delete`, `receipt`): hanya kalau peer anggota percakapannya sekarang.
- `envelope` yang belum di-ack dan `envelope_ack`: semua anggota aktif, termasuk Tamu (isi titipan tersegel).
- record yang sudah dipurge (pesan dihapus, isi channel dihapus, titipan yang sudah diserahkan): tidak pernah dikirim.
- Urutan: `channel_create` dulu, lalu urut `at`, supaya satu batch bisa diterapkan berurutan.

`ingest(from, records)` per record: parse, cek versi dan organisasi, cek tanda tangan, cek format, cek hak pembuat menurut tabel di atas. Pembuat yang sudah dikeluarkan masih diterima kalau `at` record sebelum `removed_at`-nya. Record yang gagal karena format atau tanda tangan dicatat lewat `permissions::log_rejection` dengan kode `chat_*`. Record yang belum bisa dinilai (channel belum dikenal, pembuat belum tercatat di tim menurut log keanggotaan laptop ini) tidak disimpan dan tidak dicatat; akan ditawarkan lagi pada sinkron berikutnya. Duplikat diabaikan. Idempoten.

## 5. Titipan

Saat mengirim pesan, untuk setiap anggota percakapan selain diri sendiri yang tidak ada di `FeatureHub::connected_peers()`, laptop pengirim membuat satu record `envelope`.

Kriptografi (`seal.rs`):
- Kunci publik penerima Ed25519 diubah ke X25519 dengan `VerifyingKey::to_montgomery()` (peta birasional Edwards ke Montgomery, sama dengan `crypto_sign_ed25519_pk_to_curve25519` libsodium).
- Kunci rahasia: `SigningKey::to_scalar_bytes()` (32 byte pertama SHA-512 dari seed, sama dengan `crypto_sign_ed25519_sk_to_curve25519`).
- Isi disegel dengan sealed box `crypto_box` (X25519 sementara + XSalsa20-Poly1305, format libsodium `crypto_box_seal`): hanya pemegang kunci rahasia penerima yang bisa membuka. Laptop yang dititipi hanya melihat kunci penerima, ukuran, dan waktu.
- Isi yang disegel: JSON `{"v":1,"record":"<body record message>","files":[{"hash":..,"cipher":..,"key":"<64 hex>"}]}` diawali domain `"mira-seal-v1\n"`.
- Lampiran kecil (sampai `blobs::AUTO_REPLICATE_MAX_BYTES`) dienkripsi sekali dengan XChaCha20-Poly1305 kunci acak: file sandi = `nonce 24 byte || ciphertext`. File sandi disimpan di blob store dengan hash-nya sendiri dan dipakai bersama oleh semua titipan pesan itu. Kuncinya ada di dalam segel. File besar tidak ikut dititipkan.

Alur:
1. A mengirim ke C yang offline: pesan disimpan, `envelope` untuk C dibuat. Status di A: "Menunggu".
2. B (anggota mana pun) menarik `envelope` dari A. Saat `records_for(B, ..)` menyerahkan titipan ke laptop selain penerima, A menandainya `deposited` secara lokal. Status di A: "Dititipkan". B ikut mengunduh file sandinya.
3. A mati. C menyala dan tersambung ke B. B menawarkan titipan, C membukanya, memeriksa record di dalamnya seperti record biasa (tanda tangan, pembuat sama dengan pembuat titipan, hak), menyimpannya, mengunduh file sandi dari B lalu mendekripsinya.
4. Setelah pesan dan filenya beres, C membuat `envelope_ack` dan tanda terima `delivered`. Laptop mana pun yang menerima `envelope_ack` menghapus isi titipan (baris disisakan tanpa body sebagai penanda supaya tidak diterima lagi) dan file sandi yang tidak dipakai titipan lain.
5. Tanda terima `delivered` sampai ke A lewat anggota percakapan. Status "Diterima laptopnya", lalu "Dibaca" setelah C membuka percakapannya.

## 6. Status pesan dan tanda terima

- Saat menerima pesan dari orang lain (langsung atau dari titipan), laptop membuat satu `receipt` `delivered` per percakapan per batch.
- `chat_mark_read(conv)` membuat `receipt` `read` untuk pesan orang lain yang belum dibaca.
- Status pesan milik sendiri dihitung per penerima (anggota percakapan sekarang selain diri sendiri): `read` > `delivered` > `deposited` (titipan untuknya sudah dititipkan dan belum di-ack) > `pending`. Status gabungan = yang paling rendah. Tampilan: Dibaca, Diterima laptopnya, Dititipkan, Menunggu. Channel menampilkan jumlah, misalnya "Dibaca 2 dari 5".
- Belum dibaca = pesan orang lain tanpa `receipt read` dari diri sendiri.

## 7. Hapus

- `message_delete`: isi pesan dan daftar file dihapus dari `chat_messages`, body record pesan dihapus dari `chat_records` (baris tetap sebagai penanda), tampilan menunjukkan "Pesan dihapus". Kalau hapus tiba sebelum pesannya, baris penanda dibuat dari `message_author` dan `message_at`, dan pesan yang datang belakangan langsung dihapus.
- `channel_delete`: semua pesan dan tanda terima percakapan itu dipurge, channel disembunyikan. `#umum` tidak bisa dihapus.
- `channel_archive`: channel pindah ke bagian "Diarsipkan", tidak bisa dikirimi pesan sampai dikembalikan.

## 8. Lampiran

- Kirim: file dipilih lewat dialog, disalin ke blob store (`put_file`), dicatat di pesan.
- Terima: file kecil masuk antrean unduh lokal (`chat_fetch_queue`) dan diunduh otomatis lewat `FeatureHub::fetch_blob` (mencoba pembuat pesan dan laptop pengirim batch lebih dulu). File besar diunduh saat diklik (`chat_file_download`).
- `BlobSource::blob_path_for(peer, hash)` (diperketat setelah review): chat hanya menyajikan blob yang ia buat atau unduh sendiri. Setiap blob mencatat percakapan asalnya (dikirim laptop ini, diunduh untuk pesan di percakapan itu, atau dibuka dari titipan). File biasa hanya ke anggota percakapan asal selama masih ada pesan di sana yang memuatnya; blob yang sudah ada di blob store sebelum chat menyentuhnya (misalnya file dokumen) hanya disajikan kalau laptop ini sendiri melampirkannya. File sandi titipan hanya kalau dibuat chat dan masih tercantum di titipan yang belum diserahkan.
- Antrean dicoba lagi saat `peer_connected` dan setiap 60 detik.

## 9. Notifikasi Windows

Saat `ingest` menerima pesan baru dari orang lain, `ChatHooks::notify_message` dipanggil kalau: pengaturan `chat.notify` (`all` bawaan, `mentions`, `off`) mengizinkan, percakapan tidak dibisukan (`chat_conv_settings.muted`), dan jendela Mira tidak sedang fokus. Chat pribadi dan mention dihitung sebagai "mentions". Isi notifikasi: nama pengirim dan nama percakapan, ditambah potongan teks maksimal 120 karakter.

## 10. Perintah Tauri dan event

Semua perintah di `chat/commands.rs`, data camelCase. Setiap perubahan lokal memanggil `FeatureHub::notify_changed("chat")` dan mengirim event `mira://feature` dengan payload `{"topic":"chat"}` (nama dan bentuk event sama dengan yang akan dikirim transport).

| Perintah | Argumen | Hasil |
|---|---|---|
| `chat_overview` | | `ChatOverview` |
| `chat_messages` | `conv`, `before?` (id pesan), `limit?` | `ConversationView` |
| `chat_send` | `conv`, `text`, `replyTo?`, `mentions`, `files` (path) | `MessageView` |
| `chat_delete_message` | `conv`, `messageId` | null |
| `chat_mark_read` | `conv` | null |
| `chat_create_channel` | `name`, `scope` | `ConversationSummary` |
| `chat_set_archived` | `conv`, `archived` | null |
| `chat_delete_channel` | `conv` | null |
| `chat_open_dm` | `publicKey` | `ConversationSummary` |
| `chat_message_receipts` | `messageId` | `ReceiptView[]` |
| `chat_file_open` | `messageId`, `hash` | null (nama dari pesan itu; salin ke `<data>/chat-files/<hash>/<nama>`, beri Mark of the Web, lalu buka; file yang bisa menjalankan program ditolak) |
| `chat_file_save` | `hash` | boolean (dialog Simpan dibuka di sisi Rust; false kalau dibatalkan) |
| `chat_pick_files` | | `PickedFile[]` (dialog pilih file di sisi Rust; hanya path dari sini yang diterima `chat_send`) |
| `chat_file_download` | `hash` | `FileView` |
| `chat_set_notify` | `mode` | null |
| `chat_set_muted` | `conv`, `muted` | null |

Tipe TypeScript lengkap ada di `src/api/chat.ts` (sumber kebenaran kontrak; Rust `view.rs` mengikutinya).

## 11. Migrasi v6

Satu entri di akhir `MIGRATIONS`: `crate::chat::schema::CHAT_SCHEMA`. Tabel: `chat_records`, `chat_channels`, `chat_messages`, `chat_receipts`, `chat_envelopes`, `chat_fetch_queue`, `chat_conv_settings`. Nomor final ditentukan saat merge.

## 12. Layar Chat

`src/screens/chat/` menggantikan keadaan kosong Tahap 0. Kiri: daftar Channel (dikelompokkan: #umum dan org, tim, proyek), Pesan pribadi, Diarsipkan (terlipat), tombol "Channel baru" dan "Pesan baru". Kanan: kepala percakapan (nama, cakupan, menu arsip, hapus, bisukan), daftar pesan (nama, jam, teks dengan mention disorot, kutipan balasan, kartu file, status untuk pesan sendiri, "Pesan dihapus"), komposer (lampirkan file, balas, mention dengan `@`, Enter kirim, Shift+Enter baris baru). Keadaan memuat, kosong, dan error di setiap panel. Muat ulang saat event `mira://feature` dengan `topic` `chat`, plus polling cadangan. Token tema Bata, ikon Tabler, Radix Dialog, tanpa em dash, fokus terlihat, kontras dicek.

## 13. Tugas dan pembagian kerja

Semua tugas TDD: tulis tes dulu, lihat gagal, implementasi, lihat lulus.

1. (utama) Rencana ini, kerangka modul, `model.rs` lengkap dengan tes, kontrak TypeScript `src/api/chat.ts`. Commit.
2. (subagent, worktree sendiri) `seal.rs`: konversi kunci, segel dan buka titipan, enkripsi file, tes vektor libsodium dan proptest.
3. (subagent, worktree sendiri) `schema.rs`, `audience.rs`, `store.rs`, `sync.rs`, `fetch.rs`, `hooks.rs`, `testutil.rs`, `tests/`: inti sinkron dan tes tiga laptop.
4. (subagent, worktree utama) UI daftar percakapan dan kerangka layar.
5. (subagent, worktree utama) UI percakapan, pesan, dan komposer.
6. (utama, setelah 2 dan 3 digabung) `view.rs`, `commands.rs`, `runtime.rs`, registrasi di `lib.rs`.
7. (subagent) Review keamanan dan review tampilan, paralel.
8. (utama) Uji ujung ke ujung satu laptop `scripts/chat-e2e.mjs`, screenshot terang dan gelap, laporan `docs/progress/tahap-2.md`.

## 14. Kebutuhan ke kontrak (untuk sesi transport)

- Ingest yang ingin membuat record baru (tanda terima, ack) memanggil `notify_changed` dari dalam `ingest`. Hub dipegang lewat `Weak<FeatureHub>` di `ChatHooks` supaya tidak ada siklus `Arc`.
- Event `mira://feature` dikirim juga oleh modul chat untuk perubahan lokal dan unduhan yang selesai.
