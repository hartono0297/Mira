import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeFeature, toAppError, type AppError } from "../../api";
import { subscribeDocuments } from "../../api/documents";

export type Loaded<T> = {
  data: T | null;
  error: AppError | null;
  loading: boolean; // true sampai muatan pertama untuk kunci ini selesai
  reload: () => Promise<void>;
};

// Memuat data dan memuat ulang saat event "mira://documents" atau
// "mira://feature" bertopik docs datang, atau saat
// jendela Mira kembali fokus (misalnya setelah menutup Word). Kalau muat ulang
// gagal, data terakhir tetap ditampilkan bersama error-nya. `load` null = tidak memuat.
//
// Hasil dicatat bersama kuncinya. Begitu kunci berganti (file atau lokasi
// lain), data dan error kunci lama tidak dikembalikan lagi, bahkan untuk satu
// render, dan `loading` langsung true sampai kunci baru selesai dimuat.
export function useReload<T>(load: (() => Promise<T>) | null, key: string): Loaded<T> {
  const [loaded, setLoaded] = useState<{ key: string; data: T } | null>(null);
  const [failed, setFailed] = useState<{ key: string; error: AppError } | null>(null);
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const keyRef = useRef(key);
  keyRef.current = key;
  const alive = useRef(true);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const run = loadRef.current;
    if (!run) return;
    const mine = ++seq.current;
    const forKey = keyRef.current;
    try {
      const next = await run();
      if (!alive.current || mine !== seq.current) return;
      setLoaded({ key: forKey, data: next });
      setFailed(null);
    } catch (err) {
      if (!alive.current || mine !== seq.current) return;
      setFailed({ key: forKey, error: toAppError(err) });
    } finally {
      if (alive.current && mine === seq.current) setSettledKey(forKey);
    }
  }, []);

  const enabled = load !== null;
  useEffect(() => {
    alive.current = true;
    if (!enabled) {
      // Muatan yang masih berjalan untuk kunci lama diabaikan.
      seq.current++;
      return;
    }
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

  if (!enabled) return { data: null, error: null, loading: false, reload };
  return {
    data: loaded?.key === key ? loaded.data : null,
    error: failed?.key === key ? failed.error : null,
    loading: settledKey !== key,
    reload,
  };
}
