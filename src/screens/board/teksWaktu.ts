// Teks bagian Waktu di detail task dan timer di kepala dialog (Board v0.4).
// Isinya ada di kamus src/i18n/board-time.id.ts dan .en.ts.
// Durasi pendek ("3j 20m") untuk mata, durasi panjang ("3 jam 20 menit") untuk pembaca layar.
import { defineText } from "../../i18n/core";
import en from "../../i18n/board-time.en";
import id from "../../i18n/board-time.id";

export const TW = defineText(id.tw, en.tw);

const K = defineText(id.kalimat, en.kalimat);

export function runningSinceSr(when: string): string {
  return K.runningSinceSr(when);
}

export function earlierSr(long: string): string {
  return K.earlierSr(long);
}

export function pausedSr(long: string): string {
  return K.pausedSr(long);
}

export function cycleDone(short: string): string {
  return K.cycleDone(short);
}

export function historySummary(n: number): string {
  return K.historySummary(n);
}

// Nama aksesibel tombol hapus: "Hapus catatan 1 jam 30 menit, 23 Nov, 09.12".
export function deleteEntryLabel(what: string, when: string): string {
  return K.deleteEntryLabel(what, when);
}

export function startedAt(when: string): string {
  return K.startedAt(when);
}

export const SAY = defineText(id.say, en.say);

// Pemberitahuan jeda otomatis (TimerNotice).
export const TN = defineText(id.notice, en.notice);
