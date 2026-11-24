import { useCallback, useEffect, useRef, useState } from "react";
import { orgApi, subscribeOrg } from "../../api/org";
import { ORG_TEXT } from "../../i18n/org";
import "./nav-count.css";

const POLL_MS = 30000;

// Jumlah permintaan bergabung yang menunggu keputusan orang ini
// (OrgOverview.pendingJoinCount). 0 selama memuat dan untuk orang yang tidak
// boleh memutuskan; kalau muat ulang gagal, angka terakhir dipertahankan.
// Dimuat ulang pada `mira://directory`
// dan `mira://join-requests`, dengan polling 30 detik sebagai cadangan.
export function usePendingJoinCount(): number {
  const [count, setCount] = useState(0);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const o = await orgApi.overview();
      if (mine === seq.current) setCount(typeof o?.pendingJoinCount === "number" ? o.pendingJoinCount : 0);
    } catch {
      // Angka lama dibiarkan; dicoba lagi pada event atau polling berikutnya.
    }
  }, []);

  useEffect(() => {
    void load();
    const stop = subscribeOrg(() => void load());
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      seq.current++;
      stop();
      window.clearInterval(timer);
    };
  }, [load]);

  return count;
}

// "99+" di atas 99, seperti angka notifikasi lain (usulan v0.3 bagian 6, opsi C).
export function formatCount(n: number): string {
  return n > 99 ? "99+" : String(n);
}

// Angka di menu Organisasi. Tidak tampil kalau tidak ada yang menunggu.
// Artinya juga ditulis untuk pembaca layar, bukan hanya angka.
export function OrgNavCount() {
  const count = usePendingJoinCount();
  if (count <= 0) return null;
  return (
    <span className="nav-count">
      <span aria-hidden="true">{formatCount(count)}</span>
      <span className="sr-only">{ORG_TEXT.navWaiting(count)}</span>
    </span>
  );
}
