// Satu cache Kopi untuk seluruh aplikasi. Ikon di samping nama muncul di banyak
// tempat sekaligus (daftar chat, pesan, board), jadi ringkasan dimuat sekali di
// sini, bukan per komponen. Muat ulang saat event fitur "kopi" atau "board"
// datang (Kopi dari kerja dihitung dari board), dan polling 60 detik sebagai
// cadangan. Di luar aplikasi desktop kopiApi menolak, overview tetap null.
import { useSyncExternalStore } from "react";
import { subscribeFeature } from "../api";
import { kopiApi, type KopiBadge, type KopiOverview } from "../api/kopi";

export const KOPI_POLL_MS = 60_000;

type Snapshot = {
  overview: KopiOverview | null;
  badges: Map<string, KopiBadge>;
};

const EMPTY: Snapshot = { overview: null, badges: new Map() };

let snap: Snapshot = EMPTY;
let seq = 0;
const listeners = new Set<() => void>();
let stopSources: (() => void) | null = null;

function emit() {
  for (const fn of [...listeners]) fn();
}

function set(overview: KopiOverview | null) {
  const badges = new Map<string, KopiBadge>();
  for (const b of overview?.badges ?? []) badges.set(b.publicKey, b);
  snap = { overview, badges };
  emit();
}

// Memuat ulang ringkasan. Hasil muatan lama yang selesai belakangan diabaikan.
// Kalau gagal, data terakhir tetap dipakai.
export function reloadKopi(): Promise<void> {
  const mine = ++seq;
  return (async () => {
    try {
      const next = await kopiApi.overview();
      if (mine === seq) set(next);
    } catch {
      // Inti belum siap atau di luar Tauri: tetap pakai data terakhir.
    }
  })();
}

function start() {
  void reloadKopi();
  const stopKopi = subscribeFeature("kopi", () => void reloadKopi());
  const stopBoard = subscribeFeature("board", () => void reloadKopi());
  const timer = setInterval(() => void reloadKopi(), KOPI_POLL_MS);
  stopSources = () => {
    stopKopi();
    stopBoard();
    clearInterval(timer);
  };
}

function subscribeStore(fn: () => void): () => void {
  listeners.add(fn);
  if (listeners.size === 1 && !stopSources) start();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && stopSources) {
      stopSources();
      stopSources = null;
    }
  };
}

const getSnap = () => snap;

function badgeFrom(s: Snapshot, pk: string): KopiBadge | null {
  return s.badges.get(pk) ?? null;
}

export type UseKopi = {
  overview: KopiOverview | null;
  badgeOf(pk: string): KopiBadge | null;
  reload(): Promise<void>;
};

export function useKopi(): UseKopi {
  const s = useSyncExternalStore(subscribeStore, getSnap, getSnap);
  return {
    overview: s.overview,
    badgeOf: (pk: string) => badgeFrom(s, pk),
    reload: reloadKopi,
  };
}

// Untuk tes: kosongkan cache dan hentikan sumber muat ulang.
export function resetKopiStore(): void {
  stopSources?.();
  stopSources = null;
  listeners.clear();
  seq++;
  snap = EMPTY;
}
