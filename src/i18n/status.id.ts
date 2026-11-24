// Teks layar status: memuat, gagal dibuka (StatusScreens.tsx), akun yang
// dinonaktifkan (SuspendedScreen.tsx), dan laptop yang dikeluarkan permanen
// (RemovedScreen.tsx). Versi Inggris di status.en.ts.
const id = {
  loading: "Membuka data Mira di laptop ini...",
  // Label tebal di depan langkah berikutnya, diikuti kalimatnya.
  nextLabel: "Langkah berikutnya: ",
  // Label di atas sidik jari laptop ini (huruf mono).
  fingerprintLabel: "Sidik jari laptop ini",
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
  suspended: {
    heading: (org: string) => `Akun Anda di ${org} sedang dinonaktifkan`,
    contact: "Hubungi IT atau superadmin kantor. Mereka bisa mengaktifkan Anda lagi.",
    kept: "Selama akun Anda nonaktif, data di laptop ini tetap tersimpan dan tidak ada yang dihapus.",
    fingerprintHint: "Bacakan ke IT supaya mereka yakin orangnya benar.",
    check: "Periksa lagi",
    checking: "Memeriksa...",
    auto: "Mira juga memeriksa sendiri setiap 20 detik.",
    // Waktu ditulis jam dan menit, misalnya 14.20.
    stillSuspended: (time: string) => `Dicek ${time}: masih nonaktif.`,
    active: (time: string) => `Dicek ${time}: akun Anda aktif lagi. Membuka Mira...`,
    removed: (time: string) => `Dicek ${time}: laptop ini sudah dikeluarkan dari kantor.`,
    notConnected: "Belum tersambung ke laptop kantor. Pastikan laptop ini ada di jaringan kantor.",
    // Diikuti pesan error dari inti Rust.
    failed: (message: string) => `Belum bisa memeriksa. ${message}`,
  },
  removed: {
    heading: (org: string) => `Laptop ini sudah dikeluarkan dari organisasi ${org}`,
    cause:
      "Superadmin kantor mengeluarkan laptop ini secara permanen. Pesan dan perubahan baru dari kantor tidak lagi sampai ke sini.",
    kept: "Sampai Anda me-reset, data lama tetap tersimpan di sini.",
    rejoin:
      "Laptop ini belum bisa bergabung lagi sebelum di-reset. Setelah reset, Anda bisa meminta bergabung lagi sebagai laptop baru.",
    // Diikuti sidik jari laptop ini.
    contact: "Kalau ini keliru, hubungi superadmin kantor dan sebutkan sidik jari laptop ini.",
    reset: "Reset dan mulai dari awal",
    dialog: {
      title: "Reset laptop ini?",
      data: "Data organisasi lama di laptop ini dihapus. Pilihan bahasa dan tema tetap.",
      key: "Laptop ini mendapat kunci baru, jadi sidik jarinya berubah.",
      start: "Mira kembali ke layar awal. Dari sana Anda bisa meminta bergabung lagi.",
      admin: "Admin akan melihatnya sebagai laptop baru.",
      confirm: "Hapus data dan reset",
      busy: "Mereset...",
      // Diikuti pesan error dari inti Rust.
      failed: (message: string) => `Laptop ini belum di-reset. ${message}`,
    },
  },
};

export default id;
