import { IconChevronRight, IconPlus } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { formatDate } from "../../api/format";
import { orgApi, type DepartmentView, type PersonView } from "../../api/org";
import { validateTeamName } from "../../api/validation";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import type { OrgPage } from "./context";
import { useOrgLive } from "./useOrgLive";
import "./departments.css";

type Data = { departments: DepartmentView[]; people: PersonView[] };

// Sama dengan channel_name_for di src-tauri/src/permissions/format.rs:
// nama departemen (sudah dirapikan) huruf kecil, setiap spasi menjadi "-".
export function channelNameFor(name: string): string {
  return name.trim().toLowerCase().split(" ").join("-");
}

// validateTeamName masih menyebut "tim"; di halaman ini istilahnya departemen.
function validateDepartmentName(raw: string): string | null {
  const msg = validateTeamName(raw);
  return msg ? msg.replace("Nama tim", "Nama departemen").replace("nama tim", "nama departemen") : null;
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
  const [focusArchived, setFocusArchived] = useState<string | null>(null);
  const renameButtons = useRef(new Map<string, HTMLButtonElement>());
  const archivedSummary = useRef<HTMLElement | null>(null);

  const departments = live.data?.departments ?? [];
  const active = departments.filter((d) => !d.archived).sort(byName);
  const archived = manage ? departments.filter((d) => d.archived).sort(byName) : [];
  const busy = page.pending !== null;

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

  if (live.loading && !live.data) {
    return (
      <p className="hint" role="status">
        Memuat daftar departemen...
      </p>
    );
  }

  if (!live.data) {
    return (
      <ErrorAlert title="Daftar departemen belum terbaca">
        <p>{live.error?.message ?? "Inti Mira tidak mengirim daftar departemen."}</p>
        <button type="button" className="btn btn-ghost dept-retry" onClick={() => void live.reload()}>
          Coba lagi
        </button>
      </ErrorAlert>
    );
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
            Departemen
          </h2>
          {active.length > 0 && <p className="hint">{active.length} departemen aktif</p>}
        </div>
        {manage && (
          <div className="org-head-actions">
            <button type="button" className="btn dept-new" disabled={busy} onClick={() => setCreating(true)}>
              <IconPlus size={16} aria-hidden="true" />
              Departemen baru
            </button>
          </div>
        )}
      </div>

      {live.error && (
        <p className="hint">
          Data terbaru belum bisa dibaca ({live.error.message}). Yang tampil adalah data terakhir.
        </p>
      )}

      {active.length === 0 ? (
        <div className="org-empty">
          <p>
            {manage
              ? "Belum ada departemen. Buat departemen pertama, lalu pindahkan orang ke sana lewat tab Pengguna."
              : "Belum ada departemen. Superadmin yang membuat departemen."}
          </p>
        </div>
      ) : (
        <>
          {manage && someNotEmpty && (
            <p className="hint">
              Hanya departemen yang kosong yang bisa diarsipkan. Untuk mengosongkan departemen, pindahkan orangnya dulu
              lewat tab Pengguna.
            </p>
          )}
          <table className="dept-table">
            <caption className="sr-only">Departemen aktif</caption>
            <thead>
              <tr>
                <th scope="col">Departemen</th>
                <th scope="col">Orang</th>
                <th scope="col">Admin departemen</th>
                <th scope="col">Channel</th>
                {manage && (
                  <th scope="col">
                    <span className="sr-only">Aksi</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {active.map((d) =>
                editing === d.id ? (
                  <tr key={d.id} className="dept-editing">
                    <td colSpan={cols}>
                      <RenameForm dept={d} page={page} onDone={() => closeEdit(d.id)} />
                    </td>
                  </tr>
                ) : (
                  <tr key={d.id}>
                    <td className="dept-name-cell">
                      <span className="dept-name">
                        <span className="row-name">{d.name}</span>
                        {page.overview.departmentId === d.id && <span className="chip chip-on">Departemen Anda</span>}
                      </span>
                    </td>
                    <td data-label="Orang" className="dept-num">
                      {d.memberCount}
                    </td>
                    <td data-label="Admin departemen">
                      {d.admins.length > 0 ? (
                        d.admins.map((a) => a.displayName).join(", ")
                      ) : (
                        <span className="dept-muted">Belum ada</span>
                      )}
                    </td>
                    <td data-label="Channel" className="dept-muted dept-channel">
                      {d.channelName ? `# ${d.channelName}` : "Belum ada"}
                    </td>
                    {manage && (
                      <td className="dept-actions-cell">
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            aria-label={`Ganti nama ${d.name}`}
                            ref={(el) => {
                              if (el) renameButtons.current.set(d.id, el);
                              else renameButtons.current.delete(d.id);
                            }}
                            onClick={() => setEditing(d.id)}
                          >
                            Ganti nama
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            aria-label={`Atur admin ${d.name}`}
                            onClick={() => setAdminId(d.id)}
                          >
                            Atur admin
                          </button>
                          {d.memberCount === 0 && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={busy}
                              aria-label={`Arsipkan ${d.name}`}
                              onClick={() => setArchiveId(d.id)}
                            >
                              Arsipkan
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </>
      )}

      {archived.length > 0 && (
        <details className="dept-archived">
          <summary ref={archivedSummary}>
            <IconChevronRight size={16} className="dept-chev" aria-hidden="true" />
            Diarsipkan ({archived.length})
          </summary>
          <ul className="row-list">
            {archived.map((d) => {
              const key = `restore:${d.id}`;
              return (
                <li key={d.id} className="row">
                  <div className="row-main">
                    <span className="row-name">{d.name}</span>
                    <span className="row-sub">
                      {d.archivedAt ? `Diarsipkan ${formatDate(d.archivedAt)}` : "Diarsipkan"}
                      {d.channelName ? `. Channel # ${d.channelName}, hanya-baca.` : "."}
                    </span>
                  </div>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      aria-busy={page.pending === key || undefined}
                      aria-label={`Pulihkan ${d.name}`}
                      onClick={async () => {
                        const ok = await page.act(
                          key,
                          () => orgApi.setDepartmentArchived(d.id, false),
                          `Departemen ${d.name} dipulihkan.`,
                          "Departemen belum dipulihkan",
                        );
                        // Tombol Pulihkan hilang bersama barisnya: fokus pindah ke baris yang dipulihkan.
                        if (ok) setReturnTo(d.id);
                      }}
                    >
                      {page.pending === key ? "Memulihkan..." : "Pulihkan"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </details>
      )}

      {manage && <CreateDialog open={creating} onOpenChange={setCreating} page={page} />}

      {archiveDept && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setArchiveId(null);
          }}
          title={`Arsipkan ${archiveDept.name}?`}
          confirmLabel={`Arsipkan ${archiveDept.name}`}
          busyLabel="Mengarsipkan..."
          busy={page.pending === `archive:${archiveDept.id}`}
          danger={false}
          onConfirm={async () => {
            const dept = archiveDept;
            const ok = await page.act(
              `archive:${dept.id}`,
              () => orgApi.setDepartmentArchived(dept.id, true),
              `Departemen ${dept.name} diarsipkan.`,
              "Departemen belum diarsipkan",
            );
            if (ok) setFocusArchived(dept.id);
            setArchiveId(null);
          }}
        >
          <div className="dept-confirm">
            <p>
              {archiveDept.channelName ? `Channel # ${archiveDept.channelName}` : "Channel departemen ini"} menjadi
              hanya-baca: isinya tetap bisa dibaca, tetapi tidak bisa diisi pesan baru.
            </p>
            <p>
              Departemen ini tidak bisa dipilih lagi saat orang bergabung atau diundang. Anda bisa memulihkannya kapan
              saja dari bagian Diarsipkan.
            </p>
          </div>
        </ConfirmDialog>
      )}

      {adminDept && (
        <AdminDialog
          dept={adminDept}
          people={live.data.people}
          page={page}
          onClose={() => setAdminId(null)}
        />
      )}
    </section>
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
      ? `Channel # ${dept.channelName} ikut menjadi # ${next}.`
      : "Channel departemen ikut berganti nama. Isi chat tidak berubah.";

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
      page.notify(`Departemen ${dept.name} sekarang bernama ${trimmed}. Channelnya menjadi # ${channelNameFor(trimmed)}.`);
      page.refresh();
      onDone();
    } catch (err) {
      const appErr = toAppError(err);
      if (appErr.code === "invalid_name") {
        setFieldError(appErr.message);
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
        Nama baru untuk departemen {dept.name}
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
          {saving ? "Menyimpan..." : "Simpan nama"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={onDone}>
          Batal
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
          <ErrorAlert title="Nama departemen belum diganti">
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
      page.notify(`Departemen ${deptName} dibuat, dengan channel # ${channel}.`);
      page.refresh();
      onOpenChange(false);
    } catch (err) {
      const appErr = toAppError(err);
      if (appErr.code === "invalid_name") {
        setFieldError(appErr.message);
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
      title="Departemen baru"
      description="Departemen baru langsung mendapat channel chat sendiri. Setelah dibuat, pindahkan orang ke sana lewat tab Pengguna."
    >
      <form className="dlg-form" onSubmit={(e) => void submit(e)} noValidate>
        <div className="field">
          <label htmlFor={`${id}-name`}>Nama departemen</label>
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
            {preview ? `Nama channel: # ${preview}` : "2 sampai 60 karakter. Nama channel dibuat dari nama ini."}
          </p>
        </div>
        <div aria-live="polite">
          {error && (
            <ErrorAlert title="Departemen belum dibuat">
              <p>{error.message}</p>
            </ErrorAlert>
          )}
        </div>
        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={saving}>
              Batal
            </button>
          </DialogClose>
          <button type="submit" className="btn" disabled={saving} aria-busy={saving || undefined}>
            {saving ? "Membuat..." : "Buat departemen"}
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
        admin
          ? `${p.displayName} sekarang admin departemen ${dept.name}.`
          : `${p.displayName} bukan admin departemen ${dept.name} lagi.`,
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
      title={`Admin departemen ${dept.name}`}
      description="Admin departemen menyetujui permintaan bergabung ke departemennya dan membuat kode undangan. Satu departemen boleh punya lebih dari satu admin."
    >
      {members.length === 0 ? (
        <p className="org-empty">
          {dept.name} belum punya Anggota. Pindahkan orang ke departemen ini dulu lewat tab Pengguna, lalu angkat admin di
          sini.
        </p>
      ) : (
        <ul className="row-list dept-admin-list">
          {members.map((p) => {
            const isAdmin = p.departmentRole === "admin";
            return (
              <li key={p.publicKey} className="row">
                <div className="row-main">
                  <span className="row-name">
                    {p.displayName}
                    {page.isMe(p.publicKey) && <span className="row-you"> (Anda)</span>}
                  </span>
                  <span className="row-sub">{isAdmin ? "Admin departemen" : "Anggota"}</span>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={working !== null || page.pending !== null}
                  aria-busy={working === p.publicKey || undefined}
                  aria-label={isAdmin ? `Lepas admin, ${p.displayName}` : `Jadikan admin, ${p.displayName}`}
                  onClick={() => void toggle(p, !isAdmin)}
                >
                  {working === p.publicKey ? "Menyimpan..." : isAdmin ? "Lepas admin" : "Jadikan admin"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div aria-live="polite">
        {error && (
          <ErrorAlert title="Admin departemen belum diubah">
            <p>{error.message}</p>
          </ErrorAlert>
        )}
      </div>
      <div className="dlg-actions">
        <DialogClose asChild>
          <button type="button" className="btn btn-ghost" disabled={working !== null}>
            Tutup
          </button>
        </DialogClose>
      </div>
    </Dialog>
  );
}
