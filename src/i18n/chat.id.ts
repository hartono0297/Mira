// Teks layar Chat: daftar percakapan, panel percakapan, kolom pesan, lampiran, status kirim.
// Menu klik kanan ada di chat-menu, format tanggal dan jumlah di chat-text.
const id = {
  title: "Chat",
  retry: "Coba lagi",
  reloading: "Memuat ulang...",
  close: "Tutup",
  cancel: "Batal",

  screen: {
    loading: "Memuat chat...",
    errorTitle: "Daftar chat belum terbaca",
    errorNoList: "Inti Mira tidak mengirim daftar chat.",
    errorSafe: "Pesan tersimpan di laptop ini, tidak ada yang hilang. Tunggu sebentar lalu coba lagi.",
    dmError: "Pesan pribadi belum bisa dibuka",
    emptyTitle: "Belum ada percakapan",
    emptyGuest:
      "Sebagai Tamu, Anda hanya bisa chat di proyek yang Anda diundang ke dalamnya. Chat proyek itu muncul di " +
      "bagian Proyek begitu laptop Anda tersambung dengan laptop rekan di kantor. Kalau belum muncul juga, minta " +
      "admin proyek memeriksa undangan Anda.",
    emptyMember:
      "Channel #umum, channel departemen, dan chat proyek Anda muncul di sini begitu data kantor tersalin dari " +
      "laptop rekan. Sementara itu Anda bisa membuat grup atau mengirim pesan pribadi dari daftar di kiri.",
  },

  list: {
    label: "Daftar percakapan",
    notify: "Pengaturan notifikasi chat",
    stale: "Daftar chat belum diperbarui.",
    noOrgChannel: "Belum ada channel umum.",
    newOrgChannel: "Channel umum baru",
    orgChannelBySuperadmin: "Channel umum dibuat oleh superadmin.",
    noDeptChannel: (department: string) => `Belum ada channel untuk Departemen ${department}.`,
    noDepartment: "Belum ada departemen.",
    noProjects: "Belum ada proyek yang Anda ikuti.",
    guestProjects: "Sebagai Tamu, Anda hanya melihat chat proyek yang Anda ikuti.",
    otherProjects: "Proyek lain tidak tampil karena Anda bukan anggotanya.",
    noGroups: "Belum ada grup.",
    newGroup: "Grup baru",
    noDirect: "Belum ada pesan pribadi.",
    newDirect: "Pesan baru",
    rowDirect: (name: string) => `Pesan pribadi dengan ${name}`,
    rowGroup: (name: string) => `Grup ${name}`,
    rowProject: (name: string) => `Chat proyek ${name}`,
    rowChannel: (name: string) => `Channel ${name}`,
    // Huruf kecil: disambung ke label baris untuk pembaca layar dan title.
    readOnly: "hanya-baca",
    muted: "dibisukan",
  },

  // Keadaan baris dan chip di kepala percakapan.
  state: {
    former: "Bukan anggota lagi",
    archived: "Diarsipkan",
    readOnly: "Hanya-baca",
    muted: "Dibisukan",
  },

  // Error aksi langsung dari menu percakapan (tanpa konfirmasi).
  actionErrors: {
    markRead: "Belum bisa ditandai sudah dibaca",
    mute: "Notifikasi belum bisa diubah",
    archive: "Arsip belum bisa diubah",
    lock: "Status hanya-baca belum bisa diubah",
  },

  header: {
    addPeople: "Tambah orang",
    menu: (title: string) => `Menu ${title}`,
    groupError: "Data grup belum bisa dimuat",
    groupWait: {
      rename: "Ganti nama terbuka begitu data grup termuat.",
      add: "Tambah orang terbuka begitu data grup termuat.",
    },
  },

  conv: {
    newMessage: (author: string, preview: string) => `Pesan baru dari ${author}: ${preview}`,
    loading: "Memuat pesan...",
    loadError: "Pesan belum bisa dimuat",
    latestError: "Pesan terbaru belum bisa dimuat",
    emptyCanPost: (target: string) => `Belum ada pesan di ${target}. Tulis pesan pertama di kolom bawah.`,
    empty: (target: string) => `Belum ada pesan di ${target}.`,
    emptyAfterCanPost: "Belum ada pesan. Tulis pesan pertama di kolom bawah.",
    emptyAfter: "Belum ada pesan.",
    loadingOlder: "Memuat...",
    loadOlder: "Muat pesan sebelumnya",
    olderError: "Pesan sebelumnya belum bisa dimuat",
    region: (title: string) => `Pesan di ${title}`,
    deleteTitle: "Hapus pesan ini?",
    deleteConfirm: "Hapus pesan",
    deleteBusy: "Menghapus...",
    deleteError: "Pesan belum terhapus",
    deleteBody: (title: string) =>
      `Pesan ini dihapus untuk semua orang di ${title} dan tidak bisa dikembalikan. Di percakapan hanya tersisa tanda "Pesan dihapus".`,
  },

  message: {
    // Pengganti nama penulis kutipan yang tidak diketahui: "Balasan untuk pesan: ...".
    replyUnknown: "pesan",
    replyJump: (author: string, text: string) => `Balasan untuk ${author}: ${text}. Lihat pesan asli`,
    replyTo: "Balasan untuk ",
    mentionsYou: "Menyebut Anda",
    files: "Lampiran",
    actions: (author: string, time: string) => `Aksi pesan ${author} pukul ${time}`,
    replyLabel: (author: string, time: string) => `Balas pesan ${author} pukul ${time}`,
    deleteLabel: (author: string, time: string) => `Hapus pesan ${author} pukul ${time}`,
    delete: "Hapus",
  },

  composer: {
    projectArchived: "Chat proyek ini diarsipkan, jadi pesan baru tidak bisa dikirim.",
    channelArchived: "Channel ini diarsipkan. Kembalikan dari arsip untuk mengirim pesan.",
    cannotPost: "Anda tidak bisa mengirim pesan di percakapan ini.",
    formerKept: "Pesan baru tidak dikirim lagi ke laptop Anda; pesan lama tetap tersimpan di sini.",
    formerGroup: "Anda sudah tidak ada di grup ini.",
    formerProject: "Anda sudah bukan anggota proyek ini.",
    formerDepartment: "Anda sudah pindah dari departemen ini.",
    formerChannel: "Anda sudah bukan anggota channel ini.",
    offline: (name: string) => `${name} sedang offline. Pesan dititipkan dan terkirim saat laptopnya tersambung.`,
    replying: (name: string) => `Membalas ${name}`,
    cancelReply: "Batal membalas",
    attachments: "File yang akan dikirim",
    removeAttachment: (name: string) => `Hapus lampiran ${name}`,
    sendError: "Pesan belum terkirim",
    sendErrorKept: "Teks dan lampiran masih tersimpan di kolom pesan.",
    attachError: "File belum bisa dipilih",
    attach: "Lampirkan file",
    inputLabel: (target: string) => `Pesan untuk ${target}`,
    placeholder: (target: string) => `Tulis pesan ke ${target}`,
    hint: "Enter untuk mengirim, Shift+Enter untuk baris baru, ketik @ untuk menyebut rekan.",
    mentionList: "Sebut rekan",
    sending: "Mengirim...",
    send: "Kirim",
  },

  status: {
    button: (state: string) => `Status: ${state}. Lihat rincian per orang`,
    popLabel: "Status pesan per orang",
    popTitle: "Status pesan",
    loading: "Memuat status...",
    error: "Status belum bisa dimuat.",
    empty: "Belum ada penerima.",
  },

  file: {
    openError: "File belum bisa dibuka",
    saveError: "File belum tersimpan",
    downloadError: "File belum bisa diunduh",
    downloading: "Mengunduh...",
    openLabel: (name: string) => `Buka ${name}`,
    opening: "Membuka...",
    open: "Buka",
    saving: "Menyimpan...",
    downloadLabel: (name: string) => `Unduh ${name}`,
    download: "Unduh",
    missing: "Belum tersedia. File diunduh otomatis saat laptop rekan yang menyimpannya online.",
    saved: (name: string) => `${name} tersimpan.`,
  },
};

export default id;
