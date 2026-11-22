# Laporan Tahap 1: Jaringan dan tim

Tanggal: 22 November 2026. Rencana: `docs/plans/tahap-1.md` (termasuk bagian "Perubahan setelah review keamanan").

## Ringkasan

Tahap 1 selesai di uji satu PC. Tiga instance Mira dijalankan dengan folder data berbeda, dan hasilnya:
- Ketiganya saling menemukan lewat mDNS dan tersambung lewat QUIC terenkripsi dengan autentikasi dua arah.
- Instance kedua dan ketiga bergabung lewat kode undangan dengan peran yang benar.
- Kode yang salah, sudah terpakai, atau kedaluwarsa ditolak.
- Anggota yang dikeluarkan berhenti menerima data.
- Instance yang dimatikan lalu dinyalakan menyusul perubahan yang terlewat.

Semua tes lulus, installer NSIS terbentuk, dan semua pekerjaan ter-commit lokal di `main` tanpa push. Yang belum diuji adalah beberapa laptop sungguhan di jaringan kantor dan sambungan lewat VPN. Rinciannya ada di bawah.

## Yang dibuat

**Log keanggotaan bertanda tangan (`src-tauri/src/permissions/`)**
- Setiap perubahan keanggotaan adalah "op": JSON yang ditandatangani kunci Ed25519 laptop pembuatnya. Id op adalah BLAKE3 dari isinya.
- Ada 14 jenis op: profil, buat dan hapus tim, angkat dan lepas superadmin, angkat dan lepas admin tim, tambah dan keluarkan anggota tim, keluarkan dari organisasi, buat dan cabut undangan, terima undangan, dan buat channel tim.
- Status organisasi dihitung ulang dari record genesis Tahap 0 ditambah semua op. Laptop dengan himpunan op yang sama selalu mendapat status yang sama (diuji dengan urutan kedatangan berbeda di beberapa database).
- Setiap op dari laptop lain diperiksa formatnya, tanda tangannya, organisasinya, dan izin pembuatnya pada posisinya.
  - Yang formatnya atau tanda tangannya salah tidak disimpan dan dicatat di `rejected_changes`.
  - Yang pembuatnya tidak berhak disimpan dengan status `rejected` beserta alasannya.
- Rantai kepercayaan (F-ROLE-12): genesis organisasi, lalu superadmin yang mengangkat admin tim, lalu admin tim yang menandatangani undangan, lalu laptop mana pun yang memeriksa kode dan menandatangani penerimaan.
- Kode undangan berupa 20 karakter (`ABCD-EFGH-JKMN-PQRS-TVWX`) dengan peran Admin tim, Anggota, atau Tamu, dan masa berlaku 24 jam, 7 hari, atau Sekali pakai.
- Superadmin minimal satu dijaga oleh aturan, dan tampilan memberi peringatan kalau baru satu.
- Channel `#umum` dan channel per tim sudah ada datanya untuk Tahap 2.
- Migrasi SQLite v2 sebagai entri ke-2 `MIGRATIONS`, dengan tabel: `org_ops`, `teams`, `team_members`, `invites`, `guest_access`, `channels`, `peer_addresses`, `manual_addresses`, `peer_seen`, `rejected_changes`.
- `verify_genesis` dan record organisasi dari laptop lain kini diperiksa format setiap field-nya (bawaan Tahap 0).

**Jaringan (`src-tauri/src/network/`)**
- **Endpoint:** QUIC (quinn + rustls) di UDP 47800 sampai 47809, atau di `MIRA_PORT` kalau diset.
- **Autentikasi:** kedua pihak menunjukkan sertifikat Ed25519 dari kunci laptopnya, dan tanda tangan jabat tangan TLS 1.3 diperiksa dengan kunci itu. Identitas peer selalu berasal dari sertifikat itu.
- **Keanggotaan:** setelah jabat tangan, kedua sisi memeriksa bahwa peer anggota aktif organisasi yang sama.
  - Bukan anggota: ditolak dan dicatat.
  - Sudah dikeluarkan: menerima op pengeluarannya, lalu diputus.
