---
tags: [mira, keputusan]
---

# Keputusan

Keputusan desain yang sudah berlaku, dikumpulkan dari PRD dan laporan tahap. Alasan lengkapnya ada di tabel "Keputusan yang saya ambil sendiri" di setiap laporan.

## Prinsip produk (PRD)

- LAN murni. Hanya laptop di jaringan kantor yang bisa tersambung; dari luar kantor lewat VPN kantor.
- Tanpa login. Identitas adalah kunci unik laptop ditambah nama tampilan.
- Offline itu normal. Setiap fitur harus tetap benar setelah laptop offline lalu tersambung lagi.
- Data dibatasi dari sumbernya. Laptop hanya menerima data yang boleh ia lihat.
- Satu organisasi untuk seluruh kantor, dibagi per tim, dengan channel #umum untuk semua.
- Bukan tujuan saat ini: server, akun cloud, tanda tangan elektronik tersertifikasi, edit dokumen bersamaan secara langsung, aplikasi HP, dan Linux. PRD awalnya juga mencantumkan macOS; itu diubah pada 23 November 2026, lihat [[#Dukungan macOS (23 November 2026)]].

## Platform dan installer ([[Tahap 0]])

- Installer utama mengunduh WebView2 kalau belum ada. Varian offline tersedia.
- Installer per pengguna di `%LOCALAPPDATA%\Mira`, karena karyawan sering tidak punya hak admin.
- Data di `%LOCALAPPDATA%`, bukan roaming, dan SQLite memakai `synchronous=FULL` supaya mati listrik tidak menghilangkan data.
- Uji ujung ke ujung memakai DevTools Protocol, bukan WebdriverIO + tauri-driver seperti di PRD.

## Jaringan dan izin ([[Tahap 1]])

- Direktori organisasi dikirim ke semua anggota aktif, termasuk Tamu, karena setiap laptop butuh rantai lengkap. Isi tim hanya ke anggota tim.
- Laptop yang dikeluarkan tidak bisa bergabung lagi dengan kode undangan; perlu folder data dan kunci baru.
- Pencabutan hak menang atas op yang dibuat bersamaan. Dua superadmin yang saling mengeluarkan: yang lebih senior menang.
- "Sekali pakai" berarti satu orang, berlaku paling lama 7 hari.
- Port tetap 47800, supaya mudah diatur tim jaringan.
- Tombol firewall memakai PowerShell dengan UAC, plus perintah satu baris untuk admin IT.

## Chat ([[Tahap 2]])

- Channel "Seluruh kantor" hanya bisa dibuat superadmin. Setiap proyek board otomatis punya channel proyek.
- Tamu boleh memegang titipan tersegel. Titipan hanya dibuat antara dua anggota yang berbagi percakapan.
- Lampiran yang bisa menjalankan program hanya bisa disimpan, tidak dibuka.
- Dialog pilih dan simpan file dijalankan di sisi Rust, jadi skrip di webview tidak bisa membaca file sembarangan.
- Status gabungan pesan channel diambil dari penerima dengan status paling rendah.
- Celah grup yang diketahui (diputuskan 23 November 2026, v0.3.0): orang yang sudah dikeluarkan dari organisasi tapi masih tercatat di grup bisa menandatangani penambahan anggota yang tanggalnya dibuat mundur. Rekan yang ditambahkan ikut membaca riwayat grup. Celah ini dibiarkan sebagai batasan, karena menutupnya penuh juga menghapus penambahan sah yang pernah dibuat orang itu. Penambahan selalu tampil sebagai "X menambahkan Y" bagi semua anggota, dan pemilik grup bisa langsung mengeluarkan Y. Rencana lanjutan: tandai penambahan oleh orang yang sudah dikeluarkan dengan peringatan yang jelas di percakapan.

## Board ([[Tahap 3]])

- Actor Automerge adalah kunci publik laptop. Kolom tetap To do, Dikerjakan, Selesai.
- Hapus task berupa tanda "terhapus", bukan dibuang dari dokumen.
- Proyek tanpa tim terlihat oleh semua anggota aktif kecuali Tamu.
- Tamu hanya membaca board dan tidak berkomentar; diskusi Tamu lewat channel proyek.
- Nomor task ganda diselesaikan dengan change bertanda tangan. Kode proyek ganda hanya diselesaikan di tampilan lokal.
- Draf di tampilan tidak pernah tertimpa muat ulang.

## Dokumen ([[Tahap 4]])

- Versi disimpan sebagai graf, jadi bentrok muncul sendiri saat ada dua kepala.
- Pulihkan selalu membuat versi baru.
- Nomor versi hanya untuk tampilan per laptop; identitas versi memakai id acak.
- File jenis program tidak pernah dibuka dari Mira.
- File sampai 20 MB disalin otomatis ke laptop rekan; yang lebih besar diunduh saat diklik.
- Id dokumen, versi, dan permintaan diturunkan dari kunci penulis ditambah salt acak, supaya rekan tidak bisa lebih dulu memakai id milik orang lain.
- Dokumen dan tanda tangan memakai aturan akses proyek dan Tamu milik board. Tamu tidak melihat Pustaka Umum.

## Tanda tangan ([[Tahap 5]])

- Kunci gambar tanda tangan dari Argon2id(PIN) digabung pepper kunci laptop. PIN tidak pernah disimpan.
- Hapus tanpa PIN memberi masa tunggu 24 jam.
- Setelah PIN benar, inti Rust memberi token sekali pakai berumur 5 menit untuk menyimpan versi bertanda tangan.
- Teks stempel memakai Helvetica bawaan pdf-lib; huruf di luar Latin diganti `?`.
- Batas 50 MB saat impor dan 100 MB untuk versi bertanda tangan.
- Stempel ditambahkan sebagai incremental update PDF. Versi lama harus menjadi awalan byte yang persis dari versi baru, dan setiap objek yang berubah harus masuk daftar yang diizinkan. Versi yang mengubah isi selain stempel ditolak (`version_changes_content`).
- Halaman tambahan hanya boleh dari penanda tangan terakhir (halaman catatan), supaya penanda tangan di tengah tidak bisa menyisipkan adendum.
- Mode bebas, dua tanda tangan bersamaan saat offline: yang waktunya paling awal menang, lalu kunci terkecil. Hasilnya sama di semua laptop.

## Dukungan macOS (23 November 2026)

- Kantor memakai MacBook dan Windows, jadi Mira juga dibuat untuk macOS 11 atau yang lebih baru, Apple Silicon dan Intel.
- Build Mac lewat GitHub Actions. Tes otomatis juga berjalan di sana, pada runner macOS dan Windows.
- Tanpa akun Apple Developer untuk sekarang. `Mira.app` ditandatangani ad-hoc dan tidak dinotarisasi.
- Skrip pasang satu baris `install.sh` menghapus tanda karantina setelah menyalin `Mira.app`, supaya Gatekeeper tidak menolak pembukaan pertama. Keaslian file dijaga lewat pencocokan SHA-256 dengan `digest` dari GitHub. Ini diterima karena Mira alat internal.
- Skrip pasang tidak pernah memakai `sudo`. Kalau `/Applications` tidak bisa ditulis, Mira dipasang di `~/Applications`.

Rinciannya di [[macOS]].

## Bahasa tampilan (24 November 2026)

- Mira punya dua bahasa tampilan: Indonesia (bawaan) dan Inggris. Dipilih per laptop di Pengaturan > Bahasa atau di onboarding, berlaku tanpa restart.
- Kamus bertipe buatan sendiri di `src/i18n`, tanpa pustaka i18n. Kunci yang hilang gagal di `tsc`.
- Hanya tampilan yang diterjemahkan. Data yang disimpan atau disinkronkan (nama kolom bawaan, isi jejak audit) dan teks di PDF bertanda tangan tetap seperti tercatat.
- Error dari inti Rust tetap berbahasa Indonesia di Rust; tampilan memetakan kodenya ke bahasa Inggris.

Rinciannya di `docs/progress/v04-english.md`.

## v0.4: bergabung, chat, board, menu (24 November 2026)

- Satu aplikasi untuk semua peran, tanpa aplikasi superadmin terpisah. Menu dan tab admin hanya tampil untuk peran yang berhak. Membuat kantor baru disembunyikan di bagian "Untuk admin IT".
- Orang baru menulis keterangan untuk admin, dan admin melihat nama akun login laptopnya, supaya bisa memastikan orangnya sebelum menyetujui.
- Chat proyek tampil sebagai grup berisi anggota proyek dan tidak bisa diarsipkan atau dihapus. Id percakapannya sama dengan v0.3, jadi laptop v0.3 tetap bertukar pesan.
- Grup boleh berisi pembuatnya saja.
- Subtask dan catatan waktu disimpan di dokumen Automerge task. Laptop v0.3 menolak perubahan itu; setelah diperbarui, catatan penolakan dikosongkan sekali supaya laptop itu menyusul.
- Menu klik kanan memakai komponen sendiri, bukan pustaka. Menu bawaan WebView dimatikan di seluruh aplikasi. Sidebar menu utama tidak punya menu klik kanan.

## v0.5: Active Directory dan satu domain satu kantor (24 November 2026)

- Data AD mengisi otomatis (tingkat A), admin tetap menyetujui. Persetujuan otomatis lewat bukti login Windows ditunda. Persetujuan otomatis hanya dari data AD ditolak, karena data itu dikirim laptop peminta sendiri dan bisa dipalsukan.
- Cek ulang dari laptop admin membuktikan akun ada dan aktif, bukan bahwa peminta pemilik akun itu. Kode cocok tetap dipakai.
- Departemen diambil dari atribut `department` AD; kalau kosong, dari pemetaan OU yang diatur superadmin. Departemen yang belum ada di Mira tidak dibuat otomatis.
- Satu domain, satu kantor. Pembuatan kantor tetap sekali oleh admin IT, karena pembuatnya menjadi superadmin dan tanpa server dua laptop bisa membuat kantor bersamaan. Kalau terlanjur ada dua kantor dengan domain sama, yang genesis-nya paling awal menjadi kantor utama; isi dua kantor tidak bisa digabung.
- Data AD peminta (nama akun, DN, nama, departemen) tersimpan di catatan kantor dan terlihat oleh anggota. Layar peminta memberi tahu hal ini.
- Tab "Departemen saya" dan Divisi dikerjakan di v0.6, lihat bagian v0.6 di bawah.

## v0.6: divisi, Kopi, chat, timer, kalender, nonaktifkan (25 November 2026)

Departemen dan divisi
- Divisi dibuat oleh admin departemen di departemennya sendiri atau oleh superadmin, bukan oleh anggota biasa. Anggota biasa tetap bisa membuat Grup chat.
- Tidak ada peran kustom dengan hak bebas. Peran tetap Superadmin, Admin departemen, Kepala divisi, Anggota, dan Tamu.
- Admin departemen menunjuk satu atau lebih kepala divisi. Kepala divisi hanya bisa menambah orang aktif bukan Tamu dari departemen yang sama. Satu orang boleh di beberapa divisi; pindah atau keluar departemen melepas divisinya di departemen lama.
- Admin departemen boleh mengangkat dan melepas admin lain di departemennya, dengan aturan senioritas: ia hanya melepas admin yang diangkat setelah dirinya, atau dirinya sendiri. Tanpa aturan ini, admin yang sudah dilepas bisa membalikkannya dengan op bertanggal mundur. Admin terakhir tidak bisa melepas dirinya; superadmin boleh.
- Pengaturan chat (catatan disematkan dan mode pengumuman) disimpan sebagai op log keanggotaan, bukan record chat, supaya semua anggota departemen melihat pengaturan yang sama dan izinnya ikut fold.
- Catatan disematkan adalah teks yang ditulis pengelola (paling banyak 500 karakter dan 20 baris), bukan penanda pada pesan tertentu. Menyematkan pesan bisa ditambah nanti.
- Mode pengumuman hanya berlaku di channel utama departemen dan chat divisi, dan hanya menolak pesan yang waktunya sama atau setelah pengaturan dibuat, supaya semua laptop sampai pada putusan yang sama.
- Proyek divisi dibuat oleh kepala divisi itu, admin departemennya, atau superadmin. Anggota proyek tidak mengikuti perubahan anggota divisi setelah proyek dibuat.
- Divisi yang diarsipkan menyimpan anggota dan kepala sebagai riwayat. Chatnya hanya baca, dan divisi itu tidak menerima anggota, kepala, atau pengaturan chat baru.
- Gerbang versi `DIVISION_SINCE = "0.6.0"` dengan pola `min()` seperti `JOIN_AD_SINCE`. Op divisi hanya ditulis kalau semua anggota aktif, Tamu juga, melaporkan versi itu. Jalur kode undangan tidak memeriksa versi.

Nonaktifkan dan keluarkan permanen
- Dua tindakan terpisah. Nonaktifkan (`member_suspend`) bisa dibatalkan dengan aktifkan lagi (`member_reinstate`). Keluarkan permanen (`member_remove`) tetap tidak bisa dibatalkan dan juga berlaku untuk orang yang sedang nonaktif.
- Saat nonaktif, orang itu dilepas dari departemen, proyek, label, akses Tamu, dan status superadmin, tetapi fold menyimpan cuplikan. Aktifkan lagi mengembalikan yang masih ada. Selama nonaktif, cuplikan itu tidak bisa dikurangi admin.
- Laptop nonaktif tetap tersambung lewat koneksi terbatas yang hanya membawa log keanggotaan, supaya bisa kembali tanpa restart. Op yang dibuat laptop nonaktif tidak disimpan.
- Admin departemen boleh menonaktifkan dan mengaktifkan lagi anggota biasa departemennya, mengikuti aturan lama bahwa admin boleh mengeluarkan anggota non-admin. Ia tidak bisa mengaktifkan lagi orang yang dinonaktifkan superadmin dan tidak bisa mengeluarkan permanen.
- Dua penonaktifan bersamaan dicatat bersama. Aktifkan lagi hanya berlaku kalau sudah melihat semuanya, supaya "pencabutan menang" tetap berlaku.
- Gerbang versi `SUSPEND_SINCE = "0.6.0"` untuk menulis `member_suspend`; aktifkan lagi tidak digerbang. Setelah kantor pernah memakai penonaktifan, permintaan bergabung dari Mira di bawah 0.6.0 tidak bisa disetujui.
- Reset hanya untuk laptop yang dikeluarkan permanen. Yang dihapus: kunci laptop lama dan data organisasi di folder data. Yang tetap: bahasa, tema, dan folder `ekspor`. Data dipindah dulu ke folder sementara dan dikembalikan kalau reset gagal di tengah.
- "Laptop ini pernah dikeluarkan" di kartu admin adalah petunjuk dari akun AD atau nama laptop, bukan bukti bertanda tangan kunci lama, karena laptop 0.5.0 menolak field baru di permintaan bergabung.
- Alasan data AD tidak dipakai tampil sebagai satu baris di bawah pilihan departemen, dengan urutan alasan yang tetap. Kalau AD tidak terbaca sama sekali (akun lokal, Mac), Mira tetap diam seperti di v0.5.

Kopi
- Hanya reputasi positif. Tidak ada kopi negatif atau penilaian buruk. Nama "Kopi", istilah Inggris "Coffee".
- Skor = 3 x kopi dari rekan + 1 x kopi dari kerja. Ambang Andalan 15, Senior 60, Legenda 180. Kopi dari rekan lebih bermakna dan lebih jarang, jadi Legenda tetap butuh apresiasi rekan.
- Kopi dari rekan wajib beralasan (1 sampai 120 karakter) yang terlihat semua orang di kantor. Paling banyak 3 per pemberi per hari dan 4 dari satu pemberi ke satu penerima per bulan. Tidak ke diri sendiri.
- Record ditulis laptop pemberi dan ditandatangani pemberi. Penerima tidak bisa menulis kopi rekan untuk dirinya.
- Kopi dari kerja dihitung dari board yang tersinkron, hanya kalau penanggung jawab sendiri yang memindahkan task ke Selesai, di proyek dengan lebih dari satu orang. Task dibuka lagi atau dihapus, kopinya hilang. Untuk proyek yang tidak terbaca, laptop penerima menerbitkan snapshot kerja bertanda tangan; laptop yang bisa membaca proyek selalu memakai board sendiri.
- Tamu boleh menerima kopi tapi tidak memberi, karena reputasi kantor dinilai oleh anggota.
- Superadmin bisa mematikan Kopi untuk seluruh kantor, mematikan papan bulanan saja, dan menyembunyikan satu pemberian. Semuanya record bertanda tangan superadmin.
- Tanpa gerbang versi dan tanpa migrasi bernomor. Laptop 0.5 menghentikan topik `kopi` yang tidak dikenalnya dengan diam.

Chat: reaksi, emoji, sticker
- Tanpa paket sticker bawaan. Tidak ada sticker yang meniru LINE, WhatsApp, Kaskus, atau karya berhak cipta lain; kantor mengisi sticker sendiri.
- Data emoji ditulis sendiri tanpa pustaka, dengan kata kunci Indonesia, dan hanya emoji Unicode 13 atau lebih lama supaya tampil di Windows 10 dan 11.
- Pesan sticker tetap record `message` biasa dengan teks `:nama:` dan satu gambar, bukan jenis record baru, supaya laptop lama tetap menampilkan pengganti yang wajar.
- Satu sticker kantor dipakai sebagai sticker dan sebagai emote `:nama:`. Sticker pribadi tidak menjadi emote, karena orang lain tidak punya katalognya.
- Reaksi boleh di pesan siapa pun, juga di channel Umum yang dikunci. Reaksi yang dibuat setelah channel diarsipkan diterima lalu disembunyikan, supaya putusan tidak bergantung pada record arsip yang kebetulan sudah ada. Emoji reaksi harus tepat satu emoji. Reaksi tidak memunculkan notifikasi.
- Dalam mode pengumuman, anggota yang tidak boleh menulis juga tidak bisa memberi reaksi, karena layar memakai pemeriksaan yang sama dengan menulis pesan. Record reaksi dari laptop lain hanya dinilai dengan aturan menulis, tanpa penolakan mode pengumuman. Ini batasan yang sudah diketahui.
- Jenis file sticker ditentukan dari byte (PNG, APNG, GIF, WebP). SVG dan JPEG ditolak, jadi SVG dari pengguna tidak pernah dirender. Batas 512 KB, sisi 1024 px, 120 frame, dan 32 juta piksel total.
- Reaksi dan sticker kantor hanya dikirim ke rekan yang melaporkan paling rendah `CHAT_STICKER_SINCE = "0.6.0"`. Build rilis di bawah 0.6.0 sengaja gagal dikompilasi.
- Semua label keahlian orang tampil di Chat. Organisasi dan Board tetap paling banyak 3.

Foto profil
- Foto selalu JPEG 256x256, diolah di inti Rust. Webview tidak pernah membaca file asli, dan metadata (EXIF, GPS) dibuang di satu tempat yang dites.
- Foto dari rekan harus JPEG polos dengan struktur yang diizinkan, supaya kanal foto tidak bisa membawa metadata atau file lain.
- Foto terbaru per pemilik menang. Disebar ke semua anggota aktif termasuk Tamu; laptop yang dikeluarkan tidak menerima apa pun.
- Superadmin menghapus foto per hash untuk semua pemilik, supaya anggota lain tidak bisa menerbitkan ulang foto yang sudah dihapus. Penghapusan dari Pengaturan > Profil, bukan dari layar Organisasi.
- Tanpa gerbang versi. Laptop 0.5 mengabaikan topik `profile` dan tetap menampilkan inisial.

Timer dan catat waktu manual
- Format data tidak berubah. Jeda mengisi `end` segmen yang berjalan, Lanjutkan membuat segmen baru, jadi laptop 0.5 menerima semuanya dengan total yang sama.
- Jeda langsung dengan satu klik, tanpa kotak catatan.
- Satu timer berjalan per orang di semua proyek. Timer dijeda sendiri saat timer lain dimulai, saat task masuk Selesai atau dihapus, dan saat Mira tertutup atau laptop tidur lebih dari 10 menit. Jeda karena tertutup memakai waktu terakhir Mira aktif, karena tanpa catat manual satu-satunya cara memperbaiki segmen yang terus berjalan adalah menghapusnya.
- Catat waktu manual disembunyikan lewat konstanta fitur `MANUAL_TIME_LOG = false` di `src/screens/board/timeFeatures.ts`, bukan dihapus. Catatan manual lama tetap tampil, tetap dihitung, dan bisa dihapus pemiliknya. Command `board_log_time` tetap ada.

Sidebar dan Kalender
- Pilihan sidebar ringkas disimpan di pengaturan inti Rust (`shell.sidebar`) lewat command yang sudah ada, seperti tema dan bahasa.
- Ctrl+B tidak bekerja saat dialog, menu klik kanan, atau seret tenggat sedang aktif, dan dicocokkan dari huruf yang diketik, bukan posisi tombol.
- Kalender memakai aturan akses Board (`Ctx::can_view`). Tamu hanya melihat proyek undangannya. Klik task membuka dialog detail task yang sama dengan Board.
- Kalender hanya menampilkan task bertenggat. Bawaan: Semua proyek, task Selesai tersembunyi, tampilan Bulan.

## Yang masih terbuka

| Keputusan | Keadaan sekarang |
|---|---|
| Logo final | Masih logo sementara dari `design/logo-sementara.svg` |
| Sertifikat penandatanganan kode | Installer `v0.1.0` belum ditandatangani, SmartScreen bisa memberi peringatan |
| Akun Apple Developer | Belum ada. Mira untuk macOS ditandatangani ad-hoc dan tidak dinotarisasi. Lihat [[macOS]] |
| Kebijakan PIN tanda tangan | 6 sampai 12 angka. Pilihan: tetap, minimal 8 angka, atau Windows Hello |
| Nama penerbit di installer | Isian sementara "Mira" dan "Hak cipta (c) 2026 Mira" |
| Jawaban tim jaringan kantor | Soal mDNS, aturan firewall, isolasi Wi-Fi, VLAN, dan VPN (Lampiran A PRD) belum ada |
| Visibilitas repositori | Publik sejak 23 November 2026, supaya perintah pasang satu baris jalan. Lihat [[Rilis]] |

Pertanyaan lain yang pernah diajukan di laporan [[Tahap 1]]. Repo tidak mencatat apakah sudah dijawab:
- Apakah Tamu boleh melihat direktori organisasi.
- Apakah laptop yang dikeluarkan boleh bergabung lagi dengan kode baru.
- Dua superadmin yang saling mengeluarkan: yang senior menang, atau keduanya batal.
- Aturan firewall dipasang per orang, atau oleh admin IT lewat Group Policy.
- Label tahap di tampilan dipertahankan atau diganti sebelum pilot.

Kembali ke [[Beranda]].
