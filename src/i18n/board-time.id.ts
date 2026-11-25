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
    forgot: "Lupa dijeda?",
    manual: "manual",

    // Catatan jam laptop (docs/plans/v04-board.md bagian 4).
    clockNote:
      "Jam di beberapa laptop tampaknya tidak sama, jadi durasi per status bisa meleset. Timer dan catatan manual tidak terpengaruh, karena mulai dan berhentinya dicatat di laptop yang sama.",

    // Timer. Jeda menutup segmen yang berjalan, Lanjutkan membuka segmen baru.
    timerGroup: "Timer Anda",
    start: "Mulai timer",
    pause: "Jeda",
    resume: "Lanjutkan",
    // Keadaan di kepala dialog, dan tag kecil di daftar Per orang.
    paused: "Dijeda",
    pausedTag: "dijeda",
    // Total saya di task ini tanpa timer berjalan: saat belum pernah memakai timer
    // tapi punya catatan manual lama, dan saat task sudah di Selesai.
    yourTotal: "Total Anda",
    // Bantuan di tombol Mulai dan Lanjutkan: dibaca sebagai deskripsi tombol, tidak diumumkan.
    startHint: "Kalau timer Anda berjalan di task lain, timer itu dijeda.",
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
    // Jam di kepala dialog menunjukkan total; pembaca layar mendapat total sebelum segmen ini.
    earlierSr: (long: string) => `Sebelumnya tercatat ${long}.`,
    // Kepala dialog saat dijeda: "Dijeda, total Anda di task ini 1 jam 20 menit."
    pausedSr: (long: string) => `Dijeda, total Anda di task ini ${long}.`,
    cycleDone: (short: string) => `Selesai dalam ${short} sejak dibuat`,
    historySummary: (n: number) => `Riwayat catatan waktu (${n})`,
    // "Hapus catatan 1 jam 30 menit, 23 Nov, 09.12".
    deleteEntryLabel: (what: string, when: string) => `Hapus catatan ${what}, ${when}`,
    startedAt: (when: string) => `mulai ${when}`,
  },
  say: {
    started: "Timer berjalan.",
    resumed: "Timer berjalan lagi.",
    paused: (long: string) => `Timer dijeda. Total Anda di task ini ${long}.`,
    logged: (long: string) => `Catatan ${long} disimpan.`,
    deleted: "Catatan waktu dihapus.",
  },
  // Pemberitahuan jeda otomatis (TimerNotice dari inti Rust).
  notice: {
    region: "Timer dijeda otomatis",
    dismiss: "Tutup pemberitahuan",
    dismissAll: "Tutup semua",
    switched: (code: string, title: string, startedCode: string) =>
      `Timer Anda di ${code} (${title}) dijeda karena Anda memulai timer di ${startedCode}.`,
    done: (code: string, title: string) => `Timer Anda di ${code} (${title}) dijeda karena task itu dipindah ke Selesai.`,
    deleted: (code: string, title: string) => `Timer Anda di ${code} (${title}) dijeda karena task itu dihapus.`,
    // time = jam saja ("17.32") kalau hari ini, atau tanggal dan jam.
    idle: (code: string, title: string, time: string) =>
      `Timer Anda di ${code} (${title}) dijeda pada ${time}, saat Mira terakhir aktif. Waktu setelah itu tidak dihitung.`,
  },
};

export default id;