- **Bergabung dengan kode:** ALPN terpisah (`mira-join/1`) yang hanya melayani dua pesan, dengan batas 10 percobaan per menit dan 2 sesi bersamaan per IP.
- **Sinkronisasi:**
  - Terjadi saat tersambung, setiap 30 detik, dan setiap ada op baru (lalu diteruskan ke peer lain).
  - Setiap op difilter per penerima: isi tim (channel tim) hanya dikirim ke anggota tim itu (F-ROLE-04).
- **Penemuan dan alamat:**
  - Penemuan lewat mDNS (`_mira._udp.local.`).
  - Alamat terakhir setiap rekan diingat dan dicoba ulang setiap 10 detik dengan jeda yang makin panjang (F-NET-03).
  - Alamat manual bisa diisi, dan alamat yang dipakai saat bergabung ikut diingat.
- **Status koneksi:** LAN, VPN (dari nama adaptor), atau tidak tersambung. Ada dua keadaan tambahan:
  - "Belum ada rekan di organisasi";
  - "Laptop ini sudah dikeluarkan".
- **Batas sumber daya:** QUIC Retry, batas koneksi tertunda per IP, batas buffer, dan timeout di setiap baca dan tulis.

**Platform**
- **Panduan Windows Firewall (F-ID-03),** di onboarding dan di Pengaturan > Jaringan:
  - Membaca aturan untuk `mira.exe` dan kategori jaringan (Public atau Private), hanya baca.
  - Tombol "Izinkan lewat Windows Firewall" menjalankan PowerShell dengan izin administrator, dan Windows menampilkan UAC.
  - Perintah untuk admin IT bisa disalin.
- **Warna latar jendela** diambil dari mode tema yang tersimpan, supaya tidak ada kedip putih saat dibuka dalam mode Gelap (bawaan Tahap 0).
- **Kunci laptop** kini disimpan dengan `CRED_PERSIST_LOCAL_MACHINE`, sehingga tidak ikut roaming. Entri lama berjenis "enterprise" dari Tahap 0 ditulis ulang otomatis saat dibaca (bawaan Tahap 0).
- **QR code dan tautan** `mira://peer?pk=...&addr=...` untuk alamat laptop ini.

**Tampilan (`src/`)**
- **Onboarding:**
  - "Gabung dengan kode" sungguhan, dengan alamat laptop rekan sebagai cadangan.
  - Langkah firewall sebelum bergabung dan setelah membuat organisasi.
- **Sidebar:** status koneksi dan daftar "Di jaringan", berisi rekan online lalu offline dengan "Terakhir terlihat".
- **Menu Organisasi:**
  - Tim, anggota, dan peran.
  - Dialog undangan seperti mockup. Opsi Tamu dinonaktifkan dengan penjelasan karena proyek baru ada di Tahap 3.
  - Daftar undangan dengan status dan tombol Cabut.
  - Angkat dan lepas superadmin, keluarkan dari organisasi (dengan konfirmasi), dan "Punya kode undangan untuk tim lain?".
- **Pengaturan > Jaringan:** alamat dan QR, alamat manual, status penemuan otomatis, dan panduan firewall.
- **Layar penuh** saat laptop dikeluarkan dari organisasi.

**Uji**
- `scripts/e2e-multi.mjs` (`npm run test:e2e-multi`): empat instance build release di satu PC, 25 pemeriksaan, lalu membersihkan folder data dan kunci uji di Credential Manager.
- Tes integrasi Rust `net_backend_tests.rs`: tiga node dalam satu proses lewat loopback, memakai backend sungguhan.

## Desain protokol singkat

1. **Op:** `{ payload, sig }`.
   - `payload` adalah JSON berisi `v`, `org`, `author`, `lamport`, `deps`, `at`, `nonce`, `scope`, `body`.
   - `sig` adalah tanda tangan Ed25519 atas `"mira-op-v1\n" + payload`.
   - Urutannya `(lamport, author, id)`. `deps` berisi op terakhir yang sudah dilihat pembuat.
   - Op yang memakai hak yang kemudian dicabut, dan tidak ada di masa lalu pencabutan itu, ditolak di semua laptop. Ini menutup serangan "memundurkan" op supaya diurutkan sebelum pengeluaran dirinya.
