// Teks tab Kopi di halaman Organisasi (src/screens/org/KopiBoardPanel.tsx).
const id = {
  tab: "Kopi",
  title: "Kopi",
  intro:
    "Kopi adalah tanda terima kasih. Rekan memberi Kopi dengan alasan, dan Kopi juga datang sendiri saat task selesai dengan baik. Tidak ada Kopi negatif.",
  loading: "Memuat Kopi...",
  loadErrorTitle: "Data Kopi belum terbaca",
  loadErrorEmpty: "Inti Mira tidak mengirim data Kopi.",
  badData: "Inti Mira mengirim data Kopi yang tidak terbaca.",
  retry: "Coba lagi",
  stale: (message: string) => `Data Kopi terbaru belum bisa dibaca (${message}). Yang tampil adalah data terakhir.`,

  // Fitur atau papan dimatikan superadmin
  featureOffTitle: "Fitur Kopi sedang dimatikan",
  featureOffBody:
    "Superadmin mematikan Kopi untuk seluruh kantor. Selama mati, tidak ada yang bisa memberi Kopi dan papan bulanan tidak tampil.",
  featureOffAdmin:
    "Selama mati, tidak ada yang bisa memberi Kopi dan papan bulanan tidak tampil. Nyalakan lagi lewat sakelar Fitur Kopi.",
  boardOffTitle: "Papan bulanan dimatikan",
  boardOffBody: "Superadmin mematikan papan bulanan. Kopi tetap bisa diberi dan tetap tercatat di profil setiap orang.",
  boardOffAdmin: "Orang lain tidak melihat papan ini sampai sakelar Papan bulanan dinyalakan lagi.",

  // Papan bulanan
  boardTitleNow: "Paling banyak membantu bulan ini",
  boardTitle: (month: string) => `Paling banyak membantu pada ${month}`,
  boardHint: "Sepuluh skor tertinggi dalam bulan itu, dari Kopi rekan dan Kopi kerja.",
  monthNav: "Pilih bulan",
  prevMonth: "Bulan sebelumnya",
  nextMonth: "Bulan berikutnya",
  monthLoading: (month: string) => `Memuat papan ${month}...`,
  monthErrorTitle: (month: string) => `Papan ${month} belum terbaca`,
  emptyNow:
    "Belum ada Kopi bulan ini. Beri Kopi ke rekan yang membantu lewat menu klik kanan pesannya, atau selesaikan task sebelum tenggat.",
  emptyPast: (month: string) => `Tidak ada Kopi pada ${month}.`,
  listLabel: (month: string) => `Peringkat ${month}`,
  rank: (n: number) => `Peringkat ${n}`,
  peer: "Dari rekan",
  work: "Dari kerja",
  score: "Skor",
  you: " (Anda)",

  // Cara mendapat Kopi
  howTitle: "Cara mendapat Kopi",
  howPeer: (weight: number) =>
    `Dari rekan: rekan memberi Kopi dengan alasan, dari pesan chat, task yang sudah selesai, atau profil. Satu Kopi rekan bernilai ${weight} poin skor.`,
  howWork: (weight: number) =>
    `Dari kerja: otomatis saat task yang ditugaskan orang lain selesai, atau task selesai paling lambat di hari tenggatnya. Satu Kopi kerja bernilai ${weight} poin.`,
  howLimit: (give: number, work: number) =>
    `Setiap orang bisa memberi paling banyak ${give} Kopi per hari. Kopi kerja dihitung paling banyak ${work} per orang per hari.`,
  howGuest: "Tamu bisa menerima Kopi, tetapi tidak bisa memberi.",
  tiersTitle: "Tingkatan",
  tiersHint: "Tingkatan dihitung dari skor sejak awal, bukan hanya bulan ini.",
  tierCol: "Tingkatan",
  minCol: "Skor minimal",
  tiers: {
    anak_baru: "Anak baru",
    andalan: "Andalan",
    senior: "Senior",
    legenda: "Legenda",
  },

  // Pengaturan superadmin
  settingsTitle: "Pengaturan Kopi",
  settingsHint: "Hanya superadmin yang melihat bagian ini.",
  featureSwitch: "Fitur Kopi",
  featureSwitchHint: "Untuk seluruh kantor: memberi Kopi, ikon Kopi di samping nama, dan papan.",
  boardSwitch: "Papan bulanan",
  boardSwitchHint: "Papan Paling banyak membantu di tab ini.",
  boardSwitchNeedsFeature: "Papan baru tampil kalau Fitur Kopi juga menyala.",
  on: "Nyala",
  off: "Mati",
  saving: "Menyimpan...",
  saveFail: "Pengaturan Kopi belum tersimpan",
  featureOnDone: "Fitur Kopi dinyalakan untuk seluruh kantor.",
  featureOffDone: "Fitur Kopi dimatikan untuk seluruh kantor.",
  boardOnDone: "Papan bulanan dinyalakan.",
  boardOffDone: "Papan bulanan dimatikan.",
  confirmTitle: "Matikan fitur Kopi?",
  confirmBody:
    "Selama mati, tidak ada yang bisa memberi Kopi, ikon Kopi di samping nama hilang, dan papan bulanan tidak tampil.",
  confirmKeep: "Kopi yang sudah ada tidak dihapus dan tampil lagi saat fitur dinyalakan.",
  confirmBtn: "Matikan Kopi",
  confirmBusy: "Mematikan...",
};

export default id;
