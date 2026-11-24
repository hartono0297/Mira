// Teks dialog Minta tanda tangan, Periksa file PDF, dan jejak audit.
const id = {
  newRequest: {
    title: "Minta tanda tangan",
    signersMax: (max: number) =>
      `Paling banyak ${max} penanda tangan per permintaan. Hapus centang satu nama dulu untuk memilih yang lain.`,
    droppedGuest: (who: string) =>
      `Mira melepas ${who} dari penanda tangan karena Tamu hanya bisa menandatangani dokumen di proyek yang boleh ia buka.`,
    droppedProject: (who: string, many: boolean) =>
      `Mira melepas ${who} dari penanda tangan karena ${many ? "mereka" : "ia"} tidak bisa membuka proyek ini.`,
    and: "dan",
    oneSigner: "Satu penanda tangan",
    titleEmpty: "Isi judul dokumen.",
    titleTooLong: (max: number) => `Judul paling panjang ${max} karakter.`,
    signersEmpty: "Pilih minimal satu penanda tangan.",
    titleLabel: "Judul dokumen",
    titleHint: (max: number) => `Tampil di daftar dan di halaman catatan PDF. Paling panjang ${max} karakter.`,
    projectLabel: "Proyek",
    noProject: "Tanpa proyek",
    projectHint: "Tamu hanya bisa dipilih untuk proyek yang boleh ia buka. Tanpa proyek, pilihannya anggota saja.",
    projectsLoading: "Memuat daftar proyek...",
    projectsError: (message: string) =>
      `Daftar proyek belum terbaca (${message}). Permintaan tetap bisa dibuat tanpa proyek.`,
    projectsRetry: "Baca daftar proyek lagi",
    signersLegend: "Penanda tangan",
    signersHint: (max: number, chosen: number) => `Paling banyak ${max} orang. Dipilih ${chosen}.`,
    membersLoading: "Memuat daftar anggota...",
    membersError: "Daftar anggota belum terbaca",
    retry: "Coba lagi",
    noMembersProject: "Belum ada anggota yang boleh membuka proyek ini.",
    noMembers: "Belum ada anggota di direktori laptop ini.",
    me: (name: string) => `${name} (Anda)`,
    modeLegend: "Cara menandatangani",
    order: "Urutan",
    moveUp: "Naikkan",
    moveDown: "Turunkan",
    moveUpAria: (name: string) => `Naikkan ${name}`,
    moveDownAria: (name: string) => `Turunkan ${name}`,
    sendNote: "Dikirim ke penanda tangan saat laptop mereka tersambung. Sampai saat itu, permintaan tersimpan di laptop ini.",
    saveError: "Permintaan belum dibuat",
    cancel: "Batal",
    creating: "Membuat permintaan...",
    create: "Buat permintaan",
  },

  verify: {
    title: "Periksa file PDF",
    description:
      "Cocokkan PDF yang Anda terima atau simpan dengan catatan tanda tangan di laptop ini. File tidak disimpan.",
    notSigned: "Belum menandatangani",
    fileHash: "sidik file",
    finalTitle: "File ini asli: sama persis dengan dokumen yang selesai ditandatangani",
    completed: (when: string) => `Selesai ${when}`,
    versionTitle: "File ini sama dengan salah satu versi yang tercatat",
    versionCompleted: (when: string) =>
      `Dokumen ini selesai ditandatangani ${when}, tetapi file ini versi sebelum semua tanda tangan lengkap. Versi final ada di Mira.`,
    versionOpen:
      "Penandatanganan dokumen ini belum selesai. File ini hanya memuat tanda tangan yang sudah ada saat versi ini dibuat.",
    versionSigners: "Sudah menandatangani di versi ini:",
    versionNoSigners: "Versi ini belum memuat tanda tangan siapa pun.",
    changedTitle: "File ini berubah setelah ditandatangani di Mira",
    changedOriginal: (title: string) => `Dokumen aslinya: ${title}`,
    changedBody:
      "Isinya tidak sama dengan versi mana pun yang tercatat. Jangan pakai file ini sebagai bukti. Pakai salinan yang disimpan dari Mira.",
    unknownTitle: "Mira tidak mengenali file ini",
    unknownBody:
      "Tidak ada catatan untuk file ini di laptop ini. Bisa jadi file ini dari laptop lain, belum pernah ditandatangani di Mira, atau sudah diubah sampai tidak dikenali lagi.",
    checking: "Memeriksa...",
    checkAnother: "Periksa file lain",
    pick: "Pilih file PDF",
    errorTitle: "File belum bisa diperiksa",
    openDoc: "Buka dokumen",
    close: "Tutup",
  },

  audit: {
    title: "Jejak audit",
    count: (n: number) => `${n} catatan`,
    invalid: (n: number) => `, ${n} tidak cocok`,
    warnings: (n: number) => `, ${n} perlu diperhatikan`,
    empty: "Belum ada catatan untuk permintaan ini.",
    noName: "Tanpa nama",
    duringRequest:
      "Terjadi saat permintaan ini berjalan. Pastikan pemilik tanda tangan memang melakukannya sendiri.",
    hashBefore: "Sidik file sebelum",
    hashAfter: "Sidik file sesudah",
    hash: "Sidik file",
    valid: "Catatan sah",
    invalidRecord: "Tanda tangan catatan tidak cocok. Catatan ini mungkin diubah di luar Mira.",
  },
};

export default id;
