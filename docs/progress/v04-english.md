# Laporan v0.4: pilihan bahasa Inggris

Tanggal 24 November 2026. Branch `claude/v04-english-7f5c94`. Rencana di [v04-english.md](../plans/v04-english.md).

Permintaan user: "bikin bisa ganti ke Bahasa inggris". Mira sekarang punya dua bahasa tampilan, Indonesia (bawaan) dan Inggris. Bahasa dipilih di Pengaturan > Bahasa atau di pemilih ringkas yang tampil di setiap langkah onboarding. Pilihan disimpan per laptop dan langsung berlaku tanpa memulai ulang. Teks Indonesia tidak berubah.

## Pendekatan

Kamus bertipe buatan sendiri, tanpa pustaka i18n. Alasannya:

- Teks Mira sebagian sudah dikumpulkan di objek teks (`MENU`, `TEKS`, `STEP`). Kamus bertipe meneruskan pola itu, jadi komponen tetap membaca `MENU.reply` seperti sebelumnya.
- Kunci yang hilang dan fungsi kalimat dengan parameter berbeda gagal di `tsc`, bukan saat dijalankan. Di `i18next` kunci berupa string.
- Dua bahasa saja: jamak Inggris cukup `plural(n, one, other)`, tanggal memakai `Intl` bawaan WebView2. Tidak ada dependensi baru di bundel.
- Dokumentasi `useSyncExternalStore` dicek lewat ctx7 (`/reactjs/react.dev`).

Bagian-bagiannya:

| Bagian | Isi |
|---|---|
| `src/i18n/core.ts` | Bahasa aktif (`getLang`, `setLang`, `useLang`), tipe `Dict<T>`, `defineText(id, en)`, `locale()`, `plural()` |
| `src/i18n/<modul>.id.ts` dan `.en.ts` | 38 pasang kamus. Berkas `.id` sumber kebenaran, `.en` bertipe `Dict<typeof id>` |
| `defineText` | Objek Proxy yang membaca bahasa aktif setiap properti dibaca. Nama ekspor lama tetap |
| `src/main.tsx` | Akar aplikasi memanggil `useLang()`. Saat bahasa berganti seluruh pohon render ulang tanpa kehilangan state |
| `src/i18n/preference.ts` | Kunci `app.language` di pengaturan lokal inti Rust (tabel `settings`, sama dengan tema), salinan `mira.lang` di localStorage untuk frame pertama. Penyimpanan berurutan; kalau gagal, bahasa kembali ke nilai yang terakhir benar-benar tersimpan dan error tampil |
| `src/components/LanguagePicker.tsx` | Pemilih bahasa, varian penuh (Pengaturan) dan ringkas (onboarding). Nama bahasa selalu dalam bahasanya sendiri |
| `src/i18n/errors.ts` | `localizeError` di `call()`: kode error Rust dipetakan ke teks Inggris |
| `src-tauri/src/ui_lang.rs` | Rust membaca `app.language` saat membuat teks native |
| `src/whats-new/index.ts` | `<versi>.en.md` opsional, kembali ke versi Indonesia kalau belum ada |

## Keputusan

