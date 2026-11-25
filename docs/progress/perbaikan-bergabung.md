# Laporan: perbaikan bergabung (0.5.1)

Branch: `claude/perbaikan-bergabung-5f4b52`, dari `main` a45d1b3 (v0.5.0). Rencana dan kontrak: `docs/plans/perbaikan-bergabung.md`.

Dua masalah dari pemakaian v0.5.0 di kantor:

- **A.** Data AD tidak dipakai, dan orangnya tidak tahu kenapa. Julius (PC domain, OU `IT- BussinesAnalyst_AppSupport & MIS_QA`) melihat "Kantor ditemukan: MCF" lalu harus memilih departemen sendiri tanpa penjelasan.
- **B.** Laptop yang dikeluarkan terjebak di layar dengan "Periksa lagi" yang tampak tidak berbuat apa-apa.

## Ringkasan

### A. Data akun Windows (AD)

- **Langkah 2 onboarding** sekarang punya satu baris di bawah pilihan departemen. Isinya departemen yang cocok ("Dari akun Windows Anda: X"), atau satu alasan kenapa data akun Windows tidak dipakai. Urutan alasan:
  1. AD tidak terbaca (akun lokal, Mac, DC tidak terjangkau): diam, seperti v0.5.0.
  2. Domain kantor diketahui dan berbeda: "Domain kantor (x) berbeda dengan domain akun Anda (y)...".
  3. Ada laptop kantor yang belum 0.5 (`acceptsAd` false): "Ada 2 laptop di kantor ini yang belum diperbarui ke Mira 0.5..." (jumlah dari field baru `ad_outdated` di `join_info`; tanpa jumlah kalau laptop yang menjawab masih Mira lama).
  4. Kantor belum mengatur domain: "Domain kantor ini belum diatur...".
  5. Nama akun tidak terbaca.
  6. Departemen AD belum dicocokkan admin: "Departemen Anda di akun Windows (IT- BussinesAnalyst_AppSupport & MIS_QA) belum dicocokkan admin...".
  Baris ini dibacakan sekali oleh pembaca layar dan tidak memindahkan fokus.
- **Tawaran domain di Organisasi** (superadmin, laptop domain, kantor tanpa domain AD): "Pakai macf.co.id sebagai domain AD kantor ini?" dengan tombol "Pakai macf.co.id" dan "Sembunyikan". Kalau gerbang versi tertutup, tawaran menyebut laptop yang harus diperbarui.
- **"Cocokkan OU ini ke departemen..."** di kartu Permintaan bergabung (superadmin), saat departemen atau OU dari AD belum dikenal. Form kecil: pilih OU dari jalur DN (bawaan OU paling dalam), pilih departemen, "Cocokkan". Baris ditambahkan lewat `ad_settings_set` yang ada (pengaturan dibaca ulang dulu supaya tidak menimpa perubahan lain), lalu kartu diperiksa ulang. Departemen permintaan itu sendiri tidak berubah; teks sukses menyebutnya.

**Kenapa Julius tidak melihat apa-apa (dari kode 0.5.0):** judul "Kantor ditemukan: MCF" (bukan "Kantor Anda ditemukan") berarti domain AD kantor kosong atau berbeda, jadi usulan departemen tidak pernah diminta. Baris penjelasannya memang ada, tapi berupa petunjuk abu-abu kecil di bawah form, jauh dari pilihan departemen, tidak dibacakan, dan tidak menyuruh memilih sendiri. Kemungkinan lain, `join_ad_profile` mengembalikan kosong (akun lokal); petunjuk di layar nama memberi tahu yang mana.

### B. Nonaktifkan, aktifkan lagi, keluarkan permanen

