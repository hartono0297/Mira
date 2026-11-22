import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeFeature, toAppError, type AppError } from "../../api";
import { subscribeDocuments } from "../../api/documents";

export type Loaded<T> = {
  data: T | null;
  error: AppError | null;
  loading: boolean; // true sampai muatan pertama selesai
  reload: () => Promise<void>;
};

// Memuat data dan memuat ulang saat event "mira://documents" atau
// "mira://feature" bertopik docs datang, atau saat
// jendela Mira kembali fokus (misalnya setelah menutup Word). Kalau muat ulang
// gagal, data terakhir tetap ditampilkan bersama error-nya. `load` null = tidak memuat.
export function useReload<T>(load: (() => Promise<T>) | null, key: string): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(load !== null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const alive = useRef(true);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const run = loadRef.current;
    if (!run) return;
    const mine = ++seq.current;
    try {
      const next = await run();
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

  const enabled = load !== null;
  useEffect(() => {
    alive.current = true;
    if (!enabled) {
      seq.current++;
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    // Ganti kunci (file lain dipilih): data lama tidak ditampilkan untuk file baru.
    setData(null);
    setError(null);
    setLoading(true);
    void reload();
    const stop = subscribeDocuments(() => void reload());
    // Dokumen, versi, atau tanda edit baru dari laptop rekan.
    const stopFeature = subscribeFeature("docs", () => void reload());
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => {
      alive.current = false;
      stop();
      stopFeature();
      window.removeEventListener("focus", onFocus);
    };
  }, [key, enabled, reload]);

  return { data, error, loading, reload };
}
