# Rencana: menu klik kanan, tahap dasar (v0.4)

Permintaan user: "buat click kanan pada app nya ada fungsinya, seperti kalau di chat, buat delete chat, dll u atur aja yang terbaiknya gimana untuk modul2 lain".

Tahap ini membuat komponen bersama dan memasangnya di Dokumen, Tanda tangan, dan Organisasi. Chat dan Board menyusul di gelombang berikutnya memakai komponen yang sama.

## Keputusan

- **Komponen sendiri, bukan `@radix-ui/react-context-menu`.** Dokumentasi Radix (dicek lewat ctx7) menunjukkan ContextMenu hanya dibuka dari event `contextmenu` dan tidak bisa dibuka dari tombol "...", jadi butuh `@radix-ui/react-dropdown-menu` juga, ditambah lapisan popper. Kebutuhan Mira kecil: satu daftar item datar tanpa submenu. Komponen sendiri sekitar 300 baris, satu model item untuk klik kanan dan tombol "...", dan tidak ada dependensi baru.
- **Menu bawaan WebView dimatikan di akar aplikasi** (`TextFieldMenu` di `main.tsx`). Kolom teks mendapat menu Potong, Salin, Tempel, Pilih semua berbahasa Indonesia. Teks yang dipilih di luar kolom isian mendapat menu Salin, supaya menyalin isi layar tetap bisa setelah menu bawaan hilang.
- **Shift+F10 dan tombol Menu ditangani sendiri** lewat keydown, karena jsdom tidak membuat event `contextmenu` dari keyboard dan posisi event keyboard di Chromium tidak bisa diandalkan. Event `contextmenu` yang menyusul dalam 400 ms diabaikan supaya menu tidak terbuka dua kali.
- **Fokus kembali ke elemen asal sebelum aksi berjalan.** Dialog Mira mencatat elemen terfokus saat dibuka, jadi setelah dialog ditutup fokus kembali ke baris.
- **Sidebar menu utama tanpa menu klik kanan.** Isinya hanya navigasi; satu-satunya aksi yang masuk akal ("Buka") sama dengan klik kiri, dan Mira hanya punya satu jendela, jadi "Buka di jendela baru" tidak ada. Klik kanan di sidebar cukup tidak memunculkan menu bawaan.

## Tugas

1. `src/components/ContextMenu`: model item (`items.ts`), popup (`MenuPopup.tsx`), hook `useContextMenu` dan `MenuButton`, menu teks global (`TextFieldMenu.tsx`), tes keyboard. TDD.
2. Pasang di modul, paralel per file (subagent): Dokumen, Tanda tangan, Organisasi > Pengguna, Organisasi > Departemen dan Label.
3. `scripts/contextmenu-e2e.mjs`: klik kanan sungguhan (playwright `button: "right"`) di aplikasi, menu teks dan papan klip, screenshot terang dan gelap.
4. Jalankan ulang `smoke-docs-e2e`, `sign-e2e`, `org-e2e`.
5. Review terpisah (tampilan dan aksesibilitas), lalu laporan di `docs/progress/v04-contextmenu.md`.
