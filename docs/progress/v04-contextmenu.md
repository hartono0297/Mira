# Laporan: menu klik kanan, tahap dasar (v0.4)

Branch `claude/v04-contextmenu-4da6b1`. Rencana: `docs/plans/v04-contextmenu.md`.

Permintaan user: "buat click kanan pada app nya ada fungsinya, seperti kalau di chat, buat delete chat, dll u atur aja yang terbaiknya gimana untuk modul2 lain". Tahap ini membuat komponen bersama dan memasangnya di Dokumen, Tanda tangan, dan Organisasi. Chat dan Board menyusul memakai komponen yang sama (lihat "Cara pakai").

## Hasil

- Komponen bersama `src/components/ContextMenu/`, tanpa dependensi baru.
- Menu bawaan WebView (Back, Reload, Inspect) mati di seluruh aplikasi. Kolom teks mendapat menu Potong, Salin, Tempel, Pilih semua. Teks yang dipilih di luar kolom mendapat Salin.
- Menu baris di Dokumen, Tanda tangan, Organisasi > Pengguna, Departemen, dan Label.
- Sidebar menu utama sengaja tanpa menu (alasan di bawah).

## Keputusan

| Keputusan | Alasan |
|---|---|
| Komponen sendiri, bukan `@radix-ui/react-context-menu` | Dokumentasi Radix (ctx7) menunjukkan ContextMenu hanya dibuka dari event `contextmenu`; tombol "..." butuh paket kedua (`react-dropdown-menu`) plus lapisan popper. Kebutuhan Mira hanya daftar datar tanpa submenu. Satu model item melayani klik kanan dan tombol "...". |
| Shift+F10 dan tombol Menu ditangani lewat keydown | jsdom tidak membuat `contextmenu` dari keyboard, dan posisi event keyboard di Chromium tidak bisa diandalkan. Event susulan dari keyboard (button bukan 2) dalam 400 ms diabaikan; klik kanan sungguhan selalu dilayani. |
| Fokus kembali ke elemen asal sebelum aksi berjalan | Dialog Mira mencatat elemen terfokus saat dibuka, jadi setelah dialog ditutup fokus kembali ke baris. |
| Menu di dalam dialog modal dirender di dalam dialog | Radix Dialog mengunci fokus dan klik di luar kontennya, dan menangkap Esc di `document`. Menu ikut di dalam kotak dialog, posisinya dijepit ke kotak itu, dan Esc ditangkap di `window` lebih dulu sehingga hanya menutup menu. |
| `enable_clipboard_access()` di jendela utama (`src-tauri/src/lib.rs`) | Tanpa itu, Tempel dari menu memunculkan prompt izin WebView2 berbahasa Inggris atau ditolak diam-diam (wry hanya memberi izin baca papan klip kalau diaktifkan). Halaman yang dimuat hanya frontend Mira sendiri dengan CSP `'self'`, jadi tidak ada halaman asing yang ikut bisa membaca papan klip. |
| Sidebar tanpa menu klik kanan | Isinya hanya navigasi. Satu-satunya aksi yang masuk akal ("Buka") sama dengan klik kiri, dan Mira hanya punya satu jendela. Klik kanan di sana cukup tidak memunculkan menu bawaan. |
| Dokumen tanpa "Hapus" | Tidak ada perintah hapus dokumen di `src/api/documents.ts` maupun `src-tauri/src/documents` (`delete_edit_session` hanya internal). Tidak dibuat baru. |
| Pengguna tanpa "Lihat detail" dan "Pasang label" | Tidak ada tampilan detail orang; baris sudah memuat laptop, IP, sistem, status, dan tanggal bergabung. Label dipasang per label dari tab Label, bukan per orang. Membuat alur baru di luar lingkup. |
| Departemen dan Label tanpa tombol "..." | Setiap aksi menu yang aktif sudah punya tombol di baris yang sama. Satu-satunya item tanpa tombol (Arsipkan departemen yang masih berisi orang) memang nonaktif dengan alasan. |

## Isi menu per modul

Semua menu mengikuti hak peran yang sudah ada; tidak ada hak yang diperluas. Aksi yang tidak akan pernah boleh disembunyikan; aksi yang sementara tidak bisa tampil nonaktif dengan alasan.

