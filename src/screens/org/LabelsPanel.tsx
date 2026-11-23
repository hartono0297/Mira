import { IconPlus } from "@tabler/icons-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { toAppError, type AppError } from "../../api";
import { orgApi, type LabelView, type PersonView } from "../../api/org";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { MAX_LABELS_SHOWN, NameWithLabels } from "../../components/NameWithLabels";
import type { OrgPage } from "./context";
import { useOrgLive } from "./useOrgLive";
import "./labels.css";

// Sama dengan batas nama label di inti Rust (kontrak v0.3, op label_create).
const MAX_NAME = 30;

type Data = { labels: LabelView[]; people: PersonView[] };

type DialogState =
  | { kind: "create" }
  | { kind: "rename"; label: LabelView }
  | { kind: "delete"; label: LabelView }
  | { kind: "assign"; label: LabelView }
  | null;

const collator = new Intl.Collator("id", { sensitivity: "base" });

function byName<T extends { name: string }>(a: T, b: T): number {
  return collator.compare(a.name, b.name);
}

function chars(value: string): number {
  return [...value].length;
}

async function loadData(): Promise<Data> {
  const [labels, people] = await Promise.all([orgApi.labels(), orgApi.people()]);
  if (!Array.isArray(labels) || !Array.isArray(people)) {
    throw { code: "bad_data", message: "Inti Mira mengirim data label yang tidak terbaca." };
  }
  return { labels, people };
}

// Validasi nama label di tampilan. Inti Rust mengecek ulang panjangnya.
function nameProblem(raw: string, labels: LabelView[], current?: LabelView): string | null {
  const name = raw.trim();
  if (chars(name) === 0) return "Isi nama label dulu.";
  if (chars(name) > MAX_NAME) return `Nama label paling banyak ${MAX_NAME} karakter (sekarang ${chars(name)}).`;
  if (current && name === current.name) return "Nama ini sama dengan nama sekarang.";
  const twin = labels.find((l) => l.id !== current?.id && collator.compare(l.name, name) === 0);
  if (twin && !twin.archived) return `Label ${twin.name} sudah ada.`;
  if (twin) return `Label ${twin.name} ada di bagian Dihapus. Pulihkan label itu supaya orang yang dulu memakainya ikut kembali.`;
  return null;
}

function deptText(p: PersonView): string {
  if (p.isGuest) return "Tamu";
  return p.departmentName ?? "Belum ada departemen";
}

function deptKey(p: PersonView): string {
  if (p.isGuest) return "guest";
  return p.departmentName ? `dept:${p.departmentName}` : "none";
}

