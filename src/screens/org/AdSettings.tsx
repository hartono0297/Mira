import { IconAlertTriangle, IconPlus } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { divisionApi, type DivisionRef } from "../../api/division";
import { orgApi, type AdSettingsView, type DepartmentView, type OuMapping } from "../../api/org";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { DIVISION_MISC } from "../../i18n/division-misc";
import { AD_TEXT } from "../../i18n/org-ad";
// Aturan domain yang sama dengan layar kantor baru (normalize_domain di Rust).
import { normalizeAdDomain } from "../onboarding/adProfile";
import type { OrgPage } from "./context";
import { useOrgLive } from "./useOrgLive";
import "./ad-settings.css";

const T = AD_TEXT.settings;
const D = () => DIVISION_MISC.ad;

// Sama dengan batas op ad_settings_set di inti Rust (docs/plans/onboarding-ad.md 3.5).
export const AD_MAX_ROWS = 100;
export const AD_OU_MAX_CHARS = 64;

// division: "" = tanpa divisi.
type Row = { key: number; ou: string; team: string; division: string };
// Kode galat, bukan teks: teksnya dibaca dari kamus saat render, jadi ikut bahasa aktif.
type RowError = { ou?: { kind: "empty" } | { kind: "duplicate"; row: number }; team?: true };
type Focus = { key: number; field: "ou" | "team" } | "add" | "domain" | null;

// OU unik tanpa beda huruf besar, seperti pemeriksaan di inti Rust.
export function validateRows(rows: { ou: string; team: string }[]): Map<number, RowError> {
  const out = new Map<number, RowError>();
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    const e: RowError = {};
    const ou = r.ou.trim();
    if (!ou) e.ou = { kind: "empty" };
    else {
      const k = ou.toLocaleLowerCase();
      const first = seen.get(k);
      if (first !== undefined) e.ou = { kind: "duplicate", row: first };
      else seen.set(k, i + 1);
    }
    if (!r.team) e.team = true;
    if (e.ou || e.team) out.set(i, e);
  });
  return out;
}

function snapshot(view: AdSettingsView): string {
  return JSON.stringify([view.domain ?? "", view.ouMap]);
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, "id");
}