- **Op baru** `member_suspend` dan `member_reinstate`. `member_remove` tetap berarti keluar permanen, dan kini juga berlaku untuk orang yang sedang nonaktif.
- **Saat nonaktif** orang itu dilepas dari departemen, proyek, label, akses Tamu, dan status superadmin, persis seperti dikeluarkan, tapi fold menyimpan cuplikan. Aktifkan lagi mengembalikan yang masih ada (departemen yang masih terbuka, proyek yang masih ada, label yang belum diarsipkan, akses Tamu yang timnya masih hidup). Semua pemeriksaan izin yang ada otomatis menolak orang nonaktif.
- **Laptop nonaktif** tetap tersambung lewat koneksi terbatas yang hanya menyinkronkan op ber-scope org (log keanggotaan). Tidak ada chat, board, dokumen, tanda tangan, blob, op tim, atau permintaan bergabung. Laptop nonaktif sendiri juga tidak menyimpan data fitur yang datang dan tidak mengumumkan diri lewat mDNS.
- **Layar nonaktif:** "Akun Anda di MCF sedang dinonaktifkan", kontak IT/admin departemen/superadmin, sidik jari laptop, data tidak dihapus, "Periksa lagi" dengan hasil terlihat ("Diperiksa pukul 14.20: masih nonaktif."), dan cek otomatis tiap 20 detik. Begitu diaktifkan lagi, aplikasi kembali ke tampilan biasa tanpa restart.
- **Layar keluar permanen:** penjelasan, kontak dan sidik jari, lalu "Reset dan mulai dari awal" dengan dialog yang menyebut yang dihapus (pesan, file obrolan, dokumen, dokumen bertanda tangan dari kantor itu), yang tetap (PDF bertanda tangan yang sudah diekspor, bahasa, tema), kunci baru, dan bahwa langkah ini tidak bisa dibatalkan. Setelah reset, laptop kembali ke layar awal untuk meminta bergabung lagi.
- **Organisasi > Pengguna:** chip "Nonaktif" (ikon plus teks) dengan "Dinonaktifkan <tanggal> oleh <nama>"; menu "Nonaktifkan atau keluarkan" membuka dialog pilihan Nonaktifkan (terpilih bawaan) atau Keluarkan permanen; "Aktifkan lagi"; filter bawaan "Semua kecuali yang dikeluarkan".

## Keputusan yang saya ambil sendiri

1. **Admin departemen boleh menonaktifkan dan mengaktifkan lagi anggota biasa departemennya** (bukan admin lain, superadmin, atau Tamu), mengikuti aturan lama v0.2 bahwa admin boleh mengeluarkan anggota non-admin dari departemennya. Mereka **tidak** bisa mengaktifkan lagi orang yang dinonaktifkan superadmin, dan tidak bisa mengeluarkan permanen. Untuk itu tab Pengguna kini tampil bagi admin departemen, hanya berisi orang di departemennya (termasuk yang dinonaktifkan dari sana), tanpa alamat IP.
2. **Dua penonaktifan bersamaan** dicatat bersama (`joint_suspensions`): aktifkan lagi hanya berlaku kalau sudah melihat semua penonaktifan itu. Tanpa ini, penonaktifan kedua yang bersamaan bisa terangkat oleh aktifkan lagi yang tidak pernah melihatnya ("pencabutan menang" rusak). Aktifkan lagi yang bersamaan dengan keluarkan permanen juga kalah.
3. **Gerbang versi `SUSPEND_SINCE = "0.5.1"`** (ambang `min(versi sendiri, 0.5.1)` seperti `JOIN_AD_SINCE`) untuk menulis `member_suspend`. Aktifkan lagi tidak digerbang. Setelah kantor pernah memakai penonaktifan, permintaan bergabung dari Mira di bawah 0.5.1 tidak bisa disetujui (kartu memperingatkan lebih dulu), supaya laptop lama tidak masuk dan membagi data ke orang nonaktif.
4. **Reset hanya untuk status keluar permanen di fold**, bukan untuk laptop yang belum pernah diterima. Yang dihapus: entri `device-key-<pk lama>` di Credential Manager/Keychain dan data organisasi di folder data (`mira.db`, `blobs`, `chat-files`, `chat-tmp`, `docs-incoming`, `working`, `view`, `ttd-berkas`, `ttd-unduhan`). Yang tetap: bahasa, tema, folder `ekspor` (PDF bertanda tangan yang diekspor milik orangnya), data WebView. Data dipindah dulu ke folder sementara; kalau gagal di tengah, dikembalikan, dan database tidak pernah tertinggal tanpa kuncinya. Reset yang terputus tidak dihapus saat Mira dibuka lagi kecuali sudah melewati titik tanpa kembali.
5. **"Laptop ini pernah dikeluarkan pada ..."** dibuat sebagai petunjuk, bukan bukti bertanda tangan kunci lama: bukti butuh field baru di permintaan bergabung, dan laptop 0.5.0 mengurai permintaan dengan `deny_unknown_fields`. Kartu admin menampilkan petunjuk kalau akun AD (dari keputusan bergabung yang lalu) atau nama laptop peminta sama dengan orang yang nonaktif atau dikeluarkan.
6. **Tabel `members`** punya CHECK `status IN ('active','removed')`, jadi orang nonaktif ditulis `removed` di tabel turunan; status sebenarnya ada di fold. Akibatnya fitur yang membaca tabel itu memperlakukan orang nonaktif sebagai tidak ikut. Tidak ada data yang dihapus karenanya: record chat yang ditolak hanya dicatat dan diterima lagi setelah aktif.
7. Versi aplikasi tidak dinaikkan di branch ini.

