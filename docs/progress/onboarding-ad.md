# Laporan: onboarding dengan Active Directory

Branch: `claude/onboarding-ad-71236e`, dari `main` 50d5656 (v0.4.0). Rencana dan kontrak: `docs/plans/onboarding-ad.md`.

Permintaan user: "setiap user baru install, awalnya dia pilih domain yang terdeteksi, misalnya kalau kantor gw macf.co.id. Setelah itu otomatis cek nama di pc mereka, kalau di kantor gw uda pasti pake LDAP, jadi tinggal ambil bagian department dan nama. Tapi untuk macbook ga pake LDAP, itu tetap request manual ke superadmin." Tingkat yang dipilih: **A**, data AD mengisi otomatis dan admin tetap menyetujui dengan satu klik.

Tambahan dari session utama di tengah jalan (user setuju): "kalau 1 domain harusnya 1 organisasi yang sama" (rencana bagian 6) dan kantor otomatis dari domain (bagian 6.1).

## Ringkasan

- **PC Windows dengan akun domain.** Saat onboarding, Mira membaca domain dan akun yang login (paling lama 4 detik, di thread terpisah). Nama tampilan terisi dari `displayName` AD. Kalau di jaringan ada tepat satu kantor dengan domain AD sama, kantor itu langsung dipakai ("Kantor Anda ditemukan", ringkasan "Kantor: MCF (macf.co.id)" dengan sidik dan tombol Ubah). Departemen terpilih dari atribut `department` AD, atau dari pemetaan OU yang diatur superadmin. Kotak "Yang dilihat admin" memperlihatkan nama, departemen, akun Windows (`hartono@macf.co.id`), lokasi di Active Directory (OU, dari luar ke dalam), keterangan, dan catatan bahwa data ini tersimpan di catatan kantor.
- **Mac, PC tanpa domain, akun lokal, AD tidak terhubung.** Alurnya sama dengan v0.4.0 (tidak ada teks AD sama sekali). Kalau pembacaan hanya sebagian (server domain tidak terjangkau), domain dan nama akun tetap dikirim dengan pesan "Sebagian data akun Windows tidak terbaca...".
- **Kartu Permintaan bergabung di laptop admin.** Blok "Active Directory" memeriksa ulang ke AD dari laptop admin saat kartu tampil (hasil disimpan 2 menit, tombol "Periksa lagi"). Setelah cek berhasil, kartu menonjolkan nilai dari direktori, bukan dari laporan peminta. Status: "Akun ada dan aktif di AD, nama dan departemen sama", "Akun ada dan aktif di AD, tapi nama dan departemen tidak bisa dibandingkan", "Berbeda dengan AD" (netral; peminta boleh mengubah nama tampilan), "Data AD dari laptop peminta tidak sama dengan AD" (peringatan), "Akun AD dinonaktifkan", "Akun tidak ditemukan di AD", "AD tidak bisa dihubungi dari laptop ini", "Laptop ini tidak tergabung di domain ...". Peringatan merah kalau akun AD itu sudah dipakai anggota lain. Admin tetap menekan Setujui.
- **Organisasi > Departemen (superadmin).** Bagian "Active Directory": domain kantor (dengan "Pakai domain laptop ini") dan pemetaan OU ke departemen. Departemen tidak pernah dibuat otomatis.
- **Satu domain, satu kantor.** Kantor Mira lama (0.1/0.2, mengumumkan `org` tanpa `on` dan `j`) kini tampil di onboarding dengan langkah pembaruan, bukan "Kantor belum ditemukan". Kantor baru di "Untuk admin IT" disembunyikan kalau domain laptop sama dengan kantor yang terlihat, dan meminta ketik "kantor baru" kalau ada kantor lain apa pun. Rust juga menolak membuat kantor kedua untuk domain yang sama. `--siapkan-kantor` kini mencari dulu 6 detik. Anggota melihat "Ada N laptop di jaringan ini yang tergabung di kantor Mira lain"; superadmin kantor yang lebih baru diberi tahu bahwa ada kantor lebih lama untuk domain yang sama (data tidak bisa digabung otomatis).

