# Laporan Onboarding v0.4

Branch: `claude/v04-onboarding-c92a92`, dari `main` e7def11. Rencana: `docs/plans/v04-onboarding.md`. Dasar: `docs/plans/v0.3-kontrak.md` bagian 8, `docs/progress/v03-a.md`, `docs/progress/v03-b.md`.

Permintaan user: "untuk menu awal setelah user download, gw maunya dia cuma isi nama dan pilih depart lalu pilih mau join domain mana. jadi nanti superadmin bisa cek user ini legit atau engga."

## Ringkasan

Orang baru sekarang hanya mengisi nama, memilih kantor, memilih departemen dari kantor itu, dan boleh menulis keterangan untuk admin. Setelah itu permintaannya terkirim. Kartu Permintaan bergabung di laptop admin menampilkan keterangan dan nama akun login Windows atau macOS peminta, di samping data yang sudah ada (laptop, IP, sistem, versi, waktu, kode cocok), plus petunjuk cara memastikan orangnya. Pilihan membuat kantor baru tidak lagi terlihat oleh pengguna biasa: letaknya di bagian lipat "Untuk admin IT" di layar "Kantor belum ditemukan", atau lewat argumen `--siapkan-kantor`. Tab halaman Organisasi yang berbau admin hanya tampil untuk peran yang berhak.

## Alur baru

| Langkah | Layar | Isi |
|---|---|---|
| 1 dari 3 | "Siapa nama Anda?" | isian "Nama tampilan", tombol "Lanjut" |
| 2 dari 3 | firewall | hanya kalau aturan Mira belum ada; "Lewati, atur nanti" |
| 2 dari 3 | "Mencari kantor di jaringan..." | paling lama 15 detik; setelah kantor pertama menjawab, Mira menunggu 3 detik lagi untuk kantor lain |
| 2 dari 3 | "Kantor ditemukan: <nama>" atau "Beberapa kantor ditemukan" | ringkasan nama dengan tombol "Ubah"; kantor (satu kantor terpilih otomatis dengan sidik `XXXX-XXXX`, beberapa kantor jadi daftar pilihan); "Departemen" (aktif setelah kantor dipilih, daftarnya dari kantor itu); "Keterangan untuk admin (opsional)" paling banyak 80 karakter; "Kirim permintaan" |
| 3 dari 3 | "Menunggu persetujuan" | kode cocok, kotak "Yang dilihat admin" |

Alur v0.3 tetap jalan: ditolak lalu kirim ulang, batal, lanjut setelah Mira dibuka ulang, alamat laptop rekan, kode undangan.

Layar "Kantor belum ditemukan": Cari lagi, alamat laptop rekan, "Pakai kode undangan", dan `<details>` "Untuk admin IT". Isinya baru dirender setelah dibuka. Di dalamnya ada "Siapkan Mira untuk kantor baru", atau penjelasan bahwa kantor Mira sudah ada di jaringan ini kalau di sesi itu pernah terlihat kantor atau pengumuman organisasi. Layar kantor baru meminta nama organisasi diketik ulang persis sebelum organisasi dibuat, dan tetap memuat peringatan untuk pengguna VPN.

## Keputusan yang saya ambil sendiri

