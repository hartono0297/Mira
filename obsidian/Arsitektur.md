---
tags: [mira, arsitektur]
---

# Arsitektur

Setiap laptop menjalankan aplikasi Mira yang sama. Tidak ada server. Tampilan hanya bicara dengan inti Rust, dan hanya modul jaringan yang bicara dengan laptop rekan.

```
Tampilan React + TypeScript (src/)
        |
Command dan event Tauri (invoke, mira://...)
        |
Inti Rust (src-tauri/src/)
  identity, org, permissions, peers, chat, board, documents, signing, blobs
        |                                   |
SQLite (satu file per laptop)       network/ (QUIC + mDNS)
blob store (folder blobs/)                  |
                                     laptop rekan, lewat LAN atau VPN
```

## Lapisan

**Tampilan** (`src/`). Layar ada di `src/screens/`: `onboarding`, `shell` (sidebar dan panel jaringan), `chat`, `board`, `docs`, `sign`, `org`, `settings`. Semua warna lewat token tema Bata di `src/theme/`. Penampil PDF bersama ada di `src/components/pdf/`. Pembungkus command ada di `src/api/`.

**Command Tauri.** Tampilan memanggil command lewat `invoke`. Error selalu berbentuk `{ code, message }`. Command umum ada di `commands.rs`, `team_commands.rs`, dan `network_commands.rs`; setiap fitur punya `commands.rs` sendiri (`chat/`, `board/`, `documents/`, `signing/`). Event ke tampilan antara lain `mira://board` dan `mira://feature` dengan payload `{ "topic": "<topik>" }`.

**Modul Rust** (`src-tauri/src/`):

| Modul | Isi |
|---|---|
| `identity/` | Kunci Ed25519 laptop, Credential Manager |
| `org/` | Record genesis organisasi |
| `permissions/` | Log keanggotaan bertanda tangan, fold status, undangan |
| `peers/` | Alamat rekan dan kapan terakhir terlihat |
| `network/` | Endpoint QUIC, mDNS, jabat tangan, gabung, sinkron op, transport fitur |
| `db/` | Koneksi SQLite dan migrasi |
| `blobs/` | Isi file beralamat hash BLAKE3 |
| `chat/` | Channel, pesan, tanda terima, titipan, lampiran |
| `board/` | Dokumen Automerge per proyek, akses, sinkron, pengingat |
| `documents/` | Pustaka dokumen, graf versi, pemantau Office |
| `signing/` | PIN, permintaan, jejak audit, deteksi perubahan |
| `net_backend.rs` | Adapter `network::SyncBackend` di atas `permissions` dan `peers` |
| `firewall.rs`, `qr.rs`, `window_theme.rs` | Platform Windows |

## SQLite

Satu file database per laptop, dengan `journal_mode=WAL` dan `synchronous=FULL`. Migrasi bernomor lewat `user_version` di `src-tauri/src/db/migrations.rs`. Migrasi yang sudah dirilis tidak boleh diubah; yang baru selalu ditambah di akhir.

| Versi | Asal | Tabel |
|---|---|---|
| v1 | [[Tahap 0]] fondasi | `identity`, `organizations`, `members`, `settings` |
| v2 | [[Tahap 1]] log keanggotaan | `org_ops`, `teams`, `team_members`, `invites`, `guest_access`, `channels`, `peer_addresses`, `manual_addresses`, `peer_seen`, `rejected_changes` |
| v3 | [[Tahap 3]] board | `board_projects`, `board_changes`, `board_task_index`, `board_reminders_sent` |
| v4 | [[Tahap 4]] dokumen | `documents`, `document_versions`, `document_version_parents`, `document_edit_sessions`, `document_remote_editing` |
| v5 | [[Tahap 5]] tanda tangan | `sign_saved_signature`, `sign_pin_resets`, `sign_requests`, `sign_signers`, `sign_events`, `sign_exports` |
| v6 | Sinkron board ([[Tahap 3]]) | Kolom `record_id` dan `doc_code`, tabel `board_pending`, `board_rejected` |
| v7 | [[Tahap 2]] chat | `chat_records`, `chat_channels`, `chat_messages`, `chat_files`, `chat_receipts`, `chat_envelopes`, `chat_fetch_queue`, `chat_blobs`, `chat_conv_settings` |

Catatan: laporan Tahap 2 dan laporan sinkron board sama-sama menyebut migrasinya v6, karena dikerjakan di branch terpisah. Urutan final di kode adalah sinkron board v6 dan chat v7.

## Blob store

Modul `blobs/` menyimpan isi file sekali di `<data>/blobs/<2 hex>/<hash>`, dengan hash BLAKE3. File ditulis lewat file sementara lalu di-rename, dan bersifat read-only. Versi dokumen dengan isi sama memakai blob yang sama. Chat memakai blob store untuk lampiran. Tanda tangan PDF masih memakai penyimpanan sementara `FolderStore` di `<data>/ttd-berkas/`.

## Jaringan

- QUIC (quinn + rustls) di UDP 47800 sampai 47809, atau di `MIRA_PORT`.
- Kedua pihak menunjukkan sertifikat Ed25519 dari kunci laptopnya. Identitas peer selalu diambil dari sertifikat itu. ALPN `mira/1` untuk anggota, `mira-join/1` untuk bergabung dengan kode.
- Setelah jabat tangan, kedua sisi memeriksa bahwa peer anggota aktif organisasi yang sama.
- Penemuan lewat mDNS (`_mira._udp.local.`), alamat manual, QR atau tautan `mira://peer?pk=...&addr=...`, dan alamat terakhir yang diingat (dicoba ulang dengan jeda yang makin panjang).
- Status koneksi: LAN, VPN (dari nama adaptor), atau tidak tersambung.

## Log keanggotaan

Setiap perubahan keanggotaan adalah op JSON yang ditandatangani kunci laptop pembuatnya, dengan id BLAKE3 dari isinya. Ada 14 jenis op, antara lain buat tim, angkat admin tim, tambah anggota, keluarkan, buat dan terima undangan. Status organisasi dihitung ulang (fold) dari record genesis ditambah semua op, jadi laptop dengan himpunan op yang sama selalu mendapat status yang sama. Op disinkronkan saat tersambung, setiap 30 detik, dan setiap ada op baru. Rinciannya di [[Keamanan dan izin]].

## Kontrak sinkron fitur

Kontrak ada di `src-tauri/src/network/feature.rs`. Setiap fitur mendaftarkan `FeatureSync` (dan `BlobSource` kalau punya file) ke `FeatureHub`. Fitur menentukan record apa yang boleh diterima setiap rekan dan memeriksa semua yang masuk. Transport yang mengurus kapan sinkron dan cara pengiriman.

| Topik | Fitur | Keadaan di branch ini |
|---|---|---|
| `chat` | `ChatSync` | Terdaftar dan tersinkron |
| `board` | `BoardFeature` | Terdaftar dan tersinkron |
| `docs` | Dokumen | Belum tersambung (`NoSync`), dikerjakan di branch lain |
| `sign` | Tanda tangan | Belum tersambung (`LocalOnlyOutbox`), dikerjakan di branch lain |

Cara kerja transport ada di [[Transport sinkron fitur]].

Laporan terkait: [tahap-1.md](../docs/progress/tahap-1.md), [transport-fitur.md](../docs/progress/transport-fitur.md), [integrasi-tahap-3-4-5.md](../docs/progress/integrasi-tahap-3-4-5.md).
