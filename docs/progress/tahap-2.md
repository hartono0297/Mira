# Laporan Tahap 2: Chat dasar

Tanggal: 22 November 2026. Branch `claude/tahap-2-chat-f36a9d`, dari `main` 63eb72b. Rencana: `docs/plans/tahap-2.md`.

## Ringkasan

Chat sudah bisa dipakai di satu laptop: channel #umum, channel tim, channel proyek, channel baru, chat pribadi, balas, mention, lampiran, status pesan, hapus pesan, arsip dan hapus channel, serta pengaturan notifikasi. Pengiriman ke laptop rekan memakai kontrak sinkron fitur (`network/feature.rs`). Karena transport sungguhan dikerjakan sesi lain, perpindahan data antarlaptop di branch ini dibuktikan dengan tes in-memory tiga laptop, termasuk titipan yang diteruskan laptop ketiga setelah laptop pengirim dimatikan.

Semua tes lulus: `cargo test` 615 (83 di antaranya tes chat), Vitest 453, clippy tanpa peringatan, dan uji ujung ke ujung satu laptop 19 dari 19. Yang belum: uji di beberapa laptop sungguhan, karena transport jaringan untuk fitur belum digabung. Rinciannya ada di bawah.

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

| Record yang belum bisa dinilai (pembuat belum tercatat di tim menurut laptop ini, channel belum dikenal) ditunda, tidak ditolak. Balasan ke percakapan lain, hapus dengan pembuat salah, dan tanda serah dari bukan penerima disimpan tapi tidak berefek. | Supaya semua laptop menyimpan himpunan record yang sama dan log `rejected_changes` tidak penuh oleh record yang terus ditawarkan ulang. |
| Arsip channel memakai aturan "yang terakhir menang" dan hanya membatasi pengiriman dari laptop sendiri. Pesan yang masuk ke channel yang diarsipkan tetap diterima. | Kalau ditolak saat diterima, laptop yang belum tahu arsipnya akan berbeda isi selamanya. |
| Status "Diterima laptopnya" lewat titipan dihitung dari tanda serah penerima, kecuali penerima melaporkan titipan gagal dibuka. | Pengirim yang sudah mati lalu menyala lagi tetap tahu pesannya sampai. |

## Hasil uji (apa adanya)

| Pemeriksaan | Hasil |
|---|---|
| `cargo test` (di `src-tauri`) | 615 lulus, 0 gagal, 7 diabaikan (sama dengan sebelumnya: keyring sungguhan, firewall, mDNS) |
| Tes chat saja (`cargo test --lib chat::`) | 83 lulus |
| `cargo clippy --all-targets` | 0 peringatan |
| `rustfmt --check` file chat | bersih |
| `npx tsc --noEmit` | tanpa error |
| Vitest (`npx vitest run --maxWorkers=1`) | 34 file, 453 tes lulus (75 tes layar chat) |
| Uji ujung ke ujung chat (`scripts/chat-e2e.mjs`, build debug, satu laptop) | 19 dari 19 lulus |

Catatan Vitest: saat mesin sibuk build Rust, worker Vitest kadang gagal mulai (batas 60 detik) dan satu tes `NetworkPanel` sempat gagal karena waktu. Dijalankan ulang dengan `--maxWorkers=1`, semuanya lulus.

Tes konvergensi dan pembatasan tiga laptop (in-memory lewat `network::feature::testing`), semuanya lulus:
- Tiga laptop di #umum mendapat pesan dan tanda terima yang sama, dan status dihitung benar.
- Isi channel tim tidak pernah sampai ke laptop di luar tim, walaupun anggota tim ikut meneruskan.
- **Titipan:** A mengirim chat pribadi ke C yang offline. Hanya A dan B yang tersambung, lalu A dimatikan. B dan C tersambung: C menerima dan membaca pesan, B tidak pernah punya teks atau file aslinya (diperiksa sampai ke file database dan WAL). C menerbitkan tanda serah, B menghapus titipan. A menyala lagi, sinkron dengan B, dan melihat "Diterima laptopnya".
- Titipan dengan lampiran kecil: file sandi lewat B, dibuka di C, lalu dihapus dari B setelah tanda serah.
- Tamu hanya menerima channel proyek yang diizinkan, tidak bisa chat pribadi atau dikirimi chat pribadi, dan boleh memegang titipan tersegel.
- Anggota yang dikeluarkan tidak mendapat apa pun. Record buatannya setelah dikeluarkan ditolak, sebelum dikeluarkan diterima.
- Record palsu, tanda tangan salah, organisasi lain, dan body yang di-encode ulang ditolak dan dicatat. Menerima batch yang sama dua kali tidak mengubah apa pun.
- Hapus pesan sampai ke semua laptop sebagai "Pesan dihapus", termasuk kalau hapusnya datang lebih dulu. Hapus palsu sebelum pesannya datang tidak menghapus pesan.
- Hak arsip dan hapus channel diperiksa. #umum tidak bisa diarsip atau dihapus.
- Laptop tidak menyajikan file dokumen atau file tim ke orang yang tidak berhak, walaupun hash-nya disebut di pesan atau titipan.
- Proptest: urutan tarik acak di antara tiga laptop selalu berakhir dengan pesan dan status yang sama.
- Segel: vektor uji resmi libsodium untuk konversi kunci cocok byte demi byte, kunci berorde kecil ditolak, dan setiap byte yang diubah membuat segel tidak bisa dibuka.

