// Catatan "Yang baru" per versi, dibundel ke aplikasi supaya tampil tanpa internet.
// Berkas yang sama dibaca skrip rilis untuk latest.json, jadi isinya tetap
// Markdown sederhana: paragraf, daftar "- ", dan subjudul "## ".
// Versi Inggris opsional: <versi>.en.md. Kalau belum ada, versi Indonesia dipakai.
import { getLang, type Lang } from "../i18n/core";

const files = import.meta.glob<string>("./*.md", { query: "?raw", import: "default", eager: true });

const notes: Record<Lang, Record<string, string>> = { id: {}, en: {} };
for (const [path, text] of Object.entries(files)) {
  const name = path.replace(/^\.\//, "").replace(/\.md$/, "");
  const en = name.match(/^(.+)\.en$/);
  if (en) notes.en[en[1]] = text;
  else notes.id[name] = text;
}

function usable(text: string | undefined): string | null {
  return text && text.trim() ? text : null;
}

export function notesFor(version: string | null, lang: Lang = getLang()): string | null {
  if (!version) return null;
  const v = version.replace(/^v/, "");
  return (lang === "en" ? usable(notes.en[v]) : null) ?? usable(notes.id[v]);
}
