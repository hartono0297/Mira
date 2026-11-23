import { useCallback, useEffect, useRef, useState } from "react";
import { subscribe, toAppError } from "../../api";
import { subscribeOrg } from "../../api/org";
import type { Live } from "../../api/useLive";

export const ORG_POLL_MS = 15000;

type Options = {
  // Naik setelah setiap aksi di halaman ini berhasil, supaya data dimuat ulang
  // walaupun event dari Rust belum datang (atau tidak ada, seperti di tes).
  version?: number;
  // Daftar pengguna juga berubah saat rekan tersambung atau terputus.
  network?: boolean;
  pollMs?: number;
};

// Seperti useLive, tetapi mendengarkan event organisasi v0.3 (`mira://directory`
// dan `mira://join-requests`). Data terakhir tetap tampil kalau muat ulang gagal.
export function useOrgLive<T>(load: () => Promise<T>, { version = 0, network = false, pollMs = ORG_POLL_MS }: Options = {}): Live<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ReturnType<typeof toAppError> | null>(null);
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
    const stopOrg = subscribeOrg(() => void reload());
    const stopNet = network ? subscribe("mira://network", () => void reload()) : () => {};
    const timer = window.setInterval(() => void reload(), pollMs);
    return () => {
      alive.current = false;
      stopOrg();
      stopNet();
      window.clearInterval(timer);
    };
  }, [network, pollMs, reload]);

  useEffect(() => {
    void reload();
  }, [version, reload]);

  return { data, error, loading, reload };
}