2. **Undangan:**
   - Kode 100 bit. 8 karakter pertama (`tag`) dipakai untuk mencari undangan, dan seluruh kode menurunkan kunci Ed25519 undangan.
   - `invite_create` menyimpan kunci publiknya beserta `key_sig`. Kode sendiri tidak pernah disimpan atau dikirim.
   - Orang yang bergabung menandatangani penerimaannya dengan kunci undangan dan kunci laptopnya.
   - Laptop anggota yang memeriksa menulis op `invite_accept`, yang bisa diperiksa ulang oleh laptop mana pun.
3. **Jabat tangan:**
   - QUIC dengan TLS 1.3, sertifikat Ed25519 di kedua sisi, ALPN `mira/1`.
   - Lalu `Hello` (organisasi harus sama, kunci harus sama dengan kunci TLS), lalu pemeriksaan keanggotaan.
4. **Sinkron:** `SyncHave` (id yang boleh diterima peer), lalu `SyncWant`, lalu `SyncOps` (difilter ulang).
5. **Bergabung:** `JoinHello { tag }`, lalu `JoinChallenge { org, invite }`, lalu `JoinProof`, lalu `JoinAccepted { org, ops }`. Laptop baru memeriksa genesis, memastikan undangan dengan kunci dari kodenya ada dan dirinya tercatat sebagai pemakainya, lalu memastikan dirinya anggota aktif.

## Keputusan yang saya ambil sendiri

| Keputusan | Alasan |
|---|---|
| Direktori organisasi (siapa anggota, tim apa saja, siapa di tim mana, undangan yang belum dipakai beserta kunci publiknya) dikirim ke semua anggota aktif, termasuk Tamu. Isi tim (channel tim sekarang; chat, board, dan dokumen nanti) hanya ke anggota tim. | Setiap laptop butuh rantai lengkap untuk memeriksa perubahan dan kode undangan tanpa server. Akibatnya Tamu bisa melihat daftar staf dan nama tim. Lihat bagian "Yang perlu Anda putuskan". |
| Laptop yang dikeluarkan tidak bisa bergabung lagi dengan kode undangan. | Orang yang dikeluarkan mungkin masih tahu kode 7 hari yang masih aktif. Untuk bergabung lagi, ia perlu folder data dan kunci baru. |
| Pencabutan hak menang atas op yang dibuat bersamaan dengan pencabutan itu. Kalau dua superadmin saling mengeluarkan secara bersamaan, yang lebih senior (pendiri, lalu urutan pengangkatan) menang. | Ini satu-satunya aturan deterministik yang menutup serangan memundurkan op. Efek sampingnya, perubahan jujur yang dibuat offline tepat saat hak pembuatnya dicabut ikut ditolak. |
| "Sekali pakai" berarti satu orang, berlaku paling lama 7 hari. | PRD menyebut tiga pilihan masa berlaku. Kode sekali pakai tanpa batas waktu terlalu lama terbuka. |
| Undangan Tamu belum bisa dibuat di tampilan. | Proyek baru ada di Tahap 3. Model data (`projects`, `guest_access`) sudah siap. |
| Pemindaian QR dengan webcam belum dibuat. Yang ada: QR ditampilkan, plus tautan `mira://` yang bisa disalin dan ditempel. | Izin kamera di WebView2 tidak bisa diverifikasi dengan bersih di sini. QR tetap bisa dibaca kamera HP. |
| Tombol firewall menjalankan PowerShell dengan izin administrator (UAC). Untuk karyawan tanpa hak admin, tersedia perintah satu baris untuk admin IT. Tidak ada aturan terpisah untuk port 5353. | Installer per pengguna tidak bisa membuat aturan firewall. Aturan per program sudah mencakup mDNS milik Mira, sedangkan aturan port akan membuka 5353 untuk semua program. |
| Kunci laptop ditulis lewat Credential Manager API langsung, dengan mode `LOCAL_MACHINE`. | Crate `keyring` memakai mode "enterprise" yang ikut roaming ke server domain. |
| Port tetap 47800 (sampai 47809 untuk beberapa instance). Ada tiga variabel uji: `MIRA_PORT`, `MIRA_DISABLE_MDNS=1`, dan `MIRA_CLOCK_OFFSET_SECS`. | Port tetap memudahkan tim jaringan (Lampiran A no. 4). Variabel jam dipakai untuk menguji undangan kedaluwarsa tanpa menunggu 24 jam; efeknya sama dengan mengubah jam Windows. |
| Command baru ditaruh di `team_commands.rs` dan `network_commands.rs`, dan gaya akhir baris setiap file disamakan dengan commit Tahap 0. | Mengikuti permintaan koordinasi dari session Tahap 3 sampai 5, supaya merge nanti mudah. |
| `@radix-ui/react-dialog` ditambahkan. | Dialog undangan dan konfirmasi butuh focus trap dan Escape yang benar. |

