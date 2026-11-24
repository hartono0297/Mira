// Teks bersama board: kartu, durasi, nama kolom dan prioritas, tanggal,
// kelompok Task saya, riwayat aktivitas, dan menu Pindahkan. Dipakai lewat
// TEKS di src/screens/board/teks.ts. Kalimat yang memuat angka ditulis sebagai
// fungsi kecil.

const id = {
  // Baris meta kartu board. Teks sr-only diawali koma karena dibaca menyambung
  // setelah kode task, sama dengan meta yang sudah ada.
  kartu: {
    subtaskSr: (done: number, total: number) => `, ${done} dari ${total} subtask selesai`,
    waktuSr: (durasi: string) => `, waktu tercatat ${durasi}`,
    timerBerjalanSr: ", timer berjalan",
    untukSr: (name: string) => `, untuk ${name}`,
    tanpaPenanggungJawabSr: ", belum ada penanggung jawab",
    tenggatSr: ", tenggat ",
    prioritasSr: ", prioritas ",
    komentarSr: (_n: number) => " komentar",
    label: "Label",
    digabung: "Diubah saat offline, sudah digabung",
  },

  // Format durasi (timeFormat.ts) dan isian durasi bebas (parseMinutes).
  waktu: {
    // "hr", bukan "h": "2h 5j" mudah terbaca 2 jam.
    pendek: { hari: "hr", jam: "j", menit: "m" },
    panjang: {
      hari: (n: number) => `${n} hari`,
      jam: (n: number) => `${n} jam`,
      menit: (n: number) => `${n} menit`,
    },
    kurangDariSemenit: "<1m",
    kurangDariSemenitPanjang: "kurang dari 1 menit",
    isian: {
      kosong: "Isi durasinya dulu, misalnya 1j 30m.",
      tidakDikenali: "Durasi tidak dikenali. Tulis misalnya 90, 1j 30m, 1:30, atau 1,5j.",
      terlaluSingkat: "Durasi paling singkat 1 menit.",
      terlaluLama: "Durasi paling lama 24 jam (1440 menit).",
    },
  },

  // Nama tampilan kolom bawaan. Nama yang disimpan inti Rust tetap bahasa
  // Indonesia (lihat columnLabel di format.ts).
  kolom: {
    todo: "To do",
    doing: "Dikerjakan",
    done: "Selesai",
  },

  prioritas: {
    none: "Tanpa prioritas",
    low: "Rendah",
    medium: "Sedang",
    high: "Tinggi",
  },

  tanggal: {
    bulan: ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"],
    hari: ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"],
    hariPendek: ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"],
    // "22 Nov, 09.12"
    tanggalJam: (date: string, hh: string, mm: string) => `${date}, ${hh}.${mm}`,
    // Teks tenggat kartu.
    hariIni: "Hari ini",
    besok: "Besok",
    terlambat: (n: number) => `Terlambat ${n} hari`,
  },

  proyek: {
    namaKosong: "Tulis nama proyek dulu.",
    namaAturan: "Nama proyek harus 2 sampai 80 karakter.",
    tanpaDepartemen: "Tanpa departemen",
    // "Departemen Keuangan". Nama yang sudah diawali "Departemen" tidak diberi awalan lagi.
    departemen: (name: string) => (/^departemen\b/i.test(name) ? name : `Departemen ${name}`),
  },

  grup: {
    late: "Terlambat",
    today: "Hari ini",
    tomorrow: "Besok",
    week: "7 hari ke depan",
    later: "Nanti",
    none: "Tanpa tenggat",
    done: "Selesai",
  },

  // Pintasan Alt + panah yang tidak bisa dijalankan.
  pindah: {
    kiri: (code: string) => `${code} sudah di kolom pertama.`,
    kanan: (code: string) => `${code} sudah di kolom terakhir.`,
    atas: (code: string) => `${code} sudah paling atas.`,
    bawah: (code: string) => `${code} sudah paling bawah.`,
    tombol: "Pindahkan",
    tombolLabel: (code: string) => `Pindahkan ${code}`,
  },

  // Riwayat aktivitas task. who = pelaku, d = detail (boleh kosong).
  aktivitas: {
    anda: "Anda",
    andaObjek: "Anda",
    anggotaLain: "anggota lain",
    created: (who: string) => `${who} membuat task ini`,
    title: (who: string, d: string) => (d ? `${who} mengubah judul menjadi "${d}"` : `${who} mengubah judul`),
    description: (who: string) => `${who} mengubah deskripsi`,
    moved: (who: string, column: string) => (column ? `${who} memindahkan task ke ${column}` : `${who} memindahkan task`),
    assignee: (who: string, person: string) =>
      person ? `${who} menugaskan task ke ${person}` : `${who} mengosongkan penanggung jawab`,
    due: (who: string, date: string) => (date ? `${who} mengubah tenggat menjadi ${date}` : `${who} menghapus tenggat`),
    priority: (who: string, label: string) => `${who} mengubah prioritas menjadi ${label}`,
    labels: (who: string, d: string) => (d ? `${who} mengubah label menjadi ${d}` : `${who} menghapus semua label`),
    deleted: (who: string) => `${who} menghapus task ini`,
    commented: (who: string) => `${who} menambahkan komentar`,
    renumbered: (who: string, d: string) =>
      d
        ? `${who} mengganti nomor task ini dari ${d} karena nomornya sama dengan task lain`
        : `${who} mengganti nomor task ini`,
    subtaskAdded: (who: string, d: string) => (d ? `${who} menambahkan subtask "${d}"` : `${who} menambahkan subtask`),
    subtaskDone: (who: string, d: string) => (d ? `${who} menyelesaikan subtask "${d}"` : `${who} menyelesaikan subtask`),
    subtaskReopened: (who: string, d: string) =>
      d ? `${who} membuka lagi subtask "${d}"` : `${who} membuka lagi subtask`,
    subtaskDeleted: (who: string, d: string) => (d ? `${who} menghapus subtask "${d}"` : `${who} menghapus subtask`),
    timeLogged: (who: string, text: string) => (text ? `${who} mencatat ${text}` : `${who} mencatat waktu`),
    other: (who: string, d: string) => (d ? `${who} mengubah task: ${d}` : `${who} mengubah task`),
  },

  // Judul galat aksi menu yang memakai konfirmasi.
  aksiGagal: (label: string) => `${label} gagal`,
};

export default id;
