// Teks reaksi, reaksi cepat, dan pesan sticker di daftar pesan (v0.5.1). Diekspor sebagai
// REACTION dari src/i18n/chat-reaction.ts.

const id = {
  // Daftar chip di bawah pesan.
  bar: (author: string, time: string) => `Reaksi untuk pesan ${author} pukul ${time}`,
  // Label lengkap chip untuk pembaca layar: "👍 3. Rina, Dimas, Sari."
  chip: (emoji: string, count: number, names: string) => `${emoji} ${count}. ${names}.`,
  chipMine: (emoji: string, count: number, names: string) => `${emoji} ${count}, termasuk Anda. ${names}.`,
  // Keterangan saat chip disorot atau difokus: "Rina, Dimas, dan 2 lainnya memberi 👍".
  tip: (who: string, emoji: string) => `${who} memberi ${emoji}`,
  // Chip di percakapan yang tidak bisa diberi reaksi (channel diarsipkan, bukan anggota lagi).
  tipReadOnly: "Reaksi tidak bisa diubah di percakapan ini.",
  you: "Anda",
  joinTwo: (a: string, b: string) => `${a} dan ${b}`,
  joinMany: (head: string, last: string) => `${head}, dan ${last}`,
  others: (n: number) => `${n} lainnya`,
  people: (n: number) => `${n} orang`,
  add: (author: string, time: string) => `Tambah reaksi ke pesan ${author} pukul ${time}`,

  // Bilah aksi pesan.
  quickGroup: (author: string, time: string) => `Reaksi cepat untuk pesan ${author} pukul ${time}`,
  quick: (emoji: string) => `Reaksi ${emoji}`,
  more: (author: string, time: string) => `Reaksi lain untuk pesan ${author} pukul ${time}`,
  moreShort: "Reaksi lain",
  picker: (author: string, time: string) => `Pilih reaksi untuk pesan ${author} pukul ${time}`,

  // Hasil aksi.
  added: (emoji: string) => `Reaksi ${emoji} ditambahkan.`,
  removed: (emoji: string) => `Reaksi ${emoji} dihapus.`,
  failed: (detail: string) => `Reaksi belum tersimpan. ${detail}`,

  // Pesan sticker.
  sticker: "Sticker",
  stickerFetching: "Gambar sticker sedang diambil dari laptop rekan.",
  stickerMissing: "Gambar sticker muncul setelah laptop rekan yang menyimpannya online.",
};

export default id;
