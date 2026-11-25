// Teks komponen bersama (src/components) dan nama sistem di src/platform.ts.
const id = {
  cancel: "Batal",
  copy: {
    label: "Salin",
    copied: "Tersalin",
    copiedLive: "Sudah disalin ke clipboard.",
    failed: "Tidak bisa menyalin otomatis. Pilih teksnya, lalu tekan Ctrl+C.",
  },
  labels: {
    // Dibacakan sebelum label: "Rina, label Arsitek, Senior".
    prefix: (_count: number) => ", label ",
    more: (count: number) => `, dan ${count} label lain`,
    // Dibacakan sebelum label yang berdiri sendiri di bawah nama: "Label: Arsitek, Senior".
    list: (_count: number) => "Label: ",
  },
  count: {
    more: (cap: number, meaning: string) => `lebih dari ${cap} ${meaning}`,
  },
  people: {
    guest: "Tamu",
    noDept: "Belum ada departemen",
    search: "Cari nama",
    dept: "Departemen",
    allDepts: "Semua departemen",
    selected: (count: number) => `${count} orang dipilih`,
    empty: "Belum ada orang di organisasi ini. Orang baru masuk lewat permintaan bergabung atau kode undangan.",
    filterName: (query: string) => `nama "${query}"`,
    filterDept: (dept: string) => `saringan ${dept}`,
    filterJoin: " dan ",
    noMatch: (filter: string) => `Tidak ada orang yang cocok dengan ${filter}.`,
    showAll: "Tampilkan semua orang",
    me: " (Anda)",
  },
  platform: {
    macFirewall: "Firewall macOS",
    macKeyStore: "Keychain macOS",
  },
};

export default id;