## Review

| Review | Temuan utama | Tindak lanjut |
|---|---|---|
| Keamanan izin dan reset | (sedang) laptop 0.5.0 yang masuk setelah penonaktifan tidak mengenal op itu; (sedang) admin departemen bisa membatalkan penonaktifan oleh superadmin; (rendah) reset untuk laptop yang belum pernah diterima, sapuan saat buka menghapus satu-satunya salinan kalau pengembalian gagal, label terarsip dikembalikan, IP terlihat oleh admin departemen | Semua diperbaiki kecuali jalur kode undangan (lihat Batasan) |
| Tampilan dan teks | cek otomatis 20 detik mencuri fokus tombol; live region terlalu sering bicara; dialog reset kurang jelas; istilah Inggris campur suspend/deactivate; tawaran domain menjanjikan departemen; nama aksesibel tombol OU tidak memuat teks tampak | Semua diperbaiki |
| Keamanan jaringan | Tidak ada kebocoran data fitur, op tim, blob, atau permintaan bergabung ke laptop nonaktif. (sedang) laptop nonaktif yang dimodifikasi bisa membanjiri log op kantor dengan op buatannya sendiri; (rendah) sinkron balik bisa dipicu terus-menerus; koneksi bisa tetap terbatas setelah diaktifkan lagi; "Periksa lagi" bisa memicu badai dial | Diperbaiki (op dari laptop nonaktif tidak disimpan, batas lebih kecil, sinkron balik dibatasi, cek ulang status koneksi, satu pemeriksaan sekaligus) |

## Hasil verifikasi

Windows 11, build debug. PC sedang dibebani build dan tes beberapa sesi lain, jadi semua angka waktu jauh lebih lambat dari biasanya.

- `cargo test --lib`: **1277 lulus**, 0 gagal, 7 diabaikan (yang diabaikan sudah ada sebelumnya). Di antaranya:
  - `permissions/tests/suspend_tests.rs`: nonaktif, aktif lagi, keluar dari nonaktif, izin superadmin dan admin departemen (termasuk admin tidak bisa mengangkat penonaktifan superadmin), superadmin terakhir, cuplikan dikembalikan sebagian, op lama `member_remove` tetap permanen, kasus bersamaan (nonaktif vs aktif lagi, aktif lagi vs keluar, dua superadmin saling menonaktifkan, op orang nonaktif bersamaan dengan penonaktifan), `may_receive`/`op_ids_for` untuk peer nonaktif, gerbang versi, `ad_outdated`, petunjuk `previously_removed`, daftar Pengguna untuk admin departemen.
  - Jaringan (`network/tests.rs`, `feature_tests.rs`, `net_backend_tests.rs`): laptop nonaktif menerima op org tapi tidak op tim, tidak muncul sebagai rekan, tidak menerima record fitur atau blob ke arah mana pun, menerima op penonaktifan lewat push dan penutupan `SUSPENDED`, kembali penuh setelah diaktifkan lagi tanpa restart; dua laptop nonaktif tidak saling memantul; op buatan laptop nonaktif tidak disimpan; laju sinkron balik dibatasi; `check_membership` satu per satu; DB nyata tiga laptop; port terlepas setelah shutdown.
  - Reset (`reset_commands`, `paths`, `state`): hanya untuk keluar permanen, kunci lama terhapus dari keystore uji, folder data bersih, bahasa dan tema tetap, kunci baru, gagal di tengah tidak mengubah apa pun, reset yang terputus dikembalikan saat Mira dibuka.
- `cargo clippy --all-targets -- -D warnings`: bersih.
- `npx tsc --noEmit`: bersih. `npx vitest run`: 125 berkas, 1828 tes lulus (12 berkas besar dijalankan ulang satu per satu karena worker vitest tidak sempat mulai di PC yang sibuk; semuanya lulus).
- E2E, satu per satu, build debug b9644c2, `suspend-e2e` diulang dengan e8702aa (regresi memakai salinan sementara dengan batas waktu peluncuran lebih panjang karena PC lambat; isi uji tidak diubah):
  - `suspend-e2e.mjs` (baru): **52/52** pada build e8702aa: nonaktifkan lewat Pengguna, layar nonaktif tanpa restart, "Periksa lagi", tidak ada pesan atau task yang sampai selama nonaktif, aktifkan lagi tanpa restart lalu pesan dan task sampai, keluarkan permanen, reset (kunci baru, kunci lama terhapus dari Credential Manager, data lama terhapus, bahasa dan tema tetap), minta bergabung lagi dengan petunjuk "pernah dikeluarkan", disetujui, aktif. Pada build b9644c2 hasilnya 46/47: bergabung lagi setelah reset gagal karena port jaringan lama belum dilepas (lihat di bawah).
  - `ad-reason-e2e.mjs` (baru): **32/32**.
  - `ad-e2e.mjs` **97/97** (satu pengecekan diganti ke teks alasan baru "belum dicocokkan admin"), `join-e2e.mjs` **43/43**, `org-e2e.mjs` **33/33**, `e2e-multi.mjs` **25/25**, `english-e2e.mjs` **38/38**, `chat-e2e.mjs` **39/39**, `sync-e2e.mjs` **37/37**.
