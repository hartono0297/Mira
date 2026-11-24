// Format waktu untuk tampilan, dalam bahasa aktif (id-ID atau en-GB).
import { API_TEXT } from "../i18n/api";
import { locale } from "../i18n/core";

function parse(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(iso: string): string {
  const d = parse(iso);
  if (!d) return iso;
  return d.toLocaleString(locale(), { dateStyle: "long", timeStyle: "short" });
}

export function formatDate(iso: string): string {
  const d = parse(iso);
  if (!d) return iso;
  return d.toLocaleDateString(locale(), { dateStyle: "long" });
}

// "baru saja", "5 menit lalu", "3 jam lalu", "kemarin", "4 hari lalu", lalu tanggal.
export function relativeTime(iso: string, now: Date = new Date()): string {
  const d = parse(iso);
  if (!d) return iso;
  const t = API_TEXT.relative;
  const seconds = Math.round((now.getTime() - d.getTime()) / 1000);
  if (seconds < 60) return t.justNow;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t.minutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t.hoursAgo(hours);
  const days = Math.floor(hours / 24);
  if (days === 1) return t.yesterday;
  if (days < 7) return t.daysAgo(days);
  return formatDate(iso);
}
