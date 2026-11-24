// Teks format layar Chat: hari, bulan, jam, ukuran file, cakupan, bagian daftar, status kirim.
// Dipakai fungsi murni di src/screens/chat/text.ts dan ListFormat.ts.
const id = {
  days: ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"],
  months: [
    "Januari",
    "Februari",
    "Maret",
    "April",
    "Mei",
    "Juni",
    "Juli",
    "Agustus",
    "September",
    "Oktober",
    "November",
    "Desember",
  ],
  today: "Hari ini",
  yesterday: "Kemarin",
  // "Senin, 23 November 2026"
  date: (weekday: string, day: number, month: string, year: number) => `${weekday}, ${day} ${month} ${year}`,
  // "09.12"
  time: (hours: string, minutes: string) => `${hours}.${minutes}`,
  dateTime: (date: string, time: string) => `${date} pukul ${time}`,
  decimalSeparator: ",",
  bytes: (n: number) => `${n} byte`,

  // Penulis pesan sendiri dan akhiran nama sendiri di daftar orang.
  you: "Anda",
  youSuffix: " (Anda)",
  deleted: "Pesan dihapus",

  // Status kirim di channel dan grup.
  readCount: (read: number, total: number) => `Dibaca ${read} dari ${total}`,
  deliveredCount: (delivered: number, total: number) => `Diterima ${delivered} dari ${total}`,

  // Cakupan di bawah judul percakapan.
  scope: {
    project: "Proyek",
    direct: "Pesan pribadi",
    org: "Seluruh kantor",
    group: "Grup",
    team: (name: string) => `Departemen ${name}`,
    projectNamed: (name: string) => `Proyek ${name}`,
  },
  // Awalan nama: "Departemen Desain", "Proyek Alfa". Nama yang sudah diawali kata ini tidak diberi awalan lagi.
  prefix: {
    team: "Departemen",
    project: "Proyek",
    group: "Grup",
  },

  // Judul bagian daftar percakapan.
  sections: {
    umum: "Umum",
    departemen: "Departemen",
    proyek: "Proyek",
    grup: "Grup",
    pribadi: "Pesan pribadi",
  },

  // Pembaca layar: "3 pesan belum dibaca, 1 menyebut Anda".
  unread: (n: number) => `${n} pesan belum dibaca`,
  mentionsYou: (n: number) => `${n} menyebut Anda`,
};

export default id;
