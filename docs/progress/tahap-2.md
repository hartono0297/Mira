# Laporan Tahap 2: Chat dasar

Tanggal: 22 November 2026. Branch `claude/tahap-2-chat-f36a9d`, dari `main` 63eb72b. Rencana: `docs/plans/tahap-2.md`.

## Ringkasan

Chat sudah bisa dipakai di satu laptop: channel #umum, channel tim, channel proyek, channel baru, chat pribadi, balas, mention, lampiran, status pesan, hapus pesan, arsip dan hapus channel, serta pengaturan notifikasi. Pengiriman ke laptop rekan memakai kontrak sinkron fitur (`network/feature.rs`). Karena transport sungguhan dikerjakan sesi lain, perpindahan data antarlaptop di branch ini dibuktikan dengan tes in-memory tiga laptop, termasuk titipan yang diteruskan laptop ketiga setelah laptop pengirim dimatikan.

HASIL_RINGKAS

## Yang dibuat

**Inti chat (`src-tauri/src/chat/`)**
- Semua data chat adalah record bertanda tangan kunci laptop di topik `chat`: buat, arsip, dan hapus channel; pesan; hapus pesan; tanda terima (diterima dan dibaca); titipan dan tanda serah titipan.
- Body record harus bentuk JSON baku, sehingga laptop perantara tidak bisa membuat id baru untuk record yang sama. Id channel diturunkan dari pembuat dan isi record, jadi tidak bisa dipilih untuk menabrak #umum, channel tim, atau channel proyek.
- Pembatasan data per laptop rekan (`record_ids_for`, `records_for`): channel tim hanya ke anggota tim, channel proyek ke anggota proyek (termasuk Tamu yang diizinkan), chat pribadi hanya ke dua orangnya, laptop yang dikeluarkan tidak menerima apa pun. Titipan tersegel boleh dipegang semua anggota aktif.
- Setiap record dari rekan diperiksa: format, organisasi, tanda tangan, waktu, dan hak pembuatnya. Yang gagal format atau tanda tangan dicatat di `rejected_changes` dengan kode `chat_*`. Yang belum bisa dinilai (misalnya pembuat belum tercatat di tim menurut laptop ini) tidak disimpan dan ditawarkan lagi di sinkron berikutnya.
- Status pesan: Menunggu, Dititipkan, Diterima laptopnya, Dibaca. Channel menampilkan jumlahnya, misalnya "Dibaca 2 dari 5".
- Hapus pesan menyisakan "Pesan dihapus" dan isi record pesan dihapus dari semua laptop. Hapus channel menghapus semua pesannya. #umum tidak bisa diarsip atau dihapus.
- Lampiran disimpan di blob store BLAKE3 Tahap 4. File sampai sekitar 20 MB diunduh otomatis oleh anggota percakapan; file lebih besar diunduh saat diklik dari laptop mana pun yang punya salinannya. Chat hanya menyajikan dan menghapus blob yang ia buat sendiri, tidak pernah file dokumen atau tanda tangan.
- Notifikasi Windows untuk pesan baru saat jendela Mira tidak di depan. Bisa diatur per orang (Semua, Hanya chat pribadi dan mention, Mati) dan per percakapan (bisukan).
- Migrasi SQLite v6 (satu entri di akhir `MIGRATIONS`).
- Perintah Tauri di `chat/commands.rs`, runtime (hooks, notifikasi, pengunduh lampiran, registrasi ke `FeatureHub`) di `chat/runtime.rs`. Di `lib.rs` hanya `pub mod chat`, satu blok `ChatRuntime::install`, dan 16 perintah di `generate_handler!`.

