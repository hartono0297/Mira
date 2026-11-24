// Teks layar Kalender: kepala, saringan, pindah tenggat (seret, Alt+Panah,
// menu klik kanan), dan pengumuman. Teks tampilan bulan, minggu, agenda, dan
// chip ada di calendar-view.id.ts.

const id = {
  judul: "Kalender",
  sebelumnya: {
    month: "Bulan sebelumnya",
    week: "Minggu sebelumnya",
    agenda: "Bulan sebelumnya",
  },
  berikutnya: {
    month: "Bulan berikutnya",
    week: "Minggu berikutnya",
    agenda: "Bulan berikutnya",
  },
  hariIni: "Hari ini",
  tampilan: "Tampilan",
  namaTampilan: {
    month: "Bulan",
    week: "Minggu",
    agenda: "Agenda",
  },
  lihat: "Lihat",
  taskSaya: "Task saya",
  semuaProyek: "Semua proyek",
  opsiProyek: (code: string, name: string) => `${code} · ${name}`,
  tampilkanSelesai: "Tampilkan yang selesai",
  petunjuk: "Seret task ke tanggal lain, atau tekan Alt+Panah pada task yang terpilih.",
  memuat: "Memuat task...",
  belumTerbaca: "Task kalender belum terbaca",
  intiTanpaData: "Inti Mira tidak mengirim daftar task.",
  dataLama: "Yang tampil adalah data terakhir yang terbaca.",
  cobaLagi: "Coba lagi",
  periode: (title: string) => `Menampilkan ${title}.`,
  dipindah: (code: string, day: string) => `Tenggat ${code} dipindah ke ${day}.`,
  dihapus: (code: string) => `Tenggat ${code} dihapus.`,
  gagalUbah: (code: string) => `Tenggat ${code} belum berubah`,
  tanpaHakTenggat: "Anda tidak berhak mengubah tenggat task ini.",
  menu: {
    label: (code: string) => `Pindahkan tenggat ${code} ke`,
    hariIni: "Hari ini",
    besok: "Besok",
    seninDepan: "Senin depan",
    lebihAwal: "Satu hari lebih awal",
    lebihLambat: "Satu hari lebih lambat",
    hapus: "Hapus tenggat",
    buka: "Buka task",
    tanpaHak: "Anda tidak berhak mengubah task ini",
    sudahDiTanggal: "Tenggat sudah di tanggal ini",
  },
};

export default id;
