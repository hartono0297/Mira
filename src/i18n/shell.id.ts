// Teks kerangka aplikasi: menu samping, panel jaringan, dan baris "saya".
const id = {
  nav: {
    chat: "Chat",
    board: "Board",
    calendar: "Kalender",
    docs: "Dokumen",
    sign: "Tanda tangan",
    org: "Organisasi",
    settings: "Pengaturan",
  },
  mainMenu: "Menu utama",
  // Tombol ringkas/lebarkan di bawah logo. keys: "Ctrl+B" atau "Cmd+B".
  sidebar: {
    collapse: "Ringkas menu",
    expand: "Lebarkan menu",
    withKeys: (label: string, keys: string) => `${label} (${keys})`,
  },
  // Arti angka di menu, dibacakan setelah labelnya: "Chat, 3 belum dibaca".
  // Parameter n hanya dipakai bahasa Inggris untuk jamak.
  countMeaning: {
    chat: (_n: number) => "belum dibaca",
    board: (_n: number) => "task tenggat hari ini atau lewat",
    sign: (_n: number) => "menunggu tanda tangan Anda",
    org: (_n: number) => "permintaan bergabung menunggu",
  },
  roleLabel: ", peran ",
  net: {
    region: "Jaringan kantor",
    checking: "Memeriksa jaringan...",
    unreadable: "Status jaringan belum terbaca",
    stale: "Belum bisa diperbarui. Yang tampil adalah status terakhir.",
    retry: "Coba baca lagi",
    onNetwork: "Di jaringan",
    emptyBefore: "Belum ada rekan di organisasi. Undang lewat menu",
    emptyAfter: ".",
    viaVpn: "lewat VPN",
    local: "di komputer ini",
    online: ", online",
    offline: ", offline",
    lastSeen: (when: string) => `Terakhir terlihat ${when}`,
    neverSeen: "Belum pernah terlihat",
    // Sidebar ringkas: satu ikon status. Klik membuka Organisasi. Titik di
    // akhir status ("Memeriksa jaringan...") dibuang supaya tidak berderet.
    dotLabel: (state: string) => `${state.replace(/\.+$/, "")}. Buka Organisasi`,
    // Status tidak terbaca: klik membaca ulang.
    dotRetry: (state: string) => `${state.replace(/\.+$/, "")}. Coba baca lagi`,
  },
};

export default id;
