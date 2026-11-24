// Teks tampilan Kalender: chip task, Bulan, Minggu, Agenda, dan daftar satu hari
// (DayMore). Teks kepala layar, saringan, seret, dan menu ada di calendar.id.ts.
// Bagian yang berakhiran Sr hanya untuk pembaca layar: potongan aria-label yang
// disambung dengan awalan ", ", misalnya "TES-3, Laporan bulanan, proyek Tes, lewat tenggat".

const id = {
  chip: {
    pemisahSr: ", ",
    proyekSr: (name: string) => `, proyek ${name}`,
    lewatSr: ", lewat tenggat",
    selesaiSr: ", selesai",
    untukSr: (name: string) => `, untuk ${name}`,
    tanpaOrang: "Belum ditugaskan",
    tanpaOrangSr: ", belum ditugaskan",
    prioritasSr: (label: string) => `, prioritas ${label}`,
  },
  bulan: {
    // Tombol di bawah 3 chip pertama. Nama aksesibelnya ditambah tanggal.
    lagi: (n: number) => `+${n} lagi`,
    hariSr: (day: string) => `, ${day}`,
    // Tampilan sempit: satu tombol jumlah per hari, misalnya "4".
    jumlahSr: (_n: number) => " task",
    adaLewatSr: ", ada yang lewat tenggat",
  },
  daftarHari: {
    tutup: "Tutup daftar",
  },
  minggu: {
    kosong: "Tidak ada tenggat",
  },
  agenda: {
    lewat: "Lewat tenggat",
    hariIni: "Hari ini",
    kosongJudul: (month: string) => `Tidak ada task bertenggat di ${month}.`,
    kosongSaran: "Task tanpa tenggat tidak tampil di kalender. Beri tenggat lewat Board, atau ubah saringan di atas.",
  },
};

export default id;
