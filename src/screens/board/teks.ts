// Teks antarmuka board v0.4 (subtask, pelacakan waktu, dialog task), dikumpulkan
// supaya mudah diterjemahkan nanti. Berkas ini titik masuknya:
// - TEKS di bawah: kartu board dan format durasi;
// - teksDialog.ts: dialog detail task (properti, tenggat, label, Lainnya, tab);
// - teksSubtask.ts: daftar subtask;
// - teksWaktu.ts: timer dan bagian Waktu.
// Semuanya diekspor ulang dari sini. Kalimat yang memuat angka ditulis sebagai
// fungsi kecil. Teks sebelum v0.4 masih ada di format.ts dan komponennya.

export const TEKS = {
  // Baris meta kartu board. Teks sr-only diawali koma karena dibaca menyambung
  // setelah kode task, sama dengan meta yang sudah ada.
  kartu: {
    subtaskSr: (done: number, total: number) => `, ${done} dari ${total} subtask selesai`,
    waktuSr: (durasi: string) => `, waktu tercatat ${durasi}`,
    timerBerjalanSr: ", timer berjalan",
  },

  // Format durasi (timeFormat.ts) dan isian durasi bebas (parseMinutes).
  waktu: {
    // "hr", bukan "h": "2h 5j" mudah terbaca 2 jam.
    pendek: { hari: "hr", jam: "j", menit: "m" },
    panjang: { hari: "hari", jam: "jam", menit: "menit" },
    kurangDariSemenit: "<1m",
    kurangDariSemenitPanjang: "kurang dari 1 menit",
    isian: {
      kosong: "Isi durasinya dulu, misalnya 1j 30m.",
      tidakDikenali: "Durasi tidak dikenali. Tulis misalnya 90, 1j 30m, 1:30, atau 1,5j.",
      terlaluSingkat: "Durasi paling singkat 1 menit.",
      terlaluLama: "Durasi paling lama 24 jam (1440 menit).",
    },
  },
} as const;

export * from "./teksDialog";
export * from "./teksSubtask";
export * from "./teksWaktu";
