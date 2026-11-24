// Satu cache Kopi untuk seluruh aplikasi. Ikon di samping nama muncul di banyak
// tempat sekaligus (daftar chat, pesan, board), jadi ringkasan dimuat sekali di
// sini, bukan per komponen. Muat ulang saat event fitur "kopi" atau "board"
// datang (Kopi dari kerja dihitung dari board), dan polling 60 detik sebagai
// cadangan. Di luar aplikasi desktop kopiApi menolak, overview tetap null.
//
// Supaya kopi_overview tidak dipanggil bertubi-tubi:
// - event fitur dalam jendela 2 detik digabung jadi satu muat ulang;
// - hanya satu panggilan yang berjalan; permintaan selama itu menjadwalkan satu
//   ulangan setelahnya (semua menunggu ulangan yang sama);
// - reloadKopi() langsung berjalan (dipakai setelah memberi kopi atau mengubah
//   pengaturan), tetap mengikuti aturan satu panggilan di atas.
import { useSyncExternalStore } from "react";
import { subscribeFeature, toAppError, type AppError } from "../api";
import { kopiApi, type KopiBadge, type KopiOverview } from "../api/kopi";

export const KOPI_POLL_MS = 60_000;
export const KOPI_EVENT_DELAY_MS = 2_000;

type Snapshot = {
  overview: KopiOverview | null;
  badges: Map<string, KopiBadge>;
  // Muatan terakhir gagal. overview tetap berisi data terakhir yang terbaca.
  error: AppError | null;
};

const EMPTY: Snapshot = { overview: null, badges: new Map(), error: null };

let snap: Snapshot = EMPTY;
let snapKey = "";
let gen = 0;
let inflight: Promise<void> | null = null;
let again = false;
let eventTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
let stopSources: (() => void) | null = null;

function emit() {
  for (const fn of [...listeners]) fn();
}

function set(overview: KopiOverview | null, error: AppError | null) {
  // Ringkasan yang sama tidak membuat snapshot baru, jadi ikon di seluruh
  // aplikasi tidak dirender ulang setiap polling.
  const key = JSON.stringify([overview, error?.code ?? null, error?.message ?? null]);
  if (key === snapKey) return;
  snapKey = key;
  const badges = new Map<string, KopiBadge>();
  for (const b of overview?.badges ?? []) badges.set(b.publicKey, b);
  snap = { overview, badges, error };
  emit();
}

function validOverview(value: unknown): value is KopiOverview {
  const o = value as KopiOverview | null;
  return (
    !!o &&
    typeof o === "object" &&
    typeof o.enabled === "boolean" &&
    Array.isArray(o.tiers) &&
    Array.isArray(o.badges) &&
    Array.isArray(o.givenTargets)
  );
}

// Kode error untuk data yang bentuknya tidak dikenal; layar memilih teksnya sendiri.
export const KOPI_BAD_DATA = "bad_data";

async function loadOnce(mine: number) {
  try {
    const next = await kopiApi.overview();
    if (mine !== gen) return;
    if (validOverview(next)) set(next, null);
    else set(snap.overview, { code: KOPI_BAD_DATA, message: "" });
  } catch (err) {
    // Inti belum siap atau di luar Tauri: tetap pakai data terakhir.
    if (mine === gen) set(snap.overview, toAppError(err));
  }
}

// Memuat ulang ringkasan sekarang. Kalau satu muatan sedang berjalan, satu
// ulangan dijadwalkan setelahnya dan janji yang dikembalikan selesai setelah
// ulangan itu, jadi pemanggil yang menunggu selalu mendapat data terbaru.
export function reloadKopi(): Promise<void> {
  if (inflight) {
    again = true;
    return inflight;
  }
  const mine = gen;
  const run = (async () => {
    try {
      do {
        again = false;
        await loadOnce(mine);
      } while (again && mine === gen);
    } finally {
      // Setelah resetKopiStore (gen berganti) muatan lama tidak menyentuh keadaan baru.
      if (mine === gen) inflight = null;
    }
  })();
  inflight = run;
  return run;
}

// Untuk event fitur: digabung dalam jendela KOPI_EVENT_DELAY_MS.
function reloadSoon() {
  if (eventTimer) return;
  eventTimer = setTimeout(() => {
    eventTimer = null;
    void reloadKopi();
  }, KOPI_EVENT_DELAY_MS);
}

function start() {
  void reloadKopi();
  const stopKopi = subscribeFeature("kopi", reloadSoon);
  const stopBoard = subscribeFeature("board", reloadSoon);
  const timer = setInterval(() => void reloadKopi(), KOPI_POLL_MS);
  stopSources = () => {
    stopKopi();
    stopBoard();
    clearInterval(timer);
    if (eventTimer) clearTimeout(eventTimer);
    eventTimer = null;
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
  error: AppError | null;
  badgeOf(pk: string): KopiBadge | null;
  reload(): Promise<void>;
};

export function useKopi(): UseKopi {
  const s = useSyncExternalStore(subscribeStore, getSnap, getSnap);
  return {
    overview: s.overview,
    error: s.error,
    badgeOf: (pk: string) => badgeFrom(s, pk),
    reload: reloadKopi,
  };
}

// Untuk tes: kosongkan cache dan hentikan sumber muat ulang.
export function resetKopiStore(): void {
  stopSources?.();
  stopSources = null;
  listeners.clear();
  gen++;
  inflight = null;
  again = false;
  snap = EMPTY;
  snapKey = "";
}
