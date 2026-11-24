// Teks titik masuk Kopi di Chat dan Board: item menu pesan dan tombol terima
// kasih di detail task. Teks dialog dan profil Kopi ada di kamus kopi.*.
const id = {
  // Menu klik kanan pesan rekan
  give: "Beri kopi",
  givenMessage: "Sudah diberi kopi",
  limitShort: "Jatah kopi hari ini habis",

  // Detail task di kolom Selesai
  thank: (name: string) => `Terima kasih ke ${name}`,
  givenTask: (name: string) => `Anda sudah memberi ${name} kopi untuk task ini.`,
  limitLong: (limit: number) => `Jatah kopi hari ini habis (${limit} per hari). Besok bisa memberi lagi.`,
};

export default id;
