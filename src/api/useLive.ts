import { useCallback, useEffect, useRef, useState } from "react";
import { subscribe, toAppError, type AppError, type MiraEvent } from ".";

export type Live<T> = {
  data: T | null;
  error: AppError | null;
  loading: boolean; // hanya true sebelum data pertama datang
  reload: () => Promise<void>;
};

// Memuat data, memuat ulang saat event dari Rust datang, dan polling sebagai
// cadangan kalau event terlewat. Kalau muat ulang gagal, data terakhir tetap
// ditampilkan bersama error-nya.
export function useLive<T>(load: () => Promise<T>, event: MiraEvent, pollMs: number): Live<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const alive = useRef(true);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await loadRef.current();
      if (!alive.current || mine !== seq.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (!alive.current || mine !== seq.current) return;
      setError(toAppError(err));
    } finally {
      if (alive.current && mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    const stop = subscribe(event, () => void reload());
    const timer = window.setInterval(() => void reload(), pollMs);
    return () => {
      alive.current = false;
      stop();
      window.clearInterval(timer);
    };
  }, [event, pollMs, reload]);

  return { data, error, loading, reload };
}
