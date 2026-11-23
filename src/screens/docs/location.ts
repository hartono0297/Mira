// Lokasi terakhir di layar Dokumen, diingat per laptop. Label ikut disimpan
// supaya catatan "Proyek X tidak tersedia lagi" tetap bisa menyebut namanya
// setelah proyek itu hilang dari daftar proyek saya.
export const DOCS_LOCATION_KEY = "mira.docs.location";

// null = Pustaka Umum.
export type DocsLocation = { projectId: string; label: string } | null;

export function readLocation(): DocsLocation {
  try {
    const raw = window.localStorage.getItem(DOCS_LOCATION_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const { projectId, label } = value as { projectId?: unknown; label?: unknown };
    if (typeof projectId !== "string" || projectId === "") return null;
    if (typeof label !== "string" || label === "") return null;
    return { projectId, label };
  } catch {
    return null;
  }
}

export function writeLocation(location: DocsLocation) {
  try {
    const value = location ? { projectId: location.projectId, label: location.label } : { projectId: null };
    window.localStorage.setItem(DOCS_LOCATION_KEY, JSON.stringify(value));
  } catch {
    // Penyimpanan browser tidak tersedia: pilihan hanya diingat selama layar terbuka.
  }
}