// Bagian "Active Directory" di tab Departemen (superadmin). Domain AD kantor dan
// pemetaan OU ke departemen dipakai peminta untuk usulan departemen; admin tetap
// menyetujui setiap permintaan.
export function AdSettings({ page, departments }: { page: OrgPage; departments: DepartmentView[] }) {
  const live = useOrgLive(() => orgApi.adSettings(), { version: page.version });
  const data = live.data && typeof live.data === "object" ? live.data : null;
  // Pilihan divisi per baris. Yang mengubah pengaturan ini superadmin, dan
  // my_divisions untuk superadmin berisi semua divisi yang ia kelola (semua
  // departemen), jadi satu panggilan cukup untuk semua baris.
  const divLive = useOrgLive(() => divisionApi.myDivisions(), { version: page.version });
  const divisions: DivisionRef[] = Array.isArray(divLive.data) ? divLive.data : [];
  const id = useId();

  const [domain, setDomain] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Map<number, RowError>>(new Map());
  const [domainError, setDomainError] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<AppError | null>(null);
  // Form baru tampil setelah isinya disalin dari data, supaya tidak sempat kosong.
  const [ready, setReady] = useState(false);
  const nextKey = useRef(0);
  const synced = useRef<string | null>(null);
  const pendingFocus = useRef<Focus>(null);
  const fields = useRef(new Map<string, HTMLElement>());
  const addButton = useRef<HTMLButtonElement>(null);
  const domainInput = useRef<HTMLInputElement>(null);

  // Isi form mengikuti data terbaru selama belum diubah. Muat ulang berkala dengan
  // isi yang sama tidak membuat ulang baris, supaya fokus tidak hilang.
  useEffect(() => {
    if (!data || dirty) return;
    const snap = snapshot(data);
    if (snap === synced.current) return;
    synced.current = snap;
    setDomain(data.domain ?? "");
    setRows(data.ouMap.map((m) => ({ key: nextKey.current++, ou: m.ou, team: m.team, division: m.division ?? "" })));
    setErrors(new Map());
    setDomainError(false);
    setShowSummary(false);
    setReady(true);
  }, [data, dirty]);

  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    if (target === "add") addButton.current?.focus();
    else if (target === "domain") domainInput.current?.focus();
    else fields.current.get(`${target.field}-${target.key}`)?.focus();
  });

  const editable = !!data && data.canEdit && data.allowed;
  const active = departments.filter((d) => !d.archived).sort(byName);
  const machine = data?.machineDomain?.trim() || null;
  const showMachine = editable && machine !== null && machine.toLowerCase() !== domain.trim().toLowerCase();

  function touch() {
    setDirty(true);
    setSaveError(null);
  }

  function updateRow(index: number, patch: Partial<Row>, field: "ou" | "team") {
    touch();
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    const e = errors.get(index);
    if (e?.[field]) {
      const next = new Map(errors);
      const rest = { ...e, [field]: undefined };
      if (rest.ou || rest.team) next.set(index, rest);
      else next.delete(index);
      setErrors(next);
    }
  }

  function setDivision(index: number, division: string) {
    touch();
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, division } : r)));
  }

  // Departemen baris berganti: divisi yang bukan milik departemen baru dilepas.
  function divisionFor(team: string, division: string): string {
    return divisions.some((d) => d.id === division && d.teamId === team) ? division : "";
  }

  function addRow() {
    if (rows.length >= AD_MAX_ROWS) return;
    touch();
    const key = nextKey.current++;
    setRows((prev) => [...prev, { key, ou: "", team: "", division: "" }]);
    pendingFocus.current = { key, field: "ou" };
  }

  function removeRow(index: number) {
    touch();
    const next = rows[index + 1] ?? rows[index - 1];
    setRows((prev) => prev.filter((_, i) => i !== index));
    // Galat dihitung ulang saat simpan berikutnya; nomor baris lama tidak berlaku lagi.
    setErrors(new Map());
    setShowSummary(false);
    pendingFocus.current = next ? { key: next.key, field: "ou" } : "add";
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!editable || saving) return;
    const trimmed = domain.trim();
    const normalized = trimmed === "" ? "" : normalizeAdDomain(trimmed);
    const badDomain = normalized === null;
    const found = validateRows(rows);
    setDomainError(badDomain);
    setErrors(found);
    if (badDomain || found.size > 0) {
      setShowSummary(true);
      if (badDomain) pendingFocus.current = "domain";
      else {
        const [index, err] = [...found.entries()][0];
        pendingFocus.current = { key: rows[index].key, field: err.ou ? "ou" : "team" };
      }
      return;
    }
    setShowSummary(false);
    setSaving(true);
    setSaveError(null);
    const ouMap: OuMapping[] = rows.map((r) => ({
      ou: r.ou.trim(),
      team: r.team,
      ...(r.division ? { division: r.division } : {}),
    }));
    try {
      await orgApi.setAdSettings(normalized ?? "", ouMap);
      setDirty(false);
      synced.current = null;
      page.notify(T.saved);
      page.refresh();
      void live.reload();
    } catch (err) {
      setSaveError(toAppError(err));
    } finally {
      setSaving(false);
    }
  }

  function ouError(e: RowError | undefined): string | null {
    if (!e?.ou) return null;
    return e.ou.kind === "empty" ? T.errOuEmpty : T.errOuDuplicate(e.ou.row);
  }

  function teamOptions(current: string) {
    const options = active.map((d) => (
      <option key={d.id} value={d.id}>
        {d.name}
      </option>
    ));
    if (current && !active.some((d) => d.id === current)) {
      const known = departments.find((d) => d.id === current);
      options.unshift(
        <option key={current} value={current}>
          {known ? T.archivedOption(known.name) : T.unknownOption}
        </option>,
      );
    }
    return options;
  }

  // Divisi departemen baris itu yang masih aktif, ditambah pilihan saat ini
  // kalau sudah diarsipkan atau tidak dikenal laptop ini.
  function divisionOptions(row: Row) {
    if (!row.team) return [<option key="" value="">{D().chooseDeptFirst}</option>];
    const own = divisions
      .filter((d) => d.teamId === row.team && !d.archived)
      .sort(byName)
      .map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ));
    if (row.division && !divisions.some((d) => d.id === row.division && d.teamId === row.team && !d.archived)) {
      const known = divisions.find((d) => d.id === row.division);
      own.unshift(
        <option key={row.division} value={row.division}>
          {known?.archived ? D().archivedOption(known.name) : D().unknownOption}
        </option>,
      );
    }
    if (own.length === 0) return [<option key="" value="">{D().noDivisions}</option>];
    return [
      <option key="" value="">
        {D().none}
      </option>,
      ...own,
    ];
  }

  const headingId = `${id}-title`;

  return (
    <section className="ad-set" aria-labelledby={headingId} data-testid="ad-settings">
      <div>
        <h3 id={headingId} className="ad-set-title">
          {T.title}
        </h3>
        <p className="hint">{T.intro}</p>
      </div>

      {((live.loading && !data) || (data && !ready)) && (
        <p className="hint" role="status">
          {T.loading}
        </p>
      )}

      {!live.loading && !data && (
        <div role="alert">
          <ErrorAlert title={T.loadErrorTitle}>
            <p>{live.error?.message ?? T.loadErrorEmpty}</p>
            <button type="button" className="btn btn-ghost org-retry" onClick={() => void live.reload()}>
              {T.retry}
            </button>
          </ErrorAlert>
        </div>
      )}

      {data && ready && (
        <>
          {!data.allowed && (
            <div className="notice" data-testid="ad-settings-blocked">
              <IconAlertTriangle size={18} aria-hidden="true" />
              <div>
                <strong>{T.blockedTitle}</strong>
                <p>{T.blockedBody}</p>
                <ul className="ad-set-outdated">
                  {data.outdated.map((o, i) => (
                    <li key={`${i}-${o.name}`}>
                      {o.appVersion ? T.outdatedVersion(o.name, o.appVersion) : T.outdatedUnknown(o.name)}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {data.allowed && !data.canEdit && <p className="hint">{T.readOnly}</p>}

          <form className="ad-set-form" onSubmit={(e) => void submit(e)} noValidate>
            <fieldset className="ad-set-fields" disabled={!editable}>
              <div className="field ad-set-domain">
                <label htmlFor={`${id}-domain`}>{T.domainLabel}</label>
                <div className="ad-set-domain-row">
                  <input
                    ref={domainInput}
                    id={`${id}-domain`}
                    value={domain}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={domainError ? true : undefined}
                    aria-describedby={`${domainError ? `${id}-domain-err ` : ""}${id}-domain-hint`}
                    onChange={(e) => {
                      touch();
                      setDomain(e.target.value);
                      if (domainError) setDomainError(false);
                    }}
                  />
                  {showMachine && machine && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        touch();
                        setDomain(machine);
                        setDomainError(false);
                        pendingFocus.current = "domain";
                      }}
                    >
                      {T.useMachine(machine)}
                    </button>
                  )}
                </div>
                {domainError && (
                  <div id={`${id}-domain-err`}>
                    <FieldError text={T.errDomain} />
                  </div>
                )}
                <p id={`${id}-domain-hint`} className="hint">
                  {T.domainHint}
                </p>
              </div>

              <div className="ad-set-map">
                <h4 className="ad-set-subtitle">{T.mapTitle}</h4>
                <p className="hint ad-set-order">{T.order}</p>

                {rows.length === 0 ? (
                  <p className="org-empty">{T.empty}</p>
                ) : (
                  <table className="ad-set-table" role="table">
                    <caption className="sr-only">{T.caption}</caption>
                    <thead role="rowgroup">
                      <tr role="row">
                        <th role="columnheader" scope="col">
                          {T.colOu}
                        </th>
                        <th role="columnheader" scope="col">
                          {T.colDept}
                        </th>
                        <th role="columnheader" scope="col">
                          {D().colDivision}
                        </th>
                        <th role="columnheader" scope="col">
                          <span className="sr-only">{T.colActions}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody role="rowgroup">
                      {rows.map((r, i) => {
                        const n = i + 1;
                        const err = errors.get(i);
                        const ouMsg = ouError(err);
                        const ouId = `${id}-ou-${r.key}`;
                        const teamId = `${id}-team-${r.key}`;
                        const divId = `${id}-div-${r.key}`;
                        const divChoices = divisionOptions(r);
                        return (
                          <tr key={r.key} role="row">
                            <td role="cell" className="ad-set-ou">
                              <label htmlFor={ouId} className="ad-set-k">
                                <span aria-hidden="true">{T.colOu}</span>
                                <span className="sr-only">{T.cellLabel(T.colOu, n)}</span>
                              </label>
                              <input
                                ref={(el) => {
                                  if (el) fields.current.set(`ou-${r.key}`, el);
                                  else fields.current.delete(`ou-${r.key}`);
                                }}
                                id={ouId}
                                className="ad-set-input"
                                value={r.ou}
                                maxLength={AD_OU_MAX_CHARS}
                                autoComplete="off"
                                spellCheck={false}
                                aria-invalid={ouMsg ? true : undefined}
                                aria-describedby={ouMsg ? `${ouId}-err` : undefined}
                                onChange={(e) => updateRow(i, { ou: e.target.value }, "ou")}
                              />
                              {ouMsg && (
                                <div id={`${ouId}-err`}>
                                  <FieldError text={ouMsg} />
                                </div>
                              )}
                            </td>
                            <td role="cell" className="ad-set-team">
                              <label htmlFor={teamId} className="ad-set-k">
                                <span aria-hidden="true">{T.colDept}</span>
                                <span className="sr-only">{T.cellLabel(T.colDept, n)}</span>
                              </label>
                              <select
                                ref={(el) => {
                                  if (el) fields.current.set(`team-${r.key}`, el);
                                  else fields.current.delete(`team-${r.key}`);
                                }}
                                id={teamId}
                                className="ad-set-input"
                                value={r.team}
                                aria-invalid={err?.team ? true : undefined}
                                aria-describedby={err?.team ? `${teamId}-err` : undefined}
                                onChange={(e) =>
                                  updateRow(
                                    i,
                                    { team: e.target.value, division: divisionFor(e.target.value, r.division) },
                                    "team",
                                  )
                                }
                              >
                                <option value="">{T.choose}</option>
                                {teamOptions(r.team)}
                              </select>
                              {err?.team && (
                                <div id={`${teamId}-err`}>
                                  <FieldError text={T.errDepartment} />
                                </div>
                              )}
                            </td>
                            <td role="cell" className="ad-set-div">
                              <label htmlFor={divId} className="ad-set-k">
                                <span aria-hidden="true">{D().colDivision}</span>
                                <span className="sr-only">{T.cellLabel(D().colDivision, n)}</span>
                              </label>
                              <select
                                id={divId}
                                className="ad-set-input"
                                value={r.division}
                                disabled={divLive.loading || (divChoices.length === 1 && !r.division)}
                                onChange={(e) => setDivision(i, e.target.value)}
                              >
                                {divChoices}
                              </select>
                            </td>
                            <td role="cell" className="ad-set-act">
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                aria-label={T.removeAria(n)}
                                onClick={() => removeRow(i)}
                              >
                                {T.remove}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}

                <p className="hint ad-set-order">{D().note}</p>
                {divLive.error && !Array.isArray(divLive.data) && (
                  <p className="hint ad-set-order">
                    {D().loadFailed(divLive.error.message)}{" "}
                    <button type="button" className="link-btn" onClick={() => void divLive.reload()}>
                      {D().retry}
                    </button>
                  </p>
                )}

                <div className="ad-set-add">
                  <button
                    ref={addButton}
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={rows.length >= AD_MAX_ROWS}
                    aria-describedby={`${id}-limit`}
                    onClick={addRow}
                  >
                    <IconPlus size={16} aria-hidden="true" />
                    {T.add}
                  </button>
                  <p id={`${id}-limit`} className="hint">
                    {T.limit(AD_MAX_ROWS)}
                  </p>
                </div>
              </div>

              <div aria-live="polite" className="ad-set-live">
                {showSummary && (errors.size > 0 || domainError) && <FieldError text={T.errSummary} />}
                {saveError && (
                  <ErrorAlert title={T.saveFail}>
                    <p>{saveError.message}</p>
                  </ErrorAlert>
                )}
              </div>

              <div className="ad-set-actions">
                <button type="submit" className="btn" aria-busy={saving || undefined}>
                  {saving ? T.saving : T.save}
                </button>
              </div>
            </fieldset>
          </form>
        </>
      )}
    </section>
  );
}
