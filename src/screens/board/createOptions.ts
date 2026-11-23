// Siapa boleh membuat proyek dan di departemen mana (kontrak v0.3 bagian 4,
// `Rights::can_create_project`): superadmin di departemen terbuka mana pun atau
// tanpa departemen; admin departemen di departemennya sendiri atau tanpa
// departemen. Yang lain tidak. Inti Rust tetap memeriksa izinnya.
import { useCallback, useEffect, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import { orgApi, subscribeOrg, type DepartmentView, type OrgOverview, type PersonView } from "../../api/org";

export type CreateOptions = {
  me: string;
  canCreate: boolean;
  // Departemen yang boleh dipilih, urut nama.
  departments: { id: string; name: string }[];
  allowNoDepartment: boolean;
  // Pilihan bawaan: departemen saya kalau boleh, lalu departemen pertama, lalu tanpa departemen.
  defaultDepartment: string | null;
};

export function createOptions(overview: OrgOverview, people: PersonView[], departments: DepartmentView[]): CreateOptions {
  const me = overview.publicKey;
  const mine = people.find((p) => p.publicKey === me);
  const open = departments
    .filter((d) => !d.archived)
    .map((d) => ({ id: d.id, name: d.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "id"));
  let allowed: { id: string; name: string }[] = [];
  let allowNoDepartment = false;
  if (!mine || overview.isGuest || mine.isGuest) {
    allowed = [];
  } else if (overview.isSuperadmin) {
    allowed = open;
    allowNoDepartment = true;
  } else if (mine.departmentRole === "admin" && mine.departmentId) {
    allowed = open.filter((d) => d.id === mine.departmentId);
    allowNoDepartment = true;
  }
  const canCreate = allowed.length > 0 || allowNoDepartment;
  const own = allowed.find((d) => d.id === overview.departmentId);
  return {
    me,
    canCreate,
    departments: allowed,
    allowNoDepartment,
    defaultDepartment: own?.id ?? allowed[0]?.id ?? null,
  };
}

export type OrgData = { overview: OrgOverview; people: PersonView[]; departments: DepartmentView[] };

export type CreateOptionsState =
  | { status: "loading" }
  | { status: "ready"; options: CreateOptions; data: OrgData }
  | { status: "error"; error: AppError };

// Data organisasi untuk dialog Proyek baru dan tombolnya. Dimuat ulang saat
// mira://directory datang (peran atau departemen berubah).
export function useCreateOptions(enabled = true): CreateOptionsState & { reload: () => void } {
  const [state, setState] = useState<CreateOptionsState>({ status: "loading" });
  const seq = useRef(0);
  const reload = useCallback(() => {
    const mine = ++seq.current;
    Promise.all([orgApi.overview(), orgApi.people(), orgApi.departments()])
      .then(([overview, people, departments]) => {
        if (mine !== seq.current) return;
        setState({
          status: "ready",
          options: createOptions(overview, people, departments),
          data: { overview, people, departments },
        });
      })
      .catch((err) => {
        if (mine !== seq.current) return;
        // Data lama tetap dipakai kalau muat ulang gagal.
        setState((prev) => (prev.status === "ready" ? prev : { status: "error", error: toAppError(err) }));
      });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    reload();
    const stop = subscribeOrg(reload);
    return () => {
      seq.current++;
      stop();
    };
  }, [enabled, reload]);

  return { ...state, reload };
}