## Hasil verifikasi (apa adanya)

| Pemeriksaan | Hasil |
|---|---|
| `cargo test` (di `src-tauri`) | 224 lulus, 7 diabaikan (keyring sungguhan, firewall langsung, mDNS) |
| Tes yang diabaikan, dijalankan manual oleh subagen | Keystore (4) dan firewall baca-saja lulus. mDNS dua node dalam satu proses lulus. |
| `cargo clippy --all-targets -D warnings`, `cargo fmt --check` | Bersih |
| `npm test` (Vitest) | 99 lulus di 10 file |
| `npm run build` | Lulus |
| Tes integrasi tiga node (Rust, loopback) | 5 skenario lulus, dijalankan 6 kali tanpa gagal |
| `scripts/e2e-multi.mjs` terhadap build release | 25 dari 25 lulus, dijalankan 3 kali (sekali sebelum perbaikan `deps`, dua kali dengan kode final) |
| `npm run build:installer` | Lulus: `Mira_0.1.0_x64-setup.exe`, 3,52 MB |

Pemeriksaan di uji multi-instance:
- B bergabung lewat penemuan otomatis (mDNS antarproses), dan C lewat alamat.
- Peran di tim tersinkron.
- Setiap instance melihat dua rekan online di data dan di layar "Di jaringan".
- Status A "Tersambung lewat LAN kantor".
- Penolakan:
  - Kode yang tidak sah memberi `invite_not_found`.
  - Kode sekali pakai yang terpakai memberi `invite_used`.
  - Kode yang kedaluwarsa memberi `invite_expired`; jam A dimajukan 25 jam.
  - Laptop yang ditolak tidak mendapat organisasi.
- C yang dimatikan lalu dinyalakan menerima tim baru.
- Channel Tim Pemasaran sampai ke B (anggota tim itu) dan tidak sampai ke C.
- Setelah B dikeluarkan:
  - B tahu dirinya dikeluarkan dan tidak menerima tim baru;
  - C tetap menerima perubahan;
  - B putus dari A.

Screenshot ada di `docs/progress/screenshots/tahap-1/`. Nama "Ayu Uji", "Budi Uji", "Citra Uji", dan "Dodi Uji" adalah data uji.

Review dilakukan oleh empat subagen terpisah:
- **Platform:** tidak ada celah injeksi perintah. Yang diperbaiki:
  - perintah firewall melewatkan aturan blok berbasis variabel lingkungan;
  - pesan error PowerShell tidak terbaca;
  - cek "firewall mati" bisa fail-open.
- **Izin:** yang diperbaiki:
  - bukti undangan lama bisa diputar ulang untuk mengembalikan peran;
  - satu op dengan lamport raksasa bisa membekukan organisasi;
  - timestamp ekstrem membuat aplikasi panik;
  - kunci undangan bisa disalin ke undangan atau organisasi lain;
  - lamport bisa dimundurkan (diperbaiki dengan `deps`).