Uji ujung ke ujung (satu laptop, aplikasi sungguhan lewat DevTools Protocol, `MIRA_DATA_DIR` dan `MIRA_PORT=47870` di folder sementara, mDNS dimatikan):
- #umum terpilih otomatis.
- Kirim dengan Enter, Shift+Enter untuk baris baru, dan balasan dengan kutipan.
- `chat_send` dengan path yang tidak dipilih lewat dialog ditolak.
- Buat channel `#proyek-a`, lalu hapus pesan sampai muncul "Pesan dihapus".
- Arsip channel mengunci kolom pesan, lalu channel dikembalikan.
- Pengaturan notifikasi tersimpan.
- Setelah restart semuanya tetap ada.
- Kunci uji di Credential Manager dan folder data dihapus di akhir.

Review dilakukan empat subagent terpisah:
- **Keamanan desain:** satu temuan kritis (laptop perantara bisa memberi id baru pada record yang sama) dan tujuh tinggi (id channel bisa ditabrakkan, hapus palsu sebelum pesan datang, tanda serah palsu, file dari fitur lain bisa ikut terhapus, membuka file bisa menjalankan program, path dari webview dipercaya). Semuanya sudah diperbaiki kecuali yang dicatat di bawah.
- **Segel:** dua bug nyata diperbaiki. Kunci penerima yang tidak aman (orde kecil) diterima, dan kunci rahasia tidak di-clamp seperti libsodium.
- **Kode inti setelah digabung:** dua temuan tinggi diperbaiki (blob yang bukan milik chat ikut disajikan, cabang titipan menyajikan blob sembarang) beserta temuan sedang dan rendah.
- **Tampilan:** istilah diseragamkan ("chat pribadi"), navigasi panah di daftar, pengumuman pesan baru untuk pembaca layar, dan kontras AA di terang dan gelap.

Screenshot (data uji, nama "Rina Uji"): `docs/progress/screenshots/t2-01-chat-kosong-terang.png` sampai `t2-06-daftar-gelap.png`.

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

- **Belum diuji antarlaptop sungguhan.** Transport fitur dikerjakan sesi lain; di branch ini `FeatureHub` memakai `OfflineLink`. Akibatnya di aplikasi yang berjalan sekarang semua rekan dianggap offline, sehingga setiap pesan ke rekan membuat titipan.
- **Screenshot hanya satu laptop,** jadi status pesan, kartu file, dan chat pribadi tidak terlihat di screenshot. Semuanya diuji lewat Vitest dan tes Rust.
- **Kirim lampiran lewat dialog Windows tidak diotomasi** di uji ujung ke ujung, karena dialog asli berada di luar WebView2. Notifikasi Windows juga tidak muncul di uji; yang diuji adalah keputusan kapan notifikasi dikirim.
- **Hak dinilai menurut peran sekarang, bukan saat record dibuat.** Contoh: A menulis di channel tim lalu keluar dari tim. Laptop yang baru sinkron sesudahnya menunda pesan A selamanya, sedangkan laptop yang sudah sinkron sebelumnya tetap menampilkannya. Hal yang sama berlaku untuk arsip atau hapus dari admin yang dicopot. Perbaikannya butuh riwayat keanggotaan tim di log keanggotaan.
- **Data terus bertambah.** Tanda terima dibuat per pesan per orang, dan sinkron menawarkan semua id setiap 30 detik. Untuk 10 sampai 30 orang ini masih ringan, tapi perlu dipadatkan (misalnya "sudah dibaca sampai sini") sebelum pilot panjang.
- **Belum ada kuota.** Tidak ada batas jumlah titipan per orang, batas unduhan otomatis per hari, atau batas sisa disk.
- **Metadata titipan terlihat** oleh laptop yang memegangnya, termasuk Tamu: siapa menulis ke siapa, kapan, dan berapa besar.
- **"Dititipkan"** berarti titipan sudah diserahkan ke laptop lain, belum tentu sudah tersimpan di sana. Kontrak sekarang tidak memberi tahu hal itu.
- **Kunci sementara di segel tidak diperiksa** (`crypto_box` 0.9). Paling banyak 3 bit kunci penerima bisa bocor ke anggota yang melihat apakah titipan diserahkan. Ini tidak melemahkan kunci secara berarti.
- **Pesan bertanggal mundur.** Kunci anggota yang sudah dikeluarkan masih bisa menandatangani pesan bertanggal sebelum ia dikeluarkan. Pesan itu hanya bisa masuk kalau diteruskan laptop anggota.
- **File yang sudah dimiliki untuk satu percakapan** bisa diunduh lagi untuk percakapan lain kalau hash-nya disebut di sana. Menutupnya butuh perubahan kontrak transport.
- **Notifikasi** belum dikelompokkan dan belum dibatasi jumlahnya.
- **Aksesibilitas:** saran mention memakai `role="combobox"` di textarea (didukung pembaca layar, tapi tidak sesuai aturan HTML-ARIA). Setiap pesan menambah dua atau tiga perhentian Tab. Popover status bisa terpotong di bawah area gulir.
- **File sedikit di atas 600 baris:** `chat/audience.rs` dan `chat/service.rs`.

## Commit

Branch `claude/tahap-2-chat-f36a9d`, tanpa push dan tanpa merge ke `main`. Lihat `git log 63eb72b..HEAD`.
