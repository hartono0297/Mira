import {
  IconBrandApple,
  IconBrandWindows,
  IconBuildingCommunity,
  IconDoorExit,
  IconDotsVertical,
  IconSearch,
  IconShieldCheck,
} from "@tabler/icons-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
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
import type { OrgPage } from "./context";
import { byName, matches, orgMessage, roleText } from "./PeoplePanel";
import { useOrgLive } from "./useOrgLive";
import "./users.css";

type DeptFilter = "all" | "none" | "guest" | string;
type StatusFilter = "active" | "online" | "offline" | "removed";

const STATUS_OPTIONS: { id: StatusFilter; label: string }[] = [
  { id: "active", label: "Semua yang aktif" },
  { id: "online", label: "Online" },
  { id: "offline", label: "Offline" },
  { id: "removed", label: "Dikeluarkan" },
];

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
  if (dept === "all") return "orang";
  if (dept === "none") return "orang tanpa departemen";
  if (dept === "guest") return "Tamu";
  return `orang ${deptName(dept)}`;
}

const STATUS_CLAUSE: Record<StatusFilter, string | null> = {
  active: null,
  online: "sedang online",
  offline: "sedang offline",
  removed: "sudah dikeluarkan",
};

type Loosen = { label: string; next: Filters; note: string };

// Hasil saring kosong: kalimat yang menyebut saringan aktif, dan satu tombol
// yang melonggarkan saringan yang paling mungkin memberi hasil.
function emptyResult(users: UserView[], f: Filters, deptName: (id: string) => string): { title: string; loosen: Loosen } {
  const subject = subjectText(f.dept, deptName);
  const clauses = [STATUS_CLAUSE[f.status], f.query.trim() ? `cocok dengan "${f.query.trim()}"` : null].filter(Boolean);
  const title = `Tidak ada ${subject}${clauses.length ? ` yang ${clauses.join(" dan ")}` : ""}`;
  const count = (next: Filters) => users.filter((u) => passes(u, next)).length;
  const people = (n: number) =>
    f.dept === "all"
      ? `${n} orang`
      : f.dept === "none"
        ? `${n} orang tanpa departemen`
        : f.dept === "guest"
          ? `${n} Tamu`
          : `${n} orang di ${deptName(f.dept)}`;

  if (f.status !== "active") {
    const next = { ...f, status: "active" as const };
    const n = count(next);
    if (n > 0) {
      const state = f.status === "online" ? "sedang offline" : f.status === "offline" ? "sedang online" : "masih aktif";
      return { title, loosen: { label: "Hapus saringan status", next, note: `${people(n)} ${state}.` } };
    }
  }
  if (f.dept !== "all") {
    const next = { ...f, dept: "all" };
    const n = count(next);
    if (n > 0) {
      return { title, loosen: { label: "Hapus saringan departemen", next, note: `Di departemen lain ada ${n} orang yang cocok.` } };
    }
  }
  if (f.query.trim()) {
    const next = { ...f, query: "" };
    const n = count(next);
    if (n > 0) {
      return {
        title,
        loosen: { label: "Hapus pencarian", next, note: "Pencarian memeriksa nama, label, nama laptop, dan alamat IP." },
      };
    }
  }
  return { title, loosen: { label: "Hapus semua saringan", next: NO_FILTERS, note: "Melepas satu saringan saja tetap tidak memberi hasil." } };
}

