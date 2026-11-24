import type { DeptOverview } from "../../api/division";
import type { OrgPage } from "./context";

// Yang dibagi ke setiap bagian tab Departemen saya.
export type DeptCtx = {
  page: OrgPage;
  ov: DeptOverview;
  // Ada aksi yang sedang berjalan di halaman: semua tombol aksi menunggu.
  busy: boolean;
  // Op divisi dan pengaturan chat boleh ditulis: gerbang versi terbuka dan
  // departemen tidak diarsipkan. Rust tetap memeriksa ulang.
  canWrite: boolean;
  onOpenChat?: (conv: string) => void;
};

export const PINNED_MAX = 500;

// Panjang dihitung per karakter seperti `chars().count()` di Rust, bukan per unit UTF-16.
export function charCount(text: string): number {
  return [...text].length;
}

// Aturan nama divisi sama dengan nama departemen (`is_canonical_team_name`).
export function validDivisionName(name: string): boolean {
  const n = charCount(name.trim());
  return n >= 2 && n <= 60 && ![...name].some(isControl);
}

function isControl(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return c < 0x20 || c === 0x7f;
}

// Catatan disematkan: baris baru boleh, karakter kendali lain tidak.
export function validPinned(text: string): boolean {
  return ![...text].some((ch) => ch !== "\n" && isControl(ch));
}
