// Teks tab Permintaan bergabung (src/screens/org/JoinRequestsPanel.tsx).
const id = {
  notRecorded: "Tidak tercatat",
  // Teks kartu permintaan (diekspor sebagai CARD_TEXT).
  card: {
    department: "Departemen",
    // Keterangan dan akun login ditulis oleh laptop peminta sendiri. Labelnya
    // mengatakan itu, supaya admin tidak menganggapnya sudah diperiksa.
    note: "Keterangan dari peminta (belum diperiksa)",
    laptop: "Laptop",
    account: "Akun login (dilaporkan laptop peminta)",
    // Alasannya tidak ditebak dari versi Mira, karena versi itu juga laporan peminta.
    accountNotSent: "Tidak dikirim",
    ip: "Alamat IP",
    os: "Sistem",
    appVersion: "Versi Mira",
    codeLabel: "Kode cocok",
    verifyHint:
      "Pastikan orangnya benar: telepon dia di nomor yang sudah Anda kenal, bukan nomor dari keterangan, atau datangi mejanya. Minta ia membacakan kode di layarnya, dan setujui hanya kalau kodenya sama.",
  },
  title: "Permintaan bergabung",
  intro: "Laptop baru di jaringan kantor yang memilih organisasi ini muncul di sini.",
  introScoped: " Anda hanya melihat permintaan ke departemen Anda.",
  loading: "Memuat permintaan bergabung...",
  loadErrorTitle: "Permintaan bergabung belum terbaca",
  loadErrorEmpty: "Inti Mira tidak mengirim daftar permintaan.",
  retry: "Coba lagi",
  stale: (message: string) => `Daftar terbaru belum bisa dibaca (${message}). Yang tampil adalah data terakhir.`,
  emptyTitle: "Tidak ada permintaan yang menunggu.",
  emptyBody: (scoped: boolean) =>
    `Permintaan muncul di sini saat laptop baru di jaringan kantor memilih organisasi ini${scoped ? " dan departemen Anda" : ""}. Orang yang tidak bisa menemukan kantor tetap bisa bergabung dengan kode dari tab Undangan.`,
  requested: "Minta bergabung",
  rejectAria: (name: string) => `Tolak permintaan ${name}`,
  reject: "Tolak",
  approveAria: (name: string) => `Setujui permintaan ${name}`,
  approving: "Menyetujui...",
  approve: "Setujui",
  seenBy: (name: string) => `Diterima lewat laptop ${name}`,
  rejectAllFrom: (group: string, n: number) => `Tolak semua dari ${group} (${n})`,
  approved: (name: string, team: string) => `${name} disetujui dan masuk departemen ${team}.`,
  approveFailed: "Permintaan belum disetujui",
  rejected: (name: string) => `Permintaan ${name} ditolak. Kalau keliru, ${name} bisa mengirim permintaan baru.`,
  rejectFailed: "Permintaan belum ditolak",
  bulkStopped: (done: number, total: number) => `Sebelum berhenti, ${done} dari ${total} permintaan sudah ditolak.`,
  bulkSkipped: (n: number) => `${n} sudah diputuskan orang lain lebih dulu.`,
  bulkRetry: "Yang tersisa di bawah ini bisa ditolak lagi.",
  bulkFailedTitle: (name: string) => `Gagal menolak permintaan ${name}`,
  bulkSkippedTail: (n: number) => ` ${n} lainnya sudah diputuskan orang lain lebih dulu.`,
  bulkDone: (n: number, group: string, tail: string) => `${n} permintaan dari ${group} ditolak.${tail}`,
  bulkNoneLeft: (group: string) => `Semua permintaan dari ${group} sudah diputuskan orang lain lebih dulu.`,
  rejectOneTitle: (name: string) => `Tolak permintaan ${name}?`,
  rejectOneTitleFallback: "Tolak permintaan",
  rejectOneConfirm: (name: string) => `Tolak ${name}`,
  rejecting: "Menolak...",
  rejectOneBody: (name: string) =>
    `Permintaan yang ditolak tidak bisa disetujui lagi. Kalau ternyata keliru, ${name} bisa mengirim permintaan baru dari laptopnya, dengan kode cocok yang baru.`,
  bulkTitle: (n: number, group: string) => `Tolak ${n} permintaan dari ${group}?`,
  bulkTitleFallback: "Tolak semua permintaan",
  bulkConfirm: (n: number) => `Tolak ${n} permintaan`,
  bulkProgress: (at: number, total: number) => `Menolak ${at} dari ${total}...`,
  bulkIpv6:
    "Permintaan berikut dikirim dari jaringan IPv6 yang sama (satu /64). Periksa namanya dulu: laptop rekan di jaringan kantor bisa berada di /64 yang sama.",
  bulkSameIp: "Permintaan berikut dikirim dari alamat yang sama:",
  bulkWhy:
    "Pakai ini kalau ada yang membanjiri kantor dengan permintaan palsu. Permintaan yang ditolak tidak bisa disetujui lagi; orang yang memang berhak bisa mengirim permintaan baru.",
};

export default id;