- **Ejaan dan format.** Ejaan en-US (organization, canceled). Tanggal gaya en-GB (`24 November 2026`) dan jam 24 jam `09:12`, sesuai kebiasaan kantor. Bahasa Indonesia tetap `09.12`.
- **Istilah.** Daftar istilah di rencana dipakai semua kamus: Department, Invite code, Join request, Due date, Signer, Read-only, This laptop, My tasks. Nama tema diterjemahkan: Bata jadi Brick, Kertas jadi Paper.
- **Error dari inti Rust.** Saat bahasa Indonesia aktif pesan Rust tampil apa adanya. Saat Inggris: 363 pesan statis dan 47 pola berargumen dipetakan ke kalimat Inggris (angka dan nama tetap terbawa, misalnya menit kunci PIN). Pesan lain jatuh ke kalimat umum per kode. Kode yang selalu dapat kalimat umum karena pesannya dinamis: `keystore`, `key_mismatch`, `invalid_setting`, `open_failed`, `signature_cooling`, `version_changes_content`; pesan dinamis `internal`, `storage`, `export_failed`, `pdf_invalid`, `peer_unreachable` juga. Kode error, protokol, dan pesan di Rust tidak berubah. Tes memastikan setiap pesan Indonesia di tabel masih ada persis di `src-tauri/src`.
- **Teks native Rust.** Judul dialog file ("Attach files", "Save file"), notifikasi pesan chat baru, pengingat tenggat board, notifikasi permintaan bergabung, dan teks tampilan chat yang disusun Rust saat dibaca (pratinjau pesan terakhir, pratinjau balasan, alasan tidak bisa mengirim, baris kejadian grup) ikut bahasa terpilih. Bahasa dibaca saat teks dibuat, jadi berlaku tanpa restart.
- **Data tidak diterjemahkan.**
  - Nama kolom board tersimpan dan tersinkron dalam bahasa Indonesia ("Dikerjakan"). Tampilan memakai `columnLabel`, yang menerjemahkan nama bawaan dan membiarkan nama yang diubah pengguna.
  - Teks yang ditulis ke PDF tetap bahasa Indonesia di kedua bahasa: stempel, waktu tanda tangan, dan halaman catatan tanda tangan. Itu bagian dokumen bertanda tangan yang diverifikasi laptop lain.
  - Isi jejak audit, nama orang, proyek, departemen, isi pesan, dan nama cadangan "Laptop xxxx" tampil seperti tercatat. Hanya label tampilan yang diterjemahkan.
  - Lingkup `#umum` "Seluruh kantor" (`ORG_SCOPE_NAME` di Rust) tetap karena ikut data percakapan.
- **Isian durasi.** `parseMinutes` dalam bahasa Indonesia tetap seperti dulu ("2h" ditolak karena "hr" berarti hari). Saat Inggris, isian menerima satuan Indonesia dan Inggris (h, hr, hours, min, minutes).
- **Urutan nama.** Pengurutan dan pencarian tetap memakai locale `id`, supaya urutan daftar sama di semua laptop.
- **Pemilih di onboarding.** Tampil di baris atas setiap langkah, kanan dari merek, turun ke baris kedua di jendela sempit. Pilihan yang tidak aktif diberi latar `--bg` di layar ini: di atas latar krem garisnya hanya 2,95:1, di atas `--bg` 3,19:1. Fokus otomatis ke judul langkah tidak berubah.
- **Pengaturan.** Bagian baru Bahasa di antara Tampilan dan Jaringan. Catatan di bawah pilihan menjelaskan bahwa pilihan hanya untuk laptop ini dan isi tulisan rekan tidak diterjemahkan.
- **Tes lama yang sudah gagal sebelum sesi ini.** `DepartmentsPanel.test.tsx` "bukan superadmin: klik kanan baris tidak membuka menu" gagal juga di commit dasar, karena sejak onboarding v0.4 (4d9a417) tab Departemen tidak tampil untuk bukan superadmin. Tes diganti supaya memeriksa tab itu memang tidak ada.

## Layar yang sudah diterjemahkan

- Onboarding: nama, firewall, pencarian kantor, kantor ditemukan, pilih kantor dan departemen, kode undangan, kantor baru (admin IT), menunggu verifikasi, layar memuat, layar error, layar dikeluarkan.
- Kerangka: navigasi samping beserta hitungan, panel jaringan.
- Chat: daftar percakapan, bagian lipat, percakapan, pesan, lampiran, status kirim dan baca, penulis pesan, kepala percakapan, menu klik kanan, dialog grup, channel, pesan langsung, anggota grup, ganti nama, tambah orang, notifikasi, profil, anggota proyek.
- Board: board proyek, kartu, tambah cepat, pindah kolom, menu klik kanan kartu, subtask, proyek, Task saya, proyek di luar Anda, detail task (properti, tenggat, label, komentar, aktivitas, waktu, timer), dialog proyek baru, ganti nama, anggota proyek, pengingat.
- Dokumen: pustaka, baris dokumen, detail, versi, bentrok versi, salin dan buka.
- Tanda tangan: daftar permintaan, permintaan baru, tampilan dokumen, penempatan tanda tangan, PIN, pembuatan tanda tangan, verifikasi PDF, jejak audit.
- Organisasi: pengguna, anggota, departemen, permintaan bergabung, label, undangan, dialog undangan, tukar kode.
- Pengaturan: Tampilan, Bahasa, Jaringan, Laptop ini, Tentang dan pembaruan, dialog Yang baru.
- Komponen bersama: dialog konfirmasi, tombol salin, pemilih orang, panduan firewall Windows dan macOS, menu klik kanan kolom teks (Cut, Copy, Paste), penampil PDF.
- Teks native: dialog file, notifikasi Windows.

