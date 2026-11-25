import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { toAppError } from "../../api";
import { orgApi, type AdSettingsView, type DepartmentView, type JoinRequestView, type OuMapping } from "../../api/org";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { AD_TEXT } from "../../i18n/org-ad";
import { AD_MAX_ROWS, AD_OU_MAX_CHARS } from "./AdSettings";

const T = AD_TEXT.match;
const S = AD_TEXT.settings;

type Loaded = { settings: AdSettingsView; departments: DepartmentView[] };

// Sama dengan is_valid_ou_name di inti Rust: 1 sampai 64 karakter, tanpa spasi di tepi.
// Karakter terlarang lain tetap diperiksa Rust; galatnya tampil di form.
export function mappableOu(ou: string): boolean {
  const n = [...ou].length;
  return ou.trim() === ou && n >= 1 && n <= AD_OU_MAX_CHARS;
}

// Pemetaan baru setelah menambah { ou, team }. Baris dengan OU yang sama (tanpa
// beda huruf besar, seperti check_ou_map) ke departemen yang sama: tidak ada yang
// perlu ditulis. Ke departemen terbuka lain: konflik, tidak ditimpa. Ke departemen
// yang sudah tidak terbuka: barisnya diganti.
export type MatchPlan =
  | { kind: "write"; map: OuMapping[] }
  | { kind: "same" }
  | { kind: "conflict"; team: string }
  | { kind: "full" };

export function planMatch(map: OuMapping[], ou: string, team: string, openTeams: string[]): MatchPlan {
  const key = ou.toLowerCase();
  const at = map.findIndex((r) => r.ou.toLowerCase() === key);
  if (at >= 0) {
    const row = map[at];
    if (row.team === team) return { kind: "same" };
    if (openTeams.includes(row.team)) return { kind: "conflict", team: row.team };
    return { kind: "write", map: map.map((r, i) => (i === at ? { ou: r.ou, team } : r)) };
  }
  if (map.length >= AD_MAX_ROWS) return { kind: "full" };
  return { kind: "write", map: [...map, { ou, team }] };
}

function validSettings(v: unknown): AdSettingsView | null {
  if (!v || typeof v !== "object") return null;
  const o = v as AdSettingsView;
  return {
    ...o,
    ouMap: Array.isArray(o.ouMap) ? o.ouMap : [],
    outdated: Array.isArray(o.outdated) ? o.outdated : [],
  };
}

function openDepartments(v: unknown): DepartmentView[] {
  if (!Array.isArray(v)) return [];
  return (v as DepartmentView[])
    .filter((d) => d && !d.archived)
    .sort((a, b) => a.name.localeCompare(b.name, "id"));
}

type Props = {
  request: JoinRequestView;
  // OU dari DN, paling dalam dulu (dari direktori kalau cek berhasil).
  ous: string[];
  onSetupDomain?: () => void;
  onMatched: (text: string) => void;
};

