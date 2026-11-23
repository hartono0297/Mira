// Teks menu klik kanan dan tombol "..." di layar Chat (v0.4).

export const MENU = {
  // Pesan
  messageMenu: (author: string, time: string) => `Aksi untuk pesan ${author} pukul ${time}`,
  messageMore: (author: string, time: string) => `Aksi lain untuk pesan ${author} pukul ${time}`,
  reply: "Balas",
  copyText: "Salin teks",
  mentionAuthor: (name: string) => `Sebut ${name}`,
  readStatus: "Lihat status baca",
  deleteMessage: "Hapus pesan",
  copied: "Teks pesan disalin.",
  copyFailed: "Teks belum bisa disalin. Pilih teksnya lalu tekan Ctrl+C.",

  // Percakapan di sidebar dan menu "..." di kepala percakapan
  convMenu: (title: string) => `Aksi untuk ${title}`,
  convMore: (title: string) => `Aksi lain untuk ${title}`,
  open: "Buka",
  markRead: "Tandai sudah dibaca",
  mute: "Bisukan",
  unmute: "Bunyikan",
  renameGroup: "Ganti nama",
  addPeople: "Tambah orang",
  leaveGroup: "Keluar dari grup",
  leaveTitle: (name: string) => `Keluar dari grup ${name}?`,
  leaveBody: "Anda tidak menerima pesan baru dari grup ini lagi. Pesan lama tetap tersimpan di laptop ini.",
  leaveConfirm: "Keluar dari grup",
  leaveBusy: "Keluar...",
  lock: "Jadikan hanya-baca",
  unlock: "Buka untuk semua",
  archive: "Arsipkan channel",
  unarchive: "Kembalikan dari arsip",
  deleteChannel: "Hapus channel",
  deleteChannelTitle: (title: string) => `Hapus channel ${title}?`,
  deleteChannelBody: (title: string) =>
    `Semua pesan di ${title} dihapus untuk semua anggota. Tindakan ini tidak bisa dibatalkan.`,
  deleteChannelConfirm: "Hapus channel",
  deleteChannelBusy: "Menghapus...",

  // Lampiran
  fileMenu: (name: string) => `Aksi untuk ${name}`,
  fileMore: (name: string) => `Aksi lain untuk ${name}`,
  openFile: "Buka",
  saveCopy: "Simpan salinan",
  downloadFromPeer: (size: string) => `Unduh dari rekan (${size})`,
  copyFileName: "Salin nama file",
  fileNotHere: "File belum ada di laptop ini",
  fileBusy: "Tunggu aksi lain selesai",
  fileNameCopied: (name: string) => `Nama ${name} disalin.`,

  // Orang
  personMenu: (name: string) => `Aksi untuk ${name}`,
  personMore: (name: string) => `Aksi untuk ${name}`,
  sendDm: "Kirim pesan pribadi",
  mention: "Sebut",
  profile: "Lihat profil",
  removeFromGroup: "Keluarkan dari grup",
  removeTitle: (name: string) => `Keluarkan ${name} dari grup?`,
  removeBody: (name: string) => `${name} tidak menerima pesan baru lagi; pesan lama tetap di laptopnya.`,
  removeConfirm: "Keluarkan",
  removeBusy: "Mengeluarkan...",
} as const;
