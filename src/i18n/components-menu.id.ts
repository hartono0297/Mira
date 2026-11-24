// Teks menu klik kanan bersama: menu kolom teks dan dialog konfirmasi aksi menu.
const id = {
  label: "Menu teks",
  cut: "Potong",
  copy: "Salin",
  paste: "Tempel",
  selectAll: "Pilih semua",
  noSelection: "Belum ada teks yang dipilih",
  readOnly: "Kolom ini hanya bisa dibaca",
  secret: "Isi kolom rahasia tidak bisa disalin",
  empty: "Kolom ini masih kosong",
  failed: (action: string) => `${action} gagal`,
};

export default id;
