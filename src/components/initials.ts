// Inisial untuk avatar: dua kata pertama, huruf besar.
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => [...p][0] ?? "");
  return letters.join("").toUpperCase() || "?";
}
