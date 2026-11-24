# Rencana v0.4: pilihan bahasa Inggris

Permintaan user: "bikin bisa ganti ke Bahasa inggris". Mira mendapat dua bahasa tampilan, Indonesia (bawaan) dan Inggris. Pilihan disimpan per laptop, dipilih di Pengaturan atau di langkah pertama onboarding, dan langsung berlaku tanpa memulai ulang.

## Pendekatan

Kamus bertipe buatan sendiri, tanpa pustaka. Alasannya:

- Teks Mira sudah sebagian dikumpulkan di modul teks berbentuk objek dan fungsi kecil (`menuText.ts`, `teks*.ts`, `texts.ts`). Kamus bertipe meneruskan pola itu, jadi pemindahan teks tidak mengubah cara komponen membaca teks.
- Kunci yang hilang gagal di `tsc`, bukan saat dijalankan. Fungsi kalimat (`(n: number) => string`) dicek parameternya juga. Dengan `i18next` kunci berupa string dan pengecekan tipenya butuh deklarasi tambahan.
- Hanya dua bahasa. Jamak bahasa Inggris cukup `plural(n, one, other)`, tanggal memakai `Intl` bawaan WebView2.
- Tidak menambah dependensi ke bundel.

### Bagian-bagiannya

- `src/i18n/core.ts`: bahasa aktif (`getLang`, `setLang`, `useLang` lewat `useSyncExternalStore`), tipe `Dict<T>`, `defineText(id, en)`, `locale()`, `plural()`.
- `defineText` mengembalikan objek yang membaca bahasa aktif setiap kali propertinya dibaca (Proxy). Nama ekspor lama seperti `MENU`, `TEKS`, `ROLE_LABELS` tetap, jadi pemanggil tidak perlu diubah.
- `main.tsx`: komponen akar memanggil `useLang()`. Saat bahasa berganti, akar render ulang dan seluruh pohon ikut render ulang (Mira tidak memakai `React.memo`), state tetap.
- `src/i18n/preference.ts`: kunci pengaturan `app.language` di inti Rust (per laptop, tabel `settings` yang sama dengan tema), salinan `mira.lang` di localStorage untuk frame pertama.
- `src/components/LanguagePicker.tsx`: pilihan bahasa, varian penuh (Pengaturan) dan ringkas (onboarding).
- Kamus per modul: `src/i18n/<modul>.id.ts` (sumber kebenaran, `export default`) dan `src/i18n/<modul>.en.ts` (`const en: Dict<typeof id>`). Satu modul boleh punya beberapa berkas (`board-menu.id.ts`).
- `src/i18n/dictionaries.test.ts`: setiap `.id.ts` punya `.en.ts` dengan kunci, panjang array, dan jumlah parameter yang sama; tidak ada nilai kosong atau em dash.
- Error dari inti Rust: `call()` di `src/api/index.ts` memetakan `code` ke teks Inggris saat bahasa Inggris aktif. Bahasa Indonesia tetap memakai pesan Rust apa adanya. Protokol dan data tersinkron tidak berubah.
- "Yang baru": `src/whats-new/<versi>.en.md` opsional, kembali ke versi Indonesia kalau belum ada.
- Teks native di Rust (dialog file, notifikasi Windows): Rust membaca `app.language` dari tabel `settings`.

### Aturan untuk pemindahan teks

- Pindahkan semua teks yang tampil: isi, tombol, judul, placeholder, `aria-label`, `title`, `alt`, toast, pesan error buatan tampilan, tanggal dan waktu relatif, jamak.
- Jangan terjemahkan: data pengguna, nama yang disimpan atau disinkronkan, kode error, kunci pengaturan, nama kelas CSS, `data-testid`, log konsol, komentar kode.
- Teks yang dibaca saat modul dimuat (misalnya `const PARTS = [{ label: T.a }]` di tingkat modul) membeku di bahasa awal. Bacalah teks saat render atau jadikan fungsi.
- `useMemo`, `useCallback`, dan state awal yang berisi teks memasukkan `useLang()` ke dependensi.
- Bahasa Indonesia tidak berubah satu huruf pun, supaya tes dan e2e yang ada tetap lulus.
- Tanpa em dash di kedua bahasa.

## Daftar istilah bahasa Inggris

Supaya semua layar memakai kata yang sama.

| Indonesia | Inggris |
|---|---|
| Organisasi, kantor | Organization, office |
| Departemen | Department |
| Superadmin, Admin departemen, Anggota, Tamu | Superadmin, Department admin, Member, Guest |
| Kode undangan | Invite code |
| Permintaan bergabung | Join request |
| Rekan, laptop rekan | Colleague, a colleague's laptop |
| Laptop ini | This laptop |
| Proyek, Task, Subtask | Project, Task, Subtask |
| Tenggat | Due date |
| Pengingat | Reminder |
| Waktu tercatat, timer | Time logged, timer |
| Task saya | My tasks |
| Percakapan, Grup, Kanal, Pesan langsung | Conversation, Group, Channel, Direct message |
| Bisukan, Bunyikan | Mute, Unmute |
| Hanya-baca | Read-only |
| Dokumen, Versi | Documents, Version |
| Tanda tangan, Permintaan tanda tangan, Penanda tangan | Signatures (menu), Signature request, Signer |
| Stempel, Jejak audit | Stamp, Audit trail |
| Pengaturan, Tampilan, Jaringan, Tentang dan pembaruan | Settings, Appearance, Network, About and updates |
| Yang baru, Pembaruan | What's new, Update |
| Simpan, Batal, Hapus, Tutup, Coba lagi | Save, Cancel, Delete, Close, Try again |
| Menyimpan... | Saving... |
| Anda | you (sapaan langsung, ramah dan lugas) |

Gaya: kalimat biasa (sentence case) untuk tombol dan judul, sama dengan versi Indonesia. Ringkas, tidak kaku, bukan terjemahan kata per kata. Tanggal `24 Nov 2026`, jam `09:12`.

## Tugas

1. Fondasi: inti, preferensi, pemilih bahasa, tes kamus, "Yang baru" `.en.md`. (sesi utama)
2. Pemindahan teks paralel per modul, masing-masing hanya berkas modulnya dan kamus berawalan namanya:
   - onboarding dan layar status (`src/screens/onboarding`, `StatusScreens.tsx`, `RemovedScreen.tsx`) plus pemilih ringkas di langkah pertama;
   - shell, pengaturan, pembaruan, tema (`src/screens/shell`, `src/screens/settings`, `src/updates`, `src/theme`) plus bagian Bahasa di Pengaturan;
   - chat (dua bagian berkas);
   - board (dua bagian berkas);
   - docs; sign; org;
   - components dan `platform.ts`;
   - api: label peran dan status, validasi, format, peta kode error Rust;
   - Rust: judul dialog file dan notifikasi.
3. Tes: ganti bahasa di Pengaturan, sampel layar utama tanpa teks Indonesia saat Inggris aktif.
4. Review terpisah tampilan dan teks Inggris.
5. E2E satu per satu, ditambah pemeriksaan ganti ke bahasa Inggris. Screenshot.
6. Laporan `docs/progress/v04-english.md`.
