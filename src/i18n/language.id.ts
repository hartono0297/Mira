// Teks pemilih bahasa (Pengaturan dan langkah pertama onboarding).
const id = {
  legend: "Bahasa",
  hint: "Berlaku langsung di laptop ini. Rekan tetap memakai pilihan mereka sendiri.",
  userText: "Pesan, nama, dan isi yang ditulis rekan tidak diterjemahkan.",
  saving: "Menyimpan pilihan bahasa...",
  errorTitle: "Bahasa belum tersimpan",
  errorBody: (message: string, kept: string) => `${message} Pilihan dikembalikan ke ${kept}. Coba pilih lagi.`,
};

export default id;
