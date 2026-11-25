// Siapa boleh membuat proyek dan di departemen mana (kontrak v0.3 bagian 4,
// `Rights::can_create_project`): superadmin di departemen terbuka mana pun atau
// tanpa departemen; admin departemen di departemennya sendiri atau tanpa
// departemen. Kepala divisi (sejak v0.6) hanya proyek untuk divisinya, di departemen
// divisi itu. Yang lain tidak. Inti Rust tetap memeriksa izinnya.
import { useCallback, useEffect, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import { divisionApi, type DivisionRef } from "../../api/division";
import { orgApi, subscribeOrg, type DepartmentView, type OrgOverview, type PersonView } from "../../api/org";

export type CreateOptions = {
  me: string;
  canCreate: boolean;
  // Departemen yang boleh dipilih, urut nama.
  departments: { id: string; name: string }[];
  allowNoDepartment: boolean;
  // Pilihan bawaan: departemen saya kalau boleh, lalu departemen pertama, lalu tanpa departemen.
  defaultDepartment: string | null;
  // Bukan null: orang ini hanya boleh membuat proyek untuk divisi-divisi ini (kepala divisi).
  divisionOnly: string[] | null;
};

export function createOptions(
  overview: OrgOverview,
  people: PersonView[],
  departments: DepartmentView[],
  divisions: DivisionRef[] = [],
): CreateOptions {
  const me = overview.publicKey;
  const mine = people.find((p) => p.publicKey === me);
  const open = departments
    .filter((d) => !d.archived)
    .map((d) => ({ id: d.id, name: d.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "id"));
  let allowed: { id: string; name: string }[] = [];
  let allowNoDepartment = false;
  let divisionOnly: string[] | null = null;
  if (!mine || overview.isGuest || mine.isGuest) {
    allowed = [];
  } else if (overview.isSuperadmin) {
    allowed = open;
    allowNoDepartment = true;
  } else if (mine.departmentRole === "admin" && mine.departmentId) {
    allowed = open.filter((d) => d.id === mine.departmentId);
    allowNoDepartment = true;
  } else {
    const headed = divisions.filter((d) => d.role === "head" && !d.archived && open.some((o) => o.id === d.teamId));
    if (headed.length > 0) {
      allowed = open.filter((o) => headed.some((d) => d.teamId === o.id));
      divisionOnly = headed.map((d) => d.id);
    }
  }
  const canCreate = allowed.length > 0 || allowNoDepartment;
  const own = allowed.find((d) => d.id === overview.departmentId);
  return {
    me,
    canCreate,
    departments: allowed,
    allowNoDepartment,
    defaultDepartment: own?.id ?? allowed[0]?.id ?? null,
    divisionOnly,
  };
}

export type OrgData = {
  overview: OrgOverview;
  people: PersonView[];
  departments: DepartmentView[];
  divisions?: DivisionRef[];
};

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
    // Divisi yang gagal dibaca sama dengan tidak ada divisi: hak lain tetap berlaku.
    const divisions = divisionApi
      .myDivisions()
      .then((list) => (Array.isArray(list) ? list : []))
      .catch((): DivisionRef[] => []);
    Promise.all([orgApi.overview(), orgApi.people(), orgApi.departments(), divisions])
      .then(([overview, people, departments, divisions]) => {
        if (mine !== seq.current) return;
        setState({
          status: "ready",
          options: createOptions(overview, people, departments, divisions),
          data: { overview, people, departments, divisions },
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
