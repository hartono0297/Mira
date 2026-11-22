// Format waktu untuk tampilan, bahasa Indonesia.

function parse(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(iso: string): string {
  const d = parse(iso);
  if (!d) return iso;
  return d.toLocaleString("id-ID", { dateStyle: "long", timeStyle: "short" });
}

export function formatDate(iso: string): string {
  const d = parse(iso);
  if (!d) return iso;
  return d.toLocaleDateString("id-ID", { dateStyle: "long" });
}

// "baru saja", "5 menit lalu", "3 jam lalu", "kemarin", "4 hari lalu", lalu tanggal.
export function relativeTime(iso: string, now: Date = new Date()): string {
  const d = parse(iso);
  if (!d) return iso;
  const seconds = Math.round((now.getTime() - d.getTime()) / 1000);
  if (seconds < 60) return "baru saja";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "kemarin";
  if (days < 7) return `${days} hari lalu`;
  return formatDate(iso);
}