Cek ulang di laptop admin **membuktikan akun itu ada, aktif, dan datanya sama di AD, bukan bahwa peminta adalah pemilik akun itu**: laptop peminta bisa melaporkan akun siapa pun. Kartu menulis ini tepat di bawah status, dan kode cocok plus telepon tetap cara memastikan orangnya. Persetujuan otomatis berbasis bukti login Windows (tingkat B) ditunda.

## Desain teknis

| Bagian | Isi |
|---|---|
| `src-tauri/src/ad/` (baru) | `mod.rs`: `machine_domain`, `read_local`, `lookup_user`. `windows.rs`: `GetComputerNameExW(ComputerNameDnsDomain)`, `GetUserNameExW` (SAM, DN), LDAP lewat wldap32 (port 389, v3, sign dan seal wajib, referral mati, batas waktu, bind Negotiate dengan akun yang login, filter di-escape RFC 4515, `sizelimit` 2). `fake.rs`: AD tiruan, hanya `#[cfg(debug_assertions)]`. `dn.rs`: urai DN RFC 4514, OU, domain dari DC, normalisasi domain. `dept.rs`: usulan departemen. `check.rs`: pembandingan cek ulang. |
| Permintaan bergabung | Field opsional `ad { domain, user, dn?, name?, department? }` di `JoinRequestPayload`, ditandatangani peminta. Divalidasi ketat (domain ternormalisasi, DC di DN sama dengan domain, tanpa karakter tak terlihat setelah escape dibuka). Kalau payload melewati 2048 byte, `dn` dibuang dulu, lalu seluruh klaim. |
| Pengaturan kantor | Op baru `ad_settings_set { domain, ou_map }`, hanya superadmin, op terakhir menang. Baris pemetaan ke departemen yang terhapus diabaikan saat fold. |
| `join_info` | `extras: 2` (menerima klaim AD), `ad_domain`, `ad_ou_map` (tipe wire longgar). Field AD yang rusak dibuang tanpa membuang jawaban. |
| mDNS | Kunci TXT baru `ad=<domain>` dari anggota kantor yang punya domain. |
| Command baru | `join_ad_profile`, `join_ad_suggest`, `machine_ad_domain`, `org_ad_settings`, `org_set_ad_settings`, `org_join_ad_check`, `org_other_offices`; `join_send_request(..., useAd)`, `create_organization(name, adDomain)`. |

### Urutan sumber departemen

1. Atribut `department` AD sama dengan nama departemen Mira (tanpa beda huruf besar, spasi diringkas, NFC).
2. Atribut sama dengan kunci di pemetaan OU.
3. OU dari yang paling dalam ke luar: kunci pemetaan dulu, lalu nama departemen Mira.
4. Tidak ketemu: orangnya memilih sendiri, layar menulis "Departemen Anda di akun Windows (X) belum ada di Mira", kartu admin "Departemen di AD: X (belum ada di Mira)".

## Kompatibilitas dengan laptop v0.4.0

- Laptop v0.4.0 mengurai permintaan dan op dengan `deny_unknown_fields`, jadi klaim `ad` dan op `ad_settings_set` hanya ditulis kalau semua anggota aktif (Tamu juga) melaporkan versi paling sedikit `min(versi sendiri, JOIN_AD_SINCE = "0.5.0")`. Anggota mengumumkan `extras: 2` hanya kalau syarat itu terpenuhi; v0.4.0 membaca `extras >= 1`, jadi keterangan tetap jalan.
- `JoinInfoWire` diurai laptop lama tanpa `deny_unknown_fields`, jadi `ad_domain` dan `ad_ou_map` diabaikan.
- Menyetujui permintaan ber-AD memeriksa ulang gerbang itu. Menyetujui peminta Mira lama ditolak kalau kantor sudah punya pengaturan AD (kartu memperingatkan lebih dulu).
- Tes Rust memakai salinan struct v0.4.0 untuk membuktikan bentuk permintaan tanpa `ad` sama byte demi byte dan jawaban `join_info` baru tetap terbaca.

