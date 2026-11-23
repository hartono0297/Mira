# Laporan: menu klik kanan Chat (v0.4)

Branch `claude/v04-ctx-chat-639d02`, dari `integrasi-v04`. Rencana: `docs/plans/v04-ctx-chat.md`.

Permintaan user: "buat click kanan pada app nya ada fungsinya, seperti kalau di chat, buat delete chat, dll u atur aja yang terbaiknya gimana".

## Hasil

- Menu klik kanan di pesan, lampiran, baris percakapan di sidebar, kepala percakapan, nama pengirim, dan daftar anggota grup atau proyek. Semuanya memakai komponen bersama `src/components/ContextMenu`.
- Dialog profil baru ("Lihat profil"): nama dan label, peran, departemen, sidik jari kunci. Datanya dari `orgApi.people()`.
- Tidak ada perintah Rust baru. Semua aksi memakai perintah yang sudah ada di `src/api/chat.ts` (`chat_mark_read` memang sudah per percakapan).
- Setiap aksi tetap terjangkau tanpa klik kanan: lewat tombol "...", Shift+F10, atau tombol Menu di keyboard.

## Isi menu

Hak peran tidak diperluas. Item yang tidak boleh untuk saya tidak ditampilkan.

**Pesan** (menu "Aksi untuk pesan <Nama|Anda> pukul HH.MM", plus tombol "..." di bilah aksi pesan)
- Balas, hanya kalau saya bisa menulis di percakapan itu.
- Salin teks, hanya kalau pesannya berisi teks. Hasilnya dibacakan ("Teks pesan disalin."). Kalau gagal, muncul pesan yang terlihat.
- Sebut <nama>, untuk pesan orang lain yang masih anggota, kalau saya bisa menulis. `@Nama ` disisipkan di posisi kursor kolom pesan, dan tercatat sebagai mention saat dikirim.
- Lihat status baca, untuk pesan sendiri yang punya penerima. Item ini membuka rincian per orang (siapa sudah membaca, menerima, atau dititipi).
- Hapus pesan, hanya kalau `canDelete` (pesan sendiri, atau admin yang berhak). Memakai dialog konfirmasi yang sudah ada, dan hasilnya "Pesan dihapus".
- Pesan yang sudah dihapus tidak punya menu.

**Percakapan di sidebar** (menu "Aksi untuk <judul>"). Kepala percakapan berisi aksi yang sama tanpa Buka dan Tandai sudah dibaca. Kedua menu dibangun dari satu fungsi, `conversationMenuItems` di `conversationMenu.tsx`.
- Semua jenis: Buka; Tandai sudah dibaca (hanya kalau ada yang belum dibaca); Bisukan atau Bunyikan.
- Grup (masih anggota):
  - Ganti nama dan Tambah orang: percakapan dibuka, lalu dialognya muncul begitu data grup termuat.
  - Keluar dari grup: dengan konfirmasi.
