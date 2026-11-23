---
tags: [mira, keamanan, izin]
---

# Keamanan dan izin

Tanpa server, setiap laptop memeriksa sendiri semua yang datang dari rekan. Dasarnya kunci per laptop, record bertanda tangan, dan rantai kepercayaan yang bisa diperiksa siapa saja.

## Kunci

- Saat pertama dibuka, Mira membuat kunci Ed25519 untuk laptop itu. Tidak ada akun; identitas adalah kunci ini ditambah nama tampilan.
- Kunci privat disimpan di Windows Credential Manager dengan nama `device-key-<kunci publik>.id.mira.desktop`, mode `CRED_PERSIST_LOCAL_MACHINE` supaya tidak ikut roaming.
- Kalau kunci privat hilang atau tidak cocok, Mira menampilkan error `key_mismatch` dan tidak diam-diam membuat identitas baru.
- Data disimpan di `%LOCALAPPDATA%`, bukan `%APPDATA%` (roaming), supaya identitas satu laptop tidak terbawa ke laptop lain.

## Record bertanda tangan

| Data | Bentuk |
|---|---|
| Organisasi | Record genesis ditandatangani kunci pendiri |
| Keanggotaan | Op JSON, tanda tangan Ed25519 atas `"mira-op-v1\n" + payload`, id = BLAKE3 isinya |
| Chat | Record bertanda tangan di topik `chat`, body JSON baku supaya laptop perantara tidak bisa membuat id baru |
| Board | Change Automerge bertanda tangan. Actor Automerge adalah kunci publik laptop. |
| Dokumen | Record `doc`, `ver`, `edit` dalam amplop bertanda tangan Ed25519 dengan domain khusus dokumen, jadi record tidak bisa dipakai di fitur lain |
| Tanda tangan PDF | Setiap kejadian di jejak audit ditandatangani kunci laptop, versi file di-hash BLAKE3. Record sinkron memakai amplop dengan domain khusus tanda tangan. |

Record yang format atau tanda tangannya salah tidak disimpan dan dicatat di tabel `rejected_changes`. Belum ada layar untuk admin melihat catatan itu (rencana [[Tahap 6]]).

## Rantai kepercayaan

Genesis organisasi, lalu superadmin yang mengangkat admin tim, lalu admin tim yang menandatangani undangan, lalu laptop mana pun yang memeriksa kode dan menandatangani penerimaan. Setiap laptop bisa memeriksa rantai ini tanpa server.

Kode undangan:
- 20 karakter (100 bit), dengan peran Admin tim, Anggota, atau Tamu dan masa berlaku 24 jam, 7 hari, atau sekali pakai (paling lama 7 hari).
- Kode sendiri tidak pernah disimpan atau dikirim. Yang disimpan adalah kunci publik undangan yang diturunkan dari kode.
- Bergabung memakai ALPN terpisah, dibatasi 10 percobaan per menit dan 2 sesi bersamaan per IP.

Op yang memakai hak yang kemudian dicabut, dan tidak ada di masa lalu pencabutan itu, ditolak di semua laptop. Ini menutup serangan memundurkan op.

## Peran

| Peran | Yang bisa dilakukan sekarang |
|---|---|
| Superadmin | Membuat dan menghapus tim, mengangkat dan melepas admin tim dan superadmin, mengeluarkan orang dari organisasi. Tidak otomatis melihat isi tim; harus masuk tim dulu, dan langkah itu tercatat di log keanggotaan. |
| Admin tim | Mengundang dan mengeluarkan anggota timnya, membuat proyek tim, mengundang Tamu ke proyek timnya. |
| Anggota | Chat, membuat channel di tim atau proyeknya, menulis di board tim dan proyek yang diikuti, meminta dan memberi tanda tangan. |
| Tamu | Membaca board proyek yang diizinkan (tanpa komentar), bicara di channel proyek yang diizinkan, menandatangani kalau diminta. Tidak bisa chat pribadi, tidak bisa meminta tanda tangan. |

Pembagian izin lengkap menurut rencana ada di tabel PRD bagian 7.3 ([prd-mira.html](../design/prd-mira.html)). Aturan board rinci ada di [sinkron-board.md](../docs/progress/sinkron-board.md), bagian "Aturan akses".

Superadmin minimal satu dijaga aturan, dan tampilan memberi peringatan kalau baru satu.

## Pembatasan data per tim dan proyek

Laptop hanya mengirim data ke rekan yang boleh melihatnya:

