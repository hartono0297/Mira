// Teks tab Undangan (src/screens/org/InvitesPanel.tsx) dan dialog pembuat kode
// undangan (src/screens/org/InviteDialog.tsx).
const id = {
  panel: {
    createdBy: (name: string, when: string) => `Dibuat oleh ${name}, ${when}.`,
    usedBy: (names: string) => ` Dipakai oleh ${names}.`,
    validUntil: (when: string) => ` Berlaku sampai ${when}.`,
    endedAt: (when: string) => ` Berakhir ${when}.`,
    revoked: (team: string) => `Kode undangan untuk ${team} dicabut. Kode itu tidak bisa dipakai lagi.`,
    redeemTitle: "Pakai kode undangan",
    redeemHint: "Anda belum masuk departemen mana pun. Admin yang mengundang Anda memberikan kodenya.",
    title: "Kode undangan",
    create: "Buat kode undangan",
    hint: "Isi kode hanya ditampilkan sekali, saat kode dibuat. Di sini terlihat status dan masa berlakunya.",
    noOpenDepartment:
      "Kode baru belum bisa dibuat karena belum ada departemen yang tidak diarsipkan. Buat atau pulihkan departemen di tab Departemen.",
    emptyManage: "Belum ada kode undangan. Buat kode untuk mengundang orang baru ke departemen.",
    emptyNoOpen:
      "Belum ada kode undangan. Kode hanya bisa dibuat untuk departemen yang tidak diarsipkan, dan saat ini belum ada. Buat atau pulihkan departemen di tab Departemen.",
    emptyNone: "Belum ada kode undangan yang bisa Anda kelola. Kode undangan dibuat oleh admin departemen dan superadmin.",
    revokeAria: (label: string) => `Cabut kode undangan ${label}`,
    revoke: "Cabut",
    revokeTitle: (label: string) => `Cabut kode undangan ${label}?`,
    revokeTitleFallback: "Cabut kode undangan?",
    revokeConfirm: "Cabut kode",
    revoking: "Mencabut...",
    revokeFailed: "Kode belum dicabut",
    revokeBody:
      "Orang yang belum memakai kode ini tidak bisa bergabung dengannya lagi. Orang yang sudah bergabung lewat kode ini tetap di organisasi. Pencabutan tidak bisa dibatalkan. Kalau masih perlu, buat kode baru.",
  },
  dialog: {
    roleDesc: {
      member: "Chat di departemen ini, buat dan kerjakan task di proyek yang ia ikuti.",
      team_admin:
        "Menyetujui permintaan bergabung ke departemen ini, membuat kode undangan dan proyek departemen, dan mengatur anggota proyeknya.",
      guest: "Melihat board dan membaca komentar di proyek yang dipilih. Tidak bisa mengubah task atau berkomentar.",
    },
    validityHint: {
      "24h": "Bisa dipakai beberapa orang sampai 24 jam setelah kode dibuat.",
      "7d": "Bisa dipakai beberapa orang sampai 7 hari setelah kode dibuat.",
      once: "Untuk satu orang. Kode hangus setelah dipakai, atau setelah 7 hari kalau belum dipakai.",
    },
    validity: {
      "24h": "24 jam",
      "7d": "7 hari",
      once: "Sekali pakai",
    },
    titleReady: "Kode undangan siap",
    titleTo: (team: string) => `Undang ke ${team}`,
    titleDefault: "Undang ke departemen",
    pickAtLeastOne: "Centang minimal satu proyek yang boleh dilihat Tamu.",
    sendCode:
      "Kirim kode ini ke orang yang Anda undang lewat jalur yang Anda percaya, misalnya langsung atau lewat pesan pribadi. Ia memasukkannya saat membuka Mira pertama kali.",
    copy: "Salin kode",
    role: "Peran",
    roleIn: (role: string, team: string) => `${role} di ${team}`,
    projects: "Proyek",
    hiddenProject: "Proyek yang tidak terlihat di laptop ini",
    validUntil: "Berlaku sampai",
    once: ", untuk satu orang",
    shownOnce:
      "Kode ini hanya ditampilkan sekali. Setelah dialog ditutup, Mira tidak bisa menampilkannya lagi. Kalau kode hilang, cabut kode ini lalu buat yang baru.",
    done: "Selesai",
    department: "Departemen",
    noTeams: "Anda belum mengelola departemen mana pun. Kode undangan selalu untuk satu departemen.",
    guestProjects: "Proyek yang boleh dilihat",
    guestHint: (max: number) =>
      `Tamu hanya bisa melihat board dan komentar proyek yang dicentang, tidak bisa mengubah task. Paling banyak ${max} proyek.`,
    loadingProjects: "Memuat proyek departemen...",
    projectsError: "Daftar proyek belum terbaca",
    projectsRetry: "Coba baca lagi",
    noProjects: (team: string | null) =>
      `${team ? `Departemen ${team}` : "Departemen ini"} belum punya proyek yang terlihat di laptop ini. Proyek hanya terlihat kalau Anda anggotanya. Buat proyek untuk departemen ini di menu Board, atau minta pengelola proyek menambahkan Anda, lalu undang Tamu ke proyek itu.`,
    atMax: (max: number) => `Sudah ${max} proyek, batas satu kode undangan.`,
    validFor: "Kode berlaku selama",
    forbidden: "Anda tidak punya izin mengundang ke departemen ini",
    failed: "Kode belum dibuat",
    cancel: "Batal",
    creating: "Membuat kode...",
    create: "Buat kode undangan",
  },
};

export default id;
