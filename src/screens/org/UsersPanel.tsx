import {
  IconBrandApple,
  IconBrandWindows,
  IconBuildingCommunity,
  IconDoorExit,
  IconDotsVertical,
  IconSearch,
  IconShieldCheck,
} from "@tabler/icons-react";
import { Fragment, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, toAppError, type AppError } from "../../api";
import { formatDate, relativeTime } from "../../api/format";
import { actionErrorTitle } from "../../api/messages";
import { orgApi, type DepartmentView, type UserView } from "../../api/org";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { MenuButton, menuItems, SEPARATOR, useContextMenu, type MenuEntry } from "../../components/ContextMenu";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { initials } from "../../components/initials";
import { NameWithLabels } from "../../components/NameWithLabels";
import { useLang } from "../../i18n/core";
import { ORG_TEXT, USERS_TEXT as T } from "../../i18n/org";
import type { OrgPage } from "./context";
import { byName, matches, orgMessage, roleText } from "./PeoplePanel";
import { useOrgLive } from "./useOrgLive";
import "./users.css";

type DeptFilter = "all" | "none" | "guest" | string;
type StatusFilter = "active" | "online" | "offline" | "removed";

const STATUS_OPTIONS: StatusFilter[] = ["active", "online", "offline", "removed"];

type Filters = { query: string; dept: DeptFilter; status: StatusFilter };
const NO_FILTERS: Filters = { query: "", dept: "all", status: "active" };

type DeptOption = { id: string; name: string };

// Laptop ini selalu sedang berjalan, jadi dihitung online.
function isOnline(u: UserView): boolean {
  return u.isMe || u.online;
}

function passes(u: UserView, f: Filters): boolean {
  if (f.status === "removed") {
    if (u.status !== "removed") return false;
  } else {
    if (u.status !== "active") return false;
    if (f.status === "online" && !isOnline(u)) return false;
    if (f.status === "offline" && isOnline(u)) return false;
  }
  if (f.dept === "none" && (u.isGuest || u.departmentId !== null)) return false;
  if (f.dept === "guest" && !u.isGuest) return false;
  if (f.dept !== "all" && f.dept !== "none" && f.dept !== "guest" && (u.isGuest || u.departmentId !== f.dept)) {
    return false;
  }
  return matches(f.query, [u.displayName, ...u.labels.map((l) => l.name), u.device?.laptop, u.lastIp]);
}

function subjectText(dept: DeptFilter, deptName: (id: string) => string): string {
  if (dept === "all") return T.empty.subjectAll;
  if (dept === "none") return T.empty.subjectNone;
  if (dept === "guest") return T.empty.subjectGuest;
  return T.empty.subjectDept(deptName(dept));
}

function statusClause(status: StatusFilter): string | null {
  if (status === "online") return T.empty.clauseOnline;
  if (status === "offline") return T.empty.clauseOffline;
  if (status === "removed") return T.empty.clauseRemoved;
  return null;
}

type Loosen = { label: string; next: Filters; note: string };

// Hasil saring kosong: kalimat yang menyebut saringan aktif, dan satu tombol
// yang melonggarkan saringan yang paling mungkin memberi hasil.
function emptyResult(users: UserView[], f: Filters, deptName: (id: string) => string): { title: string; loosen: Loosen } {
  const subject = subjectText(f.dept, deptName);
  const clauses = [statusClause(f.status), f.query.trim() ? T.empty.clauseQuery(f.query.trim()) : null].filter(Boolean);
  const title = T.empty.title(subject, clauses.join(T.empty.and));
  const count = (next: Filters) => users.filter((u) => passes(u, next)).length;
  const people = (n: number) =>
    f.dept === "all"
      ? T.empty.countAll(n)
      : f.dept === "none"
        ? T.empty.countNone(n)
        : f.dept === "guest"
          ? T.empty.countGuest(n)
          : T.empty.countDept(n, deptName(f.dept));

  if (f.status !== "active") {
    const next = { ...f, status: "active" as const };
    const n = count(next);
    if (n > 0) {
      const state = f.status === "online" ? T.empty.nowOffline : f.status === "offline" ? T.empty.nowOnline : T.empty.stillActive;
      return { title, loosen: { label: T.empty.clearStatus, next, note: state(n, people(n)) } };
    }
  }
  if (f.dept !== "all") {
    const next = { ...f, dept: "all" };
    const n = count(next);
    if (n > 0) {
      return { title, loosen: { label: T.empty.clearDept, next, note: T.empty.otherDepts(n) } };
    }
  }
  if (f.query.trim()) {
    const next = { ...f, query: "" };
    const n = count(next);
    if (n > 0) {
      return {
        title,
        loosen: { label: T.empty.clearSearch, next, note: T.empty.searchScope },
      };
    }
  }
  return { title, loosen: { label: T.empty.clearAll, next: NO_FILTERS, note: T.empty.stillNothing } };
}

