import { useEffect, useRef, useState } from "react";
import { divisionApi } from "../../api/division";
import { subscribeOrg, type OrgOverview } from "../../api/org";

// Tab Departemen saya tampil untuk superadmin, admin departemen, dan kepala divisi.
// Dua yang pertama terbaca dari data yang sudah ada; kepala divisi hanya terlihat
// dari dept_overview(null), yang null untuk orang yang tidak berhak. Panggilan itu
// hanya dibuat kalau perlu, dan diulang saat data organisasi berubah.
export function useMyDeptVisible(overview: OrgOverview | null, manageTeamIds: readonly string[], version: number): boolean {
  const known =
    !!overview && (overview.isSuperadmin || overview.decideJoinTeamIds.length > 0 || manageTeamIds.length > 0);
  const ask = !!overview && !known && !overview.isGuest;
  const [head, setHead] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!ask) {
      setHead(false);
      return;
    }
    let alive = true;
    const check = () => {
      const mine = ++seq.current;
      divisionApi
        .deptOverview(null)
        .then((data) => {
          if (alive && mine === seq.current) setHead(!!data && typeof data === "object");
        })
        .catch(() => {
          // Tidak terbaca: tab tetap seperti sebelumnya, dicoba lagi saat data berubah.
        });
    };
    check();
    const stop = subscribeOrg(check);
    return () => {
      alive = false;
      stop();
    };
  }, [ask, version]);

  return known || (ask && head);
}
