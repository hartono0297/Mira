// Teks bagian Waktu di detail task dan timer di kepala dialog (Board v0.4).
// Dipakai lewat TW, SAY, dan fungsi kecil di src/screens/board/teksWaktu.ts.

const id = {
  tw: {
    heading: "Waktu",
    total: "Total",
    totalTask: "Total task",
    perPerson: "Per orang",
    perStatus: "Per status",
    you: "Anda",
    running: "berjalan",
    now: "sekarang",
    never: "belum pernah",
    nobody: "Belum ada waktu tercatat.",
    notDone: "Belum selesai",
    forgot: "Lupa dihentikan?",
    manual: "manual",

    // Catatan jam laptop (docs/plans/v04-board.md bagian 4).
    clockNote:
      "Jam di beberapa laptop tampaknya tidak sama, jadi durasi per status bisa meleset. Timer dan catatan manual tidak terpengaruh, karena mulai dan berhentinya dicatat di laptop yang sama.",

    // Timer
    timerGroup: "Timer Anda",
    start: "Mulai timer",
    // Bantuan di tombol Mulai: dibaca sebagai deskripsi tombol, tidak diumumkan.
    startHint: "Timer Anda yang masih berjalan di task lain dalam proyek ini akan dihentikan.",
    stop: "Hentikan timer",
    stopDialog: "Hentikan timer",
    stopAt: "Hentikan di",
    stopNoteLabel: "Catatan sesi ini (opsional)",
    stopHint: "Enter menyimpan dan menghentikan timer. Escape menutup kotak ini, timer tetap berjalan.",
    stopWithNote: "Simpan dan hentikan",
    stopWithoutNote: "Hentikan tanpa catatan",
    notePlaceholder: "Apa yang dikerjakan",

    // Catat manual
    logOpen: "Catat waktu manual",
    logDuration: "Durasi",
    logDurationHint: "Contoh: 45m, 1j 30m, 1:30, atau 90 (menit). Paling lama 24 jam.",
    logNote: "Catatan (opsional)",
    logSave: "Simpan catatan",
    cancel: "Batal",

    // Riwayat
    confirmDelete: "Hapus catatan ini?",
    delete: "Hapus",
  },
  kalimat: {
    runningSinceSr: (when: string) => `Timer Anda berjalan sejak ${when}.`,
    stopTitleSr: (when: string) => `Hentikan timer yang berjalan sejak ${when}.`,
    cycleDone: (short: string) => `Selesai dalam ${short} sejak dibuat`,
    historySummary: (n: number) => `Riwayat catatan waktu (${n})`,
    // "Hapus catatan 1 jam 30 menit, 23 Nov, 09.12".
    deleteEntryLabel: (what: string, when: string) => `Hapus catatan ${what}, ${when}`,
    startedAt: (when: string) => `mulai ${when}`,
  },
  say: {
    started: "Timer berjalan.",
    stopped: (long: string) => `Timer berhenti. ${long} dicatat.`,
    stoppedPlain: "Timer berhenti.",
    logged: (long: string) => `Catatan ${long} disimpan.`,
    deleted: "Catatan waktu dihapus.",
  },
};

export default id;