- **Jaringan:** tidak ada temuan kritis atau tinggi. Yang diperbaiki:
  - slot koneksi bisa dihabiskan dengan jabat tangan yang tidak selesai;
  - memori bisa ditimbun sebelum otorisasi;
  - slot gabung bisa dimonopoli;
  - kandidat palsu bisa menghentikan gabung;
  - badai dial dari mDNS;
  - alamat loopback dari `Hello`.
- **Tampilan dan kontrak JSON:** kontrak cocok field demi field. Yang diperbaiki:
  - status alamat manual yang gagal;
  - teks yang menjanjikan bisa bergabung lagi setelah dikeluarkan.

Tes integrasi juga menemukan dua masalah yang sudah diperbaiki:
- Alamat yang dipakai saat bergabung tidak diingat, sehingga laptop tanpa mDNS tersendiri.
- Anggota baru baru disebarkan pada sinkron 30 detik berikutnya.

**Belum dicek atau masih terbatas:**
- **Belum diuji di beberapa laptop sungguhan dan lewat VPN.** Semua uji berjalan di satu PC, jadi lalu lintas antarlaptop dan firewall di jaringan sungguhan belum teruji. Butuh minimal tiga laptop di kantor dan satu lewat VPN.
- **Tombol "Izinkan lewat Windows Firewall" (UAC) tidak pernah dijalankan,** karena itu mengubah pengaturan sistem. Yang sudah dicek hanya sintaks perintahnya dan bagian baca-sajanya. Cara mengujinya: di laptop uji, buka Pengaturan > Jaringan, klik tombolnya, setujui UAC, lalu klik "Periksa lagi". Status harus berubah jadi diizinkan, dan aturan "Mira" muncul di `wf.msc`.
- **Prompt Windows Firewall saat uji:** menjalankan `mira.exe` yang mendengar di `0.0.0.0` bisa memunculkan prompt Windows Firewall di PC ini. Saya tidak mengklik apa pun di prompt itu. Uji tetap lulus karena lalu lintas di satu PC tidak difilter firewall.
- **Status firewall di PC ini** terbaca "Windows Firewall sudah mengizinkan Mira" (screenshot `panduan-firewall.png`). Saya tidak mengklik prompt firewall dan tidak mengubah aturan apa pun. Saya juga tidak tahu apakah aturannya dibuat oleh prompt Windows saat uji, sudah ada sebelumnya, atau firewall untuk profil itu mati. Silakan cek di `wf.msc`. Screenshot itu juga memuat nama Wi-Fi PC ini.
- **Deteksi VPN** memakai nama adaptor Windows (misalnya "Ethernet 3"), bukan deskripsinya. Adaptor seperti Cisco AnyConnect atau Fortinet bisa tampil sebagai LAN. Perlu dicek dengan VPN kantor yang sebenarnya.
- **Masa berlaku undangan** diperiksa terhadap `at` yang ditulis laptop pemeriksa. Anggota yang curang dan tahu kode lama bisa memundurkan jam laptopnya. Tanpa server tidak ada sumber waktu tepercaya.
- **Superadmin senior yang dikeluarkan** oleh superadmin junior masih bisa membalas kalau punya kaki tangan atau laptop yang belum mendengar pengeluarannya.
- **Op ber-scope tim** (channel tim) tidak ikut dibatalkan oleh pencabutan hak.
- **Status organisasi dihitung ulang** dari semua op setiap kali dibutuhkan. Untuk 10 sampai 30 orang ini cepat, tapi perlu cache sebelum log menjadi ribuan op (Tahap 2).
- **`JoinAccepted` harus muat dalam 4 MiB,** dan ini membatasi organisasi yang sangat besar.
- **Uji multi-instance** menjalankan exe dari `target/release`, bukan aplikasi hasil instal. Installer sendiri sudah diuji di Tahap 0.
- **Teks error yang kurang tepat:**
  - `name_required` saat bergabung berbunyi "sebelum membuat organisasi" (tampilan menampilkan teksnya sendiri);
  - peran undangan yang tidak dikenal memberi kode `forbidden`, padahal ini kesalahan input.

