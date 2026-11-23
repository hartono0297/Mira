// Catatan "Yang baru" per versi, dibundel ke aplikasi supaya tampil tanpa internet.
// Berkas yang sama dibaca skrip rilis untuk latest.json, jadi isinya tetap
// Markdown sederhana: paragraf, daftar "- ", dan subjudul "## ".
const files = import.meta.glob<string>("./*.md", { query: "?raw", import: "default", eager: true });

const notes: Record<string, string> = {};
for (const [path, text] of Object.entries(files)) {
  const version = path.replace(/^\.\//, "").replace(/\.md$/, "");
  notes[version] = text;
}

export function notesFor(version: string | null): string | null {
  if (!version) return null;
  const text = notes[version.replace(/^v/, "")];
  return text && text.trim() ? text : null;
}