**Dokumen** (baris file, plus tombol "Aksi lain untuk <file>")
- Word/Excel biasa: Edit di Word/Excel, Buka hanya baca, Lihat riwayat versi, Simpan salinan, Salin nama.
- Sedang Anda edit: Buka lagi, Selesai mengedit, Lihat riwayat versi, Simpan salinan, Salin nama.
- Diedit rekan atau tanpa hak edit (Tamu): Buka hanya baca, lalu sama seperti di atas. PDF dan file lain: Buka.
- Bentrok: Selesaikan bentrok (Lihat bentrok untuk Tamu), Lihat riwayat versi, Salin nama. Simpan salinan tidak ditawarkan karena "versi sekarang" belum jelas; tombol per versi di panel detail tetap ada.
- Di atas 20 MB dan belum terunduh: Unduh dari rekan (ukuran), Simpan salinan nonaktif "Unduh dulu isinya dari rekan".
- Lihat riwayat versi memilih baris lalu memindahkan fokus ke judul "Riwayat versi".

**Tanda tangan** (baris permintaan, plus tombol "Aksi lain untuk <judul>")
- Buka, Tandatangani, Unduh file (kalau perlu unduh manual), Simpan salinan PDF, Periksa keaslian file, Batalkan permintaan.
- Tandatangani hanya untuk penanda tangan yang belum tanda tangan; nonaktif dengan alasan kalau belum giliran, file belum ada, atau isi tidak cocok. Item ini membuka dokumen dan langsung menempatkan kotak tanda tangan (prop `startSigning` di `SignDocumentView`).
- Batalkan hanya untuk pengirim selama permintaan berjalan; merah dan dengan konfirmasi (teks sama dengan dialog di layar dokumen, `CANCEL_CONFIRM` di `labels.ts`).

**Organisasi > Pengguna** (baris orang, tombol titik tiga "Aksi untuk <nama>" tetap)
- Anggota atau admin lain: Ubah departemen, Ubah peran, Keluarkan dari organisasi (merah, dialog konfirmasi yang sudah ada).
- Diri sendiri: Ubah departemen, Ubah peran. Tamu: Keluarkan dari organisasi. Orang yang sudah dikeluarkan: tanpa menu.
- `ActionMenu` lama (pola disclosure) diganti komponen bersama, jadi klik kanan dan tombol titik tiga berisi item yang sama.

**Organisasi > Departemen** (superadmin): Ganti nama, Atur admin, Arsipkan (nonaktif dengan alasan kalau masih ada orang). Departemen arsip: Pulihkan.

**Organisasi > Label**: Atur orang, Ganti nama, Hapus (merah, dialog konfirmasi). Label yang dihapus: Pulihkan.

## Cara pakai (untuk sesi Chat dan Board)

```tsx
import { MenuButton, menuItems, SEPARATOR, useContextMenu } from "../../components/ContextMenu";

function MessageRow({ msg }: { msg: Message }) {
  // Satu hook per baris: buat komponen baris sendiri kalau baris masih di dalam .map().
  const menu = useContextMenu({
    label: `Aksi untuk pesan dari ${msg.author}`,
    items: menuItems(
      { id: "reply", label: "Balas", icon: <IconArrowBackUp size={16} />, onSelect: () => reply(msg) },
      { id: "copy", label: "Salin teks", onSelect: () => navigator.clipboard.writeText(msg.text) },
      canEdit && { id: "edit", label: "Edit", onSelect: () => startEdit(msg) },      // false/null dibuang
      { id: "pin", label: "Sematkan", disabled: offline && "Laptop sedang offline", onSelect: pin }, // nonaktif + alasan
      SEPARATOR,                                                                     // pemisah dirapikan otomatis
      isMine && {
        id: "delete",
        label: "Hapus pesan",
        danger: true,                                                                // teks merah
        confirm: { title: "Hapus pesan ini?", body: "Pesan hilang untuk semua anggota.", confirmLabel: "Hapus pesan", busyLabel: "Menghapus..." },
        onSelect: () => chatApi.deleteMessage(msg.id),                               // boleh Promise; error tampil di dialog
      },
    ),
  });
  return (
    <li {...menu.triggerProps}>                {/* klik kanan, tombol Menu, Shift+F10 */}
      ...isi baris...
      <MenuButton menu={menu} label={`Aksi lain untuk pesan dari ${msg.author}`} />  {/* jalan kedua tanpa klik kanan */}
      {menu.element}                           {/* render sekali: menu (portal) dan dialog konfirmasi */}
    </li>
  );
}
```

