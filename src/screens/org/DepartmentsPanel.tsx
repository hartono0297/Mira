import { IconChevronRight, IconPlus } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { formatDate } from "../../api/format";
import { orgApi, type DepartmentView, type PersonView } from "../../api/org";
import { validateTeamName } from "../../api/validation";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { menuItems, SEPARATOR, useContextMenu } from "../../components/ContextMenu";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { getLang } from "../../i18n/core";
import { DEPT_TEXT as T } from "../../i18n/org-departments";
import { AdSettings } from "./AdSettings";
import type { OrgPage } from "./context";
import { useOrgLive } from "./useOrgLive";
import "./departments.css";

type Data = { departments: DepartmentView[]; people: PersonView[] };

// Teks menu klik kanan baris departemen. Label item sama dengan tombol di baris.
const MENU = T.menu;

// Sama dengan channel_name_for di src-tauri/src/permissions/format.rs:
// nama departemen (sudah dirapikan) huruf kecil, setiap spasi menjadi "-".
export function channelNameFor(name: string): string {
  return name.trim().toLowerCase().split(" ").join("-");
}

// Pesan lama yang masih menyebut "tim" (misalnya dari laptop rekan yang belum diperbarui);
// di halaman ini istilahnya departemen.
// Bahasa Inggris tidak memakai kata "tim", jadi pesan dibiarkan.
function deptWording(message: string): string {
  if (getLang() === "en") return message;
  return message.replace(/\bTim\b/g, "Departemen").replace(/\btim\b/g, "departemen");
}

function validateDepartmentName(raw: string): string | null {
  const msg = validateTeamName(raw);
  return msg ? deptWording(msg) : null;
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, "id");
}

