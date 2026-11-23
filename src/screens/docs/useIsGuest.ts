import { useCallback, useEffect, useRef, useState } from "react";
import { orgApi, subscribeOrg } from "../../api/org";

// Apakah saya Tamu (orgApi.overview().isGuest). null selama ringkasan belum
// terbaca atau gagal dibaca: layar lalu bersikap seperti untuk anggota, dan
// inti tetap menolak apa yang tidak boleh. Dimuat ulang lewat subscribeOrg.
export function useIsGuest(): boolean | null {
  const [isGuest, setIsGuest] = useState<boolean | null>(null);
  const alive = useRef(true);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const overview = await orgApi.overview();
      if (!alive.current || mine !== seq.current) return;
      setIsGuest(overview?.isGuest === true);
    } catch {
      // Ringkasan belum bisa dibaca: pilihan terakhir tetap dipakai.
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    const stop = subscribeOrg(() => void reload());
    return () => {
      alive.current = false;
      stop();
    };
  }, [reload]);

  return isGuest;
}
