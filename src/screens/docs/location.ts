import type { ProjectSummary } from "../../api/board";
import { projectLabel } from "./text";

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

// Lokasi yang dimuat layar:
// - pending: menunggu daftar proyek (proyek yang diingat belum dipastikan,
//   atau Tamu yang belum tahu proyek pertamanya), supaya Pustaka Umum tidak
//   sempat tampil;
// - library: Pustaka Umum;
// - project: satu proyek;
// - none: Tamu tanpa proyek (Tamu tidak melihat Pustaka Umum, documents::scope::may_view);
// - unavailable: Tamu, dan daftar proyek gagal dibaca.
export type ResolvedLocation =
  | { kind: "pending" }
  | { kind: "library" }
  | { kind: "project"; id: string; label: string }
  | { kind: "none" }
  | { kind: "unavailable" };

export function resolveLocation(
  chosen: DocsLocation,
  projects: ProjectSummary[] | null,
  listFailed: boolean,
  isGuest: boolean,
): ResolvedLocation {
  if (chosen) {
    const found = projects?.find((p) => p.id === chosen.projectId);
    return found ? { kind: "project", id: found.id, label: projectLabel(found) } : { kind: "pending" };
  }
  if (!isGuest) return { kind: "library" };
  if (!projects) return listFailed ? { kind: "unavailable" } : { kind: "pending" };
  const first = projects[0];
  return first ? { kind: "project", id: first.id, label: projectLabel(first) } : { kind: "none" };
}

export function writeLocation(location: DocsLocation) {
  try {
    const value = location ? { projectId: location.projectId, label: location.label } : { projectId: null };
    window.localStorage.setItem(DOCS_LOCATION_KEY, JSON.stringify(value));
  } catch {
    // Penyimpanan browser tidak tersedia: pilihan hanya diingat selama layar terbuka.
  }
}
