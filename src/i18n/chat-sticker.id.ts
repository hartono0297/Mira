// Teks kolom pesan untuk emoji, saran :nama, dan pemilih sticker (v0.6.0).
// Dipakai src/screens/chat/Composer.tsx dan src/screens/chat/StickerPicker.tsx.
const id = {
  composer: {
    emoji: "Sisipkan emoji",
    sticker: "Kirim sticker",
    emojiList: "Saran emoji",
    // Label pilihan saran: emote kantor dibedakan dari emoji biasa lewat teks, bukan warna.
    emoteOption: (name: string) => `:${name}:, emote kantor`,
    emoteTag: "kantor",
    hint: "Ketik titik dua lalu nama untuk menyisipkan emoji.",
  },
  picker: {
    label: "Pilih sticker",
    tabs: "Jenis sticker",
    office: "Kantor",
    mine: "Punya saya",
    search: "Cari sticker",
    searchPlaceholder: "Nama atau kata kunci",
    loading: "Memuat sticker...",
    loadError: "Sticker belum bisa dimuat",
    retry: "Coba lagi",
    retrying: "Memuat ulang...",
    emptyOffice: "Belum ada sticker kantor. Superadmin bisa menambahkannya di Organisasi, tab Sticker.",
    emptyMine:
      "Belum ada sticker pribadi. Simpan sticker dari pesan lewat menu pesan, atau unggah gambar PNG, WebP, atau GIF.",
    noMatch: (query: string) => `Tidak ada sticker dengan nama atau kata kunci ${query}.`,
    notReady: "Gambarnya belum sampai di laptop ini, jadi belum bisa dikirim.",
    notReadyNote: "Sticker bergaris putus-putus belum sampai di laptop ini dan belum bisa dikirim.",
    sending: "Mengirim sticker...",
    sendError: "Sticker belum terkirim",
    upload: "Unggah sticker",
    uploadHint: "PNG, WebP, atau GIF, paling besar 512 KB dan 1024 x 1024 piksel.",
    pickError: "Gambar belum bisa dipilih",
    remove: (name: string) => `Hapus :${name}: dari sticker saya`,
    removeHint: "Tekan Delete untuk menghapus sticker yang sedang dipilih.",
    removeTitle: "Hapus sticker pribadi?",
    removeBody: (name: string) =>
      `:${name}: dihapus dari koleksi di laptop ini. Pesan yang sudah terkirim tetap menampilkannya.`,
    removeConfirm: "Hapus sticker",
    removing: "Menghapus...",
    removeError: "Sticker belum terhapus",
  },
  form: {
    title: "Sticker baru",
    details: (size: string, width: number, height: number) => `${size}, ${width} x ${height} piksel`,
    frames: (count: number) => `animasi ${count} frame`,
    name: "Nama",
    nameHint: "Dipakai sebagai :nama:. Huruf kecil, angka, dan garis bawah, 2 sampai 32 karakter.",
    nameInvalid: "Nama hanya boleh huruf kecil a sampai z, angka, dan garis bawah, 2 sampai 32 karakter.",
    keywords: "Kata kunci (boleh kosong)",
    keywordsHint: (max: number) => `Untuk pencarian. Pisahkan dengan koma atau spasi, paling banyak ${max}.`,
    tooManyKeywords: (max: number) => `Paling banyak ${max} kata kunci.`,
    keywordTooLong: (word: string) => `Kata kunci ${word} terlalu panjang. Paling banyak 24 karakter.`,
    save: "Simpan sticker",
    saving: "Menyimpan...",
    cancel: "Batal",
    saveError: "Sticker belum tersimpan",
  },
};

export default id;
