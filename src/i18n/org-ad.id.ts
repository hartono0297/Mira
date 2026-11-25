// Teks Active Directory di halaman Organisasi: blok AD di kartu Permintaan
// bergabung (src/screens/org/JoinRequestsPanelAd.tsx) dan bagian Active
// Directory di tab Departemen (src/screens/org/AdSettings.tsx).
const id = {
  card: {
    title: "Active Directory",
    // Sebelum cek selesai atau kalau cek gagal, yang tampil adalah data AD yang
    // ditulis laptop peminta sendiri. Setelah cek berhasil, nilai dari direktori.
    reported: "Dilaporkan laptop peminta, belum terbukti lewat AD.",
    verified: "Diperiksa ke AD dari laptop ini.",
    emptyInDirectory: "Kosong di AD",
    // Pembanding di bawah nilai direktori, hanya kalau berbeda.
    claimValue: (value: string) => `Dilaporkan laptop peminta: ${value}`,
    // Akun AD yang sama sudah dipakai anggota aktif: tanda kemungkinan penyamaran.
    usedByTitle: (name: string) => `Akun AD ini sudah dipakai ${name} di kantor ini.`,
    usedByBody: "Pastikan ini orang yang sama sebelum menyetujui.",
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
      exists: "Akun ada dan aktif di AD, tapi nama dan departemen tidak bisa dibandingkan",
      mismatch: "Berbeda dengan AD",
      // Laptop peminta melaporkan data AD yang tidak sama dengan direktori.
      claimMismatch: (fields: string) => `Data AD dari laptop peminta tidak sama dengan AD: ${fields}`,
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
    claimFields: { name: "nama", department: "departemen", location: "lokasi" },
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
  // Tawaran di atas halaman Organisasi (superadmin, 0.6.0): kantor belum punya
  // domain AD dan laptop ini tergabung di domain. Domain selalu dari data.
  domainOffer: {
    title: (domain: string) => `Pakai ${domain} sebagai domain AD kantor ini?`,
    body: (domain: string) =>
      `Laptop baru yang login dengan akun domain ${domain} akan mengisi nama dari akun Windows-nya, dan departemen kalau sudah dicocokkan. Admin tetap menyetujui setiap permintaan.`,
    use: (domain: string) => `Pakai ${domain}`,
    later: "Sembunyikan",
    saving: "Menyimpan...",
    saved: (domain: string) => `Domain AD kantor ini sekarang ${domain}.`,
    hidden: "Tawaran disembunyikan. Domain AD bisa diatur kapan saja di tab Departemen, bagian Active Directory.",
    saveFail: "Domain AD belum disimpan",
    blocked: (domain: string) => `${domain} baru bisa dipakai setelah laptop berikut memperbarui Mira:`,
  },
  // "Cocokkan OU ini ke departemen..." di blok AD kartu permintaan (superadmin, 0.6.0).
  match: {
    open: "Cocokkan OU ini ke departemen...",
    openAria: (name: string) => `Cocokkan OU ini ke departemen (akun ${name})`,
    loading: "Memuat pengaturan AD...",
    loadFailTitle: "Pengaturan AD belum terbaca",
    retry: "Coba lagi",
    noDomain: "Kantor ini belum punya domain AD, jadi OU belum bisa dicocokkan. Atur domainnya dulu.",
    setupDomain: "Atur domain AD",
    blocked: "Pemetaan OU belum bisa diubah sampai laptop berikut memperbarui Mira:",
    ouLegend: "OU yang dicocokkan",
    ouHint: "Dari OU paling luar ke paling dalam.",
    innermost: "paling dalam",
    tooLong: (max: number) => `terlalu panjang, paling banyak ${max} karakter`,
    deptLabel: "Departemen di Mira",
    choose: "Pilih departemen",
    noDepartments: "Belum ada departemen terbuka. Buat departemen dulu di tab Departemen.",
    errDept: "Pilih departemen.",
    submit: "Cocokkan",
    submitting: "Mencocokkan...",
    cancel: "Batal",
    saveFail: "OU belum dicocokkan",
    conflict: (ou: string, dept: string) =>
      `OU ${ou} sudah dicocokkan ke departemen ${dept}, mungkin baru saja oleh admin lain. Kalau perlu diganti, ubah di tab Departemen, bagian Active Directory.`,
    full: (max: number) =>
      `Pemetaan OU sudah ${max} baris. Hapus baris yang tidak dipakai di tab Departemen, bagian Active Directory.`,
    done: (ou: string, dept: string) =>
      `OU ${ou} sekarang dicocokkan ke departemen ${dept}. Laptop baru dari OU ini akan mendapat usulan departemen ${dept}.`,
    doneOther: (team: string) => ` Permintaan ini tetap ke departemen ${team} yang dipilih peminta.`,
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