- **Item**: `id`, `label`, `onSelect`, opsional `icon`, `shortcut` (hanya tampilan, misalnya "Ctrl+C"; tampil sebagai ⌘C di macOS), `danger`, `disabled` (`true` atau teks alasan), `confirm`.
- **Konfirmasi**: pakai `confirm` kalau layar belum punya dialog sendiri. Kalau sudah punya (misalnya `RemoveDialog`), cukup `danger: true` dan panggil pembuka dialog itu dari `onSelect`.
- **Keyboard**: panah atas/bawah (berputar), Home/End, Enter/Spasi, Esc dan Tab menutup, huruf awal melompat. Fokus awal di item pertama (panah atas di tombol "..." ke item terakhir).
- **Fokus**: kembali ke elemen terfokus di baris yang diklik kanan (atau elemen pertama yang bisa difokus, atau yang bertanda `data-menu-focus`), atau ke tombol "...".
- **Kolom teks**: klik kanan di input, textarea, atau contenteditable di dalam baris tidak membuka menu baris; menu teks global yang muncul.
- **Teks terpilih**: klik kanan di atas teks yang dipilih di dalam baris menambah "Salin" di atas menu baris.
- **Selector uji**: menu `role=menu` dengan nama = `label`; item `role=menuitem` dengan `data-menu-item={id}`; nama item hanya labelnya, alasan nonaktif menjadi deskripsi.
- **Teks**: tulis label di file teks modul. Teks menu teks global ada di `TEXT_MENU` (`TextFieldMenu.tsx`).

## Verifikasi

| Uji | Hasil |
|---|---|
| `npx tsc --noEmit -p .` | bersih |
| `npx vitest run` (seluruh repo) | 69 file, 1037 tes lulus |
| Tes keyboard ContextMenu (`src/components/ContextMenu/*.test.tsx`) | 49 tes: klik kanan, Shift+F10, tombol Menu, panah, Home/End, huruf awal, Enter, Esc, Tab, fokus kembali, item nonaktif, pintasan, konfirmasi, posisi, menu teks, dialog modal |
| `cargo test` (ada perubahan `lib.rs`) | 1007 lulus, 7 diabaikan (sudah begitu di main) |
| `scripts/contextmenu-e2e.mjs` (klik kanan sungguhan, `button: "right"`) | 27/27 |
| `scripts/smoke-docs-e2e.mjs` | 15/15 |
| `scripts/sign-e2e.mjs` | 15/15 |
| `scripts/org-e2e.mjs` | 33/33 |

Yang diperiksa `contextmenu-e2e` di aplikasi sungguhan (WebView2, build debug):
- Klik kanan di judul halaman dan di sidebar: event dibatalkan, tidak ada menu.
- Dokumen: menu baris (5 item, tanpa Hapus). Salin nama mengisi papan klip sungguhan. Shift+F10 membuka menu dengan item terfokus, Esc mengembalikan fokus ke baris. Tombol "..." berisi item yang sama. Lihat riwayat versi menampilkan daftar versi.
- Kolom teks: menu Potong, Salin, Tempel, Pilih semua. Tempel memasukkan isi papan klip, Potong mengosongkan kolom dan mengisi papan klip, Esc mengembalikan fokus ke kolom.
- Dialog modal (Departemen baru): menu teks dirender di dalam dialog, Pilih semua bisa diklik, Esc hanya menutup menu.
- Pengguna: menu baris sama dengan tombol titik tiga, Esc mengembalikan fokus ke tombol.
- Tanda tangan: Buka, Tandatangani, Simpan salinan PDF, Periksa keaslian file, Batalkan permintaan. Periksa keaslian membuka dialog dan fokus kembali ke baris setelah ditutup. Batalkan meminta konfirmasi dan Batal tidak mengubah apa pun.
- Mode terang dan gelap.

Screenshot (`docs/progress/screenshots/v04-contextmenu/`): `01-dokumen-menu-terang`, `02-menu-teks-terang`, `03-pengguna-menu-terang`, `03b-menu-teks-di-dialog-terang`, `04-tanda-tangan-menu-terang`, `05-tanda-tangan-konfirmasi-batal-terang`, `06-tanda-tangan-menu-gelap`, `07-dokumen-menu-gelap`, `08-pengguna-menu-gelap`, `09-menu-teks-gelap`.