## Keputusan yang saya ambil sendiri

1. **Data AD masuk permintaan bertanda tangan** (bukan lampiran terpisah), mengikuti pola `note`/`account` v0.4 dan gerbang versinya. Konsekuensinya data itu ikut tersimpan di op `join_approve`/`join_reject` yang direplikasi ke semua anggota (lihat Batasan). Brief meminta DN ikut terkirim, jadi DN tidak diganti hash.
2. **Rilis berikutnya sebaiknya 0.5.0.** `JOIN_AD_SINCE` 0.5.0 dengan pola `min()` membuat build dev 0.4.0 bisa menguji fitur ini di e2e; kalau rilis bernomor 0.4.1, ambangnya 0.4.1 dan tetap aman.
3. **Pencarian AD di laptop admin memakai domain laptop admin**, bukan domain dari klaim, sehingga peminta tidak bisa mengarahkan bind Negotiate ke host lain.
4. **Status cocok tidak memakai kata "terverifikasi".** Reviewer tampilan menilai "Cocok dengan AD" berwarna hijau terlalu meyakinkan, jadi teksnya kini menyebut apa yang dicek. Status "exists" ditambahkan untuk akun yang ada tapi tidak ada yang bisa dibandingkan.
5. **Nama yang diubah peminta bernada netral**, karena layar nama mengundang orang mengubah nama tampilan. Merah hanya untuk akun dinonaktifkan atau tidak ditemukan; klaim yang tidak sama dengan direktori berwarna peringatan.
6. **Akun ditulis `user@domain`**, bukan `DOMAIN\user`: Mira tidak tahu nama NetBIOS domain dari data yang dikirim.
7. **Pemberitahuan kantor lain**: semua anggota hanya melihat jumlah laptop; nama kantor dan bagian domain sama hanya untuk superadmin.
8. **Kantor utama** ditentukan dari `created_at` genesis, yang ditulis sendiri oleh pembuat kantor. Teks menyebut "menurut catatan kantor itu" dan sidik selalu tampil.
9. **Pengaturan AD yang gagal disimpan setelah kantor baru dibuat** hanya dicatat di log; kantor tetap jadi, dan superadmin bisa mengisinya di Organisasi.

## Review

| Review | Temuan utama | Tindak lanjut |
|---|---|---|
| Tampilan | Status hijau "Cocok dengan AD" terlalu meyakinkan; nama yang diubah peminta tampil merah; "superadmin" di layar orang baru; jargon AD; urutan OU beda di dua layar; format `domain\user`; aria-live berisik saat banyak kartu; peringatan kantor lama memakai kotak merah; validasi domain di Organisasi | Diperbaiki. Target sentuh 34px dibiarkan mengikuti konvensi aplikasi desktop. |
| Keamanan | (sedang) gerbang versi tidak dicek ulang saat menyetujui; kartu bisa menampilkan OU palsu dari peminta di samping status hijau; data AD tersimpan permanen di op; ambang `min()` di build dev; (rendah) bidi lewat escape heksadesimal di DN, `ad_domain`/`created_at` dari LAN tidak terautentikasi, `OuMapping` ketat di jawaban `join_info`, fold menolak op karena satu tim terhapus | Diperbaiki kecuali yang dicatat di Batasan. Kartu kini menonjolkan nilai direktori dan membandingkan klaim dengan direktori. |

## Hasil verifikasi

Semua di Windows 11, build debug (`npx tauri build --debug --no-bundle`) dari commit 483558b untuk kode.