export function DepartmentsPanel({ page }: { page: OrgPage }) {
  const manage = page.overview.manageOrg;
  const live = useOrgLive<Data>(
    async () => {
      const [departments, people] = await Promise.all([
        orgApi.departments(true),
        manage ? orgApi.people() : Promise.resolve([] as PersonView[]),
      ]);
      return { departments, people };
    },
    { version: page.version },
  );

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [adminId, setAdminId] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<AppError | null>(null);
  const [focusArchived, setFocusArchived] = useState<string | null>(null);
  const renameButtons = useRef(new Map<string, HTMLButtonElement>());
  const archivedSummary = useRef<HTMLElement | null>(null);

  const departments = live.data?.departments ?? [];
  const active = departments.filter((d) => !d.archived).sort(byName);
  const archived = manage ? departments.filter((d) => d.archived).sort(byName) : [];
  const busy = page.pending !== null || archiving;

  // Fokus ke tombol Ganti nama sebuah departemen: setelah baris edit ditutup, atau
  // setelah departemen dipulihkan (tombolnya baru ada setelah data dimuat ulang).
  useEffect(() => {
    if (!returnTo || editing !== null) return;
    const button = renameButtons.current.get(returnTo);
    if (button) {
      button.focus();
      setReturnTo(null);
    }
  }, [returnTo, editing, live.data]);

  // Setelah diarsipkan, tombol Arsipkan hilang bersama barisnya: fokus pindah ke bagian Diarsipkan.
  useEffect(() => {
    if (!focusArchived) return;
    if (live.data?.departments.some((d) => d.id === focusArchived && d.archived)) {
      archivedSummary.current?.focus();
      setFocusArchived(null);
    }
  }, [focusArchived, live.data]);

  function closeEdit(id: string) {
    setEditing(null);
    setReturnTo(id);
  }

  function openArchive(id: string) {
    setArchiveError(null);
    setArchiveId(id);
  }

  async function restore(d: DepartmentView) {
    const ok = await page.act(
      `restore:${d.id}`,
      () => orgApi.setDepartmentArchived(d.id, false),
      T.restored(d.name),
      T.restoreFail,
    );
    // Tombol Pulihkan hilang bersama barisnya: fokus pindah ke baris yang dipulihkan.
    if (ok) setReturnTo(d.id);
  }

  // Dipanggil langsung (bukan lewat page.act) supaya error tampil di dalam dialog,
  // dan dialog hanya tertutup kalau berhasil.
  async function archive(dept: DepartmentView) {
    setArchiving(true);
    setArchiveError(null);
    try {
      await orgApi.setDepartmentArchived(dept.id, true);
      page.notify(T.archived(dept.name));
      page.refresh();
      setFocusArchived(dept.id);
      setArchiveId(null);
    } catch (err) {
      const appErr = toAppError(err);
      setArchiveError(appErr);
      if (appErr.code === "not_found" || appErr.code === "forbidden") page.refresh();
    } finally {
      setArchiving(false);
    }
  }

  const archiveDept = departments.find((d) => d.id === archiveId) ?? null;
  const adminDept = departments.find((d) => d.id === adminId) ?? null;
  const cols = manage ? 5 : 4;
  const someNotEmpty = active.some((d) => d.memberCount > 0);

  return (
    <section className="set-section dept" aria-labelledby="dept-title">
      <div className="org-head">
        <div>
          <h2 id="dept-title" className="set-title">
            {T.title}
          </h2>
          {active.length > 0 && <p className="hint">{T.activeCount(active.length)}</p>}
        </div>
        {manage && live.data && (
          <div className="org-head-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => setCreating(true)}>
              <IconPlus size={16} aria-hidden="true" />
              {T.newDept}
            </button>
          </div>
        )}
      </div>

      {live.loading && !live.data && (
        <p className="hint" role="status">
          {T.loading}
        </p>
      )}

      {!live.loading && !live.data && (
        <div role="alert">
          <ErrorAlert title={T.loadErrorTitle}>
            <p>{live.error?.message ?? T.loadErrorEmpty}</p>
            <button type="button" className="btn btn-ghost org-retry" onClick={() => void live.reload()}>
              {T.retry}
            </button>
          </ErrorAlert>
        </div>
      )}

      {live.data && live.error && <p className="hint">{T.stale(live.error.message)}</p>}

      {live.data &&
        (active.length === 0 ? (
          <div className="org-empty">
            <p>{manage ? T.emptyManage : T.emptyView}</p>
          </div>
        ) : (
          <>
            {manage && someNotEmpty && <p className="hint">{T.archiveRule}</p>}
            {/* Role eksplisit: tata letak bertumpuk (display: grid) menghapus semantik tabel di WebKit. */}
            <table className="dept-table" role="table">
              <caption className="sr-only">{T.caption}</caption>
              <thead role="rowgroup">
                <tr role="row">
                  <th role="columnheader" scope="col">
                    {T.colDept}
                  </th>
                  <th role="columnheader" scope="col">
                    {T.colPeople}
                  </th>
                  <th role="columnheader" scope="col">
                    {T.colAdmins}
                  </th>
                  <th role="columnheader" scope="col">
                    {T.colChannel}
                  </th>
                  {manage && (
                    <th role="columnheader" scope="col">
                      <span className="sr-only">{T.colActions}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody role="rowgroup">
                {active.map((d) =>
                  editing === d.id ? (
                    <tr key={d.id} role="row" className="dept-editing">
                      <td role="cell" colSpan={cols} className="dept-edit-cell">
                        <RenameForm dept={d} page={page} onDone={() => closeEdit(d.id)} />
                      </td>
                    </tr>
                  ) : manage ? (
                    <ManagedDeptRow
                      key={d.id}
                      dept={d}
                      page={page}
                      busy={busy}
                      renameRef={(el) => {
                        if (el) renameButtons.current.set(d.id, el);
                        else renameButtons.current.delete(d.id);
                      }}
                      onRename={() => setEditing(d.id)}
                      onAdmins={() => setAdminId(d.id)}
                      onArchive={() => openArchive(d.id)}
                    />
                  ) : (
                    <tr key={d.id} role="row" className="dept-row">
                      <DeptCells dept={d} page={page} />
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </>
        ))}

      {archived.length > 0 && (
        <details className="org-fold">
          <summary ref={archivedSummary}>
            <IconChevronRight size={16} className="org-fold-chev" aria-hidden="true" />
            {T.archivedFold(archived.length)}
          </summary>
          <ul className="row-list">
            {archived.map((d) => (
              <ArchivedDeptRow key={d.id} dept={d} page={page} busy={busy} onRestore={() => void restore(d)} />
            ))}
          </ul>
        </details>
      )}

      {/* Hanya superadmin (tab ini sudah khusus superadmin). Butuh daftar departemen untuk pemetaan OU. */}
      {manage && live.data && <AdSettings page={page} departments={departments} />}

      {manage && <CreateDialog open={creating} onOpenChange={setCreating} page={page} />}

      {archiveDept && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setArchiveId(null);
          }}
          title={T.archiveTitle(archiveDept.name)}
          confirmLabel={T.archiveConfirm(archiveDept.name)}
          busyLabel={T.archiving}
          busy={archiving}
          danger={false}
          onConfirm={() => void archive(archiveDept)}
          error={
            archiveError && (
              <ErrorAlert title={T.archiveFail}>
                <p>{archiveError.message}</p>
              </ErrorAlert>
            )
          }
        >
          <p>
            {archiveDept.channelName ? T.archiveChannel(archiveDept.channelName) : T.archiveChannelFallback}{" "}
            {T.archiveReadOnly}
          </p>
          <p>{T.archiveBody}</p>
        </ConfirmDialog>
      )}

      {adminDept && (
        <AdminDialog
          dept={adminDept}
          people={live.data?.people ?? []}
          page={page}
          onClose={() => setAdminId(null)}
        />
      )}
    </section>
  );
}

function DeptCells({ dept, page }: { dept: DepartmentView; page: OrgPage }) {
  return (
    <>
      <td role="cell" className="dept-name-cell">
        <span className="dept-name">
          <span className="row-name">{dept.name}</span>
          {page.overview.departmentId === dept.id && <span className="chip chip-on">{T.yourDept}</span>}
        </span>
      </td>
      <td role="cell" className="dept-count">
        <span className="dept-k" aria-hidden="true">
          {T.colPeople}
        </span>
        <span className="dept-num">{dept.memberCount}</span>
      </td>
      <td role="cell" className="dept-admins">
        <span className="dept-k" aria-hidden="true">
          {T.colAdmins}
        </span>
        {dept.admins.length > 0 ? (
          <span>{dept.admins.map((a) => a.displayName).join(", ")}</span>
        ) : (
          <span className="dept-muted">{T.none}</span>
        )}
      </td>
      <td role="cell" className="dept-channel">
        <span className="dept-k" aria-hidden="true">
          {T.colChannel}
        </span>
        <span className="dept-muted">{dept.channelName ? T.channelName(dept.channelName) : T.none}</span>
      </td>
    </>
  );
}

// Baris departemen aktif untuk superadmin. Menu klik kanan berisi aksi yang
// sama dengan tombol di baris, jadi tidak perlu tombol "...". Arsipkan tetap
// tampil di menu walaupun tombolnya tersembunyi, nonaktif dengan alasannya.
function ManagedDeptRow({
  dept,
  page,
  busy,
  renameRef,
  onRename,
  onAdmins,
  onArchive,
}: {
  dept: DepartmentView;
  page: OrgPage;
  busy: boolean;
  renameRef: (el: HTMLButtonElement | null) => void;
  onRename: () => void;
  onAdmins: () => void;
  onArchive: () => void;
}) {
  const wait = busy ? MENU.busy : undefined;
  const menu = useContextMenu({
    label: MENU.label(dept.name),
    items: menuItems(
      { id: "rename", label: MENU.rename, disabled: wait, onSelect: onRename },
      { id: "admins", label: MENU.admins, disabled: wait, onSelect: onAdmins },
      SEPARATOR,
      {
        id: "archive",
        label: MENU.archive,
        disabled: dept.memberCount > 0 ? MENU.notEmpty(dept.memberCount) : wait,
        onSelect: onArchive,
      },
    ),
  });

  return (
    <tr role="row" className="dept-row dept-row-act" {...menu.triggerProps}>
      <DeptCells dept={dept} page={page} />
      <td role="cell" className="dept-actions-cell">
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            aria-label={T.renameAria(dept.name)}
            ref={renameRef}
            onClick={onRename}
          >
            {MENU.rename}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            aria-label={T.adminsAria(dept.name)}
            onClick={onAdmins}
          >
            {MENU.admins}
          </button>
          {dept.memberCount === 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              aria-label={T.archiveAria(dept.name)}
              onClick={onArchive}
            >
              {MENU.archive}
            </button>
          )}
        </div>
        {menu.element}
      </td>
    </tr>
  );
}

function ArchivedDeptRow({
  dept,
  page,
  busy,
  onRestore,
}: {
  dept: DepartmentView;
  page: OrgPage;
  busy: boolean;
  onRestore: () => void;
}) {
  const working = page.pending === `restore:${dept.id}`;
  const menu = useContextMenu({
    label: MENU.label(dept.name),
    items: menuItems({ id: "restore", label: MENU.restore, disabled: busy ? MENU.busy : undefined, onSelect: onRestore }),
  });

  return (
    <li className="row" {...menu.triggerProps}>
      <div className="row-main">
        <span className="row-name">{dept.name}</span>
        <span className="row-sub">
          {dept.archivedAt ? T.archivedOn(formatDate(dept.archivedAt)) : T.archivedPlain}
          {dept.channelName ? T.archivedChannel(dept.channelName) : "."}
        </span>
      </div>
      <div className="row-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy}
          aria-busy={working || undefined}
          aria-label={T.restoreAria(dept.name)}
          onClick={onRestore}
        >
          {working ? T.restoring : MENU.restore}
        </button>
      </div>
      {menu.element}
    </li>
  );
}

function RenameForm({ dept, page, onDone }: { dept: DepartmentView; page: OrgPage; onDone: () => void }) {
  const [name, setName] = useState(dept.name);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    input.current?.focus();
    // Kursor di akhir nama: mengetik menambah, bukan langsung mengganti seluruh nama.
    const end = input.current?.value.length ?? 0;
    input.current?.setSelectionRange(end, end);
  }, []);

  const next = channelNameFor(name);
  const hint =
    dept.channelName && validateDepartmentName(name) === null && next !== dept.channelName
      ? T.renameHintChange(dept.channelName, next)
      : T.renameHint;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const invalid = validateDepartmentName(name);
    if (invalid) {
      setFieldError(invalid);
      input.current?.focus();
      return;
    }
    const trimmed = name.trim();
    if (trimmed === dept.name) {
      onDone();
      return;
    }
    setSaving(true);
    setError(null);
    setFieldError(null);
    try {
      await orgApi.renameDepartment(dept.id, trimmed);
      page.notify(T.renamed(dept.name, trimmed, channelNameFor(trimmed)));
      page.refresh();
      onDone();
    } catch (err) {
      const appErr = toAppError(err);
      if (appErr.code === "invalid_name") {
        setFieldError(deptWording(appErr.message));
        input.current?.focus();
      } else {
        setError(appErr);
        if (appErr.code === "not_found" || appErr.code === "forbidden") page.refresh();
      }
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && !saving) {
      e.preventDefault();
      e.stopPropagation();
      onDone();
    }
  }

  return (
    <form className="dept-edit" onSubmit={(e) => void submit(e)} onKeyDown={onKeyDown} noValidate>
      <label htmlFor={`${id}-name`} className="sr-only">
        {T.renameLabel(dept.name)}
      </label>
      <div className="dept-edit-row">
        <input
          ref={input}
          id={`${id}-name`}
          className="dept-edit-input"
          value={name}
          autoComplete="off"
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={`${fieldError ? `${id}-err ` : ""}${id}-hint`}
          onChange={(e) => {
            setName(e.target.value);
            if (fieldError) setFieldError(null);
          }}
        />
        <button type="submit" className="btn btn-sm" disabled={saving} aria-busy={saving || undefined}>
          {saving ? T.saving : T.saveName}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={onDone}>
          {T.cancel}
        </button>
      </div>
      {fieldError && (
        <div id={`${id}-err`}>
          <FieldError text={fieldError} />
        </div>
      )}
      <p id={`${id}-hint`} className="hint">
        {hint}
      </p>
      <div aria-live="polite">
        {error && (
          <ErrorAlert title={T.renameFail}>
            <p>{error.message}</p>
          </ErrorAlert>
        )}
      </div>
    </form>
  );
}

