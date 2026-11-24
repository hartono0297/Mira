// Teks layar Board: daftar proyek (BoardScreen), board proyek (ProjectBoard),
// tambah task cepat (QuickAdd), Proyek lain (OutsideProjects), dan Task saya
// (MyTasks). Dipakai lewat TEKS_LAYAR di src/screens/board/teks.ts.

const id = {
  layar: {
    judul: "Board",
    navLabel: "Task saya dan proyek",
    taskSaya: "Task saya",
    proyek: "Proyek",
    memuatProyek: "Memuat proyek...",
    belumAdaProyek: "Belum ada proyek.",
    proyekBaru: "Proyek baru",
    catatanBuat: "Proyek dibuat oleh superadmin atau admin departemen.",
    // Arti angka merah di samping Task saya dan nama proyek.
    artiTenggat: "task tenggat hari ini atau lewat",
    belumSelesaiSr: (_n: number) => " task belum selesai",
    keluarSr: (code: string, name: string) => `Anda sudah keluar dari proyek ${code} ${name}.`,
    hilangSr: (code: string, name: string) => `Proyek ${code} ${name} tidak tersedia lagi.`,
    keluarJudul: (code: string, name: string) => `Anda sudah keluar dari proyek ${code} ${name}`,
    hilangJudul: (code: string, name: string) => `Proyek ${code} ${name} tidak tersedia lagi`,
    keluarIsi: "Proyek ini tidak tampil lagi di board Anda, dan laptop ini berhenti menerima data baru proyek ini.",
    hilangIsi:
      "Anda tidak bisa membuka proyek ini lagi. Biasanya karena pengelola proyek mengeluarkan Anda dari anggotanya.",
    mintaTambah: "Kalau masih perlu, minta pengelola proyek menambahkan Anda lagi.",
    bukaProyek: (code: string, name: string) => `Buka ${code} ${name}`,
    daftarBelumTerbaca: "Daftar proyek belum terbaca",
    intiTanpaDaftar: "Inti Mira tidak mengirim daftar proyek.",
    tungguDaftar: "Tunggu sebentar lalu coba lagi. Data board tersimpan di laptop ini, tidak ada yang hilang.",
    cobaLagi: "Coba lagi",
    memuatBoard: "Memuat board...",
    kosongJudul: "Belum ada proyek",
    kosongJudulTamu: "Belum ada proyek yang bisa Anda lihat",
    kosongIsi:
      "Satu proyek punya satu board dengan kolom To do, Dikerjakan, dan Selesai. Task diberi nomor dari kode proyeknya, misalnya PA-1 untuk proyek berkode PA.",
    buatPertama: "Buat proyek pertama",
    munculSetelahDitambah: "Board proyek muncul di sini setelah pengelolanya menambahkan Anda sebagai anggota.",
  },

  board: {
    tidakBerizinPindah: (code: string) => `Anda tidak punya izin memindah ${code}`,
    sudahTidakAda: (code: string) => `${code} sudah tidak ada di board ini`,
    belumDipindah: (code: string) => `${code} belum dipindah`,
    belumDipindahSr: (code: string) => `${code} belum dipindah.`,
    dipindah: (code: string, column: string, pos: number, size: number) =>
      `${code} dipindah ke ${column}, posisi ${pos} dari ${size}.`,
    dikembalikan: "Kartu dikembalikan ke tempat semula.",
    keKolom: (column: string) => `Ke ${column}`,
    namaDiubah: (name: string) => `Nama proyek diubah menjadi ${name}.`,
    dibuat: (code: string, column: string) => `${code} dibuat di ${column}.`,
    tidakDitemukan: "Proyek ini tidak ditemukan",
    belumTerbaca: "Board belum terbaca",
    intiTanpaBoard: "Inti Mira tidak mengirim data board.",
    pilihLain: "Pilih proyek lain dari daftar di kiri.",
    tungguBoard: "Tunggu sebentar lalu coba lagi. Data tersimpan di laptop ini, tidak ada yang hilang.",
    departemenSr: "Departemen proyek: ",
    jumlahTask: (total: number, open: number) => `${total} task, ${open} belum selesai`,
    anggota: "Anggota",
    anggotaLabel: (n: number) => `Anggota, ${n} orang`,
    ubahNama: "Ubah nama proyek",
    pintasan: "Pintasan keyboard",
    taskBaru: "Task baru",
    hanyaLihat:
      "Board ini hanya bisa dilihat. Anda bisa membuka task dan membaca komentarnya, tapi tidak bisa menambah, memindah, atau mengubah apa pun.",
    pintasanLihat:
      "Pilih kartu dengan Tab, lalu Enter untuk membuka detailnya. Shift + F10 atau tombol Menu membuka menu aksi kartu, sama dengan klik kanan.",
    pintasanUbah:
      "Pilih kartu dengan Tab, lalu Enter untuk membuka detailnya. Alt + panah kiri atau kanan memindah kartu ke kolom sebelah, Alt + panah atas atau bawah mengubah urutannya. Tombol panah empat arah di kartu membuka pilihan yang sama. Shift + F10 atau tombol Menu membuka menu aksi kartu, sama dengan klik kanan.",
    jumlahKolomSr: (_n: number) => " task",
    kolomKosong: "Belum ada task di kolom ini.",
  },

  tambah: {
    judulKosong: "Tulis judul task dulu.",
    buka: "Tambah task",
    label: (column: string) => `Judul task baru di ${column}`,
    placeholder: "Judul task",
    petunjuk: "Enter menyimpan. Escape menutup, teksnya tetap ada saat dibuka lagi.",
    tidakBerizin: "Anda tidak punya izin membuat task di proyek ini",
    belumDibuat: "Task belum dibuat",
    tutup: "Tutup",
    menyimpan: "Menyimpan...",
    simpan: "Simpan",
  },

  luar: {
    proyekDepartemen: (team: string) => `Proyek ${team}`,
    tanpaDepartemen: "Proyek tanpa departemen",
    sub: (creator: string, members: number) => `dibuat ${creator}, ${members} anggota`,
    sudahAnggota: (label: string) => `Anda sudah menjadi anggota ${label}.`,
    sudahAnggotaTunggu: (label: string) =>
      `Anda sudah menjadi anggota ${label}. Board muncul setelah laptop anggota proyek tersambung.`,
    judul: "Proyek lain",
    catatan: "Proyek yang belum Anda ikuti. Sebagai superadmin, Anda bisa bergabung sendiri.",
    belumTerbaca: "Daftar proyek lain belum terbaca.",
    cobaLagi: "Coba lagi",
    gabungLabel: (label: string) => `Gabung ke proyek ini: ${label}`,
    gabungTombol: "Gabung ke proyek ini",
    gabungJudul: (label: string) => `Gabung ke ${label}?`,
    gabungJudulCadangan: "Gabung ke proyek ini?",
    gabung: "Gabung",
    bergabung: "Bergabung...",
    belumBergabung: "Anda belum bergabung",
    gabungIsi:
      "Anda akan menjadi anggota proyek ini. Langkah ini tercatat di log organisasi dan terlihat oleh semua anggota.",
    boardMenyusul: "Board muncul setelah laptop anggota proyek tersambung.",
  },

  saya: {
    memuat: "Memuat task Anda...",
    belumTerbaca: "Task Anda belum terbaca",
    intiTanpaDaftar: "Inti Mira tidak mengirim daftar task.",
    cobaBacaLagi: "Coba baca lagi. Kalau tetap gagal, tutup Mira lalu buka lagi.",
    cobaLagi: "Coba lagi",
    kosongJudul: "Belum ada task untuk Anda.",
    kosongIsi: "Task yang ditugaskan ke Anda di board proyek akan muncul di sini.",
    semuaSelesai: "Semua task Anda sudah selesai.",
    judul: "Task saya",
    sub: "Task yang ditugaskan ke Anda, dikumpulkan dari semua proyek.",
  },
};

export default id;
