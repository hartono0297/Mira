// Departemen dengan divisi orang itu, untuk daftar orang, Pengguna, dan profil:
// "IT Department · Mobile, Web". Titik tengah (U+00B7) memisahkan departemen dari
// divisinya, koma memisahkan divisi. Tanpa departemen: null, supaya pemanggil
// tetap menulis teks "Belum ada departemen" miliknya sendiri.
export const DIVISION_SEPARATOR = " · ";

export function deptWithDivisions(
  departmentName: string | null | undefined,
  divisions: readonly { name: string }[] | null | undefined,
): string | null {
  const dept = departmentName?.trim();
  if (!dept) return null;
  const names = (divisions ?? []).map((d) => d.name.trim()).filter(Boolean);
  if (names.length === 0) return dept;
  return `${dept}${DIVISION_SEPARATOR}${names.join(", ")}`;
}
