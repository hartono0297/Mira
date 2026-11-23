// Teks menu klik kanan board (v0.4): kartu task, kolom, subtask, daftar
// proyek, dan Task saya. Kalimat yang memuat kode, nama, atau angka ditulis
// sebagai fungsi kecil. Rancangan isi menu ada di docs/plans/v04-ctx-board.md.

export const TEKS_MENU = {
  // Baris pertama setiap sub-menu (juga panah kiri).
  kembali: "Kembali",

  kartu: {
    menu: (code: string) => `Aksi untuk ${code}`,
    buka: "Buka task",
    pindahkan: "Pindahkan ke",
    pindahkanMenu: (code: string) => `Pindahkan ${code} ke`,
    sudahDiKolom: "Task sudah di kolom ini",
    naik: "Naik satu posisi",
    turun: "Turun satu posisi",
    sudahAtas: "Sudah paling atas",
    sudahBawah: "Sudah paling bawah",
    tugaskan: "Tugaskan ke",
    tugaskanMenu: (code: string) => `Tugaskan ${code} ke`,
    anda: (name: string) => `${name} (Anda)`,
    tanpaPenanggungJawab: "Tanpa penanggung jawab",
    penanggungJawabSekarang: "Penanggung jawab sekarang",
    belumAdaPenanggungJawab: "Belum ada penanggung jawab",
    // Penanggung jawab sekarang yang sudah keluar dari proyek: tampil nonaktif.
    bukanAnggota: (name: string, mine: boolean) =>
      mine ? `${name} (Anda, bukan anggota proyek lagi)` : `${name} (bukan anggota proyek lagi)`,
    prioritas: "Ubah prioritas",
    prioritasMenu: (code: string) => `Prioritas ${code}`,
    prioritasSekarang: "Prioritas sekarang",
    tenggat: "Atur tenggat",
    tenggatMenu: (code: string) => `Tenggat ${code}`,
    hariIni: "Hari ini",
    besok: "Besok",
    tenggatSekarang: "Tenggat sekarang",
    tanggalLain: "Tanggal lain di detail task",
    hapusTenggat: "Hapus tenggat",
    belumAdaTenggat: "Belum ada tenggat",
    mulaiTimer: "Mulai timer saya",
    hentikanTimer: "Hentikan timer saya",
    salinKode: (code: string) => `Salin kode ${code}`,
    hapus: "Hapus task",
    // Isi konfirmasi hapus dari menu kartu. Sama dengan teksDialog.hapusIsi,
    // tetapi jumlah catatan waktu tidak ada di kartu: kalau kartu menunjukkan
    // ada waktu tercatat, "catatan waktu" disebut tanpa angka. Kalimat bahwa
    // hapus tidak bisa dibatalkan tetap paling akhir.
    hapusIsi: (title: string, subtasks: number, comments: number, waktu: boolean) => {
      const parts = [
        subtasks > 0 ? `${subtasks} subtask` : "",
        comments > 0 ? `${comments} komentar` : "",
        waktu ? "catatan waktunya" : "",
      ].filter(Boolean);
      let ikut = "";
      if (parts.length === 1) ikut = ` beserta ${parts[0]}`;
      else if (parts.length === 2) ikut = ` beserta ${parts[0]} dan ${parts[1]}`;
      else if (parts.length === 3) ikut = ` beserta ${parts[0]}, ${parts[1]}, dan ${parts[2]}`;
      return `"${title}"${ikut} terhapus dari board semua anggota proyek dan dari Task saya. Mira belum punya cara mengembalikannya.`;
    },
    // Pengumuman pembaca layar dan judul galat.
    dihapus: (code: string) => `${code} dihapus.`,
    // "Hari ini, 24 Nov" untuk pengumuman tenggat.
    tanggalDengan: (label: string, date: string) => `${label}, ${date}`,
    disalin: (code: string) => `Kode ${code} disalin.`,
    gagalSalin: (code: string) => `Kode ${code} belum tersalin`,
    // Memilih teks di kartu memulai seret, jadi arahannya ke detail task.
    gagalSalinIsi: "Papan klip tidak bisa dipakai saat ini. Coba lagi sebentar, atau buka task-nya untuk melihat kodenya.",
    ditugaskan: (code: string, name: string) => `${code} ditugaskan ke ${name}.`,
    dilepas: (code: string) => `${code} tanpa penanggung jawab.`,
    prioritasDiubah: (code: string, label: string) => `Prioritas ${code}: ${label}.`,
    tenggatDiubah: (code: string, label: string) => `Tenggat ${code}: ${label}.`,
    tenggatDihapus: (code: string) => `Tenggat ${code} dihapus.`,
    timerMulai: (code: string) => `Timer Anda di ${code} berjalan.`,
    // Inti Rust menghentikan timer saya di task lain proyek ini saat timer baru mulai.
    timerMulaiGanti: (code: string, others: string[]) =>
      `Timer Anda di ${code} berjalan. Timer di ${others.length > 1 ? `${others.slice(0, -1).join(", ")} dan ${others[others.length - 1]}` : others[0]} dihentikan.`,
    timerBerhenti: (code: string) => `Timer Anda di ${code} berhenti.`,
    gagal: (code: string) => `${code} belum diubah`,
  },

  kolom: {
    menu: (name: string) => `Aksi untuk kolom ${name}`,
    taskBaru: (name: string) => `Task baru di ${name}`,
  },

  subtask: {
    menu: (title: string) => `Aksi untuk subtask ${title}`,
    centang: "Tandai selesai",
    batalCentang: "Tandai belum selesai",
    gantiNama: "Ganti nama",
    tugaskan: "Tugaskan ke",
    tugaskanMenu: (title: string) => `Tugaskan subtask ${title} ke`,
    naik: "Naik satu posisi",
    turun: "Turun satu posisi",
    sudahAtas: "Sudah paling atas",
    sudahBawah: "Sudah paling bawah",
    hapus: "Hapus subtask",
    menunggu: "Tunggu perubahan sebelumnya tersimpan",
  },

  proyek: {
    menu: (code: string, name: string) => `Aksi untuk proyek ${code} ${name}`,
    buka: "Buka board",
    sedangTerbuka: "Board ini sedang terbuka",
    anggota: "Anggota proyek",
    ubahNama: "Ubah nama proyek",
  },

  taskSaya: {
    menu: (code: string) => `Aksi untuk ${code}`,
    buka: "Buka task",
    pindahkan: "Pindahkan ke",
    pindahkanMenu: (code: string) => `Pindahkan ${code} ke`,
    salinKode: (code: string) => `Salin kode ${code}`,
    dipindah: (code: string, column: string) => `${code} dipindah ke ${column}.`,
    gagalPindah: (code: string) => `${code} belum dipindah`,
    // Baris Task saya adalah tombol, jadi kodenya tidak bisa dipilih seperti teks biasa.
    gagalSalinIsi: "Papan klip tidak bisa dipakai saat ini. Coba lagi sebentar, atau buka task-nya untuk melihat kodenya.",
  },
} as const;
