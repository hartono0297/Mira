// Format dan hitungan waktu tercatat board v0.4. Semua fungsi murni: "sekarang"
// selalu dioper oleh pemanggil (lihat useNow), supaya mudah dites.
import type { ColumnId, StatusTime, TaskCard, TaskDetail, TimeEntry } from "../../api/board";
import { getLang } from "../../i18n/core";
import { TEKS } from "./teks";

const MENIT = 60;
const JAM = 60 * MENIT;
const HARI = 24 * JAM;

// Detik yang bisa dihitung: NaN, Infinity, dan nilai negatif jadi 0, pecahan dibuang.
function clean(secs: number): number {
  return Number.isFinite(secs) && secs > 0 ? Math.floor(secs) : 0;
}

type Bagian = { hari: number; jam: number; menit: number };

// Dua satuan terbesar saja: hari dan jam, atau jam dan menit. Sisanya dibuang, tidak dibulatkan.
function bagian(secs: number): Bagian {
  const s = clean(secs);
  if (s >= HARI) return { hari: Math.floor(s / HARI), jam: Math.floor((s % HARI) / JAM), menit: 0 };
  return { hari: 0, jam: Math.floor(s / JAM), menit: Math.floor((s % JAM) / MENIT) };
}

type Satuan = (n: number) => string;

function susun(b: Bagian, satuan: { hari: Satuan; jam: Satuan; menit: Satuan }): string {
  const out: string[] = [];
  if (b.hari) out.push(satuan.hari(b.hari));
  if (b.jam) out.push(satuan.jam(b.jam));
  if (b.menit) out.push(satuan.menit(b.menit));
  return out.join(" ");
}

function pendek(): { hari: Satuan; jam: Satuan; menit: Satuan } {
  const p = TEKS.waktu.pendek;
  return { hari: (n) => `${n}${p.hari}`, jam: (n) => `${n}${p.jam}`, menit: (n) => `${n}${p.menit}` };
}

// Ringkas untuk kartu dan total: "0m", "<1m", "45m", "3j 20m", "3j", "2hr 5j".
// hr = hari, j = jam, m = menit. Bahasa Inggris: "3h 20m", "2d 5h".
export function formatDuration(secs: number): string {
  const s = clean(secs);
  if (s === 0) return `0${TEKS.waktu.pendek.menit}`;
  if (s < MENIT) return TEKS.waktu.kurangDariSemenit;
  return susun(bagian(s), pendek());
}

// Versi pembaca layar dengan ketelitian yang sama: "3 jam 20 menit", "2 hari 5 jam"
// (Inggris "3 hours 20 minutes").
export function formatDurationLong(secs: number): string {
  const s = clean(secs);
  if (s === 0) return TEKS.waktu.panjang.menit(0);
  if (s < MENIT) return TEKS.waktu.kurangDariSemenitPanjang;
  return susun(bagian(s), TEKS.waktu.panjang);
}

const dua = (n: number) => String(n).padStart(2, "0");

// Timer berjalan: "00:42:10". Jam tidak dibatasi dua digit ("123:04:05").
export function formatClock(secs: number): string {
  const s = clean(secs);
  return `${dua(Math.floor(s / JAM))}:${dua(Math.floor((s % JAM) / MENIT))}:${dua(s % MENIT)}`;
}

// Detik dari `since` (RFC 3339) sampai `now`. Minimal 0: jam laptop yang melihat
// bisa lebih lambat dari laptop pemilik timer. Waktu yang tidak terbaca = 0.
export function runningSecs(since: string, now: Date | number): number {
  const start = Date.parse(since);
  const end = typeof now === "number" ? now : now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.floor((end - start) / 1000));
}

// Durasi per status termasuk selang yang masih berjalan di kolom sekarang.
export function liveStatusSecs(st: StatusTime, now: Date | number): Record<ColumnId, number> {
  const out: Record<ColumnId, number> = {
    todo: clean(st.closedSecs.todo),
    doing: clean(st.closedSecs.doing),
    done: clean(st.closedSecs.done),
  };
  out[st.currentColumn] += runningSecs(st.currentSince, now);
  return out;
}

// Total waktu tercatat kartu: catatan yang sudah berhenti ditambah semua timer berjalan.
export function cardTrackedSecs(
  card: Pick<TaskCard, "trackedSecs" | "timersRunningSince">,
  now: Date | number,
): number {
  return card.timersRunningSince.reduce((sum, since) => sum + runningSecs(since, now), clean(card.trackedSecs));
}

