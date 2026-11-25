// Aturan catatan disematkan, dipakai dialog di chat dan formulir di tab Departemen saya.
// Batasnya sama dengan inti Rust (PINNED_MAX_CHARS dan PINNED_MAX_LINES di
// src-tauri/src/permissions/division.rs).
export const PINNED_MAX = 500;
export const PINNED_MAX_LINES = 20;

// Catatan seperti yang diterima inti: baris baru boleh, karakter kendali lain dibuang (tab jadi
// spasi), tanpa spasi di awal dan akhir.
export function normalizePinned(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "")
    .trim();
}

// Panjang dihitung per karakter seperti `chars().count()` di Rust, bukan per unit UTF-16.
export function pinnedLength(value: string): number {
  return [...normalizePinned(value)].length;
}

export function pinnedLines(value: string): number {
  const note = normalizePinned(value);
  return note === "" ? 0 : note.split("\n").length;
}

// Alasan catatan belum bisa disimpan, atau null kalau sah.
export function pinnedProblem(value: string): "chars" | "lines" | null {
  if (pinnedLength(value) > PINNED_MAX) return "chars";
  if (pinnedLines(value) > PINNED_MAX_LINES) return "lines";
  return null;
}
