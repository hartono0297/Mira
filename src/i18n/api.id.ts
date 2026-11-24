// Teks bersama dari src/api: label peran dan status, teks jaringan, validasi
// cepat di tampilan, kode undangan, dan waktu relatif.
const id = {
  roles: {
    superadmin: "Superadmin",
    team_admin: "Admin departemen",
    member: "Anggota",
    guest: "Tamu",
  },
  teamRoles: {
    admin: "Admin departemen",
    member: "Anggota",
  },
  inviteRoles: {
    team_admin: "Admin departemen",
    member: "Anggota",
    guest: "Tamu",
  },
  validity: {
    "24h": "24 jam",
    "7d": "7 hari",
    once: "Sekali pakai",
  },
  inviteStatus: {
    active: "Aktif",
    used: "Terpakai",
    expired: "Kedaluwarsa",
    revoked: "Dicabut",
  },
  delivery: {
    pending: "Menunggu",
    deposited: "Dititipkan",
    delivered: "Diterima laptopnya",
    read: "Dibaca",
  },
  netState: {
    starting: "Mencari laptop rekan...",
    no_org: "Belum tergabung di organisasi",
    alone: "Belum ada rekan di organisasi",
    lan: "Tersambung lewat LAN kantor",
    vpn: "Tersambung lewat VPN",
    offline: "Tidak tersambung ke jaringan kantor",
    removed: "Laptop ini sudah dikeluarkan dari organisasi",
    suspended: "Akun Anda di organisasi ini sedang dinonaktifkan",
  },
  offlineHint: "Kalau sedang di luar kantor, nyalakan VPN kantor.",
  inviteError: {
    invalidTitle: "Kode undangan tidak valid",
    notFoundTitle: "Kode tidak dikenali",
    notFoundBody:
      "Laptop rekan yang ditemukan tidak mengenal kode ini. Periksa lagi kodenya huruf demi huruf, atau minta kode baru ke admin departemen.",
    expiredTitle: "Kode sudah kedaluwarsa",
    expiredBody: "Masa berlaku kode ini sudah habis. Minta kode baru ke admin departemen yang mengundang Anda.",
    usedTitle: "Kode sudah dipakai",
    usedBody: "Kode sekali pakai ini sudah dipakai untuk bergabung. Minta kode baru ke admin departemen.",
    revokedTitle: "Kode sudah dicabut",
    revokedBody: "Admin sudah membatalkan kode ini. Minta kode baru ke admin departemen.",
    noPeerTitle: "Belum ada laptop rekan yang ditemukan",
    noPeerBody:
      "Kode hanya bisa diperiksa oleh laptop anggota organisasi yang sedang membuka Mira. Coba langkah berikut, lalu tekan Gabung lagi:",
    noPeerSteps: [
      "Sambungkan laptop ini ke Wi-Fi atau kabel LAN kantor yang sama dengan rekan. Wi-Fi tamu biasanya memisahkan laptop satu sama lain.",
      "Kalau sedang di luar kantor, nyalakan VPN kantor.",
      "Pastikan firewall di laptop ini dan di laptop rekan mengizinkan Mira (Windows Firewall di Windows, Firewall macOS di MacBook).",
      "Minta rekan membuka Pengaturan > Jaringan di Mira, lalu isi alamat laptopnya di kolom Alamat laptop rekan.",
    ],
    peerUnreachableTitle: "Laptop rekan tidak bisa memeriksa kode",
    peerUnreachableBody: (message: string) =>
      `${message} Coba lagi sebentar lagi. Kalau tetap gagal, minta kode baru ke admin departemen.`,
    nameRequiredTitle: "Nama tampilan belum tersimpan",
    nameRequiredBody:
      "Laptop ini belum punya nama tampilan. Muat ulang data laptop ini, lalu isi nama sebelum bergabung.",
    alreadyInOrgTitle: "Laptop ini sudah tergabung di organisasi",
    alreadyInOrgBody: "Muat ulang data laptop ini untuk membuka organisasinya.",
    removedTitle: "Laptop ini sudah dikeluarkan dari organisasi",
    removedBody:
      "Laptop yang sudah dikeluarkan tidak bisa bergabung lagi, juga dengan kode undangan baru. Kalau ini keliru, hubungi superadmin organisasi.",
    networkTitle: "Jaringan bermasalah",
    defaultTitle: "Kode belum bisa dipakai",
  },
  forbiddenTitle: "Anda tidak punya izin untuk ini",
  lastSuperadminTitle: "Organisasi butuh minimal satu superadmin",
  notFoundTitle: "Data sudah berubah",
  validation: {
    displayNameEmpty: "Isi nama tampilan dulu.",
    displayNameMax: (max: number) => `Nama tampilan paling banyak ${max} karakter.`,
    orgNameEmpty: "Isi nama organisasi dulu.",
    orgNameMin: (min: number) => `Nama organisasi minimal ${min} karakter.`,
    orgNameMax: (max: number) => `Nama organisasi paling banyak ${max} karakter.`,
    teamNameEmpty: "Isi nama departemen dulu.",
    teamNameMin: (min: number) => `Nama departemen minimal ${min} karakter.`,
    teamNameMax: (max: number) => `Nama departemen paling banyak ${max} karakter.`,
  },
  inviteCode: {
    empty: "Isi kode undangan dulu.",
    badChar: (ch: string) =>
      `Karakter "${ch}" tidak ada di kode undangan. Kode hanya berisi huruf dan angka, tanpa huruf U.`,
    wrongLength: (expected: number, got: number) =>
      `Kode undangan berisi ${expected} huruf dan angka. Yang terisi ${got}.`,
  },
  relative: {
    justNow: "baru saja",
    minutesAgo: (n: number) => `${n} menit lalu`,
    hoursAgo: (n: number) => `${n} jam lalu`,
    yesterday: "kemarin",
    daysAgo: (n: number) => `${n} hari lalu`,
  },
  // Judul dialog file Windows untuk layar Dokumen.
  pickFilesTitle: "Pilih file untuk pustaka",
  saveCopyTitle: "Simpan salinan",
  notBytes: "Isi file dari inti Mira tidak berbentuk byte.",
};

export default id;