// "Cocokkan OU ini ke departemen..." di blok AD kartu permintaan (superadmin).
// Form kecil di dalam kartu: pilih OU dari lokasi akun (bawaan yang paling dalam)
// dan departemen, lalu satu baris ditambahkan ke pemetaan OU kantor. Pengaturan AD
// dibaca ulang tepat sebelum menulis, supaya perubahan admin lain tidak tertimpa.
export function JoinAdMatchOu({ request, ous, onSetupDomain, onMatched }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ou, setOu] = useState("");
  const [team, setTeam] = useState("");
  const [teamError, setTeamError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const firstFocus = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const outerFirst = [...ous].reverse();
  const innermost = ous.find(mappableOu) ?? "";

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const [settings, departments] = await Promise.all([orgApi.adSettings(), orgApi.departments(false)]);
      if (!alive.current) return;
      const view = validSettings(settings);
      if (!view) throw new Error(S.loadErrorEmpty);
      const depts = openDepartments(departments);
      setLoaded({ settings: view, departments: depts });
      setTeam((t) => t || (depts.some((d) => d.id === request.teamId) ? request.teamId : ""));
      firstFocus.current = true;
    } catch (err) {
      if (alive.current) setLoadError(toAppError(err).message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }

  function show() {
    setOpen(true);
    setOu(innermost);
    setTeam("");
    setTeamError(false);
    setSaveError(null);
    setLoaded(null);
    void load();
  }

  function close() {
    setOpen(false);
    toggle.current?.focus();
  }

  // Setelah data termuat, fokus pindah ke OU terpilih, hanya kalau fokus masih di
  // tombol pembuka (orangnya belum pindah ke tempat lain selama menunggu).
  useEffect(() => {
    if (!firstFocus.current || !loaded) return;
    firstFocus.current = false;
    if (document.activeElement !== toggle.current) return;
    document.getElementById(`${id}-form`)?.querySelector<HTMLInputElement>("input[type=radio]:checked")?.focus();
  });

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && !saving) {
      e.stopPropagation();
      close();
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving || !loaded || !ou) return;
    if (!team) {
      setTeamError(true);
      select.current?.focus();
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const fresh = validSettings(await orgApi.adSettings());
      if (!alive.current) return;
      if (!fresh) throw new Error(S.loadErrorEmpty);
      const domain = fresh.domain?.trim() ?? "";
      if (!domain || !fresh.allowed) {
        // Keadaan berubah sejak form dibuka: tampilkan penjelasannya.
        setLoaded({ ...loaded, settings: fresh });
        return;
      }
      const openIds = loaded.departments.map((d) => d.id);
      const plan = planMatch(fresh.ouMap, ou, team, openIds);
      if (plan.kind === "conflict") {
        const name = loaded.departments.find((d) => d.id === plan.team)?.name ?? S.unknownOption;
        setSaveError(T.conflict(ou, name));
        return;
      }
      if (plan.kind === "full") {
        setSaveError(T.full(AD_MAX_ROWS));
        return;
      }
      if (plan.kind === "write") await orgApi.setAdSettings(domain, plan.map);
      if (!alive.current) return;
      const deptName = loaded.departments.find((d) => d.id === team)?.name ?? S.unknownOption;
      const other = team !== request.teamId ? T.doneOther(request.teamName) : "";
      setOpen(false);
      onMatched(T.done(ou, deptName) + other);
    } catch (err) {
      if (alive.current) setSaveError(toAppError(err).message);
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  const domain = loaded?.settings.domain?.trim() ?? "";
  const formId = `${id}-form`;

  return (
    <div className="req-ad-match" data-testid="join-ad-match">
      <button
        ref={toggle}
        type="button"
        className="btn btn-ghost btn-sm req-ad-match-open"
        aria-expanded={open}
        aria-controls={open ? formId : undefined}
        aria-label={T.openAria(request.displayName)}
        onClick={() => (open ? close() : show())}
      >
        {T.open}
      </button>

      {open && (
        <div id={formId} className="req-ad-match-box" onKeyDown={onKeyDown}>
          {loading && (
            <p className="hint" role="status">
              {T.loading}
            </p>
          )}

          {!loading && loadError && (
            <ErrorAlert title={T.loadFailTitle}>
              <p>{loadError}</p>
              <button type="button" className="btn btn-ghost org-retry" onClick={() => void load()}>
                {T.retry}
              </button>
            </ErrorAlert>
          )}

          {loaded && !domain && (
            <div className="req-ad-match-msg" data-testid="join-ad-match-no-domain">
              <p>{T.noDomain}</p>
              {onSetupDomain && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={onSetupDomain}>
                  {T.setupDomain}
                </button>
              )}
            </div>
          )}

          {loaded && domain && !loaded.settings.allowed && (
            <div className="req-ad-match-msg" data-testid="join-ad-match-blocked">
              <p>{T.blocked}</p>
              <ul className="req-ad-match-outdated">
                {loaded.settings.outdated.map((o, i) => (
                  <li key={`${i}-${o.name}`}>
                    {o.appVersion ? S.outdatedVersion(o.name, o.appVersion) : S.outdatedUnknown(o.name)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {loaded && domain && loaded.settings.allowed && (
            <form className="req-ad-match-form" onSubmit={(e) => void submit(e)} noValidate>
              <fieldset className="req-ad-match-ous" aria-describedby={`${id}-ou-hint`}>
                <legend>{T.ouLegend}</legend>
                <p id={`${id}-ou-hint`} className="hint">
                  {T.ouHint}
                </p>
                <ul className="req-ad-match-list">
                  {outerFirst.map((name, i) => {
                    const ok = mappableOu(name);
                    const inner = i === outerFirst.length - 1;
                    return (
                      <li key={`${i}-${name}`}>
                        <label className="req-ad-match-ou" data-disabled={ok ? undefined : "true"}>
                          <input
                            type="radio"
                            name={`${id}-ou`}
                            value={name}
                            checked={ou === name}
                            disabled={!ok || saving}
                            onChange={() => setOu(name)}
                          />
                          <span className="req-ad-match-ou-name">
                            {name}
                            {inner && <span className="req-ad-match-tag">{` (${T.innermost})`}</span>}
                            {!ok && <span className="req-ad-match-tag">{` (${T.tooLong(AD_OU_MAX_CHARS)})`}</span>}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>

              {loaded.departments.length === 0 ? (
                <p>{T.noDepartments}</p>
              ) : (
                <div className="field req-ad-match-dept">
                  <label htmlFor={`${id}-team`}>{T.deptLabel}</label>
                  <select
                    ref={select}
                    id={`${id}-team`}
                    value={team}
                    disabled={saving}
                    aria-invalid={teamError ? true : undefined}
                    aria-describedby={teamError ? `${id}-team-err` : undefined}
                    onChange={(e) => {
                      setTeam(e.target.value);
                      setTeamError(false);
                    }}
                  >
                    <option value="">{T.choose}</option>
                    {loaded.departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                  {teamError && (
                    <div id={`${id}-team-err`}>
                      <FieldError text={T.errDept} />
                    </div>
                  )}
                </div>
              )}

              <div aria-live="polite" className="req-ad-match-live">
                {saveError && (
                  <ErrorAlert title={T.saveFail}>
                    <p>{saveError}</p>
                  </ErrorAlert>
                )}
              </div>

              <div className="req-ad-match-actions">
                <button
                  type="submit"
                  className="btn btn-sm"
                  disabled={saving || !ou || loaded.departments.length === 0}
                  aria-busy={saving || undefined}
                >
                  {saving ? T.submitting : T.submit}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={close}>
                  {T.cancel}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
