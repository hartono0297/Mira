// Teks dialog profil. Teks menu orang ada di menuText.ts.
const id = {
  title: (name: string) => `Profil ${name}`,
  me: " (Anda)",
  loading: "Memuat profil...",
  loadFailed: "Profil belum bisa dimuat",
  retry: "Coba lagi",
  retrying: "Memuat ulang...",
  notFound: (name: string) =>
    `Data organisasi di laptop ini belum mencatat ${name}, jadi peran, departemen, dan sidik kuncinya belum bisa ditampilkan.`,
  role: "Peran",
  department: "Departemen",
  noDepartment: "Belum ada departemen",
  deptAdmin: "admin departemen",
  fingerprint: "Sidik jari kunci",
  fingerprintNote: (name: string) =>
    `Untuk memastikan ini memang ${name}, minta dia membuka Pengaturan, bagian Laptop ini, lalu cocokkan sidiknya.`,
  fingerprintNoteMe: "Sidik kunci laptop ini. Rekan bisa mencocokkannya dengan yang tampil di Pengaturan Anda.",
  sendDm: "Kirim pesan pribadi",
  opening: "Membuka chat...",
  close: "Tutup",
};

export default id;
