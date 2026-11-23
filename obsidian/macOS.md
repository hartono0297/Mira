---
tags: [mira, platform, macos]
---

# macOS

Kantor memakai MacBook dan laptop Windows, jadi Mira juga dibuat untuk macOS 11 atau yang lebih baru, di Mac Apple Silicon dan Intel. Keputusannya tercatat di [[Keputusan]] (Dukungan macOS, 23 November 2026). Build Mac dibuat lewat GitHub Actions, tanpa akun Apple Developer untuk sekarang.

## Yang berbeda di Mac

| Bagian | Windows | macOS |
|---|---|---|
| Mesin tampilan | WebView2 (Chromium), diunduh installer kalau belum ada | WebKit bawaan macOS, tidak perlu diunduh |
| Kunci privat laptop | Windows Credential Manager | Keychain macOS, nama layanan `id.mira.desktop` |
| Folder data | `%LOCALAPPDATA%\id.mira.desktop` | `~/Library/Application Support/id.mira.desktop` |
| Firewall | Windows Firewall, dengan tombol "Izinkan lewat Windows Firewall" | Firewall aplikasi macOS, bertanya sekali saat Mira menerima sambungan masuk |
| Izin jaringan lokal | Tidak ada | macOS meminta izin "Jaringan lokal" |
| Office | Word dan Excel untuk Windows | Word dan Excel for Mac |
| Penandatanganan | Installer belum ditandatangani, SmartScreen bisa memberi peringatan | Ad-hoc, tidak dinotarisasi Apple |

Penjelasan per baris:

- WebKit dan WebView2 bisa menggambar halaman sedikit berbeda. Tampilan Mira di WebKit belum dibandingkan di MacBook sungguhan.
- Keychain: kunci laptop disimpan sebagai item Keychain, bukan file. Menghapus folder data tidak menghapus kunci, sama seperti di Windows.
- Firewall: kalau firewall macOS menyala, macOS bertanya apakah Mira boleh menerima sambungan masuk. Jawab Izinkan (Allow). Kalau terlanjur ditolak, ubah lewat Pengaturan Sistem > Jaringan > Firewall > Pilihan (Options) di macOS 13 ke atas, atau Preferensi Sistem > Keamanan & Privasi > Firewall di macOS 11 dan 12.
- Jaringan lokal: di macOS 15 (Sequoia) ke atas, aplikasi harus diizinkan sebelum bisa menemukan dan menyambung ke perangkat di jaringan lokal. Mira butuh izin ini untuk mDNS dan untuk sambungan QUIC ke laptop rekan. Jawab Izinkan saat ditanya. Kalau terlanjur ditolak, nyalakan lewat Pengaturan Sistem > Privasi & Keamanan > Jaringan Lokal.
- Office for Mac: Mira mendeteksi versi baru dari pola simpan Word dan Excel. Pola simpan Office for Mac belum diperiksa di perangkat sungguhan.
- Penandatanganan ad-hoc berarti `Mira.app` punya tanda tangan kode tanpa identitas pengembang. Gatekeeper menolak membuka aplikasi seperti ini kalau aplikasinya bertanda karantina, yaitu tanda yang dipasang macOS pada file unduhan browser.

## Cara build

- GitHub Actions membuat installer macOS (`.dmg`) di runner macOS dan melampirkannya ke GitHub Release.
- Tes otomatis berjalan di GitHub Actions pada runner macOS dan Windows.
- Nama file `.dmg` di rilis belum final. [install.sh](../install.sh) menerima `Mira_*_aarch64.dmg` dan `Mira_*_x64.dmg` (dipilih menurut prosesor), `Mira_*_universal.dmg`, dan `Mira_*universal.app.tar.gz`.
- Belum ada langkah build lokal di Mac yang sudah dicoba.

## Cara memasang

Buka Terminal, lalu jalankan:

```bash
curl -fsSL https://raw.githubusercontent.com/hartono0297/Mira/main/install.sh | bash
```

