// Teks layar Dokumen (src/screens/docs). Sumber kebenaran; pasangannya docs.en.ts.
const LIBRARY = "Pustaka Umum";

const id = {
  // Lokasi: Pustaka Umum (null) atau satu proyek ("<KODE> <nama>").
  library: LIBRARY,
  // Lokasi di tengah kalimat.
  place: (label: string | null) => (label === null ? LIBRARY : `proyek ${label}`),
  addedCount: (n: number) => `${n} file`,
  added: (what: string, place: string) => `${what} ditambahkan ke ${place}.`,
  emptyTitle: (label: string | null) =>
    label === null ? `${LIBRARY} masih kosong` : `Belum ada file di proyek ${label}`,
  visibility: (label: string | null) =>
    label === null
      ? `File di ${LIBRARY} terlihat oleh semua anggota organisasi, kecuali Tamu.`
      : `File di proyek ${label} hanya terlihat oleh anggota proyek itu.`,
  gone: (label: string) => `Proyek ${label} tidak tersedia lagi untuk Anda.`,
  showing: (place: string) => `Menampilkan ${place}.`,

  guestNoProjectTitle: "Belum ada proyek yang bisa Anda buka",
  guestNoProjectText:
    "Sebagai Tamu, Anda hanya melihat file di proyek tempat Anda diundang. Minta pengelola proyek menambahkan Anda.",
  guestEmptyText:
    "File yang ditambahkan anggota proyek muncul di sini. Tamu bisa membuka file, tetapi tidak menambahkannya.",

  // Saya sebagai penulis versi: di awal baris dan di tengah kalimat.
  you: "Anda",
  youInline: "Anda",

  yesterdayAt: (time: string) => `kemarin ${time}`,
  dateAt: (date: string, time: string) => `${date} ${time}`,

  versionOne: (n: number | string) => `versi ${n}`,
  versionTwo: (a: number, b: number) => `versi ${a} dan ${b}`,
  versionMany: (head: string, last: number) => `versi ${head}, dan ${last}`,

  fetch: {
    copying: "Isinya sedang disalin dari laptop rekan.",
    waiting: "Isinya disalin otomatis begitu laptop rekan yang menyimpannya tersambung.",
    manual: "File di atas 20 MB tidak disalin otomatis. Unduh kalau Anda perlu membukanya.",
  },
  downloadLabel: (size: string) => `Unduh dari rekan (${size})`,

  // Menu klik kanan dan tombol "..." di baris file.
  menuLabel: (name: string) => `Aksi untuk ${name}`,
  menuButtonLabel: (name: string) => `Aksi lain untuk ${name}`,
  openReadOnly: "Buka hanya baca",
  history: "Lihat riwayat versi",
  exportCopy: "Simpan salinan",
  copyName: "Salin nama",
  waitReason: "Tunggu aksi lain selesai",
  copyFailedTitle: "Nama file belum bisa disalin",
  clipboardMissing: "Papan klip tidak tersedia di jendela ini.",
  copied: (name: string) => `Nama ${name} disalin.`,

  exportBlocked: {
    copying: "Isinya masih disalin dari laptop rekan",
    waiting: "Isinya menunggu laptop rekan tersambung",
    manual: "Unduh dulu isinya dari rekan",
  },

  // Baris status di daftar file.
  status: {
    conflict: (list: string) => `Bentrok: ${list} tersimpan berdampingan`,
    mine: (app: string | null, since: string) => `Sedang Anda edit${app ? ` di ${app}` : ""} sejak ${since}`,
    rekan: (name: string, since: string) => `Sedang diedit ${name} sejak ${since}`,
    added: (n: number, who: string, when: string) => `Versi ${n} · Ditambahkan ${who} ${when}`,
    edited: (n: number, who: string, when: string) => `Versi ${n} · Diubah ${who} ${when}`,
    copying: (n: number) => `Versi ${n} sedang disalin dari laptop rekan`,
    waiting: (n: number) => `Versi ${n} menunggu laptop rekan tersambung`,
    manual: (n: number, size: string) => `Versi ${n} belum diunduh (${size})`,
  },

  origin: {
    added: "Ditambahkan",
    savedFrom: (app: string) => `Disimpan dari ${app}`,
    saved: "Disimpan",
    restoredFrom: (n: number) => `Dipulihkan dari versi ${n}`,
    restoredOld: "Dipulihkan dari versi lama",
    resolved: "Bentrok diselesaikan",
  },

  notAvailable: "Belum ada laptop rekan yang tersambung dan menyimpan file ini.",

  errorTitle: {
    forbidden: "Anda tidak punya izin untuk ini",
    notFound: "File atau versi ini sudah tidak ada",
    download: "File belum bisa diunduh",
    add: "File belum bisa ditambahkan",
    edit: "File belum bisa dibuka untuk diedit",
    finish: "Edit belum bisa diselesaikan",
    open: "File belum bisa dibuka",
    restore: "Versi belum bisa dipulihkan",
    resolve: "Bentrok belum bisa diselesaikan",
    export: "Salinan belum bisa disimpan",
  },

  errorHint: {
    finishEditing: "Tutup file di Word atau Excel dulu, lalu tekan Selesai mengedit lagi.",
    editingRetry: "File ini sedang diedit. Selesaikan edit dulu, lalu coba lagi.",
    editingWait: "File ini sedang diedit. Tunggu sampai editnya selesai.",
    notAvailable: "Coba lagi saat laptop rekan yang menyimpan versi ini menyala dan tersambung ke Mira.",
    notFound: "Daftar file sudah dimuat ulang. Periksa lagi sebelum mencoba.",
    openFailed: "Pastikan Microsoft Office atau aplikasi untuk jenis file ini terpasang di laptop ini.",
  },

  // Layar utama (DocsScreen).
  screen: {
    title: "Dokumen",
    location: "Lokasi",
    addFile: "Tambah file",
    adding: "Menambahkan...",
    loadingProjects: "Memuat daftar proyek...",
    projectsError: (message: string) => `Daftar proyek belum terbaca (${message}).`,
    libraryStillUsable: `${LIBRARY} tetap bisa dipakai.`,
    retryProjects: "Baca daftar proyek lagi",
    staleList: (message: string) =>
      `Daftar terbaru belum bisa dibaca (${message}). Yang tampil adalah data terakhir.`,
    loadingDocs: "Memuat daftar dokumen...",
    listErrorTitle: "Daftar dokumen belum terbaca",
    listMissing: "Inti Mira tidak mengirim daftar dokumen.",
    retryRead: "Coba baca lagi",
    emptyBody:
      "Tambahkan file Word, Excel, PDF, atau jenis lain. Setiap kali file Word atau Excel disimpan, Mira mencatat versi baru, jadi versi lama tetap bisa dibuka dan dipulihkan.",
    listLabel: (place: string) => `File di ${place}`,
  },

  // Hasil aksi, tampil di atas daftar.
  done: {
    copyingNow: (n: number) => `Versi ${n} sedang disalin. Daftar diperbarui begitu selesai.`,
    downloaded: (n: number, name: string) => `Isi versi ${n} dari ${name} sudah ada di laptop ini.`,
    defaultApp: "aplikasi bawaan",
    editConflict: (n: number, app: string) =>
      `Versi ${n} dibuka di ${app}. Gabungkan isinya, lalu simpan untuk menyelesaikan bentrok.`,
    editOpened: (name: string, app: string) =>
      `${name} dibuka di ${app}. Setiap kali Anda menyimpan, Mira mencatat versi baru.`,
    finished: (name: string) => `Selesai mengedit ${name}. Rekan sekarang bisa mengeditnya.`,
    openedReadOnly: (name: string, n: number) => `${name} versi ${n} dibuka hanya baca.`,
    exported: (n: number, destination: string) => `Salinan versi ${n} disimpan di ${destination}.`,
    resolved: (current: number, kept: number) => `Bentrok selesai. Versi ${current} berisi isi versi ${kept}.`,
    restored: (from: number, to: number) => `Versi ${from} dipulihkan menjadi versi ${to}.`,
  },

  // Dialog Pulihkan versi.
  restore: {
    titleOf: (n: number) => `Pulihkan versi ${n}?`,
    title: "Pulihkan versi",
    confirmOf: (n: number) => `Pulihkan versi ${n}`,
    confirm: "Pulihkan",
    busy: "Memulihkan...",
    body: (n: number, name: string) =>
      `Mira membuat versi baru berisi isi versi ${n} dari ${name}. Semua versi lain tetap ada di riwayat.`,
    conflict: "Bentrok di file ini juga selesai, karena versi baru menggantikan semua versi yang berdampingan.",
  },

  // Panel detail (DocumentDetail).
  detail: {
    sub: (count: number, size: string) => `${count} versi · ${size}`,
    conflictTitle: (n: number) => `${n === 2 ? "Dua" : String(n)} versi tersimpan berdampingan`,
    conflictBody: (list: string, canMerge: boolean) =>
      `${list} dibuat terpisah, misalnya saat salah satu laptop tidak tersambung, jadi Mira menyimpan semuanya. Pilih versi yang dipakai${canMerge ? ", atau gabungkan isinya sendiri" : ""}.`,
    headTitle: (n: number, who: string) => `Versi ${n} dari ${who}`,
    headPickLater: "Versi ini bisa dipilih setelah isinya ada di laptop ini.",
    mergeNote: (app: string | null) =>
      `Gabung manual membuka versi itu di ${app ?? ""}. Salin bagian yang perlu dari versi lain, lalu simpan. Begitu Anda menyimpan, bentrok selesai.`,
    noResolve: "Anda tidak punya izin memilih versi. Minta rekan yang bisa mengedit file ini untuk memilihnya.",
    downloadAria: (n: number, size: string) => `Unduh versi ${n} dari rekan, ${size}`,
    downloading: "Mengunduh...",
    useThis: "Pakai versi ini",
    useThisAria: (n: number) => `Pakai versi ini (versi ${n})`,
    savingChoice: "Menyimpan pilihan...",
    mergeManual: "Gabung manual",
    mergeAria: (n: number) => `Gabung manual dari versi ${n}`,
    opening: "Membuka...",
    open: "Buka",
    openAria: (n: number) => `Buka versi ${n}`,
    version: (n: number) => `Versi ${n}`,
    current: "Sekarang",
    exportAria: (n: number) => `Simpan salinan versi ${n}`,
    saving: "Menyimpan...",
    history: "Riwayat versi",
    restoreAfterFinish: "Versi lama bisa dipulihkan setelah Anda menekan Selesai mengedit.",
    loadingHistory: "Memuat riwayat versi...",
    historyErrorTitle: "Riwayat versi belum terbaca",
    staleHistory: (message: string) =>
      `Riwayat terbaru belum bisa dibaca (${message}). Yang tampil adalah data terakhir.`,
    historyLabel: (name: string) => `Riwayat versi ${name}`,
  },

  // Tombol di baris file (DocumentRow).
  row: {
    reopen: "Buka lagi",
    finish: "Selesai mengedit",
    finishing: "Menyelesaikan...",
    resolveConflict: "Selesaikan bentrok",
    viewConflict: "Lihat bentrok",
    editIn: (app: string | null) => `Edit di ${app}`,
  },
};

export default id;
