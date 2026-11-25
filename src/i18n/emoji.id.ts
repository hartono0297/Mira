// Teks pemilih emoji (src/components/emoji/EmojiPicker.tsx), v0.5.1.

const id = {
  dialog: "Pilih emoji",
  search: "Cari emoji",
  searchPlaceholder: "Cari, misalnya jempol atau kopi",
  categories: "Kategori emoji",
  category: {
    recent: "Baru dipakai",
    office: "Emote kantor",
    faces: "Wajah",
    people: "Gestur dan orang",
    symbols: "Hati dan simbol",
    nature: "Hewan dan alam",
    food: "Makanan dan minuman",
    activity: "Kegiatan dan kantor",
    travel: "Perjalanan dan tempat",
    flags: "Bendera",
  },
  results: (query: string) => `Hasil untuk "${query}"`,
  noResults: (query: string) => `Tidak ada emoji untuk "${query}". Coba kata lain, misalnya senyum.`,
  emptyRecent: "Emoji yang Anda pakai akan muncul di sini.",
};

export default id;
