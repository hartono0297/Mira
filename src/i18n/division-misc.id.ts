// Teks divisi di luar tab Departemen saya: dialog Proyek baru dan pemetaan OU AD.
const id = {
  newProject: {
    label: "Untuk divisi",
    none: "Bukan proyek divisi",
    // Pilihan ditulis "Divisi, Departemen" supaya divisi bernama sama di departemen lain tetap terbedakan.
    option: (division: string, department: string) => `${division}, ${department}`,
    hint: "Boleh dikosongkan. Kalau dipilih, departemen proyek mengikuti divisi itu.",
    picked: (division: string) => `Anggota divisi ${division} otomatis ikut menjadi anggota proyek.`,
    // Ringkasan di bawah pemilih orang kalau divisi dipilih.
    summaryNone: (division: string) =>
      `Belum ada orang lain yang dipilih: proyek ini berisi anggota divisi ${division} dan Anda sebagai pengelola.`,
    summaryPicked: (picked: string, division: string) =>
      `${picked}, ditambah anggota divisi ${division} dan Anda sebagai pengelola.`,
  },
  ad: {
    colDivision: "Divisi",
    none: "Tanpa divisi",
    chooseDeptFirst: "Pilih departemen dulu",
    noDivisions: "Belum ada divisi",
    archivedOption: (name: string) => `${name} (diarsipkan)`,
    unknownOption: "Divisi tidak dikenal",
    note: "OU yang lebih dalam bisa dipetakan ke divisi. Orang yang disetujui lewat AD otomatis masuk divisi itu.",
    loadFailed: (message: string) => `Daftar divisi belum terbaca (${message}).`,
    retry: "Baca ulang divisi",
  },
};

export default id;