- Channel:
  - Jadikan hanya-baca atau Buka untuk semua, khusus superadmin di channel Umum.
  - Arsipkan channel atau Kembalikan dari arsip (`canArchive`).
  - Hapus channel (`canDelete`, bukan #umum), dengan konfirmasi.
- Chat proyek: tidak bisa dihapus atau diarsip. Hanya arsip lama dari v0.3 yang bisa dikembalikan.
- Pesan pribadi: tanpa "Hapus dari daftar", karena perintahnya tidak ada dan tidak dibuat baru.

**Lampiran** (menu "Aksi untuk <file>", plus tombol "...")
- Buka dan Simpan salinan untuk file yang sudah ada di laptop ini.
- Unduh dari rekan (ukuran) untuk file besar yang belum diunduh.
- Salin nama file, selalu ada.
- Selama aksi lain berjalan, item nonaktif dengan alasan "Tunggu aksi lain selesai".
- Tombol "Simpan" diganti namanya menjadi "Simpan salinan", sama dengan item menu.

**Orang**: nama pengirim di pesan orang lain (berupa tombol yang tampil seperti nama), avatarnya, serta baris di daftar anggota grup dan chat proyek (tombol "Aksi untuk <nama>").
- Kirim pesan pribadi, kalau saya bukan Tamu dan orang itu rekan aktif.
- Sebut.
- Lihat profil.
- Keluarkan dari grup, hanya untuk pemilik grup, dengan konfirmasi.

## Keputusan

| Keputusan | Alasan |
|---|---|
| Kontrak bersama ditulis dulu (`ChatActions.tsx`, `menuText.ts`), lalu tiga bagian dikerjakan paralel | Pesan, sidebar, dan orang ada di file terpisah. Konteks `ChatActionsContext` (layar) dan `ConversationActionsContext` (percakapan) membuat menu orang bisa dipakai di mana saja tanpa meneruskan prop. |
| `useGroupView` dipindah dari kepala percakapan ke panel percakapan | Kepala percakapan, daftar anggota, dan menu orang di pesan ("Keluarkan dari grup") memakai data grup yang sama. |
| Baris sidebar tanpa tombol "..." | Tombol di dalam tombol baris tidak sah sebagai HTML, dan tombol tambahan per baris menggandakan jumlah perhentian Tab. Jalan tanpa klik kanan: Shift+F10 atau tombol Menu di baris, dan menu "..." di kepala percakapan berisi aksi yang sama. |
| Arsipkan tanpa konfirmasi | Arsip bisa dikembalikan, dan menu kepala percakapan sejak v0.3 juga tanpa konfirmasi. Hapus channel, Keluar dari grup, Keluarkan, dan Hapus pesan tetap dengan konfirmasi. |
| Ganti nama dan Tambah orang dari sidebar membuka percakapannya dulu | Dialog Tambah orang butuh data grup (kandidat). Kalau data grup gagal dimuat, kepala percakapan menampilkan "Data grup belum bisa dimuat" dengan Coba lagi dan Batal. Permintaan tidak dibuang diam-diam. |
| Fokus dipindah setelah percakapan berganti karena aksi menu | Setelah Kirim pesan pribadi, fokus ke kolom pesan. Setelah Hapus channel atau Keluar dari grup pada percakapan yang terbuka, fokus ke judul percakapan berikutnya. Klik baris biasa dan pemuatan ulang data tidak memindahkan fokus. |
| Balas disembunyikan kalau tidak bisa menulis | Sebelumnya tombol Balas di percakapan hanya-baca atau arsip mengisi kolom pesan yang tersembunyi, jadi tidak ada yang terjadi. |
| Nama pengirim jadi tombol, sedangkan daftar anggota memakai tombol "..." | Di pesan, nama adalah tempat yang wajar untuk diklik. Di daftar anggota, nama memuat label profil, jadi tombol "..." terpisah lebih jelas untuk pembaca layar. |
| Teks konfirmasi Keluar dari grup disatukan | Menu dan panel anggota sekarang memakai teks yang sama. Panel tahu kalau saya pemilik ("peran pemilik pindah ke anggota yang paling lama"), sedangkan menu memakai kalimat bersyarat karena data grup belum tentu termuat. |
| Profil tanpa email, telepon, atau foto | Data itu tidak ada di Mira. Yang tampil hanya data organisasi yang sudah ada: peran, departemen, label, dan sidik jari kunci untuk verifikasi. |

## Usulan (tidak dibuat, karena perintahnya belum ada)

- **Edit pesan**: paling sering dibutuhkan setelah salah ketik. Perlu event baru di log chat (versi teks pesan) dan aturan siapa boleh mengedit.
- **Sembunyikan pesan pribadi dari daftar**: daftar pesan pribadi terus bertambah. Perlu tanda lokal per percakapan, mirip `muted`.
- **Sematkan pesan**: berguna untuk info tetap di channel departemen atau proyek.
- **Reaksi**: lebih rendah prioritasnya untuk kantor 10 sampai 30 orang.

## Verifikasi

| Uji | Hasil |
|---|---|
| `npx tsc --noEmit -p .` | bersih |
| `npx vitest run src/screens/chat src/components` | 24 file, 344 tes lulus |
| `npx vitest run` (seluruh repo) | 1 gagal, `src/screens/org/DepartmentsPanel.test.tsx` "bukan superadmin: klik kanan baris tidak membuka menu". Tes ini juga gagal di `integrasi-v04` tanpa perubahan sesi ini (dicek dengan stash), jadi bukan dari Chat. |
| `cargo test`, clippy | tidak dijalankan, Rust tidak diubah |
| `scripts/chat-e2e.mjs` | 39/39 lulus (build 962d9ff), termasuk pemeriksaan baru bahwa panel daftar dan percakapan mengisi tinggi jendela di mode terang dan gelap |
| `scripts/e2e-fitur-multi.mjs` | 53/53 lulus (skrip tidak diubah) |

Tes baru (Vitest):
- `MessageMenu.test.tsx`, `FileMenu.test.tsx`, `ConversationMenu.test.tsx`, `PersonMenu.test.tsx`, `ProfileDialog.test.tsx`.
- Tambahan di `ChatScreen.test.tsx` dan `Group.test.tsx`.

Cakupan tes:
- Klik kanan, Shift+F10 dari tombol Balas dan baris, panah, Enter, Esc dengan fokus kembali, dan tombol "..." dengan item yang sama.
- Isi menu per hak (pesan sendiri, orang lain, dihapus; channel, grup, proyek, pesan pribadi; former, arsip, #umum; Tamu).
- Konfirmasi.
- Sebut menyisipkan `@Nama`.
- Lihat status baca memuat rincian.
- Fokus setelah Kirim pesan pribadi atau Hapus channel.
- Error data grup dengan Coba lagi.

Pemeriksaan baru di `chat-e2e` (klik kanan sungguhan, `click({ button: "right" })`):
- Isi menu pesan sendiri.
- Balas lewat menu: chip, lalu balasan dengan kutipan dan `replyTo` benar.
- Salin teks: isi papan klip sungguhan.
- Hapus pesan lewat menu, dengan konfirmasi, lalu "Pesan dihapus". Pesan yang sudah dihapus tidak punya menu.
- Klik kanan di judul membuka menu aplikasi. Di area kosong, menu bawaan WebView tidak muncul.
- Bisukan lalu Bunyikan dari baris sidebar: label baris dan `muted` di inti.
- Shift+F10 di baris membuka satu menu dengan item pertama terfokus; Esc mengembalikan fokus ke baris.
- Keluar dari grup khusus uji lewat menu baris, dengan konfirmasi. Grup satu orang tetap di daftar sebagai "bukan anggota lagi" (`former=true`, tidak bisa menulis).

Screenshot (`docs/progress/screenshots/v04-ctx-chat/`): `01-menu-pesan-terang`, `02-menu-baris-sidebar-terang`, `03-konfirmasi-keluar-grup-terang`, `04-menu-pesan-gelap`, `05-menu-baris-sidebar-gelap`.

Kontras: tidak ada pasangan warna baru. Token yang dipakai sama dengan menu bersama (teks pendukung di atas sorotan 5,03 terang dan 6,93 gelap; cincin fokus 4,47 dan 5,88). Mode `forced-colors`: pesan dan baris yang menunya terbuka mendapat garis `Highlight`.

## Review terpisah

Reviewer (aksesibilitas, tampilan, hak peran) menemukan 3 bug dan 5 saran. Semua bug diperbaiki dengan tes regresi:

1. Wilayah error pesan pribadi menjadi anak ketiga grid `.chat`, sehingga tercipta baris grid kedua. Panel percakapan tidak mengisi tinggi jendela (e2e juga menemukannya: 739 dari 900 px). Wilayah itu sekarang ada di dalam `.chat-main` dan punya tombol Tutup.
2. Ganti nama dan Tambah orang dari menu dibuang diam-diam kalau data grup gagal dimuat. Sekarang tampil error dengan Coba lagi dan Batal.
3. Fokus jatuh ke body setelah Kirim pesan pribadi, Hapus channel, atau Keluar dari grup pada percakapan yang terbuka. Sekarang fokus pindah ke kolom pesan atau judul.

Saran yang diambil:
- Teks Keluar dari grup disatukan.
- Teks Keluarkan di panel memakai `menuText`.
- Kontrak dirapikan: teks yang tidak dipakai dihapus.
- Teks gagal salin nama file dibuat khusus.
- Tombol Simpan diganti "Simpan salinan".
- Garis `forced-colors` untuk baris dan pesan yang menunya terbuka.

## Batasan dan tindak lanjut (di luar file sesi ini)

- `MenuPopup` (komponen bersama) mengasumsikan kontainer dialog punya CSS transform. Panel anggota grup dan proyek bukan `.dlg`, sehingga diberi `.member-pop { transform: translateZ(0) }` supaya posisi menu benar. Perbaikan sebenarnya ada di `MenuPopup`: geser posisi hanya kalau kontainernya punya transform.
- `MenuPopup` menutup menu saat ada event scroll, termasuk gulir otomatis ketika pesan baru datang. Di channel yang ramai, menu pesan yang dibuka dengan Shift+F10 bisa langsung tertutup dan fokus jatuh ke body. Usul: abaikan gulir yang bukan dari pengguna, atau kembalikan fokus saat menutup.
- `MenuConfirm` belum punya judul error sendiri. Error Keluarkan dari menu berjudul "Keluarkan dari grup gagal", sedangkan di panel "<nama> belum dikeluarkan".
- `DepartmentsPanel.test.tsx` (Organisasi) gagal di `integrasi-v04` sebelum sesi ini.
- Tempel atau salin di macOS belum diuji di Mac.
