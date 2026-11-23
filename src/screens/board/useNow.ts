import { useEffect, useState } from "react";

// Waktu sekarang yang diperbarui tiap `intervalMs` (bawaan 30 detik, cukup untuk
// tampilan menit; pakai 1000 untuk jam timer). Satu interval per komponen, dilepas
// saat unmount. Selama jendela tersembunyi interval berhenti, lalu waktu langsung
// diperbarui saat jendela terlihat lagi. enabled false = tidak ada interval sama sekali.
export function useNow(intervalMs = 30_000, enabled = true): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => setNow(new Date());
    const start = () => {
      if (timer === null) timer = setInterval(tick, intervalMs);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        tick();
        start();
      }
    };

    // Waktu dari render pertama bisa sudah basi kalau enabled baru saja menyala.
    tick();
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, enabled]);

  return now;
}