1. **Firewall tidak lagi menjadi langkah tetap.** Mira memeriksa statusnya setelah langkah nama. Kalau aturannya sudah ada, tidak didukung, atau statusnya tidak terbaca, layar itu dilewati. Kalau belum ada, layar firewall v0.3 tampil dengan "Lewati, atur nanti".
2. **Nama di langkah terpisah, kantor, departemen, dan keterangan dalam satu formulir.** Urutannya sesuai permintaan (kantor sebelum departemen, karena daftar departemen datang dari kantor yang dipilih). "Ubah" kembali ke langkah nama dan isian formulir kantor tidak hilang.
3. **"Untuk admin IT" memakai `<details>` bawaan HTML** supaya bisa dibuka dengan keyboard tanpa skrip tambahan, dan isinya tidak ada di pohon aksesibilitas selama tertutup.
4. **`--siapkan-kantor` dibuat** (command `join_setup_mode`, membaca argumen proses). Setelah langkah nama dan pemeriksaan firewall, layar kantor baru langsung terbuka. Jalur ini tidak mencari kantor lebih dulu; admin IT yang menjalankan argumen itu dianggap tahu kantor belum ada.
5. **Istilah sebelum bergabung: "admin kantor", bukan "superadmin".** Kata "superadmin" hanya muncul di bagian "Untuk admin IT" dan layar kantor baru.
6. **Tombol "Buat organisasi" tidak dinonaktifkan** saat ketik ulang belum sama. Isiannya menampilkan pesan, karena tombol nonaktif tidak menjelaskan alasannya ke pembaca layar.
7. **Tab Organisasi.** Departemen hanya untuk superadmin. Undangan untuk yang bisa membuat undangan (superadmin, admin departemen) atau yang bisa memakai kode (bukan Tamu, belum punya departemen). Untuk yang hanya bisa memakai kode, tab itu hanya berisi formulir "Pakai kode undangan" tanpa teks pengelola. Anggota biasa yang sudah punya departemen dan Tamu hanya melihat Anggota.

8. **Keterangan dan akun login ada di dalam permintaan bertanda tangan**, sebagai dua field opsional `note` (1 sampai 80 karakter) dan `account` (1 sampai 64 karakter) di `JoinRequestPayload`. Permintaan tanpa keduanya sama persis byte demi byte dengan bentuk v0.3. `null` eksplisit ditolak, supaya isi yang sama tidak punya dua bentuk (dua id). Laptop penerus tidak bisa mengubahnya tanpa merusak tanda tangan peminta, dan fold memeriksa ulang permintaan di op `join_approve`.
9. **Nama akun dibaca dari `USERNAME` (Windows) atau `USER` (macOS)** lalu dibersihkan. Akun yang tidak lolos format dibuang diam-diam, karena orangnya tidak bisa mengubahnya. Tidak ada pilihan untuk tidak mengirim akun; sebagai gantinya formulir menulis apa saja yang tersimpan dan siapa yang bisa melihatnya.
10. **Kompatibilitas dengan laptop v0.3.** Laptop v0.3 memakai `deny_unknown_fields`, jadi menolak permintaan dan op yang membawa field baru. Karena itu field baru hanya dipakai kalau semua anggota aktif kantor (termasuk Tamu, karena Tamu juga menerima op organisasi) sudah melaporkan versi Mira paling sedikit `min(versi sendiri, 0.4.0)` lewat profil laptopnya:
    - laptop anggota mengumumkan `extras: 1` di jawaban `join_info` hanya kalau syarat itu terpenuhi;
    - peminta menulis keterangan dan akun hanya kalau semua anggota yang menjawab membawa `extras: 1` (`FoundOffice.acceptsNote`); kalau tidak, isian keterangan tidak tampil dan permintaan berbentuk v0.3;
    - laptop anggota menolak permintaan berfield baru (`invalid_request`) dan tidak menyimpan record terusan seperti itu selama syaratnya belum terpenuhi; syarat ini tidak pernah dipakai di fold, supaya fold tidak bercabang;
    - kirim ulang memeriksa lagi apakah kantor masih menerima field baru.

    `min()` dipakai karena branch ini masih melaporkan versi 0.3.0: kantor uji yang semuanya build dev tetap bisa menguji keterangan, dan setelah versi dinaikkan ke 0.4.0 saat rilis, syaratnya menjadi semua laptop 0.4.0 ke atas.