Perubahan skrip uji lama:
- `org-e2e.mjs`: item menu Ubah departemen sekarang `menuitem` (3 baris).
- `org-e2e.mjs`: `E2E_PORT_OFFSET` menggeser port, sama seperti `smoke-docs-e2e`. Sesi onboarding sedang memakai port 9371 dan 9372, sehingga koneksi CDP sempat nyasar ke aplikasinya.
- `org-e2e.mjs`: menunggu tab dan daftar Anggota B sebelum membacanya. Di mesin yang sibuk, judul tampil sebelum tab, dan screenshot membuktikan layarnya benar.
- `contextmenu-e2e.mjs` memakai port CDP 9487 dan `MIRA_PORT` 47931 sendiri.

Kontras (skrip `contrast-check.py`), semua lolos AA di terang dan gelap:

| Pasangan | Terang | Gelap |
|---|---|---|
| teks bahaya di atas sorotan | 6,18 | 7,08 |
| teks pendukung (alasan, pintasan) di atas sorotan | 5,03 | 6,93 |
| teks utama di atas sorotan | 13,22 | 12,25 |
| cincin fokus di atas sorotan (non-teks, 3:1) | 4,47 | 5,88 |

## Review terpisah

Reviewer (aksesibilitas, tampilan, keamanan) menemukan 10 bug dan 8 saran kecil. Semua bug diperbaiki dengan tes regresi (`ContextMenuReview.test.tsx`):

1. Menu teks di dialog modal tidak bisa diklik, fokusnya ditarik balik, dan Esc menutup dialog. Sekarang menu dirender di dalam dialog.
2. Event dari dialog konfirmasi naik lewat portal ke baris dan membuka menu baris. Sekarang event yang bukan dari dalam baris diabaikan.
3. Item terfokus yang hilang (daftar dimuat ulang dari rekan) membuat keyboard mati. Sekarang fokus pindah ke item yang tersisa, dan menu kosong tertutup.
4. Dokumen: fokus ke "Riwayat versi" dan kotak bentrok dicuri saat panel dipasang ulang. Sekarang fokus hanya pindah saat diminta.
5. Klik kanan di teks terpilih dalam baris tidak memberi Salin. Sekarang ada.
6. Alasan nonaktif dibacakan dua kali. Sekarang nama item hanya labelnya.
7. Di WebKit, klik item nonaktif melepas fokus, dan seleksi bisa hilang sebelum Salin. Sekarang mousedown di menu tidak memindahkan fokus, dan Salin memakai teks yang dicatat saat menu dibuka.
8. Tempel bergantung pada izin papan klip. Sekarang `enable_clipboard_access`.
9. Blur dan resize menutup menu tanpa mengembalikan fokus. Sekarang fokus kembali.
10. Shift+F10 di dalam menu bisa membuka menu lagi. Sekarang tidak melakukan apa-apa.

Saran yang diambil: mode kontras tinggi (`forced-colors`), panah atas di tombol "..." ke item terakhir, teks alasan sibuk diseragamkan ("Tunggu aksi lain selesai"), `setRangeText` memicu event input, menu teks tutup kalau kolomnya hilang, typeahead tanpa item terfokus, teks papan klip Dokumen dipindah ke `text.ts`.

Uji e2e sungguhan menemukan satu bug lagi: klik kanan dalam 400 ms setelah Shift+F10 ditelan oleh penjaga event susulan. Penjaganya sekarang hanya berlaku untuk event dari keyboard.

## Batasan dan tindak lanjut

- Menu baris Pengguna berisi 1 sampai 3 item, dan menu Departemen arsip atau Label yang dihapus hanya 1 item (Pulihkan). Hak peran yang ada memang tidak memberi aksi lain; klik kanan tetap berperilaku sama di setiap baris.
- Tempel di macOS (WKWebView) belum diuji di Mac: WebKit bisa menampilkan gelembung "Paste" sistem yang perlu diklik sekali lagi. Ctrl/⌘+V tetap bekerja seperti biasa.
- Chat dan Board belum memakai menu ini (gelombang berikutnya). Bahasa Inggris menyusul.
