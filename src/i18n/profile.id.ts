// Teks foto profil: Pengaturan > Profil, daftar Foto anggota (superadmin), dan
// menu profil di sidebar. Teks dialog pemotong ada di profile-crop.*.
const id = {
  section: {
    loading: "Membaca foto profil...",
    loadErrorTitle: "Foto profil belum terbaca",
    retry: "Coba baca lagi",
    change: "Ganti foto",
    remove: "Hapus foto",
    noPhoto: "Belum ada foto. Rekan melihat inisial nama Anda.",
    visibleTo: "Foto tampil di samping nama Anda di laptop semua anggota organisasi, termasuk Tamu.",
    processing: "Mira memotong foto menjadi persegi 256 piksel dan membuang data lokasi dan kamera dari file.",
    removedTitle: "Foto Anda dihapus superadmin",
    removedBody: "Rekan melihat inisial nama Anda. Anda bisa memasang foto lain lewat Ganti foto.",
    changeFailed: "Foto belum bisa dipakai",
    saved: "Foto profil disimpan.",
    removed: "Foto profil dihapus.",
  },
  confirmRemove: {
    title: "Hapus foto profil?",
    body: "Rekan akan melihat inisial nama Anda lagi. Laptop yang sedang tidak tersambung ikut berubah setelah tersambung.",
    busy: "Menghapus...",
    failed: "Foto belum terhapus",
  },
  members: {
    heading: "Foto anggota",
    intro: "Hapus foto yang tidak pantas. Pemiliknya tetap bisa memasang foto lain.",
    loading: "Membaca foto anggota...",
    loadErrorTitle: "Foto anggota belum terbaca",
    empty: "Belum ada anggota lain yang memasang foto.",
    removeLabel: (name: string) => `Hapus foto ${name}`,
    confirmTitle: (name: string) => `Hapus foto ${name}?`,
    confirmBody: (name: string) =>
      `Foto ini hilang dari laptop semua anggota. ${name} melihat catatan bahwa fotonya dihapus superadmin dan bisa memasang foto lain.`,
    removed: (name: string) => `Foto ${name} dihapus.`,
  },
  menu: {
    label: "Menu profil Anda",
    change: "Ganti foto",
    remove: "Hapus foto",
    open: "Buka profil",
    dismiss: "Tutup",
  },
};

export default id;
