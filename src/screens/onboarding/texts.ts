// Teks baru alur onboarding v0.4 (docs/plans/v04-onboarding.md), dikumpulkan di
// satu tempat supaya terjemahan bahasa Inggris nanti cukup mengganti berkas ini.
import { JOIN_NOTE_MAX_CHARS } from "../../api/join";

export const STEP = {
  name: "Langkah 1 dari 3",
  find: "Langkah 2 dari 3",
  wait: "Langkah 3 dari 3",
};

export const NAME_STEP = {
  heading: "Siapa nama Anda?",
  lead: "Admin kantor memakai nama ini untuk memastikan permintaan bergabung memang dari Anda.",
  label: "Nama tampilan",
  hint: "Rekan kerja melihat nama ini di chat dan di board. 1 sampai 50 karakter.",
  submit: "Lanjut",
  saving: "Menyimpan...",
  saveFailed: "Nama belum tersimpan",
};

export const CHECKING_FIREWALL = (name: string) => `Memeriksa ${name}...`;

export const FIREWALL_LEAD = (name: string) =>
  `Laptop rekan perlu bisa menyambung ke laptop ini. Untuk itu, ${name} perlu mengizinkan Mira.`;

export const FIREWALL_INVITE_LEAD = (name: string) =>
  `Kode undangan diperiksa oleh laptop rekan lewat jaringan kantor. Pastikan ${name} mengizinkan Mira.`;

// Tombol lanjut di langkah firewall saat Mira dibuka dengan --siapkan-kantor.
export const FIREWALL_SETUP_CONTINUE = "Lanjut siapkan kantor";

export const SEARCH_GRACE = {
  title: "Kantor ditemukan, memeriksa kantor lain...",
  hint: "Sebentar, Mira menunggu jawaban dari kantor lain di jaringan yang sama.",
};

export const OFFICE_STEP = {
  nameSummary: "Nama:",
  editName: "Ubah",
  // Nama aksesibel memuat teks yang terlihat ("Ubah"), lalu menyebut apa yang diubah.
  editNameLabel: "Ubah nama",
  noteLabel: "Keterangan untuk admin (opsional)",
  noteHint: `Misalnya jabatan atau nomor karyawan, supaya admin yakin ini Anda. Paling banyak ${JOIN_NOTE_MAX_CHARS} karakter.`,
  noteCount: (n: number) => `${n} dari ${JOIN_NOTE_MAX_CHARS} karakter`,
  noteForbidden: "Keterangan berisi karakter yang tidak diizinkan.",
  submit: "Kirim permintaan",
  sending: "Mengirim permintaan...",
};

// Hitungan karakter keterangan baru tampil kalau sisa 15 karakter atau kurang.
export const NOTE_COUNT_FROM = JOIN_NOTE_MAX_CHARS - 15;

export const WAITING = {
  adminSees: "Yang dilihat admin",
  note: "Keterangan",
  account: "Akun login",
  // Di luar kotak admin: permintaan tanpa keterangan bisa berbentuk v0.3,
  // dan admin tidak melihat akun login pada permintaan seperti itu.
  accountFact: "Akun login laptop ini",
};

export const ADMIN_IT = {
  summary: "Untuk admin IT",
  explain:
    "Kantor baru disiapkan sekali saja oleh admin IT atau superadmin, di laptop orang pertama yang memakai Mira. Orang lain tinggal meminta bergabung.",
  button: "Siapkan Mira untuk kantor baru",
  officeSeen:
    "Di jaringan ini sudah ada kantor Mira, jadi jangan menyiapkan kantor baru. Minta bergabung ke kantor itu lewat Cari lagi, alamat laptop rekan, atau kode undangan.",
};

export const NEW_OFFICE = {
  confirmLabel: "Ketik ulang nama organisasi",
  confirmHint: "Untuk memastikan, ketik nama organisasi persis seperti di atas.",
  confirmMismatch: "Belum sama dengan nama organisasi di atas. Periksa huruf dan spasinya.",
};