- `cargo test --lib`: 1225 lulus, 0 gagal, 7 diabaikan (yang diabaikan sudah ada sebelumnya). Di antaranya tes penguraian DN (termasuk DN contoh `CN=hartono,OU=IT-Development,...`, escape koma dan heksadesimal, bidi tersembunyi), pemetaan OU dan urutan sumber departemen, pembandingan cek ulang, AD tiruan (parsial, waktu habis, tidak terjangkau, dinonaktifkan), fallback tanpa domain, gerbang versi, dan kompatibilitas dengan struct v0.4.0.
- `cargo clippy --all-targets -- -D warnings`: tanpa peringatan.
- `npx tsc --noEmit`: bersih. `npx vitest run`: 118 berkas, 1728 tes lulus.
- E2e, dijalankan satu per satu dengan build yang sama, tanpa Mira lain yang berjalan:
  - `join-e2e.mjs` 43/43, `org-e2e.mjs` 33/33, `english-e2e.mjs` 38/38, `e2e-multi.mjs` 25/25 (tanpa perubahan skrip).
  - `ad-e2e.mjs` (baru) **97/97** dengan AD tiruan: A membuat kantor dengan nama dan domain bawaan `macf.co.id` lalu mengatur pemetaan OU; N1 cocok (nama, kantor otomatis, departemen dari atribut, disetujui); N2 departemen lewat pemetaan OU; N3 departemen AD belum ada di Mira dan nama diubah (berbeda dengan AD); N4 akun dinonaktifkan lalu AD tidak terjangkau setelah "Periksa lagi"; N5 tanpa domain (alur manual, tanpa teks AD); N6 data parsial; N7 pembacaan AD lambat 8 detik (layar tidak beku, alur manual tetap jalan); N8 domain sama tidak melihat pilihan kantor baru; N9 tanpa domain harus mengetik "kantor baru"; K2 kantor kedua domain sama (peminta melihat kantor utama, superadmin K2 melihat peringatan kantor lebih lama, A melihat pemberitahuan kantor lain); L meniru Mira 0.2 (`MIRA_TEST_LEGACY_ADVERT`) dan peminta melihat kantor versi lama dengan langkah pembaruan.
  - Percobaan pertama `ad-e2e.mjs` 90/97; ketujuh kegagalan ada di skrip (judul "Kantor Anda ditemukan" belum ditunggu, pemilih isian tabel, nama kantor uji mengandung kata "AD", pemberitahuan yang di-cache 60 detik). Tidak ada perubahan kode aplikasi dari putaran e2e.
- Screenshot: `docs/progress/screenshots/onboarding-ad/ad01` sampai `ad33`, termasuk langkah kantor dengan data AD dan kartu cocok, tidak cocok, dan dinonaktifkan, masing-masing terang dan gelap, Indonesia dan Inggris.
- Kontras: pasangan baru dicek dengan `check_contrast`, terendah `--text-sec` di atas `--accent-soft` 4,97:1 (terang) dan input border 3,05:1 (non-teks); status selalu teks plus ikon.

Catatan dari e2e: pemberitahuan "kantor lain" dimuat sekali saat halaman Organisasi dibuka dan petunjuk mDNS bertahan beberapa menit, jadi bisa masih menyebut kantor yang laptopnya baru dimatikan. E2e tidak bisa dipercepat dengan menjalankan skrip bersamaan, karena semua instance di satu PC saling melihat lewat mDNS dan memakai Credential Manager yang sama; isolasi mDNS per uji bisa jadi pekerjaan terpisah.

## Cara uji di PC kantor sungguhan

1. Build debug atau rilis dari branch ini di satu PC domain (admin IT, akun domain yang bisa membaca AD) dan satu PC domain lain (orang baru). Jangan set `MIRA_FAKE_AD`.
2. Di PC admin: `whoami /fqdn` harus menampilkan DN. Jalankan Mira dengan `--siapkan-kantor`; nama kantor dan domain terisi `macf.co.id`. Ganti nama kantor dengan nama yang dikenal (misalnya MACF), buat departemen, lalu di Organisasi > Departemen > Active Directory atur pemetaan OU (misalnya `IT-Development` ke departemen IT).
3. Di PC orang baru: buka Mira. Nama harus terisi `displayName` AD, kantor MACF terpilih otomatis, departemen terpilih dari atribut `department` atau OU. Kirim.
4. Di PC admin: kartu harus menampilkan "Akun ada dan aktif di AD..." dengan nama, departemen, dan lokasi dari direktori. Coba "Periksa lagi". Setujui setelah kode cocok sama.
5. Uji jalur gagal: cabut kabel/VPN di PC admin lalu "Periksa lagi" (harus "AD tidak bisa dihubungi dari laptop ini" dalam sekitar 5 detik); nonaktifkan akun uji di AD lalu periksa lagi ("Akun AD dinonaktifkan"); login ke PC domain dengan akun lokal (alur manual); MacBook (alur manual).
6. Yang perlu diperhatikan: kalau DC mewajibkan LDAPS saja (port 636) atau menolak sign/seal di 389, cek ulang akan selalu "tidak bisa dihubungi". Laporkan, karena Mira saat ini hanya memakai 389 dengan sign dan seal.