Di Pengaturan judul bagian sudah "Language", jadi legend pemilih hanya untuk pembaca layar (temuan dari screenshot, diperbaiki setelah review).

## Batasan

- Pesan validasi atau error yang sudah tampil disimpan sebagai string di state, jadi tetap dalam bahasa lama sampai tindakan berikutnya. Paling terasa di onboarding karena pemilih ada di setiap langkah.
- Error kirim chat `post_blocked` dari Rust dan status "Menunggu..." di `signing/peer_sync.rs` belum ikut bahasa.
- Tombol di dialog file Windows mengikuti bahasa Windows, bukan Mira. Judul dialognya ikut Mira.
- Installer (teks NSIS di `src-tauri/nsis/`) tetap berbahasa Indonesia, karena berjalan sebelum Mira terpasang dan belum tahu pilihan bahasa.
- Catatan "Yang baru" versi lama tidak diterjemahkan; versi berikutnya bisa menambah `<versi>.en.md`.
- Kecocokan regex pada pesan error (kode proyek, nama channel, menit kunci PIN) bergantung pada kalimat Inggris di kamus. Tes `pinLock.en.test.ts` dan `pin.en.test.ts` menjaga yang paling penting.

Temuan reviewer teks pada versi Indonesia, tidak diubah karena di luar lingkup (arti teks Indonesia tidak boleh berubah):

- "di komputer ini" di beberapa tempat, sementara istilah lain memakai "Laptop ini".
- `guestCannotRequest` dan `senderNotInProject` di pesan Rust memakai "tim", bukan "anggota proyek".
- `chat/read.rs` memakai "Kamu", bukan "Anda".
- "channel untuk seluruh kantor" dan "channel umum" bercampur.

## Tes

- `src/i18n/dictionaries.test.ts`: setiap `.id.ts` punya `.en.ts` dengan kunci, panjang array, dan jumlah parameter yang sama, tanpa nilai kosong dan tanpa em dash. Gagal kalau ada kunci yang hilang.
- `src/screens/settings/LanguageSection.test.tsx`: ganti bahasa di Pengaturan langsung mengganti judul dan menu, `app.language` tersimpan, gagal simpan kembali ke Indonesia dengan pesan.
- `src/i18n/noIndonesian.test.tsx`: seluruh `<App />` dalam bahasa Inggris, 15 sampel layar (kerangka, chat, board, detail task, dokumen, tanda tangan, organisasi, setiap bagian pengaturan, onboarding, layar error dan dikeluarkan). Memindai teks dan atribut `aria-label`, `title`, `placeholder`, `alt` untuk kata Indonesia. Dua tes kontrol memastikan pemindainya menangkap teks Indonesia.
- Tes Inggris per modul (`*.en.test.*`, `English.test.tsx`, `OnboardingLanguage.test.tsx`), `errors.test.ts`, `preference.test.tsx`, `core.test.ts`, `whatsNew.test.ts`. Tes Rust untuk pemilihan bahasa, notifikasi, dan judul dialog.

Hasil di commit terakhir sesi ini:

| Pemeriksaan | Hasil |
|---|---|
| `npx tsc --noEmit` | bersih |
| `npx vitest run` | 113 berkas, 1632 tes lulus |
| `cargo test` (src-tauri) | 1109 lulus, 7 ignored, 0 gagal |
| `cargo clippy --all-targets -- -D warnings` | bersih |

## Uji ujung ke ujung

Build `npx tauri build --debug --no-bundle`, Windows 11, `E2E_PORT_OFFSET=700`, skrip dijalankan satu per satu. Bahasa Indonesia tetap bawaan, jadi skrip lama tidak perlu diubah karena teks.

