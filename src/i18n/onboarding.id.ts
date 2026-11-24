// Teks alur onboarding (src/screens/onboarding). Sumber kebenaran; versi
// Inggris di onboarding.en.ts. Komponen membacanya lewat onboarding/texts.ts.
import { JOIN_NOTE_MAX_CHARS } from "../api/join";

const id = {
  step: {
    name: "Langkah 1 dari 3",
    find: "Langkah 2 dari 3",
    wait: "Langkah 3 dari 3",
  },
  resume: "Memeriksa permintaan bergabung yang tersimpan...",
  firewall: {
    heading: "Izinkan Mira di jaringan kantor",
    checking: (name: string) => `Memeriksa ${name}...`,
    lead: (name: string) =>
      `Laptop rekan perlu bisa menyambung ke laptop ini. Untuk itu, ${name} perlu mengizinkan Mira.`,
    inviteLead: (name: string) =>
      `Kode undangan diperiksa oleh laptop rekan lewat jaringan kantor. Pastikan ${name} mengizinkan Mira.`,
    // Tombol lanjut saat Mira dibuka dengan --siapkan-kantor.
    setupContinue: "Lanjut siapkan kantor",
    backToInvite: "Kembali ke kode undangan",
    search: "Cari kantor",
    skip: "Lewati, atur nanti",
  },
  name: {
    heading: "Siapa nama Anda?",
    lead: "Admin kantor memakai nama ini untuk memastikan permintaan bergabung memang dari Anda.",
    label: "Nama tampilan",
    hint: "Rekan kerja melihat nama ini di chat dan di board. 1 sampai 50 karakter.",
    submit: "Lanjut",
    saving: "Menyimpan...",
    saveFailed: "Nama belum tersimpan",
    // Nama terisi dari akun domain Windows (onboarding-ad).
    adSource: (domain: string) => `Diisi dari akun Windows Anda (${domain}). Ubah kalau perlu.`,
  },
  device: {
    error: "Nama dan alamat laptop ini belum terbaca. Pencarian tetap berjalan.",
    reading: "Membaca nama laptop ini...",
    laptop: "Laptop ini",
    address: "Alamat",
    offline: "Belum tersambung ke jaringan",
  },
  search: {
    heading: "Mencari kantor di jaringan...",
    lead: "Mira mencari kantor yang memakai Mira di Wi-Fi atau LAN yang sedang dipakai laptop ini.",
    searching: "Mencari",
    stopsAfter: (seconds: number) => `Pencarian berhenti sendiri setelah ${seconds} detik.`,
    // Mira dibuka dengan --siapkan-kantor: mencari dulu sebelum kantor baru.
    setupLead: "Sebelum menyiapkan kantor baru, Mira memeriksa apakah sudah ada kantor Mira di jaringan ini.",
    cancel: "Batal",
    grace: {
      title: "Kantor ditemukan, memeriksa kantor lain...",
      hint: "Sebentar, Mira menunggu jawaban dari kantor lain di jaringan yang sama.",
    },
  },
  notFound: {
    headingSearched: "Kantor belum ditemukan",
    headingOther: "Cari kantor dengan cara lain",
    leadSearched:
      "Tidak ada kantor Mira yang terlihat di jaringan ini. Ini biasa terjadi kalau Anda tersambung lewat VPN, atau memakai Wi-Fi tamu yang terpisah dari jaringan kantor.",
    leadOther:
      "Kalau kantor Anda tidak muncul di pencarian, sambungkan langsung ke laptop rekan atau pakai kode undangan.",
    mdnsTitle: "Pencarian otomatis tidak berjalan di laptop ini",
    mdnsHint: "Pakai alamat laptop rekan atau kode undangan di bawah.",
    incompleteTitle: "Pencarian tidak selesai",
    addressLabel: "Masukkan alamat laptop rekan",
    addressHint:
      "Minta alamat IP dari rekan yang sudah memakai Mira. Alamatnya ada di Mira milik rekan, menu Pengaturan, bagian Jaringan.",
    addressPlaceholder: "contoh: 192.168.1.20",
    addressEmpty: "Isi alamat laptop rekan dulu, misalnya 192.168.1.20.",
    noOfficeAtAddress:
      "Tidak ada kantor yang menjawab dari alamat itu. Periksa alamatnya, dan pastikan Mira di laptop rekan sedang terbuka.",
    connect: "Hubungkan",
    connecting: "Menghubungkan...",
    connectFailed: "Laptop rekan belum tersambung",
    inviteTitle: "Pakai kode undangan",
    inviteDesc: "Kode dari admin kantor atau admin departemen.",
    searchAgain: "Cari lagi",
    // Hanya kantor versi lama yang terlihat (onboarding-ad bagian 6).
    headingLegacy: "Kantor ditemukan, tapi belum bisa menerima permintaan",
  },
  // Kantor dengan laptop Mira 0.1 atau 0.2: terlihat, tapi belum bisa menerima permintaan.
  legacy: {
    title: "Kantor dengan Mira versi lama",
    unnamed: "Kantor tanpa nama",
    item: (name: string, laptops: number) => `${name} (${laptops} laptop)`,
    body: "Supaya Anda bisa bergabung:",
    update:
      "Minta admin kantor atau rekan di kantor itu memperbarui Mira di laptopnya dengan menjalankan lagi perintah pasang Mira, lalu tekan Cari lagi.",
    invite: "Atau minta kode undangan ke admin kantor, lalu pilih Pakai kode undangan.",
  },
  adminIt: {
    summary: "Untuk admin IT",
    explain:
      "Kantor baru disiapkan sekali saja oleh admin IT atau superadmin, di laptop orang pertama yang memakai Mira. Orang lain tinggal meminta bergabung.",
    button: "Siapkan Mira untuk kantor baru",
    // Kantor lain sudah terlihat: peringatan dan konfirmasi sebelum kantor baru.
    seenTitle: "Sudah ada kantor Mira di jaringan ini",
    seenNamed: (names: string) =>
      `Kantor yang terlihat: ${names}. Biasanya Anda cukup meminta bergabung ke kantor itu. Kantor kedua memisahkan Anda dari rekan yang sudah memakai Mira.`,
    seenUnnamed:
      "Ada laptop di jaringan ini yang sudah tergabung ke kantor Mira, walau belum menjawab. Biasanya Anda cukup meminta bergabung ke kantor itu. Kantor kedua memisahkan Anda dari rekan yang sudah memakai Mira.",
    joinSeen: "Minta bergabung ke kantor itu",
    // Frasa yang diketik untuk tetap membuat kantor baru.
    confirmPhrase: "kantor baru",
    confirmLabel: (phrase: string) => `Tetap perlu kantor baru? Ketik "${phrase}" untuk melanjutkan.`,
    confirmMismatch: (phrase: string) => `Ketik "${phrase}" persis, lalu tekan tombolnya lagi.`,
    confirmButton: "Tetap siapkan kantor baru",
    // Domain AD laptop ini sama dengan domain kantor yang terlihat: tanpa kantor baru.
    sameDomain: (domain: string, names: string) =>
      `Laptop ini memakai domain ${domain}, sama dengan kantor ${names}. Satu domain kantor hanya untuk satu kantor Mira, jadi minta bergabung ke kantor itu.`,
    // Layar --siapkan-kantor setelah pencarian singkat menemukan kantor.
    setupHeading: "Periksa dulu sebelum menyiapkan kantor baru",
    otherWay: "Cari dengan cara lain",
  },
  office: {
    nameSummary: "Nama:",
    editName: "Ubah",
    // Nama aksesibel memuat teks yang terlihat ("Ubah"), lalu menyebut apa yang diubah.
    editNameLabel: "Ubah nama",
    noteLabel: "Keterangan untuk admin (opsional)",
    noteHint: `Misalnya jabatan atau nomor karyawan, supaya admin lebih mudah mengenali Anda. Paling banyak ${JOIN_NOTE_MAX_CHARS} karakter.`,
    noteCount: (n: number) => `${n} dari ${JOIN_NOTE_MAX_CHARS} karakter`,
    noteForbidden: "Keterangan berisi karakter yang tidak diizinkan.",
    // Data yang ikut permintaan dan disimpan kantor. Kantor dengan laptop v0.3
    // (acceptsNote false) tidak menerima akun login dan keterangan.
    sharedWithNote:
      "Nama Anda, nama laptop, nama akun login laptop ini, alamat IP, dan keterangan tersimpan di catatan kantor dan bisa dilihat admin kantor.",
    shared: "Nama Anda, nama laptop, dan alamat IP tersimpan di catatan kantor dan bisa dilihat admin kantor.",
    submit: "Kirim permintaan",
    sending: "Mengirim permintaan...",
    pickOffice: "Pilih kantor Anda dulu.",
    pickTeam: "Pilih departemen Anda dulu.",
    headingOne: (name: string) => `Kantor ditemukan: ${name}`,
    // Kantor dipakai langsung karena domainnya sama; namanya ada di ringkasan.
    headingMine: "Kantor Anda ditemukan",
    headingMany: "Beberapa kantor ditemukan",
    subOne: "Kantor ini memakai Mira di jaringan yang sama dengan laptop Anda.",
    leadMany: (n: number) =>
      `Ada ${n} kantor yang memakai Mira di jaringan ini. Pilih kantor Anda. Kalau ragu, tanyakan sidik organisasinya ke admin kantor.`,
    twinsTitle: "Ada dua kantor dengan nama atau identitas yang sama",
    twinsBody:
      "Salah satunya bisa jadi tiruan. Telepon admin kantor dan cocokkan sidik organisasi di layar ini dengan sidik di menu Organisasi miliknya sebelum meminta bergabung.",
    fingerprint: "Sidik organisasi",
    offices: "Kantor",
    conflict: "Identitasnya bentrok dengan kantor lain. Cocokkan sidiknya dulu.",
    sameName: "Namanya sama dengan kantor lain.",
    noDeptTitle: "Kantor ini belum punya departemen",
    noDeptBody:
      "Setiap orang masuk ke satu departemen. Minta admin kantor membuat departemen dulu di menu Organisasi, lalu cari lagi.",
    team: "Departemen",
    teamPlaceholder: "Pilih departemen",
    teamPickOfficeFirst: "Pilih kantor dulu",
    teamHint: "Daftar ini dibuat admin kantor. Pilihan departemen tidak bisa Anda ubah sendiri nanti.",
    // Diikuti sidik organisasi dan titik.
    conflictBody:
      "Ada kantor lain dengan identitas yang sama. Telepon admin kantor dan minta ia membacakan sidik organisasi di menu Organisasi miliknya. Kirim permintaan hanya kalau sidiknya sama dengan",
    // Diikuti sidik organisasi.
    conflictConfirm: "Sidik dari admin kantor sama dengan",
    sendFailed: "Permintaan belum terkirim",
    notYours: "Bukan kantor Anda?",
    otherWay: "Cari dengan cara lain",
    // Data akun domain Windows (onboarding-ad). Hanya tampil di laptop dengan akun domain.
    ad: {
      officeMatch: (domain: string) => `Domain kantor Anda: ${domain}`,
      // Ringkasan kantor yang dipakai langsung karena domainnya sama.
      officeSummary: "Kantor:",
      officeWithDomain: (name: string, domain: string) => `${name} (${domain})`,
      changeOffice: "Ubah",
      changeOfficeLabel: "Ubah kantor",
      // Beberapa kantor dengan domain sama: yang dibuat paling awal.
      // Waktu dibuat ditulis sendiri oleh pembuat kantor, jadi tidak terdengar pasti.
      primary: (domain: string) => `Kantor utama untuk ${domain} (dibuat paling awal menurut catatan kantor itu)`,
      laterSameDomain:
        "Domainnya sama, tapi menurut catatannya dibuat lebih baru. Pilih hanya kalau admin kantor memintanya, dan cocokkan sidiknya dulu.",
      // Departemen usulan dari atribut department atau OU di Active Directory.
      deptFromAccount: (dept: string) => `Dari akun Windows Anda: ${dept}`,
      // Atribut department, atau OU paling dalam, yang belum dipetakan admin.
      deptUnmatched: (dept: string) =>
        `Departemen Anda di akun Windows (${dept}) belum dicocokkan admin dengan departemen di Mira. Pilih departemen sendiri.`,
      deptNone: "Akun Windows Anda tidak mencantumkan departemen. Pilih departemen sendiri.",
      // Sama dengan judul kotak di layar menunggu; tidak mengklaim daftar lengkap.
      boxTitle: "Yang dilihat admin",
      name: "Nama",
      team: "Departemen",
      teamNone: "Belum dipilih",
      account: "Akun Windows",
      location: "Lokasi di Active Directory",
      note: "Keterangan",
      partial:
        "Sebagian data akun Windows tidak terbaca karena server kantor tidak terjangkau. Admin akan memeriksanya lagi.",
      // Alasan data akun Windows terbaca tapi tidak dipakai (satu baris di
      // bawah pilihan departemen).
      skip: {
        // Laptop anggota yang menjawab tidak melaporkan jumlahnya (Mira lama).
        outdated:
          "Ada laptop di kantor ini yang belum diperbarui ke Mira 0.5, jadi data akun Windows Anda belum bisa dipakai. Pilih departemen sendiri.",
        outdatedCount: (n: number) =>
          `Ada ${n} laptop di kantor ini yang belum diperbarui ke Mira 0.5, jadi data akun Windows Anda belum bisa dipakai. Pilih departemen sendiri.`,
        noDomain:
          "Domain kantor ini belum diatur, jadi data akun Windows Anda belum dipakai. Pilih departemen sendiri. Admin bisa mengatur domainnya nanti.",
        otherDomain: (office: string, mine: string) =>
          `Domain kantor (${office}) berbeda dengan domain akun Anda (${mine}), jadi data akun Windows Anda tidak dipakai. Pilih departemen sendiri.`,
        noUser: "Nama akun Windows Anda belum terbaca, jadi datanya belum dipakai. Pilih departemen sendiri.",
      },
      // Di dalam kotak: data AD ikut op persetujuan yang disalin ke semua laptop anggota.
      stored:
        "Nama, departemen, akun Windows, dan lokasi di Active Directory ikut tersimpan di catatan kantor dan bisa dilihat anggota kantor.",
    },
  },
  waiting: {
    adminSees: "Yang dilihat admin",
    note: "Keterangan",
    account: "Akun login",
    // Di luar kotak admin: permintaan tanpa keterangan bisa berbentuk v0.3,
    // dan admin tidak melihat akun login pada permintaan seperti itu.
    accountFact: "Akun login laptop ini",
    heading: "Menunggu persetujuan",
    lead: (team: string) =>
      `Permintaan Anda sudah dikirim ke admin kantor dan admin departemen ${team}. Layar ini berganti sendiri begitu disetujui.`,
    name: "Nama",
    team: "Departemen",
    laptop: "Laptop",
    laptopUnknown: "belum terbaca",
    code: "Kode cocok",
    fingerprint: "Sidik organisasi",
    codeHint:
      "Kalau admin bertanya, sebutkan kode cocok ini. Kode yang sama muncul di layarnya, jadi ia tahu yang disetujui memang laptop Anda.",
    undeliveredTitle: "Belum ada laptop rekan yang menerima permintaan ini",
    undeliveredHint: "Mira terus mencoba selama layar ini terbuka, dan mengirim ulang saat Mira dibuka lagi.",
    pollTitle: "Status persetujuan belum bisa diperiksa",
    pollHint: "Mira mencoba lagi tiap 5 detik.",
    slowTitle: "Kalau lama",
    slow: [
      "Mira boleh ditutup. Permintaan tersimpan dan dikirim ulang saat Mira dibuka lagi.",
      "Laptop penyetuju harus menyala dan tersambung ke jaringan yang sama.",
      "Hubungi admin kantor langsung dan sebutkan nama laptop Anda.",
    ],
    cancelFailed: "Permintaan belum dibatalkan",
    cancel: "Batalkan permintaan",
    cancelling: "Membatalkan...",
    adAccount: "Akun Windows",
    adLocation: "Lokasi di Active Directory",
  },
  rejected: {
    heading: "Permintaan ditolak",
    // Penolak tanpa nama, di awal kalimat.
    someone: "Admin kantor",
    lead: (who: string, org: string, team: string, when: string | null) =>
      `${who} menolak permintaan Anda untuk bergabung ke ${org}, departemen ${team}${when ? ` pada ${when}` : ""}.`,
    askWhy: (who: string) =>
      `Tanyakan alasannya langsung ke ${who}. Kalau ternyata keliru, kirim permintaan lagi. Permintaan baru mendapat kode cocok baru, jadi cocokkan lagi kodenya dengan penyetuju.`,
    // Penolak tanpa nama, di tengah kalimat.
    askWhyFallback: "admin kantor",
    sendFailed: "Permintaan belum terkirim",
    deleteFailed: "Permintaan lama belum terhapus",
    searchOther: "Cari kantor lain",
    deleting: "Menghapus permintaan...",
    resend: "Kirim permintaan lagi",
    sending: "Mengirim...",
  },
  join: {
    heading: "Gabung dengan kode undangan",
    lead: "Minta kode undangan ke admin kantor atau admin departemen Anda. Kode berisi 20 huruf dan angka, misalnya ABCD-EFGH-JKMN-PQRS-TVWX.",
    nameLabel: "Nama tampilan",
    nameHint: "Nama yang dilihat rekan kerja, 1 sampai 50 karakter.",
    codeLabel: "Kode undangan",
    codeHint: "Huruf besar atau kecil sama saja. Spasi dan tanda strip boleh ikut ditempel.",
    addressToggle: "Rekan tidak ditemukan otomatis?",
    addressLabel: "Alamat laptop rekan (boleh dikosongkan)",
    addressHint:
      "Minta rekan membuka Pengaturan, bagian Jaringan, di Mira. Isi alamat yang tertera di sana, misalnya 192.168.1.20 atau 192.168.1.20:47800, atau tempel tautan yang diawali mira://.",
    searchingTitle: "Mencari laptop rekan dan memeriksa kode...",
    searchingHint: "Ini bisa makan waktu sampai 20 detik. Biarkan jendela ini terbuka.",
    checkFirewall: (name: string) => `Periksa ${name}`,
    reload: "Muat ulang data laptop ini",
    back: "Kembali",
    submit: "Gabung ke organisasi",
    submitting: "Mencari...",
  },
  newOffice: {
    confirmLabel: "Ketik ulang nama organisasi",
    confirmHint: "Untuk memastikan, ketik nama organisasi persis seperti di atas.",
    confirmMismatch: "Belum sama dengan nama organisasi di atas. Periksa huruf dan spasinya.",
    created: (org: string) => `Organisasi ${org} sudah dibuat`,
    deptPendingTitle: (dept: string) => `Departemen ${dept} belum selesai disiapkan`,
    deptPendingHint: "Buat departemen dan masukkan diri Anda ke sana dari menu Organisasi setelah Mira terbuka.",
    open: "Buka Mira",
    heading: "Siapkan Mira untuk kantor baru",
    firstOnlyTitle: "Hanya untuk orang pertama di kantor",
    firstOnlyColleagues:
      "Kalau rekan Anda sudah memakai Mira, kembali dan minta alamat laptopnya atau kode undangan. Membuat kantor kedua memisahkan Anda dari rekan.",
    firstOnlyHidden:
      "Kantor yang tidak ditemukan belum tentu belum ada. Kalau Anda memakai VPN atau Wi-Fi yang terpisah, kantor Anda bisa tidak terlihat dari laptop ini.",
    orgLabel: "Nama organisasi",
    orgPlaceholder: "contoh: nama kantor Anda",
    orgHint: "2 sampai 80 karakter, biasanya nama kantor atau perusahaan.",
    nameLabel: "Nama Anda",
    namePlaceholder: "Nama yang dikenal rekan kantor",
    nameHint: "Nama tampilan yang dilihat rekan kerja, 1 sampai 50 karakter.",
    deptLabel: "Departemen Anda",
    deptPlaceholder: "contoh: Manajemen",
    deptHint: "Departemen lain dibuat nanti di menu Organisasi.",
    superadmin: "Anda menjadi superadmin. Angkat satu superadmin lagi sebagai cadangan.",
    failed: "Organisasi belum dibuat",
    reload: "Muat ulang data laptop ini",
    back: "Kembali",
    submit: "Buat organisasi",
    saving: "Menyiapkan kantor...",
    orgFromDomain: "Diisi dari domain kantor. Ganti dengan nama yang dikenal rekan, misalnya MACF.",
    adLabel: "Domain Active Directory (opsional)",
    adPlaceholder: "contoh: kantor.co.id",
    adHint:
      "Dipakai Mira untuk mengenali laptop kantor dan mengisi nama serta departemen orang baru dari akun Windows mereka. Boleh dikosongkan.",
    adInvalid: "Tulis domain seperti kantor.co.id, tanpa spasi atau garis miring.",
  },
};

export default id;
