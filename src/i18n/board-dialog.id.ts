// Teks dialog detail task (v0.4, arah A di design/v04-detail-task.html).
// Sumber kebenaran; TEKS_DIALOG dan teksDialog di src/screens/board/teksDialog.ts.
// Kalimat yang memuat angka atau nama ditulis sebagai fungsi kecil.

export const MAX_LABELS = 10;
export const MAX_LABEL_LEN = 30;

const id = {
  dialog: {
    // Kepala dialog
    tutup: "Tutup detail task",
    lainnya: "Lainnya",
    hapusTask: "Hapus task",
    judulDialogCadangan: "Detail task",

    // Judul dan properti
    judul: "Judul",
    komentar: "Komentar",
    judulTask: "Judul task",
    rincianTask: "Rincian task",
    status: "Status",
    penanggungJawab: "Penanggung jawab",
    tenggat: "Tenggat",
    prioritas: "Prioritas",
    label: "Label",
    belumAda: "Belum ada",
    tanpaTenggat: "Tanpa tenggat",
    tanpaPenanggungJawab: "Tanpa penanggung jawab",
    tidakAdaLabel: "Tidak ada",
    judulKosong: "Judul tidak boleh kosong. Tekan Escape untuk kembali ke judul sebelumnya.",

    // Tenggat
    tanggalLain: "Tanggal lain",
    tanggalPlaceholder: "hh/bb/tttt",
    pakai: "Pakai",
    tanggalPetunjuk: "Hari/bulan/tahun, misalnya 27/11/2026.",
    tanggalKosong: "Tulis tanggalnya dulu, misalnya 27/11/2026.",
    tanggalSalah: "Tanggal tidak dikenali. Tulis hari/bulan/tahun, misalnya 27/11/2026.",
    tanggalTidakAda: "Tanggal itu tidak ada di kalender. Periksa hari dan bulannya.",
    hariIni: "Hari ini",
    besok: "Besok",
    jumatIni: "Jumat ini",
    jumatDepan: "Jumat depan",
    seninDepan: "Senin depan",

    // Label
    labelTask: "Label task",
    labelBaru: "Label baru",
    labelBaruPlaceholder: "misalnya: struktur",
    tambah: "Tambah",
    belumAdaLabelProyek: "Belum ada label di proyek ini. Tulis yang pertama di bawah.",

    // Deskripsi
    deskripsi: "Deskripsi",
    deskripsiPlaceholder: "Tambah deskripsi: apa yang perlu dikerjakan dan seperti apa hasilnya",
    belumAdaDeskripsi: "Belum ada deskripsi.",
    simpanDeskripsi: "Simpan deskripsi",
    batalkanPerubahan: "Batalkan perubahan",
    ctrlEnterMenyimpan: "Ctrl+Enter juga menyimpan.",

    // Tab Komentar dan Aktivitas
    komentarDanAktivitas: "Komentar dan aktivitas",
    tabKomentar: "Komentar",
    tabAktivitas: "Aktivitas",
    tulisKomentar: "Tulis komentar",
    ctrlEnterMengirim: "Ctrl+Enter untuk mengirim.",
    kirim: "Kirim",
    mengirim: "Mengirim...",
    belumAdaKomentar: "Belum ada komentar.",
    belumAdaKomentarTulis: "Belum ada komentar. Tulis yang pertama di bawah.",
    belumAdaAktivitas: "Belum ada aktivitas.",
    aktivitasTerbaru: "Tampilkan yang terbaru saja",

    // Simpan dan error
    menyimpan: "Menyimpan...",
    menghapus: "Menghapus...",
    komentarTerkirim: "Komentar terkirim.",
    subtaskBelumTersimpan: "Subtask belum tersimpan",
    waktuBelumTersimpan: "Waktu belum tersimpan",
    timerBelumTersimpan: "Timer belum tersimpan",
    taskBelumTerhapus: "Task belum terhapus",
    isianMasihAda: "Isian Anda masih ada. Coba lagi.",
    tidakBerizin: "Anda tidak punya izin untuk ini",
    taskTidakAdaLagi: "Task ini tidak ada lagi",
    komentarBelumTerkirim: "Komentar belum terkirim",

    // Memuat
    memuatTask: "Memuat task...",
    taskBelumTerbaca: "Task belum terbaca",
    intiTidakMengirim: "Inti Mira tidak mengirim data task.",
    mungkinSudahDihapus: "Mungkin sudah dihapus. Tutup dialog ini; board sudah memuat daftar terbaru.",
    cobaBacaLagi: "Coba baca lagi. Kalau tetap gagal, tutup Mira lalu buka lagi.",
    cobaLagi: "Coba lagi",
    tutupSingkat: "Tutup",

    // Catatan di atas dokumen
    sudahDigabung: "Sudah digabung.",
    sudahDigabungIsi: "Task ini juga diubah di laptop lain, dan perubahannya sudah digabung otomatis.",
    bisaKomentarSaja: "Anda bisa membaca dan mengomentari task ini, tapi tidak bisa mengubah isinya.",
    lihatSaja:
      "Anda hanya bisa melihat task ini. Mengubah dan mengomentari task tidak tersedia untuk peran Anda di proyek ini.",
    deskripsiDiubahRekan:
      "Deskripsi ini baru diubah di laptop lain. Ketikan Anda menggantinya kalau Anda menekan Simpan deskripsi atau menutup dialog. Pilih Batalkan perubahan atau tekan Escape untuk memakai versi terbaru.",

    // Orang
    anda: "Anda",
    anggotaLain: "anggota lain",

    // Task atau izinnya hilang
    goneTask: "Task ini dihapus di laptop lain.",
    goneProject: "Proyek task ini tidak bisa dibuka lagi.",
    goneRevoked: "Izin mengubah task ini baru dicabut.",
    goneProjectSebab: "Anda tidak punya akses lagi ke proyek ini, misalnya karena dikeluarkan dari proyek ini.",
    goneAdaDraf: "Isian Anda yang belum tersimpan masih ada di bawah. Salin dulu kalau masih perlu.",
    goneRevokedIsi: "Task tetap bisa dibaca, tapi perubahan tidak bisa disimpan lagi.",
    goneIsiTerakhir: "Yang tampil di bawah adalah isi terakhirnya. Perubahan tidak bisa disimpan lagi.",
    drafJudul: "Isian Anda yang belum tersimpan",
    drafPetunjuk: "Isian ini hilang setelah dialog ditutup. Salin dulu kalau masih perlu.",

    // Menutup dengan isian yang belum tersimpan
    adaYangGagal: "Ada perubahan yang belum tersimpan. Lihat pesan di bawah, lalu coba simpan lagi.",
    komentarBelumDikirim: "Komentar Anda belum dikirim.",
    ketikanBelumDisimpan: "Ada ketikan Anda yang belum disimpan.",
    lanjutMengedit: "Lanjut mengedit",
    tutupTanpaMenyimpan: "Tutup tanpa menyimpan",
  },
  kalimat: {
    tersimpan: (field: string) => `${field} tersimpan.`,
    belumTersimpan: (field: string) => `${field} belum tersimpan`,
    statusTersimpan: (column: string) => `Status tersimpan: ${column}.`,
    semuaAktivitas: (n: number) => `Tampilkan semua aktivitas (${n})`,
    dibuatOleh: (who: string, when: string) => `Dibuat oleh ${who}, ${when}`,
    sudahBanyakLabel: () => `Sudah ${MAX_LABELS} label, batas per task. Lepas satu untuk menambah yang baru.`,
    petunjukLabel: () => `Paling banyak ${MAX_LABELS} label per task, masing-masing ${MAX_LABEL_LEN} karakter.`,
    labelTerlaluPanjang: () => `Label paling panjang ${MAX_LABEL_LEN} karakter.`,
    labelSudahAda: (label: string) => `Label "${label}" sudah ada.`,
    judulDiubahRekan: (title: string) =>
      `Judul ini baru diubah di laptop lain menjadi "${title}". Ketikan Anda menggantinya kalau Anda menekan Enter, pindah dari kolom ini, atau menutup dialog. Tekan Escape untuk memakai judul itu.`,
    dataLama: (message: string) => `Data terbaru belum terbaca (${message}). Yang tampil adalah data terakhir.`,
    // "Budi (Anda)", "Budi (bukan anggota proyek lagi)", "Budi (Anda, bukan anggota proyek lagi)".
    namaOrang: (name: string, mine: boolean, former = false) => {
      const notes = [mine ? "Anda" : "", former ? "bukan anggota proyek lagi" : ""].filter(Boolean);
      return notes.length > 0 ? `${name} (${notes.join(", ")})` : name;
    },
    // "Jumat, 27 Nov" lalu "4 hari lagi". relatif kosong = tidak ditampilkan.
    sisaHari: (n: number) => {
      if (n === 0) return "hari ini";
      if (n === 1) return "besok";
      return n < 0 ? `terlambat ${-n} hari` : `${n} hari lagi`;
    },
    hapusJudul: (code: string) => `Hapus task ${code}?`,
    hapusTombol: (code: string) => `Hapus ${code}`,
    // '"Revisi denah" beserta 5 subtask, 3 komentar, dan 5 catatan waktu ikut terhapus ...'
    hapusIsi: (title: string, subtasks: number, comments: number, entries: number) => {
      const parts = [
        subtasks > 0 ? `${subtasks} subtask` : "",
        comments > 0 ? `${comments} komentar` : "",
        entries > 0 ? `${entries} catatan waktu` : "",
      ].filter(Boolean);
      let ikut = "";
      if (parts.length === 1) ikut = ` beserta ${parts[0]}`;
      else if (parts.length === 2) ikut = ` beserta ${parts[0]} dan ${parts[1]}`;
      else if (parts.length === 3) ikut = ` beserta ${parts[0]}, ${parts[1]}, dan ${parts[2]}`;
      return `"${title}"${ikut} terhapus dari board semua anggota proyek dan dari Task saya. Mira belum punya cara mengembalikannya.`;
    },
  },
};

export default id;