11. **Karakter yang ditolak di keterangan dan akun**: semua yang ditolak untuk nama (karakter kontrol, bidi, tak terlihat) ditambah pengisi Hangul (U+115F, U+1160, U+3164, U+FFA0), U+2800, U+034F, pemilih variasi U+FE00 sampai U+FE0F, karakter tag U+E0000 sampai U+E007F, dan lebih dari 2 tanda diakritik bertumpuk. Tampilan memeriksa aturan yang sama sebelum mengirim.
12. **Teks verifikasi tidak menjadikan keterangan sebagai bukti.** Kartu menulis "Keterangan dari peminta (belum diperiksa)" dan "Akun login (dilaporkan laptop peminta)", dan petunjuknya meminta admin menelepon nomor yang sudah ia kenal, bukan nomor dari keterangan, atau mendatangi mejanya, lalu mencocokkan kode. Akun yang tidak dikirim ditulis netral "Tidak dikirim" (versi Mira di kartu dilaporkan peminta sendiri, jadi tidak dipakai untuk menebak alasannya).

## Review

Tiga peninjau terpisah membaca hasilnya. Tidak ada temuan tingkat tinggi. Temuan yang diperbaiki:

| Review | Temuan utama | Tindak lanjut |
|---|---|---|
| Tampilan onboarding | Batal saat masa tunggu 3 detik memunculkan tombol kantor baru walau kantor sudah menjawab; `--siapkan-kantor` melewati pemeriksaan firewall; "Ubah" nama membuang isian kantor; "superadmin" di layar pengguna biasa; campuran "kantor"/"organisasi"; penghitung keterangan tidak sama dengan `maxLength` | Semua diperbaiki dengan tes |
| Tampilan kartu admin dan tab | Tab Undangan untuk orang tanpa departemen berisi teks pengelola; "Keterangan" dibaca dua kali oleh pembaca layar; catatan RTL; latar catatan mirip efek hover | Diperbaiki: tab itu kini hanya "Pakai kode undangan", catatan memakai `figure` dengan `dir="auto"` dan garis tepi |
| Keamanan | (sedang) kantor campuran v0.3/v0.4 bisa membuat anggota baru tidak terlihat di laptop v0.3; (sedang) keterangan bisa dipakai mengarahkan admin menelepon nomor penipu; (rendah) `null` eksplisit, karakter tak terlihat, kirim ulang ke kantor yang turun versi, tebakan alasan akun kosong | Diperbaiki (Keputusan 8 sampai 12). Pilihan untuk tidak mengirim akun tidak dibuat (Keputusan 9). |

## Hasil verifikasi

Semua di Windows 11, build debug (`npx tauri build --debug --no-bundle`), commit 6f67ea5 untuk kode.

- `cargo test --lib`: 1028 lulus, 0 gagal, 7 diabaikan (yang diabaikan sudah ada sebelumnya).
- `cargo clippy --all-targets -- -D warnings`: tanpa peringatan.
- `npx vitest run`: 65 berkas, 971 tes lulus. `npx tsc --noEmit`: bersih.
- `node scripts/join-e2e.mjs src-tauri/target/debug/mira.exe docs/progress/screenshots/v04-onboarding`: **43 dari 43** lulus, enam instance di satu PC. Isinya antara lain:
  - layar pertama meminta nama dan tidak menyebut kantor baru atau superadmin;
  - dua kantor di jaringan (A dan K), N melihat "Beberapa kantor ditemukan" dengan nama dan sidik keduanya, departemen belum bisa dipilih sebelum kantor dipilih, daftar departemen berasal dari kantor yang dipilih, isian keterangan maksimal 80;
  - permintaan N membawa keterangan dan nama akun login (sama dengan `USERNAME`), kantor K tidak menerimanya, kartu di A menampilkan keterangan, akun login, laptop, dan petunjuk telepon, lalu A menyetujui lewat klik dan N masuk sendiri;
  - R melihat satu kantor yang terpilih otomatis dengan sidiknya, lalu ditolak;
  - X tanpa mDNS: tombol kantor baru tidak terlihat sampai "Untuk admin IT" dibuka, lalu X bergabung lewat alamat laptop rekan;
  - B tetap bisa bergabung lewat kode undangan.