function CreateDialog({ open, onOpenChange, page }: { open: boolean; onOpenChange: (open: boolean) => void; page: OrgPage }) {
  const [name, setName] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    if (open) {
      setName("");
      setFieldError(null);
      setError(null);
    }
  }, [open]);

  const preview = channelNameFor(name);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const invalid = validateDepartmentName(name);
    if (invalid) {
      setFieldError(invalid);
      input.current?.focus();
      return;
    }
    const trimmed = name.trim();
    setSaving(true);
    setError(null);
    setFieldError(null);
    try {
      const dept = await orgApi.createDepartment(trimmed);
      const deptName = dept?.name ?? trimmed;
      const channel = dept?.channelName ?? channelNameFor(trimmed);
      page.notify(T.created(deptName, channel));
      page.refresh();
      onOpenChange(false);
    } catch (err) {
      const appErr = toAppError(err);
      if (appErr.code === "invalid_name") {
        setFieldError(deptWording(appErr.message));
        input.current?.focus();
      } else {
        setError(appErr);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
      title={T.newDept}
      description={T.createDesc}
    >
      <form className="dlg-form" onSubmit={(e) => void submit(e)} noValidate>
        <div className="field">
          <label htmlFor={`${id}-name`}>{T.nameLabel}</label>
          <input
            ref={input}
            id={`${id}-name`}
            value={name}
            autoComplete="off"
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={`${fieldError ? `${id}-err ` : ""}${id}-hint`}
            onChange={(e) => {
              setName(e.target.value);
              if (fieldError) setFieldError(null);
            }}
          />
          {fieldError && (
            <div id={`${id}-err`}>
              <FieldError text={fieldError} />
            </div>
          )}
          <p id={`${id}-hint`} className="hint">
            {preview ? T.channelPreview(preview) : T.nameHint}
          </p>
        </div>
        <div aria-live="polite">
          {error && (
            <ErrorAlert title={T.createFail}>
              <p>{error.message}</p>
            </ErrorAlert>
          )}
        </div>
        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={saving}>
              {T.cancel}
            </button>
          </DialogClose>
          <button type="submit" className="btn" disabled={saving} aria-busy={saving || undefined}>
            {saving ? T.creating : T.create}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function AdminDialog({
  dept,
  people,
  page,
  onClose,
}: {
  dept: DepartmentView;
  people: PersonView[];
  page: OrgPage;
  onClose: () => void;
}) {
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const members = people.filter((p) => p.departmentId === dept.id && !p.isGuest).sort((a, b) => a.displayName.localeCompare(b.displayName, "id"));

  async function toggle(p: PersonView, admin: boolean) {
    setWorking(p.publicKey);
    setError(null);
    try {
      await orgApi.setDepartmentAdmin(dept.id, p.publicKey, admin);
      page.notify(
        admin ? T.madeAdmin(p.displayName, dept.name) : T.unmadeAdmin(p.displayName, dept.name),
      );
      page.refresh();
    } catch (err) {
      const appErr = toAppError(err);
      setError(appErr);
      if (appErr.code === "not_found" || appErr.code === "forbidden") page.refresh();
    } finally {
      setWorking(null);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && working === null) onClose();
      }}
      title={T.adminTitle(dept.name)}
      description={T.adminDesc}
    >
      {members.length === 0 ? (
        <p className="org-empty">{T.adminEmpty(dept.name)}</p>
      ) : (
        <ul className="row-list dept-admin-list">
          {members.map((p) => {
            const isAdmin = p.departmentRole === "admin";
            return (
              <li key={p.publicKey} className="row">
                <div className="row-main">
                  <span className="row-name">
                    {p.displayName}
                    {page.isMe(p.publicKey) && <span className="row-you">{T.you}</span>}
                  </span>
                  <span className="row-sub">{isAdmin ? T.roleAdmin : T.roleMember}</span>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={working !== null || page.pending !== null}
                  aria-busy={working === p.publicKey || undefined}
                  aria-label={isAdmin ? T.removeAdminAria(p.displayName) : T.makeAdminAria(p.displayName)}
                  onClick={() => void toggle(p, !isAdmin)}
                >
                  {working === p.publicKey ? T.saving : isAdmin ? T.removeAdmin : T.makeAdmin}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div aria-live="polite">
        {error && (
          <ErrorAlert title={T.adminFail}>
            <p>{error.message}</p>
          </ErrorAlert>
        )}
      </div>
      <div className="dlg-actions">
        <DialogClose asChild>
          <button type="button" className="btn btn-ghost" disabled={working !== null}>
            {T.close}
          </button>
        </DialogClose>
      </div>
    </Dialog>
  );
}
