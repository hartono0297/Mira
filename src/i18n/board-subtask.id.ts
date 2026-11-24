// Teks bagian Subtask di dialog detail task. Batas sama dengan inti Rust
// (docs/plans/v04-board.md bagian 5). Dipakai lewat teksSubtask di src/screens/board/teksSubtask.ts.

export const SUBTASK_TITLE_MAX = 200;
export const SUBTASK_MAX = 100;

const id = {
  heading: "Subtask",
  progressLabel: "Subtask selesai",
  progressText: (done: number, total: number) => `${done} dari ${total} selesai`,
  progressShort: (done: number, total: number) => `${done}/${total}`,

  emptyEditable: "Belum ada subtask. Pecah task ini jadi langkah kecil yang bisa dicentang.",
  emptyReadOnly: "Belum ada subtask.",
  hint: "Enter menyimpan judul, Escape membatalkan. Alt + panah atas atau bawah memindah subtask. Shift + F10 di kotak centang membuka menu aksi subtask.",

  addButton: "Tambah subtask",
  newLabel: "Judul subtask baru",
  newPlaceholder: "Judul subtask, lalu Enter",
  newHint: "Enter menambah dan kolom tetap terbuka untuk subtask berikutnya. Escape menutup.",

  titleLabel: (pos: number, total: number) => `Judul subtask ${pos} dari ${total}`,
  checkLabel: (title: string) => `${title}`,
  deleteLabel: (title: string) => `Hapus subtask ${title}`,
  whoEmptyLabel: (title: string) => `Tetapkan penanggung jawab subtask ${title}`,
  whoLabel: (title: string, name: string) => `Ganti penanggung jawab subtask ${title} (sekarang ${name})`,
  whoMenuLabel: (title: string) => `Penanggung jawab subtask ${title}`,
  whoNone: "Tanpa penanggung jawab",
  whoStatic: (name: string) => `Penanggung jawab: ${name}`,
  dragHandle: "Seret untuk mengurutkan",

  you: (name: string) => `${name} (Anda)`,
  former: (name: string, mine: boolean) =>
    mine ? `${name} (Anda, bukan anggota proyek lagi)` : `${name} (bukan anggota proyek lagi)`,

  errEmpty: "Tulis judul subtask dulu.",
  errTooLong: (len: number) =>
    `Judul subtask paling banyak ${SUBTASK_TITLE_MAX} karakter. Sekarang ${len} karakter.`,
  errTooMany: `Task ini sudah punya ${SUBTASK_MAX} subtask, batas paling banyak. Hapus subtask yang tidak dipakai untuk menambah yang baru.`,
  errTitleEmpty: "Judul subtask tidak boleh kosong. Judul lama dipakai lagi.",

  saidAdded: (title: string) => `Subtask ${title} ditambahkan.`,
  saidSaved: "Judul subtask tersimpan.",
  saidReverted: "Perubahan judul dibatalkan.",
  saidDone: (done: number, total: number) => `Selesai. ${done} dari ${total} subtask selesai.`,
  saidReopened: (done: number, total: number) => `Dibuka lagi. ${done} dari ${total} subtask selesai.`,
  saidDeleted: (title: string) => `Subtask ${title} dihapus.`,
  saidMoved: (title: string, pos: number, total: number) => `${title} dipindah ke posisi ${pos} dari ${total}.`,
  saidTop: "Subtask ini sudah paling atas.",
  saidBottom: "Subtask ini sudah paling bawah.",
  saidAssigned: (title: string, name: string) => `Penanggung jawab ${title}: ${name}.`,
  saidUnassigned: (title: string) => `${title} tanpa penanggung jawab.`,
  saidDragCancelled: "Seret dibatalkan.",
};

export default id;
