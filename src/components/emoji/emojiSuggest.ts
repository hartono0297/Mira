// Saran emoji saat mengetik ":nama" di kolom pesan. Murni teks, tanpa React,
// supaya Composer dan tes bisa memakainya langsung.

const WORD = /[A-Za-z0-9_]/;
const MIN_QUERY = 2;

// ":nama" yang sedang diketik tepat sebelum kursor. Titik dua harus di awal teks
// atau setelah spasi atau baris baru, supaya "https://x" dan "10:30" tidak
// memunculkan saran. query selalu huruf kecil, start adalah posisi titik dua.
export function emojiQueryAt(text: string, caret: number): { start: number; query: string } | null {
  if (caret < 0 || caret > text.length) return null;
  let i = caret;
  while (i > 0 && WORD.test(text[i - 1])) i--;
  const query = text.slice(i, caret);
  if (query.length < MIN_QUERY) return null;
  const colon = i - 1;
  if (colon < 0 || text[colon] !== ":") return null;
  if (colon > 0 && !/\s/.test(text[colon - 1])) return null;
  return { start: colon, query: query.toLowerCase() };
}

// Ganti teks dari start sampai caret dengan insert, lalu letakkan kursor tepat
// setelah sisipan. Spasi setelah emoji, kalau perlu, ikut di insert.
export function applySuggestion(
  text: string,
  start: number,
  caret: number,
  insert: string,
): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(caret, text.length));
  return { text: text.slice(0, from) + insert + text.slice(to), caret: from + insert.length };
}