## Batasan

- **LDAP sungguhan belum pernah dijalankan.** PC pengembangan memakai akun lokal tanpa DC. Jalur nyata (DN dari `GetUserNameExW`, bind Negotiate dengan sign dan seal, pencarian, `userAccountControl`) hanya diuji sampai "membuka sesi LDAP dan mengatur opsi" tanpa jaringan. Semua skenario e2e memakai AD tiruan.
- **Cek ulang bukan bukti kepemilikan akun** (lihat Ringkasan).
- **Privasi.** Domain, nama akun, DN, `displayName`, dan `department` peminta tersimpan selamanya di op `join_approve`/`join_reject` dan direplikasi ke semua anggota, termasuk Tamu. Data dari permintaan yang ditolak juga tersimpan. Format `join_reject` tidak diubah karena laptop v0.4.0 memerlukannya. Layar peminta menulis bahwa data ini tersimpan di catatan kantor dan bisa dilihat anggota kantor.
- **Jalur kode undangan tidak memeriksa versi.** Laptop v0.4.0 yang masuk lewat kode undangan setelah pengaturan AD ada tidak bisa membaca op `ad_settings_set` dan anggota yang disetujui dengan data AD (op itu ditolak di laptop tersebut, log lain tetap jalan). Daftar laptop yang belum diperbarui tampil di pengaturan AD. Ada juga jendela bersamaan: admin departemen menyetujui peminta Mira lama sebelum op pengaturan AD superadmin sampai ke laptopnya.
- **Ambang versi di build dev.** Selama nomor versi masih 0.4.0, build dari branch ini menganggap laptop v0.4.0 rilis cukup baru. Jangan pakai build dev ini di kantor yang berisi laptop v0.4.0 rilis; rilis berikutnya harus 0.4.1 atau lebih (disarankan 0.5.0).
- **`ad_domain` dan `created_at` dari LAN tidak terautentikasi.** Laptop lain bisa membuat kantor tiruan dengan domain sama dan tanggal mundur. Sidik selalu tampil, dan admin memastikan orang lewat kode cocok, tapi kantor tiruan bisa menerima data AD peminta.
- **Thread LDAP yang macet** tetap berjalan di latar belakang setelah batas waktu sampai Windows melepasnya; jumlahnya terbatas oleh klik "Periksa lagi" dan pembacaan sekali saat onboarding.
- macOS hanya diuji lewat kode dan tes unit (semua fungsi AD mengembalikan "tidak ada").

## Catatan penggabungan

- Di luar folder milik sesi ini: `src/i18n/errors-rust.{id,en}.ts` (pesan galat baru), `src/i18n/noIndonesian.test.tsx` (fixture), `src-tauri/src/lib.rs` (registrasi), `src-tauri/src/net_backend.rs`, `network/*`, `permissions/*` (protokol), `src-tauri/Cargo.toml` (fitur `windows-sys`: `Win32_System_SystemInformation`, `Win32_Security_Authentication_Identity`, `Win32_Networking_Ldap`).
- Variabel lingkungan khusus build debug: `MIRA_FAKE_AD` (data AD tiruan, JSON atau path file) dan `MIRA_TEST_LEGACY_ADVERT=1` (meniru pengumuman Mira 0.1/0.2). Keduanya tidak dikompilasi di build release.
- **Untuk rilis**: naikkan versi ke 0.5.0. Catatan "Yang baru" sebaiknya menyebut bahwa data AD dan pengaturan AD baru aktif setelah semua laptop kantor diperbarui.