**Titipan**
- Saat mengirim, untuk setiap anggota percakapan yang laptopnya tidak tersambung, laptop pengirim membuat satu titipan: record pesan yang sudah ditandatangani, disegel untuk kunci penerima.
- Konversi kunci: kunci publik Ed25519 penerima dipetakan ke X25519 (`to_montgomery`, sama dengan `crypto_sign_ed25519_pk_to_curve25519` libsodium). Kunci rahasia: 32 byte pertama SHA-512 dari seed lalu di-clamp (sama dengan `crypto_sign_ed25519_sk_to_curve25519`). Hasilnya dicek dengan vektor uji resmi libsodium. Kunci penerima berorde kecil ditolak.
- Format segel: sealed box `crypto_box` (kunci X25519 sementara + XSalsa20-Poly1305, susunan `crypto_box_seal` libsodium: kunci sementara 32 byte, lalu isi dan tag 16 byte), lalu base64. Isi yang disegel: `mira-seal-v1\n` + JSON `{"v":1,"record":...,"files":[...]}`.
- Lampiran kecil dienkripsi sekali dengan XChaCha20-Poly1305 kunci acak (`nonce 24 byte || ciphertext`). File sandinya dipegang laptop perantara; kuncinya hanya ada di dalam segel. File besar tidak ikut dititipkan.
- Laptop perantara tidak bisa membaca isi titipan. Penerima membuka titipan, memeriksa record di dalamnya seperti record biasa, mengunduh dan membuka file sandi, lalu menerbitkan tanda serah. Semua laptop yang menerima tanda serah menghapus isi titipan dan file sandinya. Tanda serah hanya dihitung kalau dibuat penerima titipan itu. Titipan kedaluwarsa setelah 30 hari atau kalau penerimanya dikeluarkan.

**Channel proyek (titik sambung)**
- Trait `ProjectAudience` di `chat/audience.rs` menjawab "siapa boleh di channel proyek ini". Implementasi sementara `BoardTeamAudience`: proyek dengan tim berarti anggota tim itu ditambah Tamu dari `guest_access` untuk proyek itu; proyek tanpa tim berarti semua anggota aktif bukan Tamu ditambah Tamu dari `guest_access`.

**Layar Chat (`src/screens/chat/`)**
- Daftar channel (dengan petunjuk tim atau proyek), chat pribadi, dan bagian Diarsipkan yang terlipat. Lencana belum dibaca dan mention, navigasi panah, keadaan memuat, kosong, dan error.
- Percakapan: pemisah hari, jam gaya Indonesia, pesan berurutan dikelompokkan, mention disorot, kutipan balasan, kartu file per keadaan (Buka, Simpan, Unduh, Mengunduh, Belum tersedia), status pesan dengan rincian per orang, "Pesan dihapus".
- Komposer: Enter kirim, Shift+Enter baris baru, lampirkan file, balas, saran mention dengan `@`, alasan kalau tidak bisa mengirim (misalnya channel diarsipkan), dan peringatan di chat pribadi kalau rekan sedang offline.
- Dialog channel baru, chat pribadi baru, dan pengaturan notifikasi. Menu di kepala percakapan: bisukan, arsipkan atau kembalikan, hapus channel.
- Muat ulang saat event `mira://feature` bertopik `chat`, ditambah polling cadangan setiap 10 detik.
- Semua warna lewat token tema Bata, kontras dicek AA di mode terang dan gelap, fokus terlihat, tanpa em dash.

## Keputusan yang saya ambil sendiri