function ErrorBox({ error, title }: { error: AppError; title: string }) {
  return (
    <ErrorAlert title={actionErrorTitle(error, title)}>
      <p>{orgMessage(error.message)}</p>
      {error.code === "last_superadmin" && <p>Jadikan orang lain superadmin dulu, baru lepaskan peran ini.</p>}
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
  if (u.isGuest) return `Tamu, ${u.guestProjectCount} proyek`;
  if (u.departmentId === null) return "Belum ada departemen";
  return u.departmentName ?? deptName(u.departmentId);
}

function Status({ u }: { u: UserView }) {
  if (u.status === "removed") {
    return <span className="users-st">Dikeluarkan{u.removedAt ? ` ${formatDate(u.removedAt)}` : ""}</span>;
  }
  const on = isOnline(u);
  const text = u.isMe
    ? "Laptop ini"
    : u.online
      ? "Online"
      : u.lastSeenAt
        ? `Terakhir terlihat ${relativeTime(u.lastSeenAt)}`
        : "Belum pernah terlihat";
  return (
    <span className="users-st">
      <span className={on ? "users-dot" : "users-dot users-dot-off"} aria-hidden="true" />
      {text}
      {u.isMe && <span className="sr-only">, online</span>}
    </span>
  );
}

// Teks menu aksi per orang. "Aksi untuk" juga nama tombol titik tiga yang
// dipakai uji e2e, jadi jangan diubah tanpa mengubah skripnya.
const MENU_TEXT = {
  label: (name: string) => `Aksi untuk ${name}`,
  move: "Ubah departemen",
  role: "Ubah peran",
  remove: "Keluarkan dari organisasi",
  busy: "Tunggu aksi lain selesai",
};

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
  const currentName = user.departmentId === null ? null : (user.departmentName ?? current?.name ?? "departemen lama");
  const who = user.isMe ? "Anda" : user.displayName;
  const byWho = user.isMe ? "oleh Anda" : "olehnya";
  const channel = (d: DepartmentView | null, fallback: string) =>
    d?.channelName ? <span className="users-ch"># {d.channelName}</span> : `channel ${fallback}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    try {
      await orgApi.moveMember(user.publicKey, chosen.id);
      page.notify(`${user.isMe ? "Anda" : user.displayName} sekarang di departemen ${chosen.name}.`);
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
      title={user.isMe ? "Ubah departemen Anda" : `Ubah departemen ${user.displayName}`}
    >
      <form className="dlg-form" onSubmit={(e) => void submit(e)}>
        <dl className="users-kv">
          <dt>Sekarang</dt>
          <dd>{currentName ?? "Belum ada departemen"}</dd>
        </dl>
        {departments === null ? (
          departmentsError ? (
            <div role="alert">
              <ErrorAlert title="Daftar departemen belum terbaca">
                <p>{orgMessage(departmentsError.message)}</p>
                <button type="button" className="btn btn-ghost org-retry" onClick={onRetryDepartments}>
                  Coba lagi
                </button>
              </ErrorAlert>
            </div>
          ) : (
            <p className="hint" role="status">
              Memuat daftar departemen...
            </p>
          )
        ) : options.length === 0 ? (
          <p className="users-note">
            Belum ada departemen lain yang terbuka. Buat departemen di tab Departemen, lalu pindahkan {who} ke sana.
          </p>
        ) : (
          <>
            <div className="field">
              <label htmlFor={selectId}>Pindah ke</label>
              <select
                id={selectId}
                value={chosen?.id ?? ""}
                aria-describedby={chosen ? hintId : undefined}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="" disabled>
                  Pilih departemen
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
                {currentName ? (
                  <>
                    {who} keluar dari {channel(current, currentName)} dan masuk ke {channel(chosen, chosen.name)}. Riwayat{" "}
                    {channel(current, currentName)} tidak terlihat lagi {byWho}.
                  </>
                ) : (
                  <>
                    {who} masuk ke {channel(chosen, chosen.name)}.
                  </>
                )}{" "}
                Keanggotaan proyek dan grup tidak berubah.
                {user.departmentRole === "admin" && currentName && ` Hak admin departemen ${currentName} juga hilang.`}
              </p>
            )}
          </>
        )}
        <DialogError error={error} title="Belum dipindahkan" />
        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={busy}>
              Batal
            </button>
          </DialogClose>
          {options.length > 0 && (
            <button type="submit" className="btn" disabled={busy || !chosen} aria-busy={busy || undefined}>
              {busy ? "Memindahkan..." : "Pindahkan"}
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
  const who = user.isMe ? "Anda" : user.displayName;

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
      page.notify(`Peran ${user.isMe ? "Anda" : user.displayName} sekarang: ${text}.`);
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
      title={user.isMe ? "Ubah peran Anda" : `Ubah peran ${user.displayName}`}
    >
      <form className="dlg-form" onSubmit={(e) => void submit(e)}>
        {hasDept ? (
          <fieldset className="role-set">
            <legend className="users-legend">Peran di departemen {user.departmentName ?? ""}</legend>
            <label className="role-opt">
              <input type="radio" name={groupName} checked={!admin} onChange={() => setAdmin(false)} />
              <span>
                <span className="role-title">Anggota</span>
                <span className="role-desc">Chat di channel departemen dan bekerja di proyek yang diikuti.</span>
              </span>
            </label>
            <label className="role-opt">
              <input type="radio" name={groupName} checked={admin} onChange={() => setAdmin(true)} />
              <span>
                <span className="role-title">Admin departemen</span>
                <span className="role-desc">
                  Menyetujui permintaan bergabung ke departemen ini, membuat kode undangan dan proyek departemen, dan
                  mengatur anggota proyeknya.
                </span>
              </span>
            </label>
          </fieldset>
        ) : (
          <p className="users-note">
            {who} belum masuk departemen, jadi belum bisa dijadikan admin departemen. Masukkan dulu lewat Ubah
            departemen.
          </p>
        )}

        <div className="users-sa">
          <p className="users-legend">Superadmin organisasi</p>
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
              <span className="role-title">Jadikan superadmin</span>
              <span className="role-desc">
                Mengatur departemen, label, dan pengguna. Bisa memindahkan dan mengeluarkan orang, dan memutuskan
                permintaan bergabung ke departemen mana pun.
              </span>
              {lastSuperadmin && (
                <span id={saNoteId} className="role-note">
                  {user.isMe ? "Anda" : user.displayName} satu-satunya superadmin. Jadikan orang lain superadmin dulu,
                  baru lepaskan peran ini.
                </span>
              )}
            </span>
          </label>
        </div>

        <DialogError error={error} title="Peran belum disimpan" />
        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={busy}>
              Batal
            </button>
          </DialogClose>
          <button type="submit" className="btn" disabled={busy || (!adminChanged && !saChanged)} aria-busy={busy || undefined}>
            {busy ? "Menyimpan..." : "Simpan peran"}
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

  const users = useMemo(() => [...(live.data ?? [])].sort(byName), [live.data]);
  const deptOptions: DeptOption[] = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of depts.data ?? []) if (!d.archived) map.set(d.id, d.name);
    for (const u of users) if (u.departmentId && !map.has(u.departmentId)) map.set(u.departmentId, u.departmentName ?? "Departemen lain");
    return [...map].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "id"));
  }, [depts.data, users]);
  const deptName = (id: string) => deptOptions.find((d) => d.id === id)?.name ?? "Departemen lain";

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
            Pengguna
          </h2>
          <p className="hint">
            Setiap laptop melaporkan nama laptop, sistem, dan versi Mira saat tersambung. Alamat IP dilihat dari
            sambungan terakhir.
          </p>
        </div>
      </div>

      {live.loading && !live.data && (
        <p className="hint" role="status">
          Memuat daftar pengguna...
        </p>
      )}

      {!live.loading && !live.data && (
        <div role="alert">
          <ErrorAlert title="Daftar pengguna belum terbaca">
            <p>{live.error ? orgMessage(live.error.message) : "Inti Mira tidak mengirim daftar pengguna."}</p>
            <button type="button" className="btn btn-ghost org-retry" onClick={() => void live.reload()}>
              Coba lagi
            </button>
          </ErrorAlert>
        </div>
      )}

      {live.data && (
        <>
          {live.error && (
            <p className="hint">
              Data terbaru belum bisa dibaca ({orgMessage(live.error.message)}). Yang tampil adalah data terakhir.
            </p>
          )}

          {onlyMe && (
            <div className="org-empty">
              <p>
                Baru Anda di organisasi ini. Buat kode undangan di tab Undangan, lalu berikan ke rekan supaya laptopnya
                bisa bergabung.
              </p>
            </div>
          )}

          <div className="users-tools">
            <div className="field users-search">
              <label htmlFor={searchId}>Cari</label>
              <span className="users-search-box">
                <IconSearch size={16} aria-hidden="true" />
                <input
                  id={searchId}
                  type="search"
                  value={filters.query}
                  placeholder="Cari nama, laptop, atau IP"
                  autoComplete="off"
                  onChange={(e) => set({ query: e.target.value })}
                />
              </span>
            </div>
            <div className="field users-select">
              <label htmlFor={deptId}>Departemen</label>
              <select id={deptId} value={filters.dept} onChange={(e) => set({ dept: e.target.value })}>
                <option value="all">Semua</option>
                {deptOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
                <option value="none">Belum ada departemen</option>
                <option value="guest">Tamu</option>
              </select>
            </div>
            <div className="field users-select">
              <label htmlFor={statusId}>Status</label>
              <select id={statusId} value={filters.status} onChange={(e) => set({ status: e.target.value as StatusFilter })}>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="users-count" role="status">
              {shown.length} orang
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
                  <th role="columnheader" scope="col">Nama</th>
                  <th role="columnheader" scope="col">Departemen</th>
                  <th role="columnheader" scope="col">Laptop dan IP terakhir</th>
                  <th role="columnheader" scope="col">Sistem dan versi</th>
                  <th role="columnheader" scope="col">Status</th>
                  <th role="columnheader" scope="col">Bergabung</th>
                  <th role="columnheader" scope="col">
                    <span className="sr-only">Aksi</span>
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
          <NameWithLabels className="ut-n" name={u.displayName} labels={u.labels} suffix={u.isMe ? " (Anda)" : undefined} />
          <span className="ut-sub">{roleText(u)}</span>
        </span>
      </td>
      <td role="cell" className="ut-dept">
        <span className="ut-k">Departemen</span>
        <span className={u.isGuest || u.departmentId === null ? "ut-muted" : undefined}>{departmentCell(u, deptName)}</span>
      </td>
      <td role="cell" className="ut-laptop">
        <span className="ut-k">Laptop dan IP terakhir</span>
        {u.device ? <span className="mono ut-mono">{u.device.laptop}</span> : <span className="ut-muted">Belum dilaporkan</span>}
        <span className={u.lastIp ? "mono ut-mono ut-sub" : "ut-sub"}>
          {u.lastIp ?? (u.isMe ? "Tidak dicatat" : "Belum terlihat")}
        </span>
      </td>
      <td role="cell" className="ut-sys">
        <span className="ut-k">Sistem dan versi</span>
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
            <span className="sr-only">Belum dilaporkan</span>
          </span>
        )}
      </td>
      <td role="cell" className="ut-status">
        <span className="ut-k">Status</span>
        <Status u={u} />
      </td>
      <td role="cell" className="ut-joined">
        <span className="ut-k">Bergabung</span>
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
      page.notify(`${name} sudah dikeluarkan dari organisasi.`);
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
      title={`Keluarkan ${name} dari organisasi?`}
      confirmLabel={`Keluarkan ${name}`}
      busyLabel="Mengeluarkan..."
      busy={busy}
      onConfirm={() => void confirm()}
      error={error && <ErrorBox error={error} title={`${name} belum dikeluarkan`} />}
    >
      <p>
        {name} keluar dari departemennya dan kehilangan semua perannya. Laptopnya tidak menerima pesan dan perubahan
        baru lagi, dan laptop rekan menolak sambungan dari laptop itu.
      </p>
      <p>Data yang sudah ada di laptop {name} tetap ada di sana. Mira tidak bisa menghapusnya dari jauh.</p>
      <p>
        Laptop itu tidak bisa bergabung lagi ke organisasi ini, juga dengan kode undangan baru. Langkah ini tidak bisa
        dibatalkan.
      </p>
    </ConfirmDialog>
  );
}