Skrip itu:
1. berhenti dengan pesan jelas kalau bukan macOS, atau macOS lebih lama dari 11;
2. mencari rilis terbaru yang bukan draft (prerelease ikut), lewat API GitHub;
3. memilih file untuk prosesor Mac ini. `uname -m` `arm64` berarti `aarch64`, `x86_64` berarti `x64`. Shell yang jalan lewat Rosetta di Apple Silicon tetap dikenali sebagai `aarch64`;
4. mengunduh ke folder sementara dan mencocokkan SHA-256 dengan `digest` dari GitHub (atau file `.sha256` di rilis). Kalau tidak cocok, pemasangan dibatalkan;
5. menutup Mira kalau sedang jalan, lalu menunggu sampai tertutup;
6. membuka `.dmg` hanya-baca dan menyalin `Mira.app` dengan `ditto` ke `/Applications`, atau ke `~/Applications` kalau `/Applications` tidak bisa ditulis. Tidak pernah memakai `sudo`;
7. menutup `.dmg`, menghapus tanda karantina, membuka Mira, dan menghapus folder sementara.

`MIRA_INSTALL_DRY_RUN=1` hanya mengunduh dan mencocokkan checksum. `MIRA_GITHUB_TOKEN` dipakai kalau repositori kembali private. Keduanya sama dengan [install.ps1](../install.ps1) untuk Windows.

Daftar rilis dari GitHub dibaca dengan JavaScript lewat `osascript` (selalu ada di macOS). Kalau gagal, skrip memakai `python3` (hanya kalau Command Line Tools terpasang, supaya tidak memunculkan dialog pemasangan), lalu pembaca JSON kecil di `awk`.

Kenapa tanda karantina dihapus: Mira tidak dinotarisasi, jadi Gatekeeper akan menolak `Mira.app` yang bertanda karantina. Dengan menghapus tanda itu, Gatekeeper tidak memeriksa Mira. Yang menjamin file ini sama dengan yang diterbitkan adalah checksum SHA-256 dari GitHub. Untuk alat internal yang diunduh dari repositori kantor sendiri, ini bisa diterima. `curl` sendiri tidak memasang tanda karantina; skrip tetap menghapusnya untuk berjaga-jaga.

Cara manual, termasuk klik kanan > Buka dan perubahan di macOS 15, ada di [README](../README.md#macos).

## Yang belum diuji

- Mira belum pernah dijalankan di MacBook sungguhan. Yang ada hanya tes otomatis di GitHub Actions.
- Sambungan antara MacBook dan laptop Windows di jaringan kantor: mDNS, QUIC, firewall, dan izin Jaringan Lokal.
- Pola simpan Office for Mac (Word dan Excel).
- Apakah macOS meminta kata sandi atau izin Keychain setelah Mira diperbarui. Tanda tangan ad-hoc berubah di setiap build, jadi ini perlu dicek saat pembaruan pertama.
- Tampilan di WebKit dibanding WebView2.
- [install.sh](../install.sh) belum pernah dijalankan di Mac. Pembacaan lewat `osascript`, `hdiutil`, `ditto`, `xattr`, `open`, dan perintah tutup lewat `osascript` belum pernah jalan sungguhan. Yang sudah diuji di Git Bash di Windows:
  - pembaca daftar rilis versi `python3` dan `awk`, plus inti JavaScript yang sama (dijalankan dengan Node), terhadap JSON asli dari API GitHub dan beberapa contoh buatan. Hasil ketiganya sama;
  - pemilihan file per prosesor;
  - unduh dan pencocokan `shasum -a 256` terhadap `digest` installer Windows `v0.1.0` yang asli;
  - alur pasang lengkap dengan perintah macOS yang ditiru: pasang baru, pasang ulang di atas versi lama, checksum tidak cocok, rilis tanpa file Mac, macOS 10.15, dan uji coba `MIRA_INSTALL_DRY_RUN=1`.

Lihat juga: [[Belum diuji]], [[Cara menjalankan dan menguji]]. Kembali ke [[Beranda]].
