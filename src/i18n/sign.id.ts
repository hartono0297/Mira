// Teks tampilan tanda tangan PDF: label bersama (labels.ts), alur menandatangani
// (signFlow.ts), dan pesan error stempel (stamp.ts). Teks yang ditulis ke PDF
// (stempel, halaman catatan) TIDAK ada di sini: tetap di stamp.ts, selalu
// Indonesia, karena menjadi bagian dokumen bertanda tangan.
const id = {
  myState: {
    your_turn: "Giliran Anda",
    waiting_others: "Menunggu orang lain",
    signed: "Sudah Anda tanda tangani",
    not_involved: "Anda bukan penanda tangan",
  },
  status: {
    in_progress: "Berjalan",
    completed: "Selesai, terkunci",
    cancelled: "Dibatalkan",
  },
  requestState: {
    waitingFile: "Menunggu file",
    waitingPeer: "Menunggu tanda tangan rekan",
    cannotSign: "Tidak bisa ditandatangani",
    waitingSigners: "Menunggu penanda tangan",
  },
  headerProgress: (status: string, signed: number, total: number) => `${status}, ${signed} dari ${total} sudah tanda tangan`,
  sealInvalid: "Selesai, kunci tidak sah",
  mode: {
    sequential: "Berurutan",
    parallel: "Bebas",
  },
  modeHint: {
    sequential: "Satu per satu sesuai urutan. Orang berikutnya baru bisa menandatangani setelah giliran sebelumnya selesai.",
    parallel: "Siapa saja boleh lebih dulu. Dokumen selesai setelah semua menandatangani.",
  },
  kind: {
    guest: "Tamu",
    member: "Anggota",
  },
  events: {
    created: "Permintaan dibuat",
    signed: "Menandatangani",
    completed: "Semua selesai, dokumen dikunci",
    cancelled: "Permintaan dibatalkan",
    exported: "Salinan PDF disimpan ke luar Mira",
    signature_saved: "Membuat tanda tangan baru",
    signature_deleted: "Menghapus tanda tangan",
  },
  eventOther: (kind: string) => `Catatan lain (${kind})`,
  integrity: {
    intact: "Isi file utuh",
    changed: "Isi file tidak cocok dengan catatan Mira",
    missing: "File hilang dari penyimpanan Mira",
  },
  exportState: {
    intact: "Utuh",
    changed: "Berubah",
    missing: "Tidak ditemukan",
  },
  exportWarningMany: (count: number) => `${count} salinan PDF yang disimpan di luar Mira berubah`,
  exportWarningOne: "Salinan PDF yang disimpan di luar Mira berubah",
  fileNeed: {
    downloadingNewer: "Tanda tangan terbaru dari rekan sedang disalin ke laptop ini",
    downloading: "File sedang disalin dari laptop rekan",
    autoNewer: "Tanda tangan terbaru dari rekan disalin otomatis saat laptop rekan yang menyimpannya tersambung.",
    auto: "File disalin otomatis saat laptop rekan yang menyimpannya tersambung.",
    whyUnknown: "Ukurannya belum diketahui, jadi tidak disalin otomatis.",
    whyLarge: "File di atas 20 MB tidak disalin otomatis.",
    newer: (why: string) => `Versi bertanda tangan terbaru belum diunduh. ${why}`,
    unknownSize: (why: string) => `File ini belum diunduh. ${why}`,
    sized: (size: string, why: string) => `File ${size} belum diunduh. ${why}`,
  },
  download: "Unduh file",
  downloadSized: (size: string) => `Unduh file (${size})`,
  cancelConfirm: {
    title: "Batalkan permintaan ini?",
    confirmLabel: "Batalkan permintaan",
    busyLabel: "Membatalkan...",
    body: "Penanda tangan yang belum menandatangani tidak bisa menandatangani lagi. Tanda tangan yang sudah ada tetap tercatat di jejak audit. Pembatalan tidak bisa diurungkan.",
  },
  rowMenu: {
    open: "Buka",
    sign: "Tandatangani",
    export: "Simpan salinan PDF",
    verify: "Periksa keaslian file",
    cancel: "Batalkan permintaan",
    notYourTurn: "Belum giliran Anda",
    fileAbsent: "File belum ada di laptop ini",
    fileChanged: "Isi file tidak cocok dengan catatan Mira",
    fileMissing: "File dokumen tidak ditemukan",
    waitingPeer: "Menunggu tanda tangan terbaru dari rekan",
    exporting: "Sedang menyimpan salinan",
    downloading: "Sedang mengunduh",
    otherDownload: "Tunggu unduhan lain selesai",
  },
  signError: {
    version_not_prefix:
      "Mira menolak hasil tanda tangan ini karena isi versi sebelumnya tidak utuh di dalamnya. Tanda tangan hanya boleh ditambahkan di belakang isi lama. Coba lagi. Kalau tetap ditolak, minta pengirim membuat permintaan baru.",
    version_changes_content:
      "Mira menolak hasil tanda tangan ini karena mengubah isi dokumen selain stempel tanda tangan. Coba lagi. Kalau tetap ditolak, minta pengirim membuat permintaan baru.",
    not_available:
      "Belum ada laptop rekan yang tersambung dan menyimpan file ini. Coba lagi saat laptop rekan yang menyimpannya menyala dan tersambung ke Mira.",
  },
  reject: {
    version_changes_content: (n: string) =>
      `Versi dari ${n} ditolak karena mengubah isi dokumen, bukan hanya menambah tanda tangan.`,
    version_not_prefix: (n: string) =>
      `Versi dari ${n} ditolak karena isi dokumen sebelumnya tidak utuh di dalamnya. Tanda tangan hanya boleh ditambahkan di belakang isi lama.`,
    pdf_invalid: (n: string) =>
      `Versi dari ${n} ditolak karena Mira tidak bisa membaca atau memeriksa file PDF-nya.`,
    tag_missing: (n: string) => `Versi dari ${n} ditolak karena file itu bukan untuk dokumen ini.`,
    skipped_concurrent: (n: string, other: string | null) =>
      `Versi dari ${n} tidak dipakai karena ${other ?? "penanda tangan lain"} menandatangani versi yang sama lebih dulu. ${n} perlu menandatangani versi terbaru.`,
    on_rejected: (n: string) =>
      `Versi dari ${n} ditolak karena ditandatangani di atas versi lain yang sudah ditolak.`,
    outdated_version: (n: string) =>
      `Versi dari ${n} tidak dipakai karena ditandatangani di atas versi lama dokumen.`,
    not_allowed: (n: string) => `Versi dari ${n} ditolak karena ${n} bukan penanda tangan dokumen ini.`,
    not_your_turn: (n: string) => `Versi dari ${n} ditolak karena dibuat sebelum giliran ${n}.`,
    already_signed: (n: string) =>
      `Versi dari ${n} tidak dipakai karena ${n} sudah menandatangani versi lain dokumen ini.`,
    request_closed: (n: string) =>
      `Versi dari ${n} tidak dipakai karena dokumen sudah selesai ditandatangani.`,
    invalid_record: (n: string) => `Versi dari ${n} ditolak karena catatan tanda tangannya tidak lengkap.`,
  },
  rejectFallback: (name: string) => `Versi dari ${name} tidak dipakai Mira.`,
  colleague: "rekan",
  exportNotice: (count: number) =>
    `${count > 1 ? `${count} salinan` : "Satu salinan"} yang disimpan di luar Mira berubah. Rinciannya ada di bagian Salinan PDF.`,
  cooling: (when: string) =>
    `Tanda tangan baru Anda bisa dipakai mulai ${when}, karena tanda tangan sebelumnya dihapus tanpa PIN.`,
  size: {
    bytes: (n: number) => `${n} byte`,
  },
  checkPdf: {
    notPdf: "File ini bukan PDF. Pilih file berakhiran .pdf.",
    empty: "File ini kosong.",
    tooLarge: "File lebih dari 50 MB. Mira menerima PDF sampai 50 MB.",
  },
  // Posisi kotak tanda tangan di halaman, dari describeSpot.
  spot: {
    left: "kiri",
    right: "kanan",
    top: "atas",
    bottom: "bawah",
    center: "tengah",
    // Posisi tengah mendatar dengan arah tegak, mis. "tengah atas".
    centerV: (vert: string) => `tengah ${vert}`,
    // Arah mendatar dengan tengah tegak, mis. "kiri tengah".
    centerH: (h: string) => `${h} tengah`,
    corner: (h: string, vert: string) => `${h} ${vert}`,
  },
  flow: {
    stampFailed: "Tanda tangan belum bisa ditempel ke PDF.",
    auditFailed: "Halaman catatan belum bisa ditambahkan.",
    saveFailed: "PDF bertanda tangan belum tersimpan.",
    auditIncomplete: (name: string) =>
      `${name} belum tercatat menandatangani, jadi halaman catatan belum bisa dibuat. Muat ulang dokumen lalu coba lagi.`,
  },
  // Pesan error dari stamp.ts yang tampil di layar (bukan isi PDF).
  stamp: {
    invalidTime: "Waktu tanda tangan tidak valid.",
    encrypted:
      "PDF ini dilindungi kata sandi pemilik, jadi Mira tidak bisa menambahkan tanda tangan. Simpan ulang tanpa perlindungan di aplikasi asalnya, lalu coba lagi.",
    notPdf: "File ini bukan PDF atau rusak, jadi tidak bisa ditandatangani.",
    broken:
      "PDF ini rusak atau formatnya tidak didukung, jadi Mira tidak bisa menambahkan tanda tangan. Simpan ulang dari aplikasi asalnya, lalu coba lagi.",
    invalidDocTag: "Kode dokumen tidak valid.",
    imageNotTransparent:
      "Gambar tanda tangan ini tidak berlatar transparan, jadi bisa menutup tulisan di dokumen. Gambar ulang tanda tangan, atau impor foto tanda tangan di atas kertas putih.",
    imageDense:
      "Lebih dari separuh gambar tanda tangan ini tertutup tinta, jadi bisa menutup tulisan di dokumen. Gambar ulang dengan goresan yang lebih tipis, atau impor foto tanda tangan di atas kertas putih.",
    imageCover:
      "Gambar tanda tangan ini punya bagian putih yang tidak transparan, jadi bisa menutup tulisan di dokumen. Gambar ulang tanda tangan, atau impor foto tanda tangan di atas kertas putih.",
    pageMissing: (page: number, count: number) => `Halaman ${page} tidak ada di PDF ini (jumlah halaman ${count}).`,
    invalidPlacement: "Posisi tanda tangan tidak valid.",
    imageUnreadable: "Gambar tanda tangan tidak bisa dibaca.",
  },
};

export default id;