function ErrorBox({ error, title }: { error: AppError; title: string }) {
  return (
    <ErrorAlert title={actionErrorTitle(error, title)}>
      <p>{orgMessage(error.message)}</p>
      {error.code === "last_superadmin" && <p>{ORG_TEXT.lastSuperadminHint}</p>}
    </ErrorAlert>
  );
}

function OsIcon({ os }: { os: string }) {
  const lower = os.toLowerCase();
  if (lower.startsWith("windows")) return <IconBrandWindows size={15} aria-hidden="true" />;
  if (lower.startsWith("mac")) return <IconBrandApple size={15} aria-hidden="true" />;
  return null;
}

function departmentCell(u: UserView, deptName: (id: string) => string): string {
  if (u.isGuest) return T.guestCell(u.guestProjectCount);
  if (u.departmentId === null) return T.noDepartment;
  return u.departmentName ?? deptName(u.departmentId);
}

function Status({ u }: { u: UserView }) {
  if (u.status === "removed") {
    return <span className="users-st">{T.removedOn(u.removedAt ? formatDate(u.removedAt) : "")}</span>;
  }
  const on = isOnline(u);
  const text = u.isMe
    ? T.thisLaptop
    : u.online
      ? T.online
      : u.lastSeenAt
        ? T.lastSeen(relativeTime(u.lastSeenAt))
        : T.neverSeen;
  return (
    <span className="users-st">
      <span className={on ? "users-dot" : "users-dot users-dot-off"} aria-hidden="true" />
      {text}
      {u.isMe && <span className="sr-only">{T.onlineSr}</span>}
    </span>
  );
}

// Teks menu aksi per orang. "Aksi untuk" juga nama tombol titik tiga yang
// dipakai uji e2e, jadi jangan diubah tanpa mengubah skripnya. Objek kamus ini
// membaca bahasa aktif setiap kali propertinya dibaca.
const MENU_TEXT = T.menu;

// Mengganti {kunci} di kalimat kamus dengan isinya (teks atau elemen).
function fill(template: string, values: Record<string, ReactNode>): ReactNode[] {
  return template.split(/(\{\w+\})/).map((part, i) => {
    const key = /^\{(\w+)\}$/.exec(part)?.[1];
    return <Fragment key={i}>{key !== undefined && key in values ? values[key] : part}</Fragment>;
  });
}

type RowActions = {
  onMove: (u: UserView) => void;
  onRole: (u: UserView) => void;
  onRemove: (u: UserView) => void;
};

// Hak yang sama dengan menu lama: Tamu tidak punya departemen dan peran,
// diri sendiri tidak bisa dikeluarkan, orang yang sudah dikeluarkan tidak punya aksi.
function hasActions(u: UserView): boolean {
  return u.status === "active" && (!u.isGuest || !u.isMe);
}

function rowMenu(u: UserView, busy: boolean, act: RowActions): MenuEntry[] {
  if (!hasActions(u)) return [];
  const disabled = busy ? MENU_TEXT.busy : undefined;
  return menuItems(
    !u.isGuest && {
      id: "move",
      label: MENU_TEXT.move,
      icon: <IconBuildingCommunity size={16} aria-hidden="true" />,
      disabled,
      onSelect: () => act.onMove(u),
    },
    !u.isGuest && {
      id: "role",
      label: MENU_TEXT.role,
      icon: <IconShieldCheck size={16} aria-hidden="true" />,
      disabled,
      onSelect: () => act.onRole(u),
    },
    SEPARATOR,
    !u.isMe && {
      id: "remove",
      label: MENU_TEXT.remove,
      icon: <IconDoorExit size={16} aria-hidden="true" />,
      danger: true,
      disabled,
      onSelect: () => act.onRemove(u),
    },
  );
}

function DialogError({ error, title }: { error: AppError | null; title: string }) {
  return (
    <div aria-live="polite">{error && <ErrorBox error={error} title={title} />}</div>
  );
}

