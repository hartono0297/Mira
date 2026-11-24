// Teks layar daftar Tanda tangan (SignScreen).
const id = {
  title: "Tanda tangan",
  subWaiting: (n: number) => `${n} dokumen menunggu tanda tangan Anda`,
  subIdle: "PDF yang ditandatangani di laptop ini",
  loading: "Memuat tanda tangan dan daftar dokumen...",
  incompleteData: "Inti Mira mengirim data tanda tangan yang tidak lengkap.",
  loadErrorTitle: "Daftar tanda tangan belum terbaca",
  loadErrorFallback: "Inti Mira tidak mengirim data tanda tangan.",
  retry: "Coba lagi",
  staleData: (message: string) => `Data terbaru belum bisa dibaca (${message}). Yang tampil adalah data terakhir.`,

  waitingTitle: "Menunggu tanda tangan Anda",
  waitingHint: "Permintaan dari rekan yang mencantumkan nama Anda. Giliran Anda tampil paling atas.",

  mine: {
    title: "Tanda tangan saya",
    savedSince: (when: string) => `Tersimpan sejak ${when}, dipakai dengan PIN`,
    cooling: (when: string) =>
      `Bisa dipakai mulai ${when}, 24 jam setelah tanda tangan sebelumnya dihapus tanpa PIN.`,
    locked: (when: string) => `Terkunci sementara sampai ${when} karena PIN salah beberapa kali.`,
    failed: (failed: number, left: number) =>
      `PIN salah ${failed} kali sejak terakhir benar. Sisa ${left} percobaan sebelum terkunci sementara.`,
    noneTitle: "Belum ada tanda tangan tersimpan",
    noneHint:
      "Gambar dengan mouse atau pena, atau pakai foto tanda tangan. Gambar disimpan terkunci dan hanya bisa dipakai dengan PIN Anda.",
    delete: "Hapus tanda tangan",
    create: "Buat tanda tangan",
  },

  row: {
    menuLabel: (title: string) => `Aksi untuk ${title}`,
    moreLabel: (title: string) => `Aksi lain untuk ${title}`,
    requestedBy: (name: string) => `Diminta oleh ${name}`,
    signedOf: (signed: number, total: number) => `${signed} dari ${total} sudah tanda tangan`,
    completedAt: (when: string) => `selesai ${when}`,
    changedAt: (when: string) => `terakhir berubah ${when}`,
    downloadingAria: (title: string) => `Mengunduh file ${title}`,
    downloadAria: (title: string, size: string) => `Unduh file ${title}${size}`,
    downloading: "Mengunduh...",
  },

  docs: {
    title: "Dokumen",
    verify: "Periksa file PDF",
    reading: "Membaca PDF...",
    pick: "Pilih PDF untuk ditandatangani",
    guest:
      "Sebagai Tamu, Anda tidak bisa meminta tanda tangan, tetapi bisa menandatangani dokumen dari rekan untuk proyek yang boleh Anda buka.",
    warnTitle: (n: number) => `${n === 1 ? "Satu dokumen" : `${n} dokumen`} perlu diperiksa`,
    warnBody: "Ada file yang berubah atau hilang setelah ditandatangani. Rinciannya ada di baris bertanda peringatan.",
    emptyOthers: "Dokumen lain yang Anda kirim atau sudah Anda tanda tangani muncul di sini.",
    emptyRequester:
      "Belum ada dokumen. Pilih PDF untuk ditandatangani sendiri atau bersama rekan. Permintaan dikirim ke penanda tangan saat laptop mereka tersambung.",
    emptySigner:
      "Belum ada dokumen untuk Anda tanda tangani. Permintaan dari rekan muncul di sini begitu laptop pengirimnya tersambung.",
  },

  feedback: {
    saved: "Tanda tangan tersimpan. Mira akan meminta PIN setiap kali Anda memakainya.",
    deletedWithPin: "Tanda tangan tersimpan sudah dihapus. Tanda tangan baru bisa langsung dibuat dan dipakai.",
    deletedWithoutPin:
      "Tanda tangan tersimpan sudah dihapus. Tanda tangan baru bisa dibuat sekarang dan dipakai 24 jam setelah penghapusan ini.",
    pdfError: "PDF belum bisa dibuka",
    copying: (title: string) => `File ${title} sedang disalin. Daftar diperbarui begitu selesai.`,
    downloaded: (title: string) => `File ${title} sudah ada di laptop ini.`,
    downloadError: "File belum bisa diunduh",
    exported: (title: string, path: string) => `Salinan ${title} tersimpan di ${path}`,
    exportError: "Salinan belum tersimpan",
    cancelled: (title: string) => `Permintaan ${title} dibatalkan.`,
  },

  pinDelete: {
    title: "Hapus tanda tangan tersimpan?",
    description:
      "Masukkan PIN tanda tangan Anda. Gambar tanda tangan dan PIN-nya dihapus dari laptop ini, dokumen yang sudah Anda tanda tangani tidak berubah. Tanda tangan baru bisa langsung dibuat dan dipakai.",
    submit: "Hapus tanda tangan",
    forgot: "Lupa PIN?",
  },

  forgot: {
    title: "Hapus tanda tangan tanpa PIN?",
    confirm: "Hapus tanpa PIN",
    busy: "Menghapus...",
    errorTitle: "Tanda tangan belum terhapus",
    body1: "Gambar tanda tangan dan PIN-nya dihapus dari laptop ini. Dokumen yang sudah Anda tanda tangani tidak berubah.",
    body2:
      "Tanda tangan baru yang Anda buat setelah ini baru bisa dipakai 24 jam setelah penghapusan. Masa tunggu ini mencegah orang lain yang memakai laptop Anda saat tidak terkunci menghapus tanda tangan Anda, lalu menandatangani dengan PIN buatannya sendiri.",
    body3: "Penghapusan ini tercatat di jejak audit.",
  },
};

export default id;
