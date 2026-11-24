// Teks halaman Organisasi: kerangka layar, tab Anggota, formulir kode undangan,
// dan angka permintaan bergabung di menu.
const id = {
  retry: "Coba lagi",
  you: " (Anda)",
  stale: (message: string) => `Data terbaru belum bisa dibaca (${message}). Yang tampil adalah data terakhir.`,
  lastSuperadminHint: "Jadikan orang lain superadmin dulu, baru lepaskan peran ini.",
  screen: {
    title: "Organisasi",
    fingerprint: "sidik",
    notFoundHint: "Data di layar ini sudah dimuat ulang. Periksa lagi sebelum mencoba.",
    forbiddenHint: "Peran Anda mungkin baru berubah. Data di layar ini sudah dimuat ulang.",
    tabs: {
      users: "Pengguna",
      people: "Anggota",
      departments: "Departemen",
      requests: "Permintaan bergabung",
      labels: "Label",
      invites: "Undangan",
    },
    tabsAria: "Bagian organisasi",
    waiting: (n: number) => `, ${n} menunggu`,
    loading: "Memuat data organisasi...",
    loadErrorTitle: "Data organisasi belum terbaca",
    loadErrorEmpty: "Inti Mira tidak mengirim data organisasi.",
    oneSuperadminTitle: "Organisasi ini baru punya satu superadmin",
    oneSuperadminBody:
      "Kalau laptop superadmin rusak, hilang, atau orangnya keluar, tidak ada yang bisa membuat departemen, menunjuk admin, atau mengeluarkan orang. Jadikan satu orang lain superadmin lewat Ubah peran.",
    openUsers: "Buka daftar Pengguna",
    invitesLoading: "Memuat kode undangan...",
    invitesErrorTitle: "Kode undangan belum terbaca",
    invitesErrorEmpty: "Inti Mira tidak mengirim data undangan.",
  },
  navWaiting: (n: number) => `, ${n} permintaan bergabung menunggu`,
  people: {
    superadminAndAdmin: "Superadmin, admin departemen",
    title: "Anggota organisasi",
    hint: "Semua orang aktif di organisasi, dengan departemen dan perannya.",
    loading: "Memuat daftar anggota...",
    loadErrorTitle: "Daftar anggota belum terbaca",
    loadErrorEmpty: "Inti Mira tidak mengirim daftar anggota.",
    alone:
      "Belum ada orang lain di organisasi ini. Rekan bisa bergabung lewat kode undangan dari admin departemen atau superadmin, atau lewat permintaan bergabung dari laptopnya.",
    search: "Cari",
    searchPlaceholder: "Nama atau label",
    count: (n: number) => `${n} orang`,
    noMatch: (query: string) => `Tidak ada orang yang cocok dengan "${query}"`,
    noMatchHint: "Pencarian memeriksa nama dan label.",
    clearSearch: "Hapus pencarian",
    guest: "Tamu",
    noDepartment: "Belum ada departemen",
  },
  redeem: {
    forbiddenTitle: "Kode ini tidak bisa Anda pakai",
    forbiddenBody:
      "Kode undangan hanya untuk orang yang belum punya departemen. Kalau Anda perlu pindah departemen, minta superadmin memindahkan Anda.",
    accepted: "Kode diterima. Anda sekarang anggota departemen yang tertulis di kode itu.",
    title: "Belum punya departemen? Pakai kode undangan",
    label: "Kode undangan",
    checking: "Memeriksa kode...",
    submit: "Pakai kode",
    hintShort: "Kode memasukkan Anda ke departemen yang tertulis di kode itu.",
    hintLong:
      "Kode memasukkan Anda ke departemen yang tertulis di kode itu. Minta kode ke admin departemen atau superadmin.",
  },
};

export default id;
