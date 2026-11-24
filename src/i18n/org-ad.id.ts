// Teks Active Directory di halaman Organisasi: blok AD di kartu Permintaan
// bergabung (src/screens/org/JoinRequestsPanelAd.tsx) dan bagian Active
// Directory di tab Departemen (src/screens/org/AdSettings.tsx).
const id = {
  card: {
    title: "Active Directory",
    // Data AD ditulis laptop peminta sendiri; cek ulang dari laptop admin
    // hanya memastikan akunnya ada dan aktif.
    reported: "Dilaporkan laptop peminta, lalu diperiksa ulang dari laptop ini.",
    account: "Akun",
    name: "Nama di AD",
    department: "Departemen di AD",
    departmentMissing: (department: string) => `${department} (belum ada di Mira)`,
    // Dari OU paling luar ke paling dalam, sama dengan layar peminta.
    ous: "Lokasi di Active Directory",
    notSent: "Tidak dikirim",
    checking: "Memeriksa ke AD...",
    status: {
      // Sengaja tidak "Cocok": cek ini bukan bukti bahwa peminta pemilik akun itu.
      match: "Akun ada dan aktif di AD, nama dan departemen sama",
      mismatch: "Berbeda dengan AD",
      disabled: "Akun AD dinonaktifkan",
      notFound: "Akun tidak ditemukan di AD",
      unreachable: "AD tidak bisa dihubungi dari laptop ini",
      otherDomain: (domain: string) => `Laptop ini tidak tergabung di domain ${domain}, jadi tidak bisa memeriksa`,
      notDomainMachine: "Laptop ini tidak tergabung di domain, jadi tidak bisa memeriksa",
    },
    mismatchName: (directory: string, requested: string) => `Nama di AD: ${directory}, di permintaan: ${requested}`,
    mismatchDepartment: (directory: string, requested: string) =>
      `Departemen di AD: ${directory}, di permintaan: ${requested}`,
    nameNote: "Peminta boleh mengubah nama tampilan, jadi nama yang berbeda belum tentu masalah.",
    recheck: "Periksa lagi",
    recheckAria: (name: string) => `Periksa lagi akun AD ${name}`,
    limit:
      "Cek ini memastikan akun ada dan aktif di AD, bukan bahwa peminta adalah pemilik akun itu. Tetap cocokkan kode cocok di bawah.",
    outdatedTitle: "Mira di laptop peminta perlu diperbarui dulu",
    outdatedBody: (name: string) =>
      `Kantor ini memakai pengaturan Active Directory, dan Mira di laptop ${name} terlalu lama untuk itu. Minta ${name} memperbarui Mira, lalu setujui. Sebelum itu, Setujui akan ditolak.`,
  },
  settings: {
    title: "Active Directory",
    intro:
      "Laptop yang login dengan akun domain kantor mengisi nama dan departemen dari AD saat meminta bergabung. Admin tetap menyetujui setiap permintaan.",
    loading: "Memuat pengaturan Active Directory...",
    loadErrorTitle: "Pengaturan Active Directory belum terbaca",
    loadErrorEmpty: "Inti Mira tidak mengirim pengaturan Active Directory.",
    retry: "Coba lagi",
    readOnly: "Hanya superadmin yang bisa mengubah pengaturan ini.",
    blockedTitle: "Pengaturan AD belum bisa diubah",
    blockedBody:
      "Semua laptop anggota perlu Mira versi baru lebih dulu, supaya tidak ada yang tertinggal saat pengaturan ini dikirim. Laptop yang belum:",
    outdatedVersion: (name: string, version: string) => `${name}, versi ${version}`,
    outdatedUnknown: (name: string) => `${name}, versi belum dilaporkan`,
    domainLabel: "Domain AD",
    domainHint: "Contoh: kantor.co.id. Kosongkan kalau kantor tidak memakai AD.",
    errDomain: "Tulis domain seperti kantor.co.id, tanpa spasi atau garis miring.",
    useMachine: (domain: string) => `Pakai domain laptop ini: ${domain}`,
    mapTitle: "Pemetaan OU ke departemen",
    order:
      "Mira memakai atribut department di AD lebih dulu. Kalau atribut itu kosong, Mira mencocokkan OU akun dari yang paling dalam: dengan tabel ini, lalu dengan nama departemen yang sama. Departemen tidak dibuat otomatis.",
    caption: "Pemetaan OU ke departemen",
    colOu: "Nama OU",
    colDept: "Departemen",
    colActions: "Aksi",
    // Nama isian per baris untuk pembaca layar, misalnya "Nama OU baris 2".
    cellLabel: (column: string, n: number) => `${column} baris ${n}`,
    choose: "Pilih departemen",
    archivedOption: (name: string) => `${name} (diarsipkan)`,
    unknownOption: "Departemen tidak dikenal",
    remove: "Hapus",
    removeAria: (n: number) => `Hapus baris ${n}`,
    add: "Tambah baris",
    limit: (max: number) => `Paling banyak ${max} baris.`,
    empty: "Belum ada pemetaan. Tanpa pemetaan, Mira hanya mencocokkan OU dengan nama departemen yang sama.",
    errOuEmpty: "Isi nama OU.",
    errOuDuplicate: (row: number) => `OU ini sudah ada di baris ${row}.`,
    errDepartment: "Pilih departemen.",
    errSummary: "Periksa isian yang ditandai, lalu simpan lagi.",
    save: "Simpan pengaturan AD",
    saving: "Menyimpan...",
    saved: "Pengaturan Active Directory disimpan.",
    saveFail: "Pengaturan AD belum disimpan",
  },
  // Pemberitahuan di halaman Organisasi: laptop di jaringan yang tergabung di
  // kantor Mira lain (docs/plans/onboarding-ad.md bagian 6 butir 3). Hanya petunjuk.
  otherOffices: {
    title: (n: number) => `Ada ${n} laptop di jaringan ini yang tergabung di kantor Mira lain.`,
    names: (names: string) => `Kantor yang terlihat: ${names}.`,
    more: (n: number) => ` dan ${n} lainnya`,
    sameDomain: (n: number) =>
      `${n} di antaranya memakai domain AD yang sama dengan kantor ini, jadi kemungkinan ada kantor ganda. Superadmin kedua kantor perlu memutuskan kantor mana yang dipakai.`,
    hint: "Ini hanya petunjuk. Mira tidak menyatukan kantor secara otomatis.",
    // Hanya untuk superadmin: kantor lain dengan domain AD sama yang dibuat lebih dulu
    // (bagian 6.1 butir 3). Kantor itu dianggap kantor utama domain ini.
    older: {
      title: "Domain AD ini sudah dipakai kantor lain yang dibuat lebih dulu",
      office: (name: string, date: string) => `${name}, dibuat ${date}.`,
      fingerprint: "Sidik kantor itu:",
      body: "Kantor itu dianggap kantor utama domain ini, dan orang baru akan diarahkan ke sana. Data dua kantor tidak bisa digabung otomatis, jadi Anda yang perlu memutuskan, misalnya meminta anggota kantor ini bergabung ke kantor utama.",
    },
  },
};

export default id;
