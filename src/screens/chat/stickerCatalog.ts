// Katalog sticker dan emote bersama untuk layar Chat dan Organisasi (v0.6.0,
// docs/plans/chat-sticker.md bagian 7). Satu salinan di modul ini: kolom pesan, daftar
// pesan (emote sebaris), dan panel sticker kantor membaca data yang sama tanpa provider.
// Dimuat saat pertama dipakai, lalu dimuat ulang setiap event chat dan setelah aksi.
import { useSyncExternalStore } from "react";
import { chatApi, subscribeChat, type OfficeSticker, type StickerCatalog } from "../../api/chat";

type Snapshot = { catalog: StickerCatalog | null; error: unknown };

let snapshot: Snapshot = { catalog: null, error: null };
const listeners = new Set<() => void>();
let stopEvents: (() => void) | null = null;
let inflight: Promise<void> | null = null;
let again = false;

function emit() {
  for (const l of listeners) l();
}

// Memuat ulang katalog. Panggilan yang datang selagi memuat digabung jadi satu muat ulang lagi.
export function reloadStickerCatalog(): Promise<void> {
  if (inflight) {
    again = true;
    return inflight;
  }
  inflight = (async () => {
    do {
      again = false;
      try {
        const catalog = await chatApi.stickers();
        snapshot = { catalog, error: null };
      } catch (error) {
        snapshot = { catalog: snapshot.catalog, error };
      }
      emit();
    } while (again);
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

// Untuk tes dan setelah keluar organisasi.
export function resetStickerCatalog(catalog: StickerCatalog | null = null) {
  snapshot = { catalog, error: null };
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!stopEvents) {
    stopEvents = subscribeChat(() => void reloadStickerCatalog());
    // Selalu muat ulang: selama tidak ada pendengar, event chat tidak diikuti dan katalog
    // bisa sudah basi (sticker kantor baru dari laptop lain, emoji baru dipakai).
    void reloadStickerCatalog();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopEvents) {
      stopEvents();
      stopEvents = null;
    }
  };
}

function getSnapshot() {
  return snapshot;
}

export function useStickerCatalog(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Emote kantor yang aktif menurut nama (tanpa titik dua). Kalau dua sticker memakai nama yang
// sama, yang nameTaken false menang (inti Rust sudah menandai yang kalah).
export function officeEmoteMap(catalog: StickerCatalog | null): Map<string, OfficeSticker> {
  const map = new Map<string, OfficeSticker>();
  if (!catalog) return map;
  for (const s of catalog.office) {
    if (s.state !== "active" || s.nameTaken) continue;
    if (!map.has(s.name)) map.set(s.name, s);
  }
  return map;
}
