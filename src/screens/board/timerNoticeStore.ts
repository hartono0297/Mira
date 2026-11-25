// Sumber bersama pemberitahuan jeda otomatis timer (docs/plans/timer-jeda.md).
// TimerNotices di layar board yang mengambil dari inti Rust (takeTimerNotices)
// dan mendorongnya ke sini. Daftar yang terlihat dibaca TimerNotices; kalimat
// untuk pembaca layar dibaca lewat useTimerNoticeAnnouncement, juga di dalam
// dialog task, karena modal menyembunyikan isi di luarnya dari pembaca layar.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TimerNotice } from "../../api/board";
import { getLang } from "../../i18n/core";
import { formatDateTime, todayIso } from "./format";
import { TN } from "./teksWaktu";

export const MAX_SHOWN = 5;
const REASONS = new Set(["switched", "done", "deleted", "idle"]);

export type ShownNotice = { key: number; notice: TimerNotice };
// Pemberitahuan yang baru masuk dalam satu pengambilan, terbaru dulu.
export type NoticeBatch = { seq: number; notices: TimerNotice[] };

type State = { shown: ShownNotice[]; latest: NoticeBatch | null };

let state: State = { shown: [], latest: null };
let nextKey = 0;
const listeners = new Set<() => void>();

function set(next: State) {
  state = next;
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function validNotice(n: unknown): n is TimerNotice {
  if (!n || typeof n !== "object") return false;
  const o = n as Partial<TimerNotice>;
  return (
    typeof o.reason === "string" &&
    REASONS.has(o.reason) &&
    typeof o.code === "string" &&
    typeof o.title === "string" &&
    typeof o.at === "string" &&
    (o.reason !== "switched" || typeof o.startedCode === "string")
  );
}

// Hasil takeTimerNotices apa adanya (urutan antrean, terlama dulu). Isi yang
// tidak sah dilewati; yang baru ditumpuk di atas, paling banyak MAX_SHOWN.
export function pushTimerNotices(list: unknown): void {
  const fresh = (Array.isArray(list) ? list : []).filter(validNotice).reverse();
  if (fresh.length === 0) return;
  const added = fresh.map((notice) => ({ key: nextKey++, notice }));
  set({
    shown: [...added, ...state.shown].slice(0, MAX_SHOWN),
    latest: { seq: (state.latest?.seq ?? 0) + 1, notices: fresh },
  });
}

export function dismissTimerNotice(key: number): void {
  set({ ...state, shown: state.shown.filter((s) => s.key !== key) });
}

export function dismissAllTimerNotices(): void {
  set({ ...state, shown: [] });
}

// Hanya untuk tes.
export function resetTimerNotices(): void {
  nextKey = 0;
  set({ shown: [], latest: null });
}

export function useTimerNotices(): ShownNotice[] {
  return useSyncExternalStore(subscribe, () => state.shown);
}

// Jam saja ("17.32", Inggris "17:32") kalau hari ini, selain itu tanggal dan jam.
function pausedAt(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (todayIso(d) !== todayIso(now)) return formatDateTime(iso, now);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return getLang() === "en" ? `${hh}:${mm}` : `${hh}.${mm}`;
}

export function noticeText(n: TimerNotice): string {
  switch (n.reason) {
    case "switched":
      return TN.switched(n.code, n.title, n.startedCode ?? "");
    case "done":
      return TN.done(n.code, n.title);
    case "deleted":
      return TN.deleted(n.code, n.title);
    case "idle":
      return TN.idle(n.code, n.title, pausedAt(n.at));
  }
}

// Kalimat pemberitahuan yang masuk sesudah komponen pemanggil dipasang, untuk
// wilayah role="status". Dikosongkan dulu lalu diisi sesaat kemudian, supaya
// kalimat yang sama tetap dibacakan ulang. Yang sudah ada sebelum dipasang
// tidak dibacakan lagi (misalnya saat dialog task dibuka).
export function useTimerNoticeAnnouncement(): string {
  const latest = useSyncExternalStore(subscribe, () => state.latest);
  // Kumpulan saat dipasang. Dibandingkan dengan ini, bukan ditandai "sudah
  // dibaca" di dalam efek, supaya efek yang dipasang ulang (StrictMode) tetap mengisi.
  const atMount = useRef(latest);
  const [say, setSay] = useState("");
  useEffect(() => {
    if (!latest || latest === atMount.current) return;
    setSay("");
    const timer = setTimeout(() => setSay(latest.notices.map(noticeText).join(" ")), 30);
    return () => clearTimeout(timer);
  }, [latest]);
  return say;
}
