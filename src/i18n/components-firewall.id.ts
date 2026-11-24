// Teks panduan firewall (FirewallGuide): onboarding dan Pengaturan > Jaringan.
const id = {
  categories: {
    public: "Publik",
    private: "Pribadi",
    domain: "Domain kantor",
  },
  noStatus: "Inti Mira tidak mengirim status firewall.",
  checking: (name: string) => `Memeriksa ${name}...`,
  loadErrorTitle: (name: string) => `Status ${name} belum terbaca`,
  loadErrorBody:
    "Anda tetap bisa melanjutkan. Kalau rekan nanti tidak bisa tersambung, periksa lagi dari Pengaturan, bagian Jaringan.",
  allowBusy: "Membuka jendela izin...",
  allow: "Izinkan lewat Windows Firewall",
  allowHint:
    "Windows akan menampilkan jendela izin administrator. Kalau akun Anda bukan administrator, jendela itu meminta nama dan kata sandi admin.",
  started: "Jendela izin Windows sudah dibuka. Setelah Anda memilih Ya di jendela itu, tekan Periksa lagi.",
  notStartedTitle: "Jendela izin Windows tidak terbuka",
  notStartedBody: "Mungkin jendelanya ditutup atau dibatalkan. Coba lagi, atau kirim perintah di bawah ke tim IT.",
  requestErrorTitle: "Izin belum bisa diminta",
  noAdmin: "Tidak punya hak administrator?",
  noAdminBody:
    "Kirim perintah ini ke tim IT kantor. Perintah ini menambah satu aturan Windows Firewall yang mengizinkan Mira menerima sambungan dari laptop rekan.",
  copyCommand: "Salin perintah",
  recheckBusy: "Memeriksa...",
  recheck: "Periksa lagi",
  win: {
    unsupported:
      "Pemeriksaan firewall hanya ada di Windows dan macOS. Kalau rekan tidak bisa tersambung, izinkan Mira menerima sambungan UDP di firewall sistem ini.",
    allowed: "Windows Firewall sudah mengizinkan Mira. Laptop rekan bisa menyambung ke laptop ini.",
    blocked: "Windows Firewall memblokir Mira. Laptop rekan tidak bisa menyambung ke laptop ini sampai aturan itu diganti.",
    missing:
      "Belum ada aturan Windows Firewall untuk Mira. Tanpa aturan ini, laptop rekan mungkin tidak bisa menemukan dan menyambung ke laptop ini.",
    unknown: "Mira belum bisa membaca aturan Windows Firewall.",
    detail: (detail: string) => ` Keterangan dari Windows: ${detail}`,
    unknownTail: " Anda tetap bisa meminta izin di bawah.",
  },
  mac: {
    allowed: "Firewall macOS tidak menghalangi Mira. Laptop rekan bisa menyambung ke laptop ini.",
    blocked: "Firewall macOS memblokir Mira, jadi laptop rekan tidak bisa menyambung ke laptop ini.",
    missing:
      "Firewall macOS menyala dan Mira belum ada di daftarnya. Saat Mira mulai menerima sambungan, macOS akan bertanya apakah Mira boleh menerima sambungan masuk. Pilih Izinkan.",
    unknown: "Mira belum bisa membaca status Firewall macOS.",
    unknownTail: " Langkah di bawah tetap bisa Anda ikuti.",
    stepsTitle: "Kalau pertanyaan macOS terlewat atau Anda memilih Tolak",
    // Nama menu ditulis seperti yang tampil di macOS berbahasa Indonesia.
    steps: [
      "Buka Pengaturan Sistem > Jaringan > Firewall, lalu klik Pilihan.",
      "Cari Mira di daftar. Kalau belum ada, klik tombol tambah (+), lalu pilih aplikasi Mira.",
      "Atur Mira ke Izinkan sambungan masuk, lalu klik OK.",
      "Kembali ke Mira, lalu tekan Periksa lagi.",
    ],
    adminHint: "Mengubah pengaturan firewall meminta kata sandi admin Mac ini.",
    noAdmin: "Tidak punya hak admin di Mac ini?",
    noAdminBody:
      "Kirim perintah ini ke tim IT kantor. Perintah ini dijalankan di Terminal dan mengizinkan Mira menerima sambungan dari laptop rekan lewat Firewall macOS.",
  },
  profiles: {
    title: "Jaringan yang sedang dipakai laptop ini",
    none: "Windows tidak melaporkan jaringan yang tersambung. Periksa kabel LAN atau Wi-Fi.",
    publicNote:
      "Windows paling ketat di jaringan Publik. Jaringan VPN sering tercatat sebagai Publik, jadi aturan Mira juga dipasang untuk jaringan Publik.",
  },
};

export default id;
