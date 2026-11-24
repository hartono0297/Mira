// Teks dialog chat: channel, pesan pribadi, grup (baru, anggota, tambah orang, ganti nama),
// notifikasi, pemilih orang, dan anggota chat proyek.
const id = {
  common: {
    cancel: "Batal",
    close: "Tutup",
  },
  // Panel anggota grup dan proyek.
  members: {
    loading: "Memuat anggota...",
    loadFailed: "Daftar anggota belum bisa dimuat",
    retry: "Coba lagi",
    retrying: "Memuat ulang...",
    stale: "Daftar terbaru belum bisa dimuat. Yang tampil adalah daftar terakhir.",
  },
  newChannel: {
    title: "Channel umum baru",
    description: "Semua anggota kantor bisa membaca dan menulis di channel umum, kecuali Tamu.",
    nameLabel: "Nama channel",
    // Diikuti pratinjau nama, misalnya #pengumuman.
    previewAs: "Tampil sebagai ",
    rules: (max: number) =>
      `Huruf kecil, angka, dan tanda hubung. Spasi jadi tanda hubung. Paling banyak ${max} karakter.`,
    nameNoChars: "Nama ini tidak menyisakan huruf atau angka. Pakai huruf a sampai z atau angka.",
    nameEmpty: "Tulis nama channel dulu.",
    lockHint:
      "Channel untuk pengumuman bisa Anda jadikan hanya-baca lewat menu channel setelah dibuat. Setelah itu hanya superadmin yang bisa menulis di sana.",
    forbidden: "Hanya superadmin yang bisa membuat channel umum",
    failed: "Channel belum dibuat",
    creating: "Membuat channel...",
    create: "Buat channel",
  },
  newDirect: {
    title: "Pesan baru",
    description: "Pilih rekan untuk chat pribadi. Hanya Anda berdua yang bisa membacanya.",
    noPeople: "Belum ada rekan lain di kantor ini. Undang rekan dari menu Organisasi, lalu chat pribadi bisa dimulai.",
    searchLabel: "Cari rekan",
    count: (n: number) => `${n} rekan`,
    listLabel: "Rekan",
    opening: "Membuka...",
    noMatch: (query: string) => `Tidak ada rekan bernama "${query}".`,
    failed: "Chat pribadi belum terbuka",
  },
  newGroup: {
    title: "Grup baru",
    description:
      "Grup untuk percakapan dengan beberapa rekan dari departemen mana pun. Hanya anggota grup yang menerima pesannya.",
    nameLabel: "Nama grup",
    nameEmpty: "Isi nama grup.",
    nameTooLong: (max: number) => `Nama grup paling panjang ${max} karakter.`,
    pickTooMany: (max: number) => `Paling banyak ${max} orang sekaligus.`,
    empty: "Belum ada rekan lain yang bisa dimasukkan ke grup. Tamu tidak bisa dimasukkan ke grup.",
    hintNone:
      "Belum ada yang dipilih. Grup bisa dibuat berisi Anda saja, lalu tambah orang belakangan. Tamu tidak bisa dimasukkan ke grup.",
    hintSome: (n: number) => `${n} orang dipilih, ditambah Anda. Tamu tidak bisa dimasukkan ke grup.`,
    failed: "Grup belum dibuat",
    creating: "Membuat grup...",
    create: "Buat grup",
  },
  groupMembers: {
    button: (n: number) => `Grup · ${n} anggota`,
    panelTitle: (n: number) => `Anggota grup (${n})`,
    empty: "Belum ada anggota yang tercatat di grup ini.",
    owner: "Pemilik grup",
    remove: "Keluarkan",
    removeLabel: (name: string) => `Keluarkan ${name} dari grup`,
    removeFailed: (name: string) => `${name} belum dikeluarkan`,
  },
  addPeople: {
    title: (group: string) => `Tambah orang ke ${group}`,
    pickNone: "Pilih minimal satu orang.",
    empty: "Semua rekan yang bisa dimasukkan sudah ada di grup ini. Tamu tidak bisa dimasukkan ke grup.",
    hintNone: "Orang yang ditambahkan bisa membaca pesan lama di grup ini.",
    hintSome: (n: number) => `${n} orang dipilih. Orang yang ditambahkan bisa membaca pesan lama di grup ini.`,
    failed: "Orang belum ditambahkan",
    adding: "Menambahkan...",
    add: "Tambah ke grup",
  },
  renameGroup: {
    title: "Ganti nama grup",
    description: "Nama baru terlihat oleh semua anggota grup.",
    failed: "Nama grup belum diganti",
    saving: "Menyimpan...",
    save: "Simpan nama",
  },
  notify: {
    title: "Notifikasi chat",
    description: (system: string) =>
      `Notifikasi muncul di ${system} saat jendela Mira tidak sedang di depan. Pengaturan ini hanya untuk laptop ini.`,
    legend: "Kirim notifikasi untuk",
    all: {
      label: "Semua pesan baru",
      desc: "Setiap pesan dari rekan, kecuali di percakapan yang Anda bisukan.",
    },
    mentions: {
      label: "Hanya chat pribadi dan yang menyebut saya",
      desc: "Pesan di channel muncul hanya kalau nama Anda disebut dengan @.",
    },
    off: {
      label: "Mati",
      desc: "Tidak ada notifikasi. Pesan baru tetap terlihat di daftar chat.",
    },
    saved: (label: string) => `Tersimpan: ${label}.`,
    failed: "Pengaturan notifikasi belum tersimpan",
    reverted: "Pilihan dikembalikan seperti semula. Coba pilih lagi.",
  },
  picker: {
    label: "Pilih orang",
    placeholder: "Cari nama",
    shown: (n: number) => `${n} rekan ditampilkan`,
    deptFilter: "Saring menurut departemen",
    allDepts: "Semua",
    listLabel: "Rekan",
    chosenLabel: "Orang yang dipilih",
    removeChip: (name: string) => `Hapus ${name} dari pilihan`,
    noMatch: (query: string) => `Tidak ada rekan bernama "${query}".`,
    noneInDept: "Tidak ada rekan di departemen ini.",
  },
  projectMembers: {
    button: (n: number) => `Proyek · ${n} anggota`,
    panelTitle: (n: number) => `Anggota proyek (${n})`,
    empty: "Proyek ini belum punya anggota di Board.",
    manager: "Pengelola proyek",
    always: "Anggota chat ini selalu sama dengan anggota proyek.",
    former: "Anda sudah bukan anggota proyek ini, jadi pesan baru tidak sampai lagi ke laptop Anda.",
    canManage: "Untuk menambah atau mengeluarkan orang, buka Anggota proyek di Board.",
    managed: "Pengelola proyek yang mengatur anggotanya di Board.",
  },
};

export default id;