| Data | Dikirim ke |
|---|---|
| Direktori organisasi (anggota, tim, undangan aktif) | Semua anggota aktif, termasuk Tamu, karena setiap laptop butuh rantai lengkap |
| Channel tim | Anggota tim itu |
| Channel proyek | Anggota proyek, termasuk Tamu yang diizinkan |
| Chat pribadi | Dua orangnya saja |
| Titipan tersegel | Boleh dipegang semua anggota aktif, tapi isinya hanya bisa dibuka penerima |
| Board proyek milik tim | Anggota tim itu dan Tamu yang diundang ke proyek itu |
| Board proyek tanpa tim | Semua anggota aktif kecuali Tamu |
| Dokumen di Pustaka Umum | Semua anggota aktif kecuali Tamu |
| Dokumen milik tim | Anggota tim itu |
| Dokumen milik proyek | Sama dengan board proyek: anggota tim pemilik proyek dan Tamu yang diundang ke proyek itu. Proyek tanpa tim: semua anggota aktif kecuali Tamu. |
| Permintaan tanda tangan dan file PDF-nya | Pengirim dan penanda tangannya yang anggota aktif. Tamu hanya kalau permintaan dikaitkan ke proyek yang diizinkan untuknya. Anggota lain tidak menerimanya. |

Laptop yang dikeluarkan tidak menerima apa pun lagi, termasuk dokumen baru. Data yang sudah ada di laptop itu tidak bisa dihapus dari jauh.

## Aturan dokumen dan tanda tangan

Aturan ini ditambahkan atau dipertegas setelah review penggabungan sinkron dokumen dan tanda tangan:
- Dokumen dan tanda tangan memakai aturan akses proyek dan Tamu yang sama dengan board (`board::access`). Cakupan selalu diambil dari dokumen yang tersimpan, bukan dari pengirim.
- Superadmin hanya melihat dokumen sebuah tim kalau ia sudah masuk tim itu.
- Lampiran chat tidak bisa diambil lewat versi dokumen atau permintaan tanda tangan oleh orang di luar percakapan chat itu, walaupun ia tahu hash filenya.
- File PDF asli yang dipakai ulang hanya diterima kalau pengirimnya memang sudah boleh memegang file itu. Ini mencegah file tim bocor ke cakupan lain hanya dengan menyebut sidik filenya.
- Versi bertanda tangan harus berupa incremental update dari versi sebelumnya. Versi yang mengubah isi selain stempel ditolak di semua laptop (`version_changes_content`).
- Laptop menolak record dari anggota yang dikeluarkan, termasuk record yang dibuat sebelum ia dikeluarkan, karena waktu di record bisa dipalsukan.

## Kriptografi lain

- Titipan chat: sealed box `crypto_box` (X25519 + XSalsa20-Poly1305). Kunci Ed25519 penerima dipetakan ke X25519 dan dicek dengan vektor uji libsodium. Lampiran kecil dienkripsi XChaCha20-Poly1305.
- PIN tanda tangan: Argon2id (64 MiB, 3 putaran) digabung dengan pepper dari kunci laptop, lalu BLAKE3. Gambar tanda tangan dienkripsi XChaCha20-Poly1305. PIN tidak pernah disimpan.
- CSP jendela hanya mengizinkan `'self'`, ditambah `'wasm-unsafe-eval'` untuk pdf.js. Gambar juga boleh dari `blob:`, supaya pratinjau tanda tangan tampil.

## Risiko yang tercatat

- Masa berlaku undangan dan masa tunggu PIN memakai jam laptop. Tanpa server tidak ada sumber waktu tepercaya.
- Kalau kunci laptop dan `mira.db` sama-sama dicuri program yang berjalan dengan akun Windows yang sama, PIN 6 angka bisa ditebak dalam hitungan jam. Lihat kebijakan PIN di [[Keputusan]].
- Metadata titipan (siapa menulis ke siapa, kapan, berapa besar) terlihat oleh laptop pemegangnya, termasuk Tamu.

Laporan terkait: [tahap-1.md](../docs/progress/tahap-1.md), [tahap-2.md](../docs/progress/tahap-2.md), [sinkron-board.md](../docs/progress/sinkron-board.md), [tahap-5-lokal.md](../docs/progress/tahap-5-lokal.md), [sinkron-dokumen-ttd.md](../docs/progress/sinkron-dokumen-ttd.md), [integrasi-dokumen.md](../docs/progress/integrasi-dokumen.md).

Lihat juga: [[Arsitektur]], [[Belum diuji]].