- Skrip lain yang memakai `scripts/e2e-onboarding.mjs`, dijalankan satu per satu dengan build yang sama: `smoke-e2e` 12/12, `e2e-multi` 25/25, `org-e2e` 33/33, `board-e2e` 17/17, `board-sync-e2e` 26/26, `chat-e2e` 19/19, `sign-e2e` 15/15, `smoke-docs-e2e` 15/15, `e2e-fitur-multi` 41/41.
  - Putaran pertama, `smoke-e2e`, `e2e-multi`, `board-e2e`, dan `board-sync-e2e` gagal dengan "WebView2 tidak bisa dihubungi lewat CDP", dan `org-e2e` sekali gagal karena kunci laptop uji hilang dari Credential Manager. Saat itu sesi lain (worktree context-menu) sedang menjalankan Mira di PC yang sama. Setelah tidak ada Mira dari worktree lain, semuanya lulus. Catatan untuk sesi utama ada di folder catatan bersama (`v04-onboarding-e2e-bentrok.md`).
  - `org-e2e` juga gagal sungguhan sekali: pemeriksaan tab B membaca daftar tab sebelum `org_overview` selesai dimuat. Skripnya sekarang menunggu tab "Anggota".
- Screenshot: `docs/progress/screenshots/v04-onboarding/j01` sampai `j10`.
- Kontras: tidak ada warna baru; pasangan yang dipakai dicek dengan `check_contrast`, terendah `text-sec` di atas `hover` 5,03:1 (terang) dan 6,93:1 (gelap).

Yang belum terverifikasi:
- macOS (pembacaan `USER`, argumen `--siapkan-kantor`) hanya lewat kode dan tes unit.
- Kantor campuran v0.3 dan v0.4 hanya diuji di tes Rust (anggota yang menjawab dengan `extras: 0`, syarat versi), belum dengan laptop v0.3.0 sungguhan.
- Uji ujung ke ujung berjalan di satu PC; belum di beberapa PC sungguhan.
- `--siapkan-kantor` diuji di Vitest, belum lewat e2e.

## Catatan penggabungan

- **Di luar folder milik sesi ini**, perubahan kecil:
  - `src/api/org.ts`: `JoinRequestView.note`, `JoinRequestView.account` (aditif).
  - `src/screens/org/OrgScreen.tsx` (aturan tab), `InvitesPanel.tsx` dan `RedeemForm.tsx` (tampilan khusus pakai kode), tes `DepartmentsPanel`, `LabelsPanel`, `InvitesPanel`, `OrgScreen`, dan `src/test/orgFixtures.ts`. Brief memasukkan pembatasan menu admin ke lingkup sesi ini.
  - `src-tauri/src/lib.rs`: satu baris registrasi `join_commands::join_setup_mode`.
  - `src-tauri/src/network/mod.rs` (`JoinInfoWire.extras`), `net_backend.rs`, dan tes di `permissions/tests/`, `network/`.
  - `scripts/smoke-e2e.mjs`, `scripts/e2e-multi.mjs`, `scripts/org-e2e.mjs`: mengikuti alur dan aturan tab baru.
- **Untuk rilis**: naikkan versi ke 0.4.0 seperti biasa. Syarat versi keterangan memakai `min(versi sendiri, 0.4.0)`, jadi setelah dinaikkan, keterangan dan akun baru terkirim kalau semua laptop kantor sudah 0.4.0. Catatan "Yang baru" sebaiknya menyebut bahwa keterangan untuk admin baru muncul setelah semua laptop kantor diperbarui.
- **Pesan penolakan** `invalid_request` dari laptop anggota yang belum menerima keterangan tampil di laptop peminta sebagai pesan umum "isinya tidak sah", karena pesan di peminta sengaja dibuat lokal. Kasus ini hanya terjadi kalau pandangan versi antarlaptop belum sinkron.
- **Sisa dari review yang tidak diubah**: `DepartmentsPanel.tsx` masih punya cabang tampilan untuk bukan superadmin yang kini tidak bisa dicapai; `--siapkan-kantor` tidak mencari kantor lebih dulu, jadi tidak memperingatkan kalau kantor dengan nama sama sudah ada.
- Folder `node_modules` diinstal di worktree ini (`npm ci`) supaya Vitest dan build tidak bergantung pada folder induk.