| Keputusan | Alasan |
|---|---|
| Channel "Seluruh kantor" hanya bisa dibuat superadmin. Anggota membuat channel untuk tim atau proyeknya. | PRD F-CHAT-01 menyebut "channel di timnya"; keputusan "semua anggota boleh membuat channel" tetap berlaku untuk tim dan proyek. |
| Setiap proyek board otomatis punya channel proyek. | Supaya Tamu yang diundang ke proyek langsung punya tempat bicara. |
| Tamu boleh memegang titipan tersegel, sesuai keputusan Anda. Titipan hanya boleh dibuat antara dua anggota yang berbagi percakapan. | Mengikuti keputusan user, dengan batas supaya Tamu tidak bisa menitipkan ke sembarang orang. |
| Membuka lampiran yang bisa menjalankan program (.exe, .lnk, .js, .html, dan sejenisnya) ditolak; file seperti itu hanya bisa disimpan. File yang dibuka diberi tanda "dari jaringan" (Mark of the Web) supaya Office membukanya di Protected View. | Hasil review keamanan: nama file seperti `Laporan.pdf.exe` bisa menipu. |
| Dialog pilih file dan simpan file dijalankan di sisi Rust. `chat_send` hanya menerima path yang dipilih lewat dialog itu. | Skrip di webview tidak bisa menyuruh Mira membaca atau menulis file sembarangan. |
| Status gabungan pesan channel diambil dari penerima dengan status paling rendah. | Sederhana dan jujur: "Dibaca" berarti semua sudah membaca. |
| Pesan di channel yang hanya berisi saya dianggap "Diterima laptopnya" dan statusnya tidak ditampilkan. | Tidak ada penerima lain. |
| Notifikasi tidak muncul kalau jendela Mira sedang di depan. | Pesannya sudah terlihat atau tinggal satu klik. |

KEPUTUSAN_TAMBAHAN

## Hasil uji (apa adanya)

HASIL_UJI

## Titik sambung

- **Transport (sesi sinkron fitur):** `ChatSync` sudah terdaftar di `FeatureHub` sebagai `FeatureSync` dan `BlobSource`. Begitu transport memasang link sungguhan dengan `set_link`, chat ikut tersinkron tanpa perubahan. Yang perlu diketahui transport:
  - `ingest` bisa membuat record baru (tanda terima, tanda serah) dan memanggil `notify_changed("chat")` dari dalamnya. Hooks dipanggil setelah kunci database dilepas.
  - `peer_connected` membangunkan pengunduh lampiran.
  - Pengunduh memanggil `FeatureHub::fetch_blob(hash, size, prefer, tmp)` lalu `fetch_done` atau `fetch_failed`.
  - `send` membaca `connected_peers()` untuk memutuskan siapa yang perlu titipan. Dengan `OfflineLink` semua penerima dianggap offline, jadi setiap pesan ke rekan membuat titipan sampai transport tersambung.
  - Chat juga mengirim event `mira://feature` dengan payload `{"topic":"chat"}` untuk perubahan lokal, dengan nama dan bentuk yang sama dengan event transport.
- **Sinkron board (akses Tamu per proyek):** ganti `BoardTeamAudience` dengan implementasi `ProjectAudience` yang membaca akses Tamu per proyek dari log keanggotaan.
- **Kontrak `network/feature.rs`:** tidak diubah. Tidak ada kebutuhan yang memaksa perubahan. Usulan untuk nanti: cara bagi feature untuk tahu bahwa laptop lain benar-benar menyimpan record (supaya "Dititipkan" berarti sudah tersimpan, bukan baru diserahkan).

## Catatan merge

- Migrasi chat adalah entri terakhir `MIGRATIONS` (v6 di branch ini). Tes migrasi dokumen kini juga menghapus tabel chat dan mengharapkan versi 6; sesuaikan nomornya saat urutan final ditentukan.
- `lib.rs`: `pub mod chat;`, blok `ChatRuntime::install` setelah `SignSessions`, dan 16 perintah `chat::commands::*`. `ChatRuntime::install` butuh `MiraState` dan `Arc<FeatureHub>` sudah di-manage sebelumnya.
- `Cargo.toml`: `crypto_box = { version = "0.9.1", features = ["seal"] }` di dependencies dan `curve25519-dalek = "4"` di dev-dependencies.
- `Shell.tsx` tidak diubah; `ChatScreen()` tetap tanpa props.
- `permissions/`, `network/feature.rs`, `node.rs`, `wire.rs`, dan `design/` tidak diubah.

## Belum dicek atau masih terbatas

BELUM