// Keadaan timer satu orang di satu task (v0.6, docs/plans/timer-jeda.md):
// - "idle": belum pernah ada segmen timer (manual: false) miliknya;
// - "running": ada segmennya yang berjalan;
// - "paused": punya segmen timer yang sudah berhenti dan tidak ada yang berjalan.
export type TimerState = "idle" | "running" | "paused";

export type PersonTimer = {
  state: TimerState;
  // Segmen berjalan yang paling baru dimulai; null kalau tidak berjalan.
  running: TimeEntry | null;
  // Semua catatannya yang sudah berhenti, termasuk catatan manual.
  closedSecs: number;
  // closedSecs ditambah semua segmen yang berjalan sampai `now`.
  totalSecs: number;
};

// `entries` adalah catatan yang belum dihapus (TaskDetail.timeEntries).
export function personTimer(entries: readonly TimeEntry[], publicKey: string, now: Date | number): PersonTimer {
  let closedSecs = 0;
  let runningSum = 0;
  let running: TimeEntry | null = null;
  let hadTimer = false;
  for (const e of entries) {
    if (e.person.publicKey !== publicKey) continue;
    if (e.end === null) {
      runningSum += runningSecs(e.start, now);
      if (!running || Date.parse(e.start) > Date.parse(running.start)) running = e;
      continue;
    }
    closedSecs += clean(e.secs);
    if (!e.manual) hadTimer = true;
  }
  const state: TimerState = running ? "running" : hadTimer ? "paused" : "idle";
  return { state, running, closedSecs, totalSecs: closedSecs + runningSum };
}

// Timer saya di task ini.
export function myTimer(task: Pick<TaskDetail, "timeEntries">, me: string, now: Date | number): PersonTimer {
  return personTimer(task.timeEntries, me, now);
}

export const MIN_LOG_MINUTES = 1;
export const MAX_LOG_MINUTES = 1440;

export type ParsedMinutes = { minutes: number; reason: null } | { minutes: null; reason: string };

const JAM_MENIT = /^(?:(\d+(?:[.,]\d+)?)\s*(?:j|jam))?\s*(?:(\d+)\s*(?:m|mnt|menit))?$/;
// Bahasa Inggris menerima satuan Indonesia juga (isian lama tetap jalan) ditambah
// h, hr, hrs, hour, hours, min, mins, minute, minutes. Di bahasa Indonesia "h"
// tetap ditolak, karena di sana "hr" berarti hari.
const JAM_MENIT_EN =
  /^(?:(\d+(?:[.,]\d+)?)\s*(?:j|jam|h|hrs?|hours?))?\s*(?:(\d+)\s*(?:m|mnt|menit|mins?|minutes?))?$/;
const JAM_TITIK_DUA = /^(\d{1,2}):([0-5]\d)$/;

function gagal(reason: string): ParsedMinutes {
  return { minutes: null, reason };
}

// Isian durasi bebas jadi menit bulat, 1 sampai 1440.
// Diterima: "90" (menit), "45m", "45 menit", "2j", "1j 30m", "1 jam 30 menit", "1:30", "1,5j", "1.5 jam".
// Saat bahasa Inggris aktif juga "1h 30m", "2 hours", "45 min", "1.5h".
export function parseMinutes(input: string): ParsedMinutes {
  const text = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return gagal(TEKS.waktu.isian.kosong);

  let minutes: number;
  const titikDua = JAM_TITIK_DUA.exec(text);
  if (/^\d+$/.test(text)) {
    minutes = Number(text);
  } else if (titikDua) {
    minutes = Number(titikDua[1]) * 60 + Number(titikDua[2]);
  } else {
    const m = (getLang() === "en" ? JAM_MENIT_EN : JAM_MENIT).exec(text);
    if (!m || (m[1] === undefined && m[2] === undefined)) return gagal(TEKS.waktu.isian.tidakDikenali);
    const jam = m[1] === undefined ? 0 : Number(m[1].replace(",", "."));
    const menit = m[2] === undefined ? 0 : Number(m[2]);
    minutes = Math.round(jam * 60 + menit);
  }

  if (!Number.isFinite(minutes)) return gagal(TEKS.waktu.isian.tidakDikenali);
  if (minutes < MIN_LOG_MINUTES) return gagal(TEKS.waktu.isian.terlaluSingkat);
  if (minutes > MAX_LOG_MINUTES) return gagal(TEKS.waktu.isian.terlaluLama);
  return { minutes, reason: null };
}
