import { useCallback, useEffect, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import { subscribeChat } from "../../api/chat";

export const CHAT_POLL_MS = 10000;

export type ChatLive<T> = {
  data: T | null;
  error: AppError | null;
  loading: boolean; // hanya true sebelum data pertama datang
  reload: () => Promise<void>;
  setData: (next: T) => void;
};

// Seperti useLive, tapi untuk event mira://feature bertopik chat dan bisa diganti sumbernya
// lewat `key` (misalnya id percakapan). Ganti key = data lama dibuang, muat dari awal.
export function useChatLive<T>(load: () => Promise<T>, key: string, pollMs = CHAT_POLL_MS): ChatLive<T> {
  const [data, setDataState] = useState<T | null>(null);
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
      setDataState(next);
      setError(null);
    } catch (err) {
      if (!alive.current || mine !== seq.current) return;
      setError(toAppError(err));
    } finally {
      if (alive.current && mine === seq.current) setLoading(false);
    }
  }, []);

  // Data dari hasil aksi (misalnya pesan yang baru dikirim). Muat
  // ulang yang sedang berjalan dibatalkan supaya tidak menimpanya dengan data lama.
  const setData = useCallback((next: T) => {
    seq.current++;
    setDataState(next);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    alive.current = true;
    setDataState(null);
    setError(null);
    setLoading(true);
    void reload();
    const stop = subscribeChat(() => void reload());
    const timer = window.setInterval(() => void reload(), pollMs);
    return () => {
      alive.current = false;
      stop();
      window.clearInterval(timer);
    };
  }, [key, pollMs, reload]);

  return { data, error, loading, reload, setData };
}