- Screenshot: `docs/progress/screenshots/perbaikan-bergabung/pb01` sampai `pb17` (nonaktif dan dikeluarkan, terang/gelap, Indonesia/Inggris, dialog, Pengguna) dan `pb21` sampai `pb29` (alasan AD, tawaran domain, cocokkan OU).

**Bug yang ditemukan e2e:** setelah "Reset dan mulai dari awal", jaringan tidak bisa mulai lagi di port yang sama ("Port UDP 47962 tidak bisa dipakai"). Penyebabnya siklus referensi: backend jaringan menyimpan `Network` di `OnceLock`, dan `Network` memegang backend, jadi socket UDP tidak pernah dilepas setelah shutdown. Kini backend melepas `Network` saat shutdown, reset mencoba memulai jaringan lagi beberapa kali, dan tes `shutdown_after_detach_frees_the_port` memastikan port yang sama bisa dipakai lagi. Di rilis (tanpa `MIRA_PORT`) dampaknya satu port terbuang per reset.

## Batasan

- **Jalur kode undangan tidak memeriksa versi.** Laptop 0.5.0 yang masuk lewat kode undangan setelah ada penonaktifan tidak bisa membaca `member_suspend`, menganggap orang nonaktif masih aktif, dan bisa membagi data fitur ke laptop itu kalau laptop itu memakai Mira yang dimodifikasi. Mira asli di laptop nonaktif tidak menerima data fitur.
- **Ambang versi di build dev.** Selama nomor versi masih 0.5.0, build dari branch ini menganggap laptop 0.5.0 rilis cukup baru. Rilis ini harus bernomor 0.5.1.
- **Cuplikan beku.** Selama seseorang nonaktif, admin tidak bisa mengurangi apa yang akan dikembalikan (proyek, label, superadmin). Untuk mencabut superadmin, aktifkan lagi lalu turunkan.
- **Laptop yang belum pernah diterima** tapi menyimpan catatan kantor melihat layar keluar dengan Reset yang ditolak. Ini hanya terjadi kalau op penerimaan laptop itu sendiri ditolak di fold-nya, dan pesan penolakannya menjelaskan.
- **Fitur yang membaca tabel `members`** mengembalikan galat `removed` (bukan `suspended`) ke laptop nonaktif; layar nonaktif tetap tampil karena ditentukan dari keanggotaan.
- LDAP sungguhan tetap belum pernah dijalankan; semua skenario AD memakai `MIRA_FAKE_AD`.
- **Skrip e2e lama dan Credential Manager.** Skrip lama (org, e2e-multi, join, english, chat, sync) membersihkan dengan menghapus setiap `device-key-*` yang dibuat setelah skrip mulai. Kalau beberapa sesi menjalankan e2e bersamaan, skrip itu bisa menghapus kunci uji sesi lain (ini yang dua kali membuat `sync-e2e` gagal di sini). Peluncuran yang gagal juga meninggalkan kunci uji: saat laporan ini ditulis ada sekitar 62 entri `device-key-*`, sebagian besar dari uji berbagai sesi. Saya hanya menghapus kunci dari peluncuran diagnostik saya sendiri; sisanya tidak bisa dibedakan dari kunci Mira yang terpasang, jadi dibiarkan. Dua skrip baru mencatat sendiri kunci yang mereka buat dan hanya menghapus kunci itu.

## Catatan penggabungan

- Di luar folder milik sesi: `src/i18n/errors.{id,en}.ts`, `errors.test.ts`, `api.{id,en}.ts`, `noIndonesian.test.tsx`, `App.test.tsx`, `src/test/orgFixtures.ts`, beberapa tes board (field `listUsers`), `src-tauri/src/error.rs` (`AppError::Suspended`), `org_ad_commands.rs` (literal tes), `src/screens/shell/NetworkPanel.tsx` (ikon status `suspended`), `LabelsPanel.test.tsx`.
- Untuk rilis: naikkan versi ke 0.5.1. Catatan "Yang baru" sebaiknya menyebut bahwa Nonaktifkan baru bisa dipakai setelah semua laptop kantor diperbarui.
