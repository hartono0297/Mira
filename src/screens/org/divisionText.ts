import { DIVISION_TEXT } from "../../i18n/org-division";

// Departemen dengan divisi orang itu, untuk daftar orang, Pengguna, dan profil:
// "IT Department · Mobile (kepala), Web". Titik tengah (U+00B7) memisahkan departemen dari
// divisinya, koma memisahkan divisi. Tanpa departemen: null, supaya pemanggil
// tetap menulis teks "Belum ada departemen" miliknya sendiri.
export const DIVISION_SEPARATOR = " · ";

export function deptWithDivisions(
  departmentName: string | null | undefined,
  divisions: readonly { name: string; role?: "head" | "member" }[] | null | undefined,
): string | null {
  const dept = departmentName?.trim();
  if (!dept) return null;
  const names = (divisions ?? [])
    .map((d) => ({ name: d.name.trim(), head: d.role === "head" }))
    .filter((d) => d.name !== "")
    .map((d) => (d.head ? DIVISION_TEXT.members.headOf(d.name) : d.name));
  if (names.length === 0) return dept;
  return `${dept}${DIVISION_SEPARATOR}${names.join(", ")}`;
}
