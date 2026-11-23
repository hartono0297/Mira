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
- Bukan tujuan saat ini: server, akun cloud, tanda tangan elektronik tersertifikasi, edit dokumen bersamaan secara langsung, aplikasi HP, macOS, dan Linux.

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

## Yang masih terbuka

| Keputusan | Keadaan sekarang |
|---|---|
| Logo final | Masih logo sementara dari `design/logo-sementara.svg` |
| Sertifikat penandatanganan kode | Installer `v0.1.0` belum ditandatangani, SmartScreen bisa memberi peringatan |
| Kebijakan PIN tanda tangan | 6 sampai 12 angka. Pilihan: tetap, minimal 8 angka, atau Windows Hello |
| Nama penerbit di installer | Isian sementara "Mira" dan "Hak cipta (c) 2026 Mira" |
| Jawaban tim jaringan kantor | Soal mDNS, aturan firewall, isolasi Wi-Fi, VLAN, dan VPN (Lampiran A PRD) belum ada |
| Visibilitas repositori | Saat ini privat. Lihat [[Rilis]] |

Pertanyaan lain yang pernah diajukan di laporan [[Tahap 1]]. Repo tidak mencatat apakah sudah dijawab:
- Apakah Tamu boleh melihat direktori organisasi.
- Apakah laptop yang dikeluarkan boleh bergabung lagi dengan kode baru.
- Dua superadmin yang saling mengeluarkan: yang senior menang, atau keduanya batal.
- Aturan firewall dipasang per orang, atau oleh admin IT lewat Group Policy.
- Label tahap di tampilan dipertahankan atau diganti sebelum pilot.

Kembali ke [[Beranda]].