function MoveDialog({
  user,
  departments,
  departmentsError,
  onRetryDepartments,
  onClose,
  page,
}: {
  user: UserView;
  departments: DepartmentView[] | null;
  departmentsError: AppError | null;
  onRetryDepartments: () => void;
  onClose: () => void;
  page: OrgPage;
}) {
  const selectId = useId();
  const hintId = useId();
  const options = (departments ?? [])
    .filter((d) => !d.archived && d.id !== user.departmentId)
    .sort((a, b) => a.name.localeCompare(b.name, "id"));
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const chosen = options.find((d) => d.id === target) ?? null;
  const current = (departments ?? []).find((d) => d.id === user.departmentId) ?? null;
  const currentName = user.departmentId === null ? null : (user.departmentName ?? current?.name ?? T.move.oldDept);
  const channel = (d: DepartmentView | null, fallback: string) =>
    d?.channelName ? <span className="users-ch"># {d.channelName}</span> : T.move.channel(fallback);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    try {
      await orgApi.moveMember(user.publicKey, chosen.id);
      page.notify(user.isMe ? T.move.doneSelf(chosen.name) : T.move.done(user.displayName, chosen.name));
      page.refresh();
      onClose();
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={user.isMe ? T.move.titleSelf : T.move.title(user.displayName)}
    >
      <form className="dlg-form" onSubmit={(e) => void submit(e)}>
        <dl className="users-kv">
          <dt>{T.move.current}</dt>
          <dd>{currentName ?? T.noDepartment}</dd>
        </dl>
        {departments === null ? (
          departmentsError ? (
            <div role="alert">
              <ErrorAlert title={T.move.listErrorTitle}>
                <p>{orgMessage(departmentsError.message)}</p>
                <button type="button" className="btn btn-ghost org-retry" onClick={onRetryDepartments}>
                  {ORG_TEXT.retry}
                </button>
              </ErrorAlert>
            </div>
          ) : (
            <p className="hint" role="status">
              {T.move.listLoading}
            </p>
          )
        ) : options.length === 0 ? (
          <p className="users-note">{user.isMe ? T.move.noOtherSelf : T.move.noOther(user.displayName)}</p>
        ) : (
          <>
            <div className="field">
              <label htmlFor={selectId}>{T.move.target}</label>
              <select
                id={selectId}
                value={chosen?.id ?? ""}
                aria-describedby={chosen ? hintId : undefined}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="" disabled>
                  {T.move.choose}
                </option>
                {options.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            {chosen && (
              <p id={hintId} className="users-note">
                {currentName
                  ? fill(user.isMe ? T.move.fromToSelf : T.move.fromTo, {
                      name: user.displayName,
                      from: channel(current, currentName),
                      to: channel(chosen, chosen.name),
                    })
                  : fill(user.isMe ? T.move.toSelf : T.move.to, {
                      name: user.displayName,
                      to: channel(chosen, chosen.name),
                    })}{" "}
                {T.move.unchanged}
                {user.departmentRole === "admin" && currentName && T.move.adminLost(currentName)}
              </p>
            )}
          </>
        )}
        <DialogError error={error} title={T.move.failTitle} />
        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={busy}>
              {T.cancel}
            </button>
          </DialogClose>
          {options.length > 0 && (
            <button type="submit" className="btn" disabled={busy || !chosen} aria-busy={busy || undefined}>
              {busy ? T.move.moving : T.move.submit}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

function RoleDialog({
  user,
  superadminCount,
  onClose,
  page,
}: {
  user: UserView;
  superadminCount: number;
  onClose: () => void;
  page: OrgPage;
}) {
  const groupName = useId();
  const saId = useId();
  const saNoteId = useId();
  const hasDept = user.departmentId !== null;
  const [admin, setAdmin] = useState(user.departmentRole === "admin");
  const [superadmin, setSuperadmin] = useState(user.isSuperadmin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const lastSuperadmin = user.isSuperadmin && superadminCount <= 1;
  const adminChanged = hasDept && admin !== (user.departmentRole === "admin");
  const saChanged = superadmin !== user.isSuperadmin;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || (!adminChanged && !saChanged)) return;
    setBusy(true);
    setError(null);
    let done = false;
    try {
      if (adminChanged && user.departmentId) {
        await orgApi.setDepartmentAdmin(user.departmentId, user.publicKey, admin);
        done = true;
      }
      if (saChanged) {
        if (superadmin) await api.addSuperadmin(user.publicKey);
        else await api.removeSuperadmin(user.publicKey);
      }
      const text = roleText({
        isGuest: false,
        isSuperadmin: superadmin,
        departmentRole: hasDept ? (admin ? "admin" : "member") : null,
      });
      page.notify(user.isMe ? T.role.doneSelf(text) : T.role.done(user.displayName, text));
      page.refresh();
      onClose();
    } catch (err) {
      setError(toAppError(err));
      // Perubahan pertama mungkin sudah tersimpan: muat ulang supaya daftar benar.
      if (done) page.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={user.isMe ? T.role.titleSelf : T.role.title(user.displayName)}
    >
      <form className="dlg-form" onSubmit={(e) => void submit(e)}>
        {hasDept ? (
          <fieldset className="role-set">
            <legend className="users-legend">{T.role.legend(user.departmentName ?? "")}</legend>
            <label className="role-opt">
              <input type="radio" name={groupName} checked={!admin} onChange={() => setAdmin(false)} />
              <span>
                <span className="role-title">{T.role.member}</span>
                <span className="role-desc">{T.role.memberDesc}</span>
              </span>
            </label>
            <label className="role-opt">
              <input type="radio" name={groupName} checked={admin} onChange={() => setAdmin(true)} />
              <span>
                <span className="role-title">{T.role.admin}</span>
                <span className="role-desc">{T.role.adminDesc}</span>
              </span>
            </label>
          </fieldset>
        ) : (
          <p className="users-note">{user.isMe ? T.role.noDeptSelf : T.role.noDept(user.displayName)}</p>
        )}

        <div className="users-sa">
          <p className="users-legend">{T.role.superadmin}</p>
          <label className={lastSuperadmin ? "role-opt role-opt-off" : "role-opt"} htmlFor={saId}>
            <input
              id={saId}
              type="checkbox"
              checked={superadmin}
              disabled={lastSuperadmin}
              aria-describedby={lastSuperadmin ? saNoteId : undefined}
              onChange={(e) => setSuperadmin(e.target.checked)}
            />
            <span>
              <span className="role-title">{T.role.makeSuperadmin}</span>
              <span className="role-desc">{T.role.superadminDesc}</span>
              {lastSuperadmin && (
                <span id={saNoteId} className="role-note">
                  {user.isMe ? T.role.onlySuperadminSelf : T.role.onlySuperadmin(user.displayName)}
                </span>
              )}
            </span>
          </label>
        </div>

        <DialogError error={error} title={T.role.failTitle} />
        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={busy}>
              {T.cancel}
            </button>
          </DialogClose>
          <button type="submit" className="btn" disabled={busy || (!adminChanged && !saChanged)} aria-busy={busy || undefined}>
            {busy ? T.role.saving : T.role.submit}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

type Open = { kind: "move" | "role" | "remove"; user: UserView } | null;

// Daftar pengguna khusus superadmin: laptop, IP, sistem, status, dan aksi per orang.
export function UsersPanel({ page }: { page: OrgPage }) {
  const live = useOrgLive(() => orgApi.users(), { version: page.version, network: true });
  const depts = useOrgLive(() => orgApi.departments(false), { version: page.version });
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [open, setOpen] = useState<Open>(null);
  const searchId = useId();
  const deptId = useId();
  const statusId = useId();
  const lang = useLang();

  const users = useMemo(() => [...(live.data ?? [])].sort(byName), [live.data]);
  const deptOptions: DeptOption[] = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of depts.data ?? []) if (!d.archived) map.set(d.id, d.name);
    for (const u of users) if (u.departmentId && !map.has(u.departmentId)) map.set(u.departmentId, u.departmentName ?? T.otherDept);
    return [...map].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "id"));
    // lang: nama cadangan "Departemen lain" ikut bahasa aktif.
  }, [depts.data, users, lang]);
  const deptName = (id: string) => deptOptions.find((d) => d.id === id)?.name ?? T.otherDept;

  const active = users.filter((u) => u.status === "active");
  const superadminCount = active.filter((u) => u.isSuperadmin).length;
  const shown = users.filter((u) => passes(u, filters));
  const onlyMe = active.length <= 1 && active.every((u) => u.isMe);
  const busy = page.pending !== null;

  // Setelah seseorang dikeluarkan, barisnya hilang dari daftar. Fokus pindah ke
  // tombol aksi orang berikutnya (atau sebelumnya), kalau tidak ada ke judul tab.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [refocus, setRefocus] = useState<{ gone: string; next: string | null } | null>(null);
  useEffect(() => {
    if (!refocus || shown.some((u) => u.publicKey === refocus.gone)) return;
    const target = refocus.next
      ? tableRef.current?.querySelector<HTMLButtonElement>(`[data-user-key="${refocus.next}"] [aria-haspopup="menu"]`)
      : null;
    (target ?? headingRef.current)?.focus();
    setRefocus(null);
  });

  function removed(u: UserView) {
    const i = shown.findIndex((x) => x.publicKey === u.publicKey);
    const others = [...shown.slice(i + 1), ...shown.slice(0, Math.max(i, 0)).reverse()];
    const next = others.find((x) => hasActions(x)) ?? null;
    setRefocus({ gone: u.publicKey, next: next?.publicKey ?? null });
    setOpen(null);
  }

  function set(next: Partial<Filters>) {
    setFilters((f) => ({ ...f, ...next }));
  }

  const actions: RowActions = {
    onMove: (u) => setOpen({ kind: "move", user: u }),
    onRole: (u) => setOpen({ kind: "role", user: u }),
    onRemove: (u) => setOpen({ kind: "remove", user: u }),
  };

  const empty = live.data && shown.length === 0 && users.length > 0 ? emptyResult(users, filters, deptName) : null;

  return (
    <section className="set-section users" aria-labelledby="users-title">
      <div className="org-head">
        <div>
          <h2 id="users-title" className="set-title" ref={headingRef} tabIndex={-1}>
            {T.title}
          </h2>
          <p className="hint">{T.hint}</p>
        </div>
      </div>

      {live.loading && !live.data && (
        <p className="hint" role="status">
          {T.loading}
        </p>
      )}

      {!live.loading && !live.data && (
        <div role="alert">
          <ErrorAlert title={T.loadErrorTitle}>
            <p>{live.error ? orgMessage(live.error.message) : T.loadErrorEmpty}</p>
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

          {onlyMe && (
            <div className="org-empty">
              <p>{T.alone}</p>
            </div>
          )}

          <div className="users-tools">
            <div className="field users-search">
              <label htmlFor={searchId}>{T.search}</label>
              <span className="users-search-box">
                <IconSearch size={16} aria-hidden="true" />
                <input
                  id={searchId}
                  type="search"
                  value={filters.query}
                  placeholder={T.searchPlaceholder}
                  autoComplete="off"
                  onChange={(e) => set({ query: e.target.value })}
                />
              </span>
            </div>
            <div className="field users-select">
              <label htmlFor={deptId}>{T.department}</label>
              <select id={deptId} value={filters.dept} onChange={(e) => set({ dept: e.target.value })}>
                <option value="all">{T.all}</option>
                {deptOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
                <option value="none">{T.noDepartment}</option>
                <option value="guest">{T.guests}</option>
              </select>
            </div>
            <div className="field users-select">
              <label htmlFor={statusId}>{T.statusLabel}</label>
              <select id={statusId} value={filters.status} onChange={(e) => set({ status: e.target.value as StatusFilter })}>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {T.status[s]}
                  </option>
                ))}
              </select>
            </div>
            <p className="users-count" role="status">
              {T.count(shown.length)}
            </p>
          </div>

          {empty && (
            <div className="org-empty users-none">
              <p>
                <strong>{empty.title}</strong>
              </p>
              <p className="hint">{empty.loosen.note}</p>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFilters(empty.loosen.next)}>
                {empty.loosen.label}
              </button>
            </div>
          )}

          {shown.length > 0 && (
            <table className="ut" role="table" aria-labelledby="users-title" ref={tableRef}>
              <thead role="rowgroup">
                <tr role="row">
                  <th role="columnheader" scope="col">{T.colName}</th>
                  <th role="columnheader" scope="col">{T.colDept}</th>
                  <th role="columnheader" scope="col">{T.colLaptop}</th>
                  <th role="columnheader" scope="col">{T.colSystem}</th>
                  <th role="columnheader" scope="col">{T.colStatus}</th>
                  <th role="columnheader" scope="col">{T.colJoined}</th>
                  <th role="columnheader" scope="col">
                    <span className="sr-only">{T.colActions}</span>
                  </th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {shown.map((u) => (
                  <UserRow key={u.publicKey} u={u} deptName={deptName} busy={busy} actions={actions} />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {open?.kind === "move" && (
        <MoveDialog
          user={open.user}
          departments={depts.data}
          departmentsError={depts.error}
          onRetryDepartments={() => void depts.reload()}
          onClose={() => setOpen(null)}
          page={page}
        />
      )}
      {open?.kind === "role" && (
        <RoleDialog user={open.user} superadminCount={superadminCount} onClose={() => setOpen(null)} page={page} />
      )}

      {open?.kind === "remove" && (
        <RemoveDialog user={open.user} onClose={() => setOpen(null)} onRemoved={removed} page={page} />
      )}
    </section>
  );
}

// Satu baris orang. Klik kanan, tombol Menu, atau Shift+F10 di baris membuka
// menu yang sama dengan tombol titik tiga.
function UserRow({
  u,
  deptName,
  busy,
  actions,
}: {
  u: UserView;
  deptName: (id: string) => string;
  busy: boolean;
  actions: RowActions;
}) {
  const menu = useContextMenu({ label: MENU_TEXT.label(u.displayName), items: rowMenu(u, busy, actions) });
  return (
    <tr
      role="row"
      className={u.status === "removed" ? "ut-off" : undefined}
      data-user-key={u.publicKey}
      {...menu.triggerProps}
    >
      <td role="cell" className="ut-name">
        <span className="users-av" aria-hidden="true">
          {initials(u.displayName)}
        </span>
        <span className="ut-who">
          <NameWithLabels className="ut-n" name={u.displayName} labels={u.labels} suffix={u.isMe ? ORG_TEXT.you : undefined} />
          <span className="ut-sub">{roleText(u)}</span>
        </span>
      </td>
      <td role="cell" className="ut-dept">
        <span className="ut-k">{T.colDept}</span>
        <span className={u.isGuest || u.departmentId === null ? "ut-muted" : undefined}>{departmentCell(u, deptName)}</span>
      </td>
      <td role="cell" className="ut-laptop">
        <span className="ut-k">{T.colLaptop}</span>
        {u.device ? <span className="mono ut-mono">{u.device.laptop}</span> : <span className="ut-muted">{T.notReported}</span>}
        <span className={u.lastIp ? "mono ut-mono ut-sub" : "ut-sub"}>
          {u.lastIp ?? (u.isMe ? T.notRecorded : T.notSeen)}
        </span>
      </td>
      <td role="cell" className="ut-sys">
        <span className="ut-k">{T.colSystem}</span>
        {u.device ? (
          <>
            <span className="ut-os">
              <OsIcon os={u.device.os} />
              {u.device.os}
            </span>
            <span className="mono ut-mono ut-sub">Mira {u.device.appVersion}</span>
          </>
        ) : (
          <span className="ut-muted">
            <span aria-hidden="true">-</span>
            <span className="sr-only">{T.notReported}</span>
          </span>
        )}
      </td>
      <td role="cell" className="ut-status">
        <span className="ut-k">{T.colStatus}</span>
        <Status u={u} />
      </td>
      <td role="cell" className="ut-joined">
        <span className="ut-k">{T.colJoined}</span>
        <span>{formatDate(u.joinedAt)}</span>
      </td>
      <td role="cell" className="ut-act">
        <MenuButton
          menu={menu}
          label={MENU_TEXT.label(u.displayName)}
          className="btn btn-ghost btn-sm users-menu-btn"
          icon={<IconDotsVertical size={18} aria-hidden="true" />}
        />
        {menu.element}
      </td>
    </tr>
  );
}

function RemoveDialog({
  user,
  onClose,
  onRemoved,
  page,
}: {
  user: UserView;
  onClose: () => void;
  onRemoved: (u: UserView) => void;
  page: OrgPage;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const name = user.displayName;

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.removeMember(user.publicKey);
      page.notify(T.remove.done(name));
      page.refresh();
      onRemoved(user);
    } catch (err) {
      setError(toAppError(err));
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={T.remove.title(name)}
      confirmLabel={T.remove.confirm(name)}
      busyLabel={T.remove.busy}
      busy={busy}
      onConfirm={() => void confirm()}
      error={error && <ErrorBox error={error} title={T.remove.failTitle(name)} />}
    >
      <p>{T.remove.effect(name)}</p>
      <p>{T.remove.data(name)}</p>
      <p>{T.remove.final}</p>
    </ConfirmDialog>
  );
}
