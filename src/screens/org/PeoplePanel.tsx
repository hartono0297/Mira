import { IconSearch } from "@tabler/icons-react";
import { useId, useMemo, useState } from "react";
import { ROLE_LABELS, TEAM_ROLE_LABELS } from "../../api";
import { orgApi, type PersonView } from "../../api/org";
import { ErrorAlert } from "../../components/ErrorAlert";
import { initials } from "../../components/initials";
import { NameWithLabels } from "../../components/NameWithLabels";
import { getLang } from "../../i18n/core";
import { ORG_TEXT, USERS_TEXT } from "../../i18n/org";
import type { OrgPage } from "./context";
import { ReinstateDialog, SuspendedStatus, TakeOutDialog, type StatusTarget } from "./UsersPanelStatus";
import { useOrgLive } from "./useOrgLive";
import "./users.css";

// 0.5.1: admin departemen menonaktifkan dan mengaktifkan lagi anggota biasa
// departemennya dari tab ini. Field status dan tanda aksi dibaca kalau inti
// Rust mengirimnya di org_people; tanpa itu daftar tetap hanya baca.
type PersonRow = PersonView & StatusTarget;

type Open = { kind: "suspend" | "reinstate"; person: PersonRow } | null;

// Peran yang ditulis di daftar: gabungan superadmin organisasi dan peran di departemen.
export function roleText(p: Pick<PersonView, "isGuest" | "isSuperadmin" | "departmentRole">): string {
  if (p.isGuest) return ROLE_LABELS.guest;
  if (p.isSuperadmin) return p.departmentRole === "admin" ? ORG_TEXT.people.superadminAndAdmin : ROLE_LABELS.superadmin;
  return p.departmentRole === "admin" ? TEAM_ROLE_LABELS.admin : ROLE_LABELS.member;
}

// Pesan dari inti Rust masih bisa menyebut "tim"; di tampilan v0.3 namanya departemen.
// Dalam bahasa Inggris pesan sudah dipetakan dari kodenya, dan "Tim" bisa nama orang.
export function orgMessage(message: string): string {
  if (getLang() === "en") return message;
  return message.replace(/\bTim\b/g, "Departemen").replace(/\btim\b/g, "departemen");
}

export function byName<T extends { displayName: string }>(a: T, b: T): number {
  return a.displayName.localeCompare(b.displayName, "id", { sensitivity: "base" });
}

// Cocok kalau setiap kata pencarian ada di salah satu teks.
export function matches(query: string, texts: (string | null | undefined)[]): boolean {
  const words = query.toLocaleLowerCase("id").split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = texts
    .filter((t): t is string => typeof t === "string")
    .join("\n")
    .toLocaleLowerCase("id");
  return words.every((w) => hay.includes(w));
}

// Daftar orang untuk yang bukan superadmin: hanya baca, tanpa laptop atau IP.
export function PeoplePanel({ page }: { page: OrgPage }) {
  const live = useOrgLive<PersonRow[]>(() => orgApi.people(), { version: page.version });
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Open>(null);
  const searchId = useId();
  const T = USERS_TEXT;

  const people = useMemo(() => [...(live.data ?? [])].sort(byName), [live.data]);
  const shown = people.filter((p) =>
    matches(query, [p.displayName, ...p.labels.map((l) => l.name)]),
  );
  const onlyMe = people.length === 0 || (people.length === 1 && page.isMe(people[0].publicKey));

  return (
    <section className="set-section users" aria-labelledby="people-title">
      <div className="org-head">
        <div>
          <h2 id="people-title" className="set-title">
            {ORG_TEXT.people.title}
          </h2>
          <p className="hint">{ORG_TEXT.people.hint}</p>
        </div>
      </div>

      {live.loading && !live.data && (
        <p className="hint" role="status">
          {ORG_TEXT.people.loading}
        </p>
      )}

      {!live.loading && !live.data && (
        <div role="alert">
          <ErrorAlert title={ORG_TEXT.people.loadErrorTitle}>
            <p>{live.error ? orgMessage(live.error.message) : ORG_TEXT.people.loadErrorEmpty}</p>
            <button type="button" className="btn btn-ghost org-retry" onClick={() => void live.reload()}>
              {ORG_TEXT.retry}
            </button>
          </ErrorAlert>
        </div>
      )}

      {live.data && (
        <>
          {live.error && (
            <p className="hint">{ORG_TEXT.stale(orgMessage(live.error.message))}</p>
          )}

          {onlyMe ? (
            <div className="org-empty">
              <p>{ORG_TEXT.people.alone}</p>
            </div>
          ) : (
            <div className="users-tools">
              <div className="field users-search">
                <label htmlFor={searchId}>{ORG_TEXT.people.search}</label>
                <span className="users-search-box">
                  <IconSearch size={16} aria-hidden="true" />
                  <input
                    id={searchId}
                    type="search"
                    value={query}
                    placeholder={ORG_TEXT.people.searchPlaceholder}
                    autoComplete="off"
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </span>
              </div>
              <p className="users-count" role="status">
                {ORG_TEXT.people.count(shown.length)}
              </p>
            </div>
          )}

          {!onlyMe && shown.length === 0 && (
            <div className="org-empty users-none">
              <p>
                <strong>{ORG_TEXT.people.noMatch(query.trim())}</strong>
              </p>
              <p className="hint">{ORG_TEXT.people.noMatchHint}</p>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setQuery("")}>
                {ORG_TEXT.people.clearSearch}
              </button>
            </div>
          )}

          {shown.length > 0 && (
            <ul className="row-list people-list">
              {shown.map((p) => {
                const self = page.isMe(p.publicKey);
                const suspended = p.status === "suspended";
                const canSuspend = !self && !suspended && p.canSuspend === true;
                const canReinstate = !self && suspended && p.canReinstate === true;
                return (
                  <li key={p.publicKey} className="row">
                    <span className="users-av" aria-hidden="true">
                      {initials(p.displayName)}
                    </span>
                    <div className="row-main">
                      <NameWithLabels
                        className="row-name"
                        name={p.displayName}
                        labels={p.labels}
                        suffix={self ? ORG_TEXT.you : undefined}
                      />
                      <span className="row-sub">
                        {p.isGuest ? ORG_TEXT.people.guest : (p.departmentName ?? ORG_TEXT.people.noDepartment)}
                        {!p.isGuest && <>, {roleText(p).toLocaleLowerCase("id")}</>}
                      </span>
                      {suspended && <SuspendedStatus u={p} />}
                    </div>
                    {canSuspend && (
                      <span className="people-act">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-label={T.people.suspendAria(p.displayName)}
                          onClick={() => setOpen({ kind: "suspend", person: p })}
                        >
                          {T.menu.suspend}
                        </button>
                      </span>
                    )}
                    {canReinstate && (
                      <span className="people-act">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-label={T.people.reinstateAria(p.displayName)}
                          onClick={() => setOpen({ kind: "reinstate", person: p })}
                        >
                          {T.menu.reinstate}
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {open?.kind === "suspend" && (
        <TakeOutDialog
          user={open.person}
          allowSuspend
          allowRemove={false}
          onClose={() => setOpen(null)}
          onDone={() => setOpen(null)}
          page={page}
        />
      )}
      {open?.kind === "reinstate" && (
        <ReinstateDialog user={open.person} onClose={() => setOpen(null)} onDone={() => setOpen(null)} page={page} />
      )}
    </section>
  );
}
