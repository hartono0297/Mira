// Teks menu klik kanan dan tombol "..." di layar Chat (v0.4). Diekspor sebagai MENU
// dari src/screens/chat/menuText.ts.

const LEAVE = "Keluar dari grup";

const id = {
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
  // v0.6.0
  react: "Beri reaksi",
  saveSticker: "Simpan sticker",
  stickerSaved: "Sticker disimpan ke koleksi Anda.",
  stickerSaveFailed: (detail: string) => `Sticker belum tersimpan. ${detail}`,
  // Konfirmasi Hapus pesan untuk pesan sticker (label menu tetap "Hapus pesan").
  deleteStickerBody: (title: string) =>
    `Sticker ini dihapus untuk semua orang di ${title} dan tidak bisa dikembalikan. Di percakapan hanya tersisa tanda "Pesan dihapus".`,

  // Percakapan di sidebar dan menu "..." di kepala percakapan
  convMenu: (title: string) => `Aksi untuk ${title}`,
  open: "Buka",
  markRead: "Tandai sudah dibaca",
  mute: "Bisukan",
  unmute: "Bunyikan",
  renameGroup: "Ganti nama",
  addPeople: "Tambah orang",
  // Konfirmasi Keluar dari grup: dipakai menu percakapan dan tombol di panel anggota grup.
  leaveGroup: LEAVE,
  leaveTitle: (name: string) => `${LEAVE} ${name}?`,
  leaveBody:
    "Anda tidak menerima pesan baru dari grup ini lagi. Pesan lama tetap tersimpan di laptop ini. " +
    "Untuk masuk lagi, anggota grup perlu menambahkan Anda.",
  // Panel anggota tahu saya pemilik dan masih ada anggota lain.
  leaveOwner: "Anda pemilik grup ini, jadi peran pemilik pindah ke anggota yang paling lama di grup.",
  // Menu percakapan belum memuat data grup, jadi pemiliknya belum diketahui.
  leaveOwnerMaybe: "Kalau Anda pemilik grup, peran pemilik pindah ke anggota yang paling lama di grup.",
  leaveConfirm: LEAVE,
  leaveBusy: "Keluar...",
  // Sama dengan judul error yang dibuat menu untuk item berkonfirmasi: "<label> gagal".
  leaveFailed: `${LEAVE} gagal`,
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
  saveCopyFile: (name: string) => `Simpan salinan ${name}`,
  copyFileName: "Salin nama file",
  fileBusy: "Tunggu aksi lain selesai",
  fileNameCopied: (name: string) => `Nama ${name} disalin.`,
  fileNameCopyFailed: "Nama file belum bisa disalin. Pilih namanya lalu tekan Ctrl+C.",

  // Orang. Label yang sama untuk menu dan tombol "..." di baris orang.
  personMenu: (name: string) => `Aksi untuk ${name}`,
  sendDm: "Kirim pesan pribadi",
  mention: "Sebut",
  profile: "Lihat profil",
  removeFromGroup: "Keluarkan dari grup",
  removeTitle: (name: string) => `Keluarkan ${name} dari grup?`,
  removeBody: (name: string) => `${name} tidak menerima pesan baru lagi; pesan lama tetap di laptopnya.`,
  removeConfirm: "Keluarkan",
  removeBusy: "Mengeluarkan...",
};

export default id;
