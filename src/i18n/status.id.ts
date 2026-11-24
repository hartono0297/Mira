// Teks layar status: memuat, gagal dibuka (StatusScreens.tsx), dan laptop yang
// dikeluarkan dari organisasi (RemovedScreen.tsx). Versi Inggris di status.en.ts.
const id = {
  loading: "Membuka data Mira di laptop ini...",
  // Label tebal di depan langkah berikutnya, diikuti kalimatnya.
  nextLabel: "Langkah berikutnya: ",
  error: {
    heading: "Mira belum bisa dibuka",
    code: (code: string) => `Kode error: ${code}`,
    retry: "Coba lagi",
    next: {
      noTauriMac: "Tutup halaman ini, lalu buka Mira dari folder Aplikasi atau Launchpad.",
      noTauriWindows: "Tutup halaman ini, lalu buka Mira lewat ikon aplikasinya di menu Start atau di desktop.",
      keystoreMac:
        "Mira menyimpan kunci laptop di Keychain macOS. Coba lagi. Kalau macOS menanyakan izin Keychain untuk Mira, pilih Izinkan. Kalau tetap gagal, mulai ulang laptop lalu buka Mira lagi.",
      keystoreWindows:
        "Mira menyimpan kunci laptop di Windows Credential Manager. Coba lagi. Kalau tetap gagal, mulai ulang laptop lalu buka Mira lagi.",
      keyMismatch: "Jangan hapus folder data Mira. Hubungi admin organisasi Anda dan sebutkan kode error di bawah.",
      database: "Tutup jendela Mira lain yang mungkin masih terbuka, lalu coba lagi.",
      other: "Coba lagi. Kalau masih gagal, tutup Mira lalu buka kembali.",
    },
  },
  removed: {
    heading: (org: string) => `Laptop ini sudah dikeluarkan dari organisasi ${org}`,
    cause:
      "Pesan dan perubahan baru dari organisasi ini tidak lagi dikirim ke laptop ini, dan laptop rekan tidak menerima sambungan dari laptop ini.",
    kept: "Data yang sudah ada di laptop ini tetap tersimpan di sini. Mira tidak menghapusnya.",
    // Diikuti sidik jari laptop ini.
    next: "Kalau ini keliru, hubungi superadmin organisasi. Laptop yang sudah dikeluarkan belum bisa bergabung lagi dengan kode undangan di versi ini. Sebutkan sidik jari laptop ini supaya superadmin yakin orangnya benar:",
    recheck: "Periksa lagi",
  },
};

export default id;