| Skrip | Hasil |
|---|---|
| `english-e2e.mjs` (baru) | 38/38 |
| `smoke-e2e.mjs` | 12/12 |
| `smoke-docs-e2e.mjs` | 15/15 |
| `sign-e2e.mjs` | 15/15 |
| `chat-e2e.mjs` | 39/39 |
| `board-e2e.mjs` | 43/43 |
| `board-sync-e2e.mjs` | 26/26 |
| `board-v04-multi-e2e.mjs` | 29/29 |
| `contextmenu-e2e.mjs` | 27/27 |
| `org-e2e.mjs` | 33/33 |
| `join-e2e.mjs` | 43/43 |
| `sync-e2e.mjs` | 37/37 |
| `e2e-fitur-multi.mjs` | 53/53 pada percobaan kedua |
| `e2e-multi.mjs` | 25/25 pada percobaan ketiga |

`english-e2e.mjs` (`npm run test:e2e-english`): pilih English di langkah nama onboarding (judul dan tombol berganti tanpa restart), kembali ke Indonesia dan buat kantor, pilih English di Pengaturan > Bahasa, kunjungi Chat, Board (proyek dan task baru), detail task, Dokumen, Tanda tangan, setiap tab Organisasi, setiap bagian Pengaturan. Setiap layar dipindai untuk kata Indonesia (teks dan atribut, kecuali blok kode). Lalu restart: frame pertama sudah berbahasa Inggris dan `app.language` tetap `en`. Terakhir kembali ke Indonesia tanpa restart.

Perubahan skrip lama:

- `join-e2e.mjs`: cek "satu kantor tanpa radio" sekarang hanya menghitung radio pilihan kantor, karena pemilih bahasa menambah dua radio di onboarding.
- `e2e-fitur-multi.mjs`: putaran pertama 13/14 karena skrip masih memperlakukan "Penanggung jawab" sebagai `<select>`, padahal sejak dialog task board v0.4 itu tombol menu. Langkah 6 sekarang memakai menu. Bukan karena bahasa.
- `e2e-multi.mjs`: dua kali 24/25, daftar "Di jaringan" belum memuat kedua rekan dalam jeda tetap 2 detik. Jeda diganti menunggu sampai kedua rekan tampil (paling lama 20 detik). Bukan karena bahasa.

Perintah PowerShell aturan firewall yang ditampilkan untuk disalin (Pengaturan > Jaringan dan panduan firewall) tetap memuat deskripsi aturan berbahasa Indonesia, karena itu teks yang ditulis ke Windows Firewall, bukan teks tampilan.

## Screenshot bahasa Inggris

Di `docs/progress/screenshots/v04-english/`, diambil oleh `english-e2e.mjs`:

- `01-onboarding-indonesia.png`, `02-onboarding-english.png`: langkah nama sebelum dan sesudah memilih English.
- `03-pengaturan-bahasa-english.png`, `14-pengaturan-1` sampai `-5`: Pengaturan (Appearance, Language, Network, This laptop, About and updates).
- `04-chat.png`, `05-board-kosong.png`, `06-proyek-baru.png`, `07-board-proyek.png`, `08-detail-task.png`.
- `09-dokumen.png`, `10-tanda-tangan.png`, `11-buat-tanda-tangan.png`.
- `12-organisasi.png`, `13-organisasi-1` sampai `-5`: Users, Departments, Join requests, Labels, Invites.
- `15-setelah-restart.png`: tetap bahasa Inggris setelah restart.
- `16-kembali-indonesia.png`: kembali ke bahasa Indonesia tanpa restart.

Screenshot skrip e2e lain yang ikut tertimpa saat uji tidak di-commit, supaya diff hanya memuat perubahan sesi ini.

## Cara kerja sesi

Fondasi ditulis di sesi utama, lalu 12 subagent memindahkan teks paralel per modul (onboarding, shell dan pengaturan, chat dua bagian, board dua bagian, dokumen, tanda tangan, organisasi, komponen, api dan error Rust, teks native Rust), masing-masing dengan kamus berawalan nama modulnya. Setelah itu tiga subagent lagi: reviewer teks Inggris, reviewer kode dan tampilan, penulis tes layar. E2E dijalankan satu per satu oleh subagent terpisah. Akhir baris berkas dikembalikan ke bentuk aslinya (LF atau CRLF) sebelum commit.
