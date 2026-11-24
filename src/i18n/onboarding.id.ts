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
    stopsAfter: "Pencarian berhenti sendiri setelah 15 detik.",
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
  },
  adminIt: {
    summary: "Untuk admin IT",
    explain:
      "Kantor baru disiapkan sekali saja oleh admin IT atau superadmin, di laptop orang pertama yang memakai Mira. Orang lain tinggal meminta bergabung.",
    button: "Siapkan Mira untuk kantor baru",
    officeSeen:
      "Di jaringan ini sudah ada kantor Mira, jadi jangan menyiapkan kantor baru. Minta bergabung ke kantor itu lewat Cari lagi, alamat laptop rekan, atau kode undangan.",
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
  },
};

export default id;
