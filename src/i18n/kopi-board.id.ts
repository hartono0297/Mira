// Teks tab Kopi di halaman Organisasi (src/screens/org/KopiBoardPanel.tsx).
// "Kopi" kapital hanya untuk nama fitur, judul tab, dan nama pengaturan; satuan
// di dalam kalimat ditulis kecil ("beri kopi", "3 kopi"), sama dengan kamus kopi.*.
// Nama tingkatan ada di kamus kopi (tier).
const id = {
  tab: "Kopi",
  title: "Kopi",
  intro:
    "Kopi adalah tanda terima kasih dan hanya bisa bertambah. Rekan memberi kopi dengan alasan, dan kopi juga datang sendiri saat task selesai tepat waktu atau saat task dari rekan selesai.",
  loading: "Memuat kopi...",
  loadErrorTitle: "Data kopi belum terbaca",
  loadErrorEmpty: "Inti Mira tidak mengirim data kopi.",
  badData: "Inti Mira mengirim data kopi yang tidak terbaca.",
  retry: "Coba lagi",
  stale: (message: string) => `Data kopi terbaru belum bisa dibaca (${message}). Yang tampil adalah data terakhir.`,

  // Fitur atau papan dimatikan superadmin
  featureOffTitle: "Fitur Kopi sedang dimatikan",
  featureOffBody:
    "Superadmin mematikan Kopi untuk seluruh kantor. Selama mati, tidak ada yang bisa memberi kopi dan papan bulanan tidak tampil.",
  featureOffAdmin:
    "Selama mati, tidak ada yang bisa memberi kopi dan papan bulanan tidak tampil. Nyalakan lagi dengan mencentang Fitur Kopi di Pengaturan Kopi.",
  boardOffTitle: "Papan bulanan dimatikan",
  boardOffBody: "Superadmin mematikan papan bulanan. Kopi tetap bisa diberi dan tetap tercatat di profil setiap orang.",
  boardOffAdmin: "Orang lain tidak melihat papan ini sampai Papan bulanan dicentang lagi.",

  // Papan bulanan
  boardTitleNow: "Paling banyak membantu bulan ini",
  boardTitle: (month: string) => `Paling banyak membantu pada ${month}`,
  boardHint: "Sepuluh skor tertinggi dalam bulan itu, dari kopi rekan dan kopi kerja.",
  monthNav: "Pilih bulan",
  prevMonth: "Bulan sebelumnya",
  nextMonth: "Bulan berikutnya",
  monthLoading: (month: string) => `Memuat papan ${month}...`,
  monthErrorTitle: (month: string) => `Papan ${month} belum terbaca`,
  emptyNow:
    "Belum ada kopi bulan ini. Beri kopi ke rekan yang membantu lewat menu klik kanan pesannya, atau selesaikan task paling lambat di hari tenggat.",
  emptyPast: (month: string) => `Tidak ada kopi pada ${month}.`,
  listLabel: (month: string) => `Peringkat ${month}`,
  rank: (n: number) => `Peringkat ${n}`,
  peer: "Dari rekan",
  work: "Dari kerja",
  score: "Skor",
  you: " (Anda)",

  // Cara mendapat kopi
  howTitle: "Cara mendapat kopi",
  howPeer: (weight: number) =>
    `Dari rekan: rekan memberi kopi dengan alasan, lewat pesan chat, task yang sudah selesai, atau profil. Satu kopi dari rekan bernilai ${weight} poin skor.`,
  howWork: (weight: number) =>
    `Dari kerja: datang sendiri saat task yang ditugaskan orang lain selesai, atau saat task selesai paling lambat di hari tenggatnya. Satu kopi dari kerja bernilai ${weight} poin.`,
  howLimit: (give: number, work: number) =>
    `Setiap orang bisa memberi paling banyak ${give} kopi per hari. Kopi dari kerja dihitung paling banyak ${work} per orang per hari.`,
  howGuest: "Tamu bisa menerima kopi, tetapi tidak bisa memberi.",
  tiersTitle: "Tingkatan",
  tiersHint: "Tingkatan dihitung dari skor sejak awal, bukan hanya bulan ini.",
  tierCol: "Tingkatan",
  minCol: "Skor minimal",

  // Pengaturan superadmin
  settingsTitle: "Pengaturan Kopi",
  settingsHint: "Hanya superadmin yang melihat bagian ini.",
  featureSwitch: "Fitur Kopi",
  featureSwitchHint: "Untuk seluruh kantor: memberi kopi, ikon kopi di samping nama, dan papan.",
  boardSwitch: "Papan bulanan",
  boardSwitchHint: "Menampilkan peringkat bulanan di tab ini.",
  boardSwitchNeedsFeature: "Papan baru tampil kalau Fitur Kopi juga menyala.",
  saving: "Menyimpan...",
  saveFail: "Pengaturan Kopi belum tersimpan",
  featureOnDone: "Fitur Kopi dinyalakan untuk seluruh kantor.",
  featureOffDone: "Fitur Kopi dimatikan untuk seluruh kantor.",
  boardOnDone: "Papan bulanan dinyalakan.",
  boardOffDone: "Papan bulanan dimatikan.",
  confirmTitle: "Matikan fitur Kopi?",
  confirmBody:
    "Selama mati, tidak ada yang bisa memberi kopi, ikon kopi di samping nama hilang, dan papan bulanan tidak tampil.",
  confirmKeep: "Kopi yang sudah ada tidak dihapus dan tampil lagi saat fitur dinyalakan.",
  confirmBtn: "Matikan Kopi",
  confirmBusy: "Mematikan...",
};

export default id;
