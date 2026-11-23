import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { orgApi, subscribeOrg, type LabelRef } from "../../api/org";

// Label profil per kunci publik untuk seluruh layar chat, dari orgApi.people(). Dimuat
// sekali per layar dan dimuat ulang saat data organisasi berubah (label baru, dipasang,
// dilepas). Tanpa provider atau selama memuat, peta kosong: nama tampil tanpa label.
const LabelsContext = createContext<ReadonlyMap<string, readonly LabelRef[]>>(new Map());

const NO_LABELS: readonly LabelRef[] = [];

export function PeopleLabelsProvider({ children }: { children: ReactNode }) {
  const [labels, setLabels] = useState<ReadonlyMap<string, readonly LabelRef[]>>(() => new Map());
  useEffect(() => {
    let stale = false;
    const load = () => {
      orgApi
        .people()
        .then((people) => {
          if (stale) return;
          const map = new Map<string, readonly LabelRef[]>();
          for (const p of people) if (p.labels.length > 0) map.set(p.publicKey, p.labels);
          setLabels(map);
        })
        .catch(() => {
          // Tanpa data organisasi chat tetap jalan, hanya tanpa label.
        });
    };
    load();
    const stop = subscribeOrg(load);
    return () => {
      stale = true;
      stop();
    };
  }, []);
  return <LabelsContext.Provider value={labels}>{children}</LabelsContext.Provider>;
}

export function useLabelsOf(publicKey: string): readonly LabelRef[] {
  return useContext(LabelsContext).get(publicKey) ?? NO_LABELS;
}
