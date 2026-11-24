// Teks chat divisi dan pengaturan chat departemen (v0.6): baris sidebar, catatan disematkan,
// dialog ubah catatan, dan pengganti kolom pesan saat mode pengumuman aktif.
const id = {
  // Nama baris di sidebar untuk pembaca layar.
  row: (name: string) => `Chat divisi ${name}`,

  pinned: {
    label: "Catatan disematkan",
    edit: "Ubah",
    editLabel: "Ubah catatan disematkan",
    add: "Sematkan catatan",
    more: "Tampilkan semua",
    less: "Ringkas",
    announceOn: "Mode pengumuman aktif",
    saved: "Catatan disimpan.",
  },

  dialog: {
    title: "Catatan dan mode pengumuman",
    descTeam: "Berlaku untuk channel departemen ini. Semua anggota departemen melihat catatannya di atas chat.",
    descDivision: "Berlaku untuk chat divisi ini. Semua anggota divisi melihat catatannya di atas chat.",
    note: "Catatan disematkan",
    noteHint: "Kosongkan untuk menghapus catatan. Baris baru tetap seperti yang Anda tulis.",
    count: (used: number, max: number) => `${used} dari ${max} karakter`,
    tooLong: (max: number) => `Catatan paling panjang ${max} karakter.`,
    announce: "Mode pengumuman",
    announceTeam: "Hanya admin departemen dan superadmin yang bisa menulis.",
    announceDivision: "Hanya kepala divisi, admin departemen, dan superadmin yang bisa menulis.",
    cancel: "Batal",
    save: "Simpan",
    saving: "Menyimpan...",
    failed: "Pengaturan chat belum tersimpan",
  },

  gate: {
    team: "Hanya admin departemen dan superadmin yang bisa menulis di channel ini. Untuk menanggapi, kirim pesan pribadi ke salah satu dari mereka.",
    division:
      "Hanya kepala divisi, admin departemen, dan superadmin yang bisa menulis di chat ini. Untuk menanggapi, kirim pesan pribadi ke salah satu dari mereka.",
  },
};

export default id;