## Cara menguji multi-instance

```
npm install
npm run build:installer            # atau: npx tauri build --no-bundle
npm run test:e2e-multi             # 4 instance, 25 pemeriksaan, membersihkan sendiri
cd src-tauri; cargo test           # termasuk tes integrasi tiga node
```

Manual, di tiga jendela PowerShell:

```
$env:MIRA_DATA_DIR = "D:\mira-uji\laptop-a"; $env:MIRA_PORT = "47801"; & ".\src-tauri\target\release\mira.exe"
$env:MIRA_DATA_DIR = "D:\mira-uji\laptop-b"; $env:MIRA_PORT = "47802"; & ".\src-tauri\target\release\mira.exe"
$env:MIRA_DATA_DIR = "D:\mira-uji\laptop-c"; $env:MIRA_PORT = "47803"; & ".\src-tauri\target\release\mira.exe"
```

Langkah:
1. Di A: buat organisasi, buat tim di menu Organisasi, lalu "Undang ke tim".
2. Di B dan C: "Gabung dengan kode". Kalau penemuan otomatis gagal, isi alamat `127.0.0.1:47801`.
3. Untuk menguji alamat manual saja, tambahkan `$env:MIRA_DISABLE_MDNS = "1"`.
4. Untuk menguji kedaluwarsa, jalankan ulang A dengan `$env:MIRA_CLOCK_OFFSET_SECS = "90000"`.

Untuk mengulang dari awal, hapus folder data dan entri `device-key-...id.mira.desktop` di Credential Manager.

## Lokasi installer

`D:\GitHub\ChatCompany\src-tauri\target\release\bundle\nsis\Mira_0.1.0_x64-setup.exe` (tidak di-commit).

## Yang perlu Anda putuskan

1. **Apakah Tamu boleh melihat direktori organisasi** (nama staf, nama tim, siapa di tim mana)? Saat ini boleh, karena setiap laptop butuh rantai lengkap. Kalau tidak boleh, Tahap 3 perlu versi direktori yang dipangkas untuk Tamu beserta cara memeriksa rantainya. Ini lebih rumit.
2. **Laptop yang dikeluarkan: boleh bergabung lagi dengan kode baru, atau tidak sama sekali?** Saat ini tidak boleh, dan orangnya harus memakai folder data baru.
3. **Dua superadmin yang saling mengeluarkan secara bersamaan: yang senior menang** (sekarang), **atau keduanya batal?**
4. **Aturan firewall:** dipasang per orang lewat tombol (butuh hak admin), atau oleh admin IT lewat Group Policy untuk semua laptop (Lampiran A no. 8)? Perintah untuk admin IT sudah tersedia di aplikasi.
5. **Jawaban tim jaringan atas Lampiran A PRD** (mDNS, isolasi Wi-Fi, VLAN, VPN) masih dibutuhkan, beserta tiga laptop dan satu VPN untuk uji sungguhan.
6. **Label tahap di tampilan** ("Direncanakan di Tahap 2", "proyek baru hadir di Tahap 3"): tetap seperti di Tahap 0, atau diganti sebelum pilot?

## Commit

Branch `main`, tanpa remote dan tanpa push. Lihat `git log 0268a56..HEAD`. Berisi:
- rencana dan dependensi;
- modul platform, izin, jaringan, dan tampilan dari empat subagen paralel;
- integrasi;
- perbaikan dari lima review;
- tes integrasi dan uji multi-instance;
- `deps` kausal;
- laporan ini.

Catatan: saat membersihkan worktree build sementara, `git worktree remove --force` ikut masuk ke junction dan mengosongkan `node_modules` di checkout utama. Folder itu sudah saya pulihkan dengan `npm ci` dari `package-lock.json`, dan semua tes lulus lagi. Tidak ada data lain yang tersentuh.
