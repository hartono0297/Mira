// Teks penampil PDF bersama (src/components/pdf).
const id = {
  toolbar: (label: string) => `Kontrol tampilan ${label}`,
  prev: "Sebelumnya",
  prevTitle: "Halaman sebelumnya",
  next: "Berikutnya",
  nextTitle: "Halaman berikutnya",
  zoomOut: "Perkecil",
  zoomIn: "Perbesar",
  zoomValue: (percent: number) => `Perbesaran ${percent} persen`,
  fitWidth: "Sesuai lebar",
  loading: "Membuka PDF...",
  empty: "PDF ini tidak punya halaman, jadi tidak ada yang bisa ditampilkan. Periksa file aslinya.",
  pageOf: (page: number, count: number) => `Halaman ${page} dari ${count}`,
  drawing: (page: number) => `Menampilkan halaman ${page}...`,
  pageErrorTitle: (page: number) => `Halaman ${page} gagal ditampilkan`,
  pageErrorBody: (detail: string) =>
    `Isi halaman ini tidak bisa digambar${detail ? ` (${detail})` : ""}. Pindah ke halaman lain lalu kembali, atau buka ulang file.`,
  pageField: "Halaman",
  pageFieldOf: (count: string) => `dari ${count}`,
  place: {
    role: "kotak yang bisa dipindah",
    keyHint:
      "Tombol panah memindah kotak, Shift dan panah memindah lebih jauh. Alt dan panah, atau tombol plus dan minus, mengubah ukuran.",
    edge: "Sudah di tepi halaman.",
    largest: "Sudah ukuran terbesar di halaman ini.",
    smallest: "Sudah ukuran terkecil.",
  },
  errors: {
    empty: {
      title: "File PDF kosong",
      detail: "File ini berukuran 0 byte, jadi tidak ada isi yang bisa ditampilkan. Ambil lagi file aslinya, lalu buka ulang.",
    },
    invalid: {
      title: "File ini bukan PDF atau rusak",
      detail:
        "Mira tidak menemukan struktur PDF yang bisa dibaca. Pastikan file berakhiran .pdf dan bisa dibuka di aplikasi lain. Kalau tidak bisa, minta pengirim mengirim ulang.",
    },
    password: {
      title: "PDF dikunci kata sandi",
      detail:
        "Mira belum bisa membuka PDF yang dikunci. Buka kuncinya di aplikasi PDF lain, simpan tanpa kata sandi, lalu buka lagi di sini.",
    },
    runtimeMac: {
      title: "Komponen tampilan macOS perlu diperbarui",
      detail:
        "WebKit di Mac ini terlalu lama untuk menampilkan PDF. Perbarui macOS lewat Pengaturan Sistem > Umum > Pembaruan Perangkat Lunak, lalu coba lagi.",
    },
    runtimeWindows: {
      title: "Komponen tampilan Windows perlu diperbarui",
      detail:
        "Microsoft Edge WebView2 di komputer ini terlalu lama untuk menampilkan PDF. Jalankan Windows Update atau pasang ulang Mira, lalu coba lagi.",
    },
    unknownTitle: "PDF tidak bisa dibuka",
    unknownDetail: (detail: string) =>
      `Terjadi kesalahan saat membaca file${detail ? ` (${detail})` : ""}. Tutup lalu buka lagi file ini. Kalau tetap gagal, file kemungkinan rusak.`,
  },
};

export default id;
