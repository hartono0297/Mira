// Teks tab Label di halaman Organisasi (src/screens/org/LabelsPanel.tsx).
const id = {
  // Menu klik kanan baris label. Label item sama dengan tombol di baris.
  menu: {
    label: (name: string) => `Aksi untuk label ${name}`,
    assign: "Atur orang",
    rename: "Ganti nama",
    remove: "Hapus",
    restore: "Pulihkan",
    busy: "Tunggu perubahan yang sedang disimpan.",
  },
  badData: "Inti Mira mengirim data label yang tidak terbaca.",
  // Validasi nama
  nameEmpty: "Isi nama label dulu.",
  nameTooLong: (max: number, now: number) => `Nama label paling banyak ${max} karakter (sekarang ${now}).`,
  nameSame: "Nama ini sama dengan nama sekarang.",
  nameTaken: (name: string) => `Label ${name} sudah ada.`,
  nameTakenRemoved: (name: string) =>
    `Label ${name} ada di bagian Dihapus. Pulihkan label itu supaya orang yang dulu memakainya ikut kembali.`,
  restored: (name: string) => `Label ${name} dipulihkan dan kembali tampil di samping nama orang yang dulu memakainya.`,
  restoreFail: (name: string) => `Label ${name} belum dipulihkan`,
  title: "Label",
  intro: (max: number) =>
    `Label tampil di samping nama di chat, daftar pengguna, dan pemilih orang. Paling banyak ${max} label tampil di samping satu nama. Hanya superadmin yang mengatur label.`,
  newLabel: "Label baru",
  loading: "Memuat daftar label...",
  loadErrorTitle: "Daftar label belum terbaca",
  loadErrorEmpty: "Inti Mira tidak mengirim daftar label.",
  retry: "Coba lagi",
  stale: (message: string) => `Daftar label terbaru belum bisa dibaca (${message}). Yang tampil adalah data terakhir.`,
  empty:
    "Belum ada label. Buat label untuk keahlian atau posisi, misalnya Drafter atau K3, lewat tombol Label baru, lalu pasang ke orang.",
  allRemoved: "Semua label sudah dihapus. Pulihkan dari bagian Dihapus di bawah, atau buat lewat tombol Label baru.",
  activeList: "Label aktif",
  removedFold: (n: number) => `Dihapus (${n})`,
  removedHint:
    "Label yang dihapus tidak tampil di samping nama siapa pun. Pulihkan supaya label kembali ke orang yang dulu memakainya.",
  removedList: "Label yang dihapus",
  // Baris label
  unassigned: "Belum dipasang ke siapa pun",
  people: (n: number) => `${n} orang`,
  srLabelComma: (name: string) => `, label ${name}`,
  srLabel: (name: string) => `label ${name}`,
  noneSaved: "Tidak ada orang tersimpan",
  saved: (n: number) => `${n} orang tersimpan`,
  restoringBtn: "Memulihkan... ",
  restoreBtn: "Pulihkan ",
  // Isian nama
  nameLabel: "Nama label",
  nameHint: (max: number) => `1 sampai ${max} karakter, misalnya Drafter, K3, atau Senior.`,
  cancel: "Batal",
  // Label baru
  created: (name: string) => `Label ${name} dibuat.`,
  assignTitle: (name: string) => `Atur orang untuk label ${name}`,
  later: "Atur nanti",
  createdIntro: (name: string) =>
    `Label ${name} sudah dibuat. Centang orang yang memakainya lalu pilih Simpan, atau atur nanti lewat tombol Atur orang di barisnya.`,
  create: "Buat label",
  creating: "Membuat label...",
  createFail: "Label belum dibuat",
  // Ganti nama
  renamed: (from: string, to: string) => `Label ${from} sekarang bernama ${to}.`,
  renameTitle: (name: string) => `Ganti nama label ${name}`,
  saveName: "Simpan nama",
  savingName: "Menyimpan nama...",
  renameFail: "Nama label belum diganti",
  // Hapus
  deleted: (name: string) => `Label ${name} dihapus. Label ini bisa dipulihkan dari bagian Dihapus.`,
  deleteTitle: (name: string) => `Hapus label ${name}?`,
  deleteConfirm: (name: string) => `Hapus ${name}`,
  deleting: "Menghapus...",
  deleteFail: (name: string) => `Label ${name} belum terhapus`,
  deleteBodyCount: (name: string, n: number) =>
    `Label ${name} hilang dari samping nama ${n} orang dan tidak bisa dipasang lagi.`,
  deleteBody: (name: string) => `Label ${name} hilang dari daftar dan tidak bisa dipasang lagi.`,
  deleteKeep:
    "Daftar orang yang memakainya tetap tersimpan. Kalau nanti label ini dipulihkan dari bagian Dihapus, label kembali ke orang yang sama.",
  // Pemilih orang
  progress: (n: number, total: number) => `Menyimpan perubahan ${n} dari ${total}...`,
  assignDone: (name: string, added: number, removed: number) => {
    const parts: string[] = [];
    if (added > 0) parts.push(`dipasang ke ${added} orang`);
    if (removed > 0) parts.push(`dilepas dari ${removed} orang`);
    return `Label ${name} ${parts.join(" dan ")}.`;
  },
  pickerList: (name: string) => `Orang untuk label ${name}`,
  unsaved: (n: number) => `, ${n} perubahan belum disimpan`,
  tooMany: (others: number, max: number) =>
    `Sudah punya ${others} label lain. Di samping nama hanya tampil ${max} label pertama menurut abjad.`,
  stopAssign: (who: string) => `Berhenti saat memasang label ke ${who}`,
  stopRemove: (who: string) => `Berhenti saat melepas label dari ${who}`,
  noneStored: "Belum ada perubahan yang tersimpan.",
  someStored: (done: number, total: number) => `${done} dari ${total} perubahan sudah tersimpan.`,
  retryRest: "Pilih Simpan untuk mencoba sisanya.",
  saving: "Menyimpan...",
  save: "Simpan",
};

export default id;