export function LabelsPanel({ page }: { page: OrgPage }) {
  const live = useOrgLive(loadData, { version: page.version });
  const [dialog, setDialog] = useState<DialogState>(null);
  const data = live.data;

  const { active, removed, people, countOf } = useMemo(() => {
    const labels = data?.labels ?? [];
    const people = data?.people ?? [];
    // Orang yang sudah dikeluarkan tidak ada di people dan tidak dihitung.
    const present = new Set(people.map((p) => p.publicKey));
    return {
      active: labels.filter((l) => !l.archived).sort(byName),
      removed: labels.filter((l) => l.archived).sort(byName),
      people,
      countOf: (l: LabelView) => l.memberKeys.filter((k) => present.has(k)).length,
    };
  }, [data]);

  const busy = page.pending !== null;
  const close = () => setDialog(null);

  const restore = (l: LabelView) =>
    void page.act(
      `label-restore:${l.id}`,
      () => orgApi.setLabelArchived(l.id, false),
      `Label ${l.name} dipulihkan dan kembali tampil di samping nama orang yang dulu memakainya.`,
      `Label ${l.name} belum dipulihkan`,
    );

  return (
    <section className="set-section lbl" aria-labelledby="labels-title">
      <h2 id="labels-title" className="sr-only">
        Label
      </h2>
      <div className="lbl-tools">
        <p className="hint lbl-hint">
          Label tampil di samping nama di chat, daftar pengguna, dan pemilih orang. Paling banyak {MAX_LABELS_SHOWN} label
          tampil di samping satu nama. Hanya superadmin yang mengatur label.
        </p>
        <button type="button" className="btn" disabled={busy} onClick={() => setDialog({ kind: "create" })}>
          <IconPlus size={18} aria-hidden="true" />
          Label baru
        </button>
      </div>

      {live.loading && !data && (
        <p className="hint" role="status">
          Memuat daftar label...
        </p>
      )}

      {!live.loading && !data && (
        <div role="alert">
          <ErrorAlert title="Daftar label belum terbaca">
            <p>{live.error?.message ?? "Inti Mira tidak mengirim daftar label."}</p>
            <button type="button" className="btn btn-ghost btn-sm lbl-retry" onClick={() => void live.reload()}>
              Coba lagi
            </button>
          </ErrorAlert>
        </div>
      )}

      {data && live.error && (
        <p className="hint">Daftar label terbaru belum bisa dibaca ({live.error.message}). Yang tampil adalah data terakhir.</p>
      )}

      {data && active.length === 0 && (
        <div className="org-empty">
          {removed.length === 0 ? (
            <p>
              Belum ada label. Buat label untuk keahlian atau posisi, misalnya Drafter atau K3, lewat tombol Label baru,
              lalu pasang ke orang.
            </p>
          ) : (
            <p>Semua label sudah dihapus. Pulihkan dari bagian Dihapus di bawah, atau buat lewat tombol Label baru.</p>
          )}
        </div>
      )}

      {data && active.length > 0 && (
        <ul className="row-list" aria-label="Label aktif">
          {active.map((l) => {
            const n = countOf(l);
            return (
              <li key={l.id} className="lbl-row">
                <div className="lbl-main">
                  <span className="lab lbl-lab">{l.name}</span>
                  <span className="lbl-count">{n === 0 ? "Belum dipasang ke siapa pun" : `${n} orang`}</span>
                </div>
                <div className="lbl-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => setDialog({ kind: "assign", label: l })}
                  >
                    Atur orang<span className="sr-only">, label {l.name}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => setDialog({ kind: "rename", label: l })}
                  >
                    Ganti nama<span className="sr-only">, label {l.name}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm lbl-del"
                    disabled={busy}
                    onClick={() => setDialog({ kind: "delete", label: l })}
                  >
                    Hapus <span className="sr-only">label {l.name}</span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {data && removed.length > 0 && (
        <details className="lbl-gone">
          <summary>Dihapus ({removed.length})</summary>
          <p className="hint lbl-gone-hint">
            Label yang dihapus tidak tampil di samping nama siapa pun. Pulihkan supaya label kembali ke orang yang dulu
            memakainya.
          </p>
          <ul className="row-list" aria-label="Label yang dihapus">
            {removed.map((l) => {
              const n = countOf(l);
              const key = `label-restore:${l.id}`;
              return (
                <li key={l.id} className="lbl-row">
                  <div className="lbl-main">
                    <span className="lab lbl-lab lbl-lab-gone">{l.name}</span>
                    <span className="lbl-count">{n === 0 ? "Tidak ada orang tersimpan" : `${n} orang tersimpan`}</span>
                  </div>
                  <div className="lbl-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      aria-busy={page.pending === key || undefined}
                      onClick={() => restore(l)}
                    >
                      {page.pending === key ? "Memulihkan... " : "Pulihkan "}
                      <span className="sr-only">label {l.name}</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </details>
      )}

      {dialog?.kind === "create" && (
        <CreateLabelDialog page={page} labels={data?.labels ?? []} people={people} onClose={close} />
      )}
      {dialog?.kind === "rename" && (
        <RenameLabelDialog page={page} label={dialog.label} labels={data?.labels ?? []} onClose={close} />
      )}
      {dialog?.kind === "delete" && (
        <DeleteLabelDialog page={page} label={dialog.label} count={countOf(dialog.label)} onClose={close} />
      )}
      {dialog?.kind === "assign" && (
        <AssignDialog page={page} label={dialog.label} people={people} onClose={close} />
      )}
    </section>
  );
}

// Isian nama label, dipakai dialog Label baru dan Ganti nama.
function NameForm({
  initial,
  labels,
  current,
  busy,
  submitText,
  busyText,
  failTitle,
  error,
  onSubmit,
}: {
  initial: string;
  labels: LabelView[];
  current?: LabelView;
  busy: boolean;
  submitText: string;
  busyText: string;
  failTitle: string;
  error: AppError | null;
  onSubmit: (name: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const [tried, setTried] = useState(false);
  const inputId = useId();
  const hintId = useId();
  const errId = useId();
  const problem = nameProblem(value, labels, current);
  const shown = tried ? problem : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (problem) return;
    onSubmit(value.trim());
  };

  return (
    <form className="dlg-form" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor={inputId}>Nama label</label>
        <input
          id={inputId}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={shown ? true : undefined}
          aria-describedby={shown ? `${hintId} ${errId}` : hintId}
          readOnly={busy}
        />
        <p id={hintId} className="hint">
          1 sampai {MAX_NAME} karakter, misalnya Drafter, K3, atau Senior.
        </p>
        {shown && (
          <div id={errId}>
            <FieldError text={shown} />
          </div>
        )}
      </div>
      <div aria-live="polite">
        {error && (
          <ErrorAlert title={failTitle}>
            <p>{error.message}</p>
          </ErrorAlert>
        )}
      </div>
      <div className="dlg-actions">
        <DialogClose asChild>
          <button type="button" className="btn btn-ghost" disabled={busy}>
            Batal
          </button>
        </DialogClose>
        <button type="submit" className="btn" disabled={busy} aria-busy={busy || undefined}>
          {busy ? busyText : submitText}
        </button>
      </div>
    </form>
  );
}

// Label baru. Sesudah dibuat, dialog yang sama berganti menjadi pemilih orang
// untuk label itu, supaya superadmin langsung bisa memasangnya.
function CreateLabelDialog({
  page,
  labels,
  people,
  onClose,
}: {
  page: OrgPage;
  labels: LabelView[];
  people: PersonView[];
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [created, setCreated] = useState<LabelView | null>(null);

  const create = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      const id = await orgApi.createLabel(name);
      page.notify(`Label ${name} dibuat.`);
      page.refresh();
      setCreated({ id, name, archived: false, createdAt: "", memberKeys: [] });
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={created ? `Atur orang untuk label ${created.name}` : "Label baru"}
    >
      {created ? (
        <PeoplePicker
          page={page}
          label={created}
          people={people}
          busy={busy}
          setBusy={setBusy}
          onDone={onClose}
          closeText="Atur nanti"
          focusSearch
          intro={
            <p className="notice-plain">
              Label {created.name} sudah dibuat. Centang orang yang memakainya lalu pilih Simpan, atau atur nanti lewat
              tombol Atur orang di barisnya.
            </p>
          }
        />
      ) : (
        <NameForm
          initial=""
          labels={labels}
          busy={busy}
          submitText="Buat label"
          busyText="Membuat label..."
          failTitle="Label belum dibuat"
          error={error}
          onSubmit={(name) => void create(name)}
        />
      )}
    </Dialog>
  );
}

function RenameLabelDialog({
  page,
  label,
  labels,
  onClose,
}: {
  page: OrgPage;
  label: LabelView;
  labels: LabelView[];
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  const rename = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      await orgApi.renameLabel(label.id, name);
      page.notify(`Label ${label.name} sekarang bernama ${name}.`);
      page.refresh();
      onClose();
    } catch (err) {
      setError(toAppError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={`Ganti nama label ${label.name}`}
    >
      <NameForm
        initial={label.name}
        labels={labels}
        current={label}
        busy={busy}
        submitText="Simpan nama"
        busyText="Menyimpan nama..."
        failTitle="Nama label belum diganti"
        error={error}
        onSubmit={(name) => void rename(name)}
      />
    </Dialog>
  );
}

// Hapus = arsipkan di inti Rust: pasangan orang tetap tersimpan.
function DeleteLabelDialog({
  page,
  label,
  count,
  onClose,
}: {
  page: OrgPage;
  label: LabelView;
  count: number;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await orgApi.setLabelArchived(label.id, true);
      page.notify(`Label ${label.name} dihapus. Label ini bisa dipulihkan dari bagian Dihapus.`);
      page.refresh();
      onClose();
    } catch (err) {
      setError(toAppError(err));
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Hapus label ${label.name}?`}
      confirmLabel={`Hapus ${label.name}`}
      busyLabel="Menghapus..."
      busy={busy}
      onConfirm={() => void remove()}
      error={
        error && (
          <ErrorAlert title={`Label ${label.name} belum terhapus`}>
            <p>{error.message}</p>
          </ErrorAlert>
        )
      }
    >
      <p>
        {count > 0
          ? `Label ${label.name} hilang dari samping nama ${count} orang dan tidak bisa dipasang lagi.`
          : `Label ${label.name} hilang dari daftar dan tidak bisa dipasang lagi.`}
      </p>
      <p className="lbl-confirm-more">
        Daftar orang yang memakainya tetap tersimpan. Kalau nanti label ini dipulihkan dari bagian Dihapus, label kembali
        ke orang yang sama.
      </p>
    </ConfirmDialog>
  );
}

function AssignDialog({
  page,
  label,
  people,
  onClose,
}: {
  page: OrgPage;
  label: LabelView;
  people: PersonView[];
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={`Atur orang untuk label ${label.name}`}
    >
      <PeoplePicker page={page} label={label} people={people} busy={busy} setBusy={setBusy} onDone={onClose} closeText="Batal" />
    </Dialog>
  );
}

type SaveError = { error: AppError; who: string; assigned: boolean; done: number; total: number };

function PeoplePicker({
  page,
  label,
  people,
  busy,
  setBusy,
  onDone,
  closeText,
  intro,
  focusSearch = false,
}: {
  page: OrgPage;
  label: LabelView;
  people: PersonView[];
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onDone: () => void;
  closeText: string;
  intro?: ReactNode;
  focusSearch?: boolean;
}) {
  // Titik awal: orang aktif yang sekarang memakai label ini. Setelah sebagian
  // perubahan tersimpan lalu gagal, titik awal ikut maju supaya Simpan berikutnya
  // hanya mengirim sisanya.
  const [baseline, setBaseline] = useState<Set<string>>(() => {
    const present = new Set(people.map((p) => p.publicKey));
    return new Set(label.memberKeys.filter((k) => present.has(k)));
  });
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(baseline));
  const [query, setQuery] = useState("");
  const [dept, setDept] = useState("all");
  const [progress, setProgress] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const uid = useId();

  useEffect(() => {
    if (focusSearch) searchRef.current?.focus();
  }, [focusSearch]);

  const sorted = useMemo(
    () => [...people].sort((a, b) => collator.compare(a.displayName, b.displayName)),
    [people],
  );
  const deptNames = useMemo(
    () =>
      [...new Set(people.filter((p) => !p.isGuest && p.departmentName).map((p) => p.departmentName as string))].sort(
        collator.compare,
      ),
    [people],
  );
  const hasGuest = people.some((p) => p.isGuest);
  const hasNone = people.some((p) => !p.isGuest && !p.departmentName);
  const deptLabel = (key: string) =>
    key === "guest" ? "Tamu" : key === "none" ? "Belum ada departemen" : key.slice("dept:".length);

  const q = query.trim().toLocaleLowerCase("id");
  const shown = sorted.filter(
    (p) => (dept === "all" || deptKey(p) === dept) && (!q || p.displayName.toLocaleLowerCase("id").includes(q)),
  );

  const nameOf = (pk: string) => people.find((p) => p.publicKey === pk)?.displayName ?? `Laptop ${pk.slice(0, 8)}`;
  const toAdd = [...chosen].filter((k) => !baseline.has(k));
  const toRemove = [...baseline].filter((k) => !chosen.has(k));
  const changes = toAdd.length + toRemove.length;

  const toggle = (pk: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(pk)) next.delete(pk);
      else next.add(pk);
      return next;
    });

  const resetFilters = () => {
    setQuery("");
    setDept("all");
    searchRef.current?.focus();
  };

  const save = async () => {
    const steps = [
      ...toAdd.map((k) => ({ key: k, assigned: true })),
      ...toRemove.map((k) => ({ key: k, assigned: false })),
    ];
    if (steps.length === 0) {
      onDone();
      return;
    }
    setBusy(true);
    setSaveError(null);
    const base = new Set(baseline);
    let done = 0;
    for (const step of steps) {
      setProgress(`Menyimpan perubahan ${done + 1} dari ${steps.length}...`);
      try {
        await orgApi.setLabelAssigned(label.id, step.key, step.assigned);
      } catch (err) {
        setBaseline(base);
        setSaveError({ error: toAppError(err), who: nameOf(step.key), assigned: step.assigned, done, total: steps.length });
        setProgress(null);
        setBusy(false);
        if (done > 0) page.refresh();
        return;
      }
      if (step.assigned) base.add(step.key);
      else base.delete(step.key);
      done++;
    }
    setProgress(null);
    setBusy(false);
    const parts: string[] = [];
    if (toAdd.length > 0) parts.push(`dipasang ke ${toAdd.length} orang`);
    if (toRemove.length > 0) parts.push(`dilepas dari ${toRemove.length} orang`);
    page.notify(`Label ${label.name} ${parts.join(" dan ")}.`);
    page.refresh();
    onDone();
  };

  const filterText = (() => {
    const bits: string[] = [];
    if (q) bits.push(`nama "${query.trim()}"`);
    if (dept !== "all") bits.push(dept === "guest" ? "saringan Tamu" : `saringan ${deptLabel(dept)}`);
    return bits.join(" dan ");
  })();

  return (
    <div className="dlg-form">
      {intro}
      <div className="lbl-filters">
        <div className="field">
          <label htmlFor={`${uid}-q`}>Cari nama</label>
          <input
            id={`${uid}-q`}
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-d`}>Departemen</label>
          <select id={`${uid}-d`} value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="all">Semua departemen</option>
            {deptNames.map((name) => (
              <option key={name} value={`dept:${name}`}>
                {name}
              </option>
            ))}
            {hasGuest && <option value="guest">Tamu</option>}
            {hasNone && <option value="none">Belum ada departemen</option>}
          </select>
        </div>
      </div>

      <p className="hint lbl-picked">
        {chosen.size} orang dipilih
        {changes > 0 && `, ${changes} perubahan belum disimpan`}
      </p>

      {people.length === 0 ? (
        <div className="org-empty">
          <p>Belum ada orang di organisasi ini. Orang baru masuk lewat kode undangan di tab Undangan.</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="org-empty lbl-nomatch">
          <p>Tidak ada orang yang cocok dengan {filterText}.</p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={resetFilters}>
            Tampilkan semua orang
          </button>
        </div>
      ) : (
        <ul className="lbl-pick" aria-label={`Orang untuk label ${label.name}`}>
          {shown.map((p, i) => {
            const others = p.labels.filter((l) => l.id !== label.id);
            const nameId = `${uid}-n${i}`;
            const subId = `${uid}-s${i}`;
            const noteId = `${uid}-t${i}`;
            const crowded = others.length >= MAX_LABELS_SHOWN;
            return (
              <li key={p.publicKey}>
                <label className="lbl-pick-row">
                  <input
                    type="checkbox"
                    checked={chosen.has(p.publicKey)}
                    onChange={() => toggle(p.publicKey)}
                    disabled={busy}
                    aria-labelledby={nameId}
                    aria-describedby={crowded ? `${subId} ${noteId}` : subId}
                  />
                  <span className="lbl-pick-text">
                    <span id={nameId}>
                      <NameWithLabels
                        name={p.displayName}
                        labels={others}
                        suffix={page.isMe(p.publicKey) ? " (Anda)" : undefined}
                      />
                    </span>
                    <span id={subId} className="row-sub">
                      {deptText(p)}
                    </span>
                    {crowded && (
                      <span id={noteId} className="lbl-pick-note">
                        Sudah punya {others.length} label lain. Di samping nama hanya tampil {MAX_LABELS_SHOWN} label
                        pertama menurut abjad.
                      </span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <div aria-live="polite">
        {progress && <p className="hint">{progress}</p>}
        {saveError && (
          <ErrorAlert
            title={
              saveError.assigned
                ? `Berhenti saat memasang label ke ${saveError.who}`
                : `Berhenti saat melepas label dari ${saveError.who}`
            }
          >
            <p>{saveError.error.message}</p>
            <p>
              {saveError.done === 0
                ? "Belum ada perubahan yang tersimpan."
                : `${saveError.done} dari ${saveError.total} perubahan sudah tersimpan.`}{" "}
              Pilih Simpan untuk mencoba sisanya.
            </p>
          </ErrorAlert>
        )}
      </div>

      <div className="dlg-actions">
        <DialogClose asChild>
          <button type="button" className="btn btn-ghost" disabled={busy}>
            {closeText}
          </button>
        </DialogClose>
        <button type="button" className="btn" disabled={busy} aria-busy={busy || undefined} onClick={() => void save()}>
          {busy ? "Menyimpan..." : "Simpan"}
        </button>
      </div>
    </div>
  );
}
