import { useCallback, useEffect, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import { boardApi, subscribeBoard, type ProjectSummary } from "../../api/board";

export type Projects = {
  // null sampai muatan pertama berhasil. Muat ulang yang gagal tetap
  // menyimpan daftar terakhir.
  list: ProjectSummary[] | null;
  error: AppError | null;
  reload: () => Promise<void>;
};

// Proyek yang boleh saya lihat, untuk pilihan Lokasi. Dimuat ulang saat board
// atau keanggotaan proyek berubah (subscribeBoard).
export function useProjects(): Projects {
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const alive = useRef(true);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await boardApi.listProjects();
      if (!alive.current || mine !== seq.current) return;
      setList(Array.isArray(next) ? next : []);
      setError(null);
    } catch (err) {
      if (!alive.current || mine !== seq.current) return;
      setError(toAppError(err));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    const stop = subscribeBoard(() => void reload());
    return () => {
      alive.current = false;
      stop();
    };
  }, [reload]);

  return { list, error, reload };
}
