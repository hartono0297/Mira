import * as RadixDialog from "@radix-ui/react-dialog";
import { IconAlertTriangle, IconGitMerge, IconTrash, IconX } from "@tabler/icons-react";
import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { toAppError, type AppError } from "../../api";
import {
  boardApi,
  subscribeBoard,
  type BoardView,
  type ColumnId,
  type Person,
  type Priority,
  type TaskDetail as Task,
} from "../../api/board";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { initials } from "../../components/initials";
import { COLUMN_NAMES, COLUMN_ORDER, daysUntil, dueLabel, formatDateTime, formatDue, PRIORITY_LABELS } from "./format";
import { activitySentence } from "./taskActivity";
import { useHeld } from "./useHeld";
import "./task.css";

type Field = "title" | "description" | "status" | "assignee" | "due" | "priority" | "labels" | "comment";

const FIELD_NAMES: Record<Field, string> = {
  title: "Judul",
  description: "Deskripsi",
  status: "Status",
  assignee: "Penanggung jawab",
  due: "Tenggat",
  priority: "Prioritas",
  labels: "Label",
  comment: "Komentar",
};

const PRIORITIES: Priority[] = ["none", "low", "medium", "high"];
const MAX_LABELS = 10;
const MAX_LABEL_LEN = 30;
const ACTIVITY_PREVIEW = 6;

type Props = {
  projectId: string;
  taskId: string;
  onClose: () => void;
  onChanged: () => void;
  // Dipanggil setelah task terhapus, sebelum onClose. Board memindahkan fokus dan mengumumkannya.
  onDeleted?: (taskId: string, code: string) => void;
};

type SelectField = "status" | "assignee" | "priority";

// Task atau proyeknya hilang saat muat ulang, biasanya karena perubahan dari laptop lain.
// "revoked": izin mengubah dicabut saat masih ada draf yang belum tersimpan.
type Gone = "task" | "project" | "revoked";

const GONE_TITLE: Record<Gone, string> = {
  task: "Task ini dihapus di laptop lain.",
  project: "Proyek task ini tidak bisa dibuka lagi.",
  revoked: "Izin mengubah task ini baru dicabut.",
};

function errorTitle(field: Field, error: AppError): string {
  if (error.code === "forbidden") return "Anda tidak punya izin untuk ini";
  if (error.code === "not_found") return "Task ini tidak ada lagi";
  if (field === "comment") return "Komentar belum terkirim";
  return `${FIELD_NAMES[field]} belum tersimpan`;
}

export function PriorityChip({ priority }: { priority: Priority }) {
  return <span className={`td-prio td-prio-${priority}`}>{PRIORITY_LABELS[priority]}</span>;
}

// Detail task sebagai dialog modal. Selalu terbuka selama dipasang; pemanggil
// melepasnya lewat onClose. Fokus terkunci di dalam, Escape menutup (kecuali
// sedang membatalkan ketikan judul atau label), fokus kembali ke pembuka.
export function TaskDetail({ projectId, taskId, onClose, onChanged, onDeleted }: Props) {
  const [task, setTask] = useState<Task | null>(null);
  const [board, setBoard] = useState<BoardView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Field, AppError>>>({});
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState<Field | null>(null);

  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [titleProblem, setTitleProblem] = useState<string | null>(null);
  const [descDraft, setDescDraft] = useState<string | null>(null);
  const [dueDraft, setDueDraft] = useState<string | null>(null);
  const [dueProblem, setDueProblem] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [labelProblem, setLabelProblem] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [unsaved, setUnsaved] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<AppError | null>(null);
  const [allActivity, setAllActivity] = useState(false);
  const [selDraft, setSelDraft] = useState<Partial<Record<SelectField, string>>>({});
  const [gone, setGone] = useState<Gone | null>(null);
  // Nilai server saat ketikan dimulai. Kalau server berubah selama draf belum
  // disimpan, pengguna diberi tahu sebelum ketikannya menimpa perubahan rekan.
  const [titleBase, setTitleBase] = useState<string | null>(null);
  const [descBase, setDescBase] = useState<string | null>(null);
  const titleHeld = useHeld(task?.title ?? "");
  const descHeld = useHeld(task?.description ?? "");
  const dueHeld = useHeld(task?.due ?? "");

  const ids = useId();
  // Pilihan lewat mouse langsung disimpan. Lewat keyboard, panah di select yang
  // tertutup memicu change per langkah, jadi baru disimpan saat Enter atau blur.
  const pointerPick = useRef(false);
  const deleted = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const dueRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const goneCloseRef = useRef<HTMLButtonElement>(null);
  const hasTask = useRef(false);
  hasTask.current = task !== null;
  const wasEditable = useRef(false);
  wasEditable.current = task?.canEdit === true;
  const hasDrafts = useRef(false);
  hasDrafts.current =
    titleDraft !== null ||
    descDraft !== null ||
    dueDraft !== null ||
    labelDraft.trim() !== "" ||
    comment.trim() !== "" ||
    Object.values(selDraft).some((v) => v !== undefined);
  const alive = useRef(true);
  const seq = useRef(0);
  const applied = useRef(0);
  const inflight = useRef<Partial<Record<Field, Promise<boolean>>>>({});
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  // Dialog dibuka lewat state, jadi pembukanya dicatat saat render pertama
  // (fokus belum pindah) dan difokus lagi saat dialog tutup.
  const opener = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  const apply = useCallback((mine: number, next: Task) => {
    if (!alive.current || mine < applied.current) return;
    applied.current = mine;
    setTask(next);
  }, []);

  // Muat ulang tidak menyentuh draf (judul, deskripsi, label, komentar):
  // semuanya state terpisah yang hanya dikosongkan setelah disimpan atau dibatalkan.
  const load = useCallback(async () => {
    const mine = ++seq.current;
    const [t, b] = await Promise.allSettled([boardApi.getTask(projectId, taskId), boardApi.getBoard(projectId)]);
    if (!alive.current || deleted.current) return;
    if (t.status === "fulfilled") apply(mine, t.value);
    if (b.status === "fulfilled") setBoard(b.value);
    const boardErr = b.status === "rejected" ? toAppError(b.reason) : null;
    const taskErr = t.status === "rejected" ? toAppError(t.reason) : null;
    if (!boardErr && !taskErr && t.status === "fulfilled") {
      // Izin mengubah dicabut (misalnya jadi Tamu) saat masih ada draf: draf
      // ditampilkan untuk disalin, sama seperti saat task hilang.
      const canEditNow = t.value.canEdit;
      const revokedNow = wasEditable.current && !canEditNow && hasDrafts.current;
      setGone((prev) => (revokedNow || (prev === "revoked" && !canEditNow) ? "revoked" : null));
      setLoadError(null);
    } else if (hasTask.current && boardErr && (boardErr.code === "not_found" || boardErr.code === "forbidden")) {
      setGone("project");
    } else if (hasTask.current && taskErr?.code === "not_found") {
      setGone("task");
    } else {
      setLoadError(taskErr ?? boardErr);
    }
    setLoading(false);
  }, [projectId, taskId, apply]);

  useEffect(() => {
    alive.current = true;
    void load();
    const stop = subscribeBoard(() => void load());
    return () => {
      alive.current = false;
      stop();
    };
  }, [load]);

  async function run(field: Field, work: () => Promise<Task>, done: string): Promise<boolean> {
    const mine = ++seq.current;
    setPending(field);
    setStatus("Menyimpan...");
    setErrors((e) => ({ ...e, [field]: undefined }));
    try {
      const next = await work();
      apply(mine, next);
      if (alive.current) setStatus(done);
      onChangedRef.current();
      return true;
    } catch (err) {
      if (alive.current) {
        setErrors((e) => ({ ...e, [field]: toAppError(err) }));
        setStatus("");
      }
      return false;
    } finally {
      if (alive.current) setPending((p) => (p === field ? null : p));
    }
  }

  // Satu simpan per field sekaligus: blur lalu klik Tutup tidak menyimpan dua kali.
  function once(field: Field, work: () => Promise<boolean>): Promise<boolean> {
    const current = inflight.current[field];
    if (current) return current;
    const p = work().finally(() => {
      delete inflight.current[field];
    });
    inflight.current[field] = p;
    return p;
  }

  const update = (field: Field, patch: Parameters<typeof boardApi.updateTask>[2]) =>
    run(field, () => boardApi.updateTask(projectId, taskId, patch), `${FIELD_NAMES[field]} tersimpan.`);

  function commitTitle(closing = false): Promise<boolean> {
    return once("title", async () => {
      if (!task || titleDraft === null) return true;
      const value = titleDraft.trim();
      if (value === task.title) {
        setTitleDraft(null);
        titleHeld.settle(task.title);
        setTitleProblem(null);
        return true;
      }
      if (!value) {
        if (closing) {
          setTitleDraft(null);
          setTitleProblem(null);
          return true;
        }
        setTitleProblem("Judul tidak boleh kosong. Tekan Escape untuk kembali ke judul sebelumnya.");
        return false;
      }
      setTitleProblem(null);
      const ok = await update("title", { title: value });
      if (ok && alive.current) {
        setTitleDraft(null);
        titleHeld.settle(value);
      }
      return ok;
    });
  }

  function commitDescription(): Promise<boolean> {
    return once("description", async () => {
      if (!task || descDraft === null) return true;
      if (descDraft === task.description) {
        setDescDraft(null);
        descHeld.settle(task.description);
        return true;
      }
      const ok = await update("description", { description: descDraft });
      if (ok && alive.current) {
        setDescDraft(null);
        descHeld.settle(descDraft);
      }
      return ok;
    });
  }

  function commitDue(): Promise<boolean> {
    return once("due", async () => {
      if (!task || dueDraft === null) return true;
      if (dueRef.current?.validity.badInput) {
        setDueProblem("Tanggal belum lengkap. Isi hari, bulan, dan tahun, atau pilih dari kalender.");
        return false;
      }
      setDueProblem(null);
      const value = dueDraft === "" ? null : dueDraft;
      if (value === task.due) {
        setDueDraft(null);
        dueHeld.settle(task.due ?? "");
        return true;
      }
      const ok = await update("due", { due: value });
      if (ok && alive.current) {
        setDueDraft(null);
        dueHeld.settle(value ?? "");
      }
      return ok;
    });
  }

  // Elemen yang difokus bisa lepas saat tampilan berganti ke mode hilang.
  // Fokus dipindah ke tombol Tutup di keterangan supaya tetap di dalam dialog.
  useEffect(() => {
    if (!gone) return;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body || active === contentRef.current) goneCloseRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [gone]);

  async function requestClose() {
    if (!task) {
      onClose();
      return;
    }
    // Task yang sudah hilang tidak bisa disimpan lagi. Draf yang belum
    // tersimpan sudah ditampilkan untuk disalin, jadi dialog ditutup langsung.
    if (gone) {
      onClose();
      return;
    }
    const ok =
      (await commitTitle(true)) &&
      (await commitDescription()) &&
      (await commitDue()) &&
      (await commitSelect("status")) &&
      (await commitSelect("assignee")) &&
      (await commitSelect("priority"));
    if (!alive.current) return;
    if (!ok) {
      setUnsaved("Ada perubahan yang belum tersimpan. Lihat pesan di bawah, lalu coba simpan lagi.");
      return;
    }
    if (comment.trim()) {
      setUnsaved("Komentar Anda belum dikirim.");
      return;
    }
    onClose();
  }

  function savedSelect(t: Task, field: SelectField): string {
    if (field === "status") return t.columnId;
    if (field === "assignee") return t.assignee?.publicKey ?? "";
    return t.priority;
  }

  // Menyimpan pilihan select yang belum tersimpan. Nilai tujuan tetap tampil
  // selama menyimpan; kalau gagal, select kembali ke nilai tersimpan.
  function commitSelect(field: SelectField, picked?: string): Promise<boolean> {
    return once(field, async () => {
      const value = picked ?? selDraft[field];
      if (!task || value === undefined) return true;
      if (value === savedSelect(task, field)) {
        setSelDraft((d) => ({ ...d, [field]: undefined }));
        return true;
      }
      setSelDraft((d) => ({ ...d, [field]: value }));
      let ok: boolean;
      if (field === "status") ok = await changeStatus(value as ColumnId);
      else if (field === "assignee") ok = await update("assignee", { assignee: value || null });
      else ok = await update("priority", { priority: value as Priority });
      if (alive.current) setSelDraft((d) => ({ ...d, [field]: undefined }));
      return ok;
    });
  }

  function selectProps(field: SelectField, t: Task) {
    return {
      "data-field": field,
      value: selDraft[field] ?? savedSelect(t, field),
      onPointerDown: () => {
        pointerPick.current = true;
      },
      onMouseDown: () => {
        pointerPick.current = true;
      },
      onKeyDown: (e: KeyboardEvent<HTMLSelectElement>) => {
        pointerPick.current = false;
        if (e.key === "Enter") {
          e.preventDefault();
          void commitSelect(field);
        }
      },
      onChange: (e: ChangeEvent<HTMLSelectElement>) => {
        const value = e.target.value;
        if (pointerPick.current) {
          pointerPick.current = false;
          void commitSelect(field, value);
        } else {
          setSelDraft((d) => ({ ...d, [field]: value }));
        }
      },
      onBlur: () => {
        pointerPick.current = false;
        void commitSelect(field);
      },
    };
  }

  function changeStatus(columnId: ColumnId): Promise<boolean> {
    return run(
      "status",
      async () => {
        const view = await boardApi.moveTask(projectId, taskId, columnId, 0);
        if (alive.current) setBoard(view);
        return boardApi.getTask(projectId, taskId);
      },
      `Status tersimpan: ${COLUMN_NAMES[columnId]}.`,
    );
  }

  async function addLabel() {
    if (!task) return;
    const value = labelDraft.trim();
    if (!value) return;
    if (value.length > MAX_LABEL_LEN) {
      setLabelProblem(`Label paling panjang ${MAX_LABEL_LEN} karakter.`);
      return;
    }
    if (task.labels.length >= MAX_LABELS) {
      setLabelProblem(`Sudah ${MAX_LABELS} label. Hapus satu dulu untuk menambah yang baru.`);
      return;
    }
    if (task.labels.some((l) => l.toLowerCase() === value.toLowerCase())) {
      setLabelProblem(`Label "${value}" sudah ada.`);
      return;
    }
    setLabelProblem(null);
    const ok = await update("labels", { labels: [...task.labels, value] });
    if (ok && alive.current) setLabelDraft("");
  }

  async function removeLabel(label: string) {
    if (!task) return;
    labelRef.current?.focus();
    setLabelProblem(null);
    await update("labels", { labels: task.labels.filter((l) => l !== label) });
  }

  async function sendComment() {
    const body = comment.trim();
    if (!body || pending === "comment") return;
    const ok = await run("comment", () => boardApi.addComment(projectId, taskId, body), "Komentar terkirim.");
    if (ok && alive.current) {
      setComment("");
      setUnsaved(null);
    }
  }

  async function deleteTask() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await boardApi.deleteTask(projectId, taskId);
      deleted.current = true;
      onChangedRef.current();
      onDeleted?.(taskId, task?.code ?? "");
      onClose();
    } catch (err) {
      if (alive.current) setDeleteError(toAppError(err));
    } finally {
      if (alive.current) setDeleting(false);
    }
  }

  // Wilayah aria-live selalu dipasang supaya error yang muncul belakangan ikut dibacakan.
  function fieldError(field: Field, keepsInput = false) {
    const err = errors[field];
    return (
      <div className="td-live" aria-live="polite">
        {err && (
          <ErrorAlert title={errorTitle(field, err)}>
            <p>{err.message}</p>
            {keepsInput && err.code !== "forbidden" && err.code !== "not_found" && (
              <p>Isian Anda masih ada. Coba lagi.</p>
            )}
          </ErrorAlert>
        )}
      </div>
    );
  }

  function problem(id: string, text: string | null) {
    return (
      <div className="td-live" id={id} aria-live="polite">
        {text && <FieldError text={text} />}
      </div>
    );
  }

  const me = board?.me ?? "";
  const people: Person[] = board?.assignees ?? [];
  const nameOf = (p: Person) => (p.publicKey === me ? `${p.name} (Anda)` : p.name);
  // Penanggung jawab yang sudah tidak ada di daftar (misalnya dikeluarkan dari
  // tim) tetap tampil dengan keterangan, supaya tidak hilang diam-diam.
  const isFormer = (p: Person | null) => !!p && !!board && !people.some((x) => x.publicKey === p.publicKey);
  // Satu pasang kurung saja: "Budi (tidak bisa ditugaskan lagi)", "Budi (Anda, tidak bisa ditugaskan lagi)".
  const assigneeName = (p: Person) => {
    if (!isFormer(p)) return nameOf(p);
    return p.publicKey === me ? `${p.name} (Anda, tidak bisa ditugaskan lagi)` : `${p.name} (tidak bisa ditugaskan lagi)`;
  };

  function body() {
    if (loading && !task) {
      return (
        <p className="td-pad hint" role="status">
          Memuat task...
        </p>
      );
    }
    if (!task) {
      const gone = loadError?.code === "not_found";
      return (
        <div className="td-pad" role="alert">
          <ErrorAlert title={gone ? "Task ini tidak ada lagi" : "Task belum terbaca"}>
            <p>{loadError?.message ?? "Inti Mira tidak mengirim data task."}</p>
            <p>
              {gone
                ? "Mungkin sudah dihapus. Tutup dialog ini; board sudah memuat daftar terbaru."
                : "Coba baca lagi. Kalau tetap gagal, tutup Mira lalu buka lagi."}
            </p>
            <div className="td-row-actions">
              {!gone && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setLoading(true);
                    void load();
                  }}
                >
                  Coba lagi
                </button>
              )}
              <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
                Tutup
              </button>
            </div>
          </ErrorAlert>
        </div>
      );
    }
    if (gone) return readOnly(task, true);
    return task.canEdit ? editable(task) : readOnly(task);
  }

  function topNotes(t: Task) {
    return (
      <>
        {t.merged && (
          <p className="td-merged">
            <IconGitMerge size={16} aria-hidden="true" />
            <span>
              <strong>Sudah digabung.</strong> Task ini juga diubah di laptop lain, dan perubahannya sudah digabung
              otomatis.
            </span>
          </p>
        )}
        {loadError && (
          <p className="hint">Data terbaru belum terbaca ({loadError.message}). Yang tampil adalah data terakhir.</p>
        )}
      </>
    );
  }

  function dueHint(due: string | null) {
    if (!due) return null;
    const n = daysUntil(due);
    const label = dueLabel(due);
    if (label === formatDue(due)) return null;
    return <span className={`td-due-hint${n !== null && n < 0 ? " td-late" : ""}`}>{label}</span>;
  }

  function editable(t: Task) {
    const titleValue = titleDraft ?? titleHeld.value;
    const descValue = descDraft ?? descHeld.value;
    const descDirty = descDraft !== null && descDraft !== t.description;
    const dueValue = dueDraft ?? dueHeld.value;
    const assigneeListed = t.assignee === null || people.some((p) => p.publicKey === t.assignee?.publicKey);
    const titleMoved = titleDraft !== null && titleBase !== null && t.title !== titleBase && titleDraft.trim() !== t.title;
    const descMoved = descDirty && descBase !== null && t.description !== descBase;
    return (
      <div className="td-grid">
        <div className="td-top">
          {topNotes(t)}
          <div className="td-field">
            <label htmlFor={`${ids}-title`} className="sr-only">
              Judul task
            </label>
            <input
              id={`${ids}-title`}
              ref={titleRef}
              className="td-title-input"
              value={titleValue}
              maxLength={200}
              aria-invalid={titleProblem ? true : undefined}
              aria-describedby={titleProblem ? `${ids}-title-err` : undefined}
              onFocus={titleHeld.hold}
              onChange={(e) => {
                if (titleDraft === null) setTitleBase(titleValue);
                setTitleDraft(e.target.value);
                setTitleProblem(null);
              }}
              onBlur={() => {
                titleHeld.release();
                void commitTitle();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitTitle();
                }
              }}
            />
            {problem(`${ids}-title-err`, titleProblem)}
            <div className="td-live" aria-live="polite">
              {titleMoved && (
                <p className="td-moved">
                  Judul ini baru diubah di laptop lain menjadi "{t.title}". Ketikan Anda menggantinya kalau Anda menekan
                  Enter, pindah dari kolom ini, atau menutup dialog. Tekan Escape untuk memakai judul itu.
                </p>
              )}
            </div>
            {fieldError("title", true)}
          </div>

          <div className="td-field">
            <label htmlFor={`${ids}-desc`} className="td-label">
              Deskripsi
            </label>
            <textarea
              id={`${ids}-desc`}
              className="td-textarea"
              rows={5}
              value={descValue}
              placeholder="Apa yang perlu dikerjakan, dan seperti apa hasilnya"
              onFocus={descHeld.hold}
              onBlur={descHeld.release}
              onChange={(e) => {
                if (descDraft === null) setDescBase(descValue);
                setDescDraft(e.target.value);
              }}
              onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
                if (e.key === "Enter" && e.ctrlKey) {
                  e.preventDefault();
                  void commitDescription();
                }
              }}
            />
            <div className="td-live" aria-live="polite">
              {descMoved && (
                <p className="td-moved">
                  Deskripsi ini baru diubah di laptop lain. Ketikan Anda menggantinya kalau Anda menekan Simpan deskripsi
                  atau menutup dialog. Pilih Batalkan perubahan untuk memakai versi terbaru.
                </p>
              )}
            </div>
            {descDirty && (
              <div className="td-row-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={pending === "description"}
                  aria-busy={pending === "description" || undefined}
                  onClick={() => void commitDescription()}
                >
                  {pending === "description" ? "Menyimpan..." : "Simpan deskripsi"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={pending === "description"}
                  onClick={() => {
                    setDescDraft(null);
                    descHeld.settle(t.description);
                  }}
                >
                  Batalkan perubahan
                </button>
                <span className="hint">Ctrl+Enter juga menyimpan.</span>
              </div>
            )}
            {fieldError("description", true)}
          </div>
        </div>

        <aside className="td-side" aria-label="Rincian task">
          <div className="td-field">
            <label htmlFor={`${ids}-status`} className="td-label">
              Status
            </label>
            <select id={`${ids}-status`} className="td-input" {...selectProps("status", t)}>
              {(board?.columns.map((c) => ({ id: c.id, name: c.name })) ??
                COLUMN_ORDER.map((id) => ({ id, name: COLUMN_NAMES[id] }))
              ).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {fieldError("status")}
          </div>

          <div className="td-field">
            <label htmlFor={`${ids}-assignee`} className="td-label">
              Penanggung jawab
            </label>
            <select id={`${ids}-assignee`} className="td-input" {...selectProps("assignee", t)}>
              <option value="">Belum ada</option>
              {!assigneeListed && t.assignee && <option value={t.assignee.publicKey}>{assigneeName(t.assignee)}</option>}
              {people.map((p) => (
                <option key={p.publicKey} value={p.publicKey}>
                  {nameOf(p)}
                </option>
              ))}
            </select>
            {fieldError("assignee")}
          </div>

          <div className="td-field">
            <label htmlFor={`${ids}-due`} className="td-label">
              Tenggat
            </label>
            <input
              id={`${ids}-due`}
              ref={dueRef}
              type="date"
              className="td-input"
              value={dueValue}
              aria-invalid={dueProblem ? true : undefined}
              aria-describedby={dueProblem ? `${ids}-due-err` : undefined}
              onFocus={dueHeld.hold}
              onChange={(e) => {
                setDueDraft(e.target.value);
                setDueProblem(null);
              }}
              onBlur={() => {
                dueHeld.release();
                void commitDue();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitDue();
                }
              }}
            />
            {dueDraft === null && dueHint(t.due)}
            {problem(`${ids}-due-err`, dueProblem)}
            {t.due && dueDraft === null && (
              <button type="button" className="link-btn td-link" onClick={() => void update("due", { due: null })}>
                Hapus tenggat
              </button>
            )}
            {fieldError("due")}
          </div>

          <div className="td-field">
            <label htmlFor={`${ids}-prio`} className="td-label">
              Prioritas
            </label>
            <select id={`${ids}-prio`} className="td-input" {...selectProps("priority", t)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
            {fieldError("priority")}
          </div>

          <div className="td-field">
            <span className="td-label" id={`${ids}-labels`}>
              Label
            </span>
            {t.labels.length > 0 ? (
              <ul className="td-labels" aria-labelledby={`${ids}-labels`}>
                {t.labels.map((l) => (
                  <li key={l} className="td-label-chip">
                    <span>{l}</span>
                    <button
                      type="button"
                      className="td-chip-x"
                      aria-label={`Hapus label ${l}`}
                      onClick={() => void removeLabel(l)}
                    >
                      <IconX size={14} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">Belum ada label.</p>
            )}
            {t.labels.length < MAX_LABELS ? (
              <div className="td-label-add">
                <input
                  ref={labelRef}
                  className="td-input"
                  value={labelDraft}
                  maxLength={MAX_LABEL_LEN}
                  aria-label="Label baru"
                  aria-describedby={`${ids}-labels-hint ${ids}-label-err`}
                  placeholder="Label baru"
                  onChange={(e) => {
                    setLabelDraft(e.target.value);
                    setLabelProblem(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void addLabel();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={!labelDraft.trim()}
                  onClick={() => void addLabel()}
                >
                  Tambah
                </button>
              </div>
            ) : null}
            <span className="hint" id={`${ids}-labels-hint`}>
              {t.labels.length >= MAX_LABELS
                ? `Sudah ${MAX_LABELS} label, batas per task. Hapus satu untuk menambah yang baru.`
                : `Tekan Enter untuk menambah. Paling banyak ${MAX_LABELS} label, masing-masing ${MAX_LABEL_LEN} karakter.`}
            </span>
            {problem(`${ids}-label-err`, labelProblem)}
            {fieldError("labels", true)}
          </div>

          {sideFooter(t)}
        </aside>

        <div className="td-bottom">
          {comments(t)}
          {activity(t)}
        </div>
      </div>
    );
  }

  // Isian yang belum tersimpan saat task hilang. Ditampilkan sebagai teks yang
  // bisa dipilih dan disalin, karena tidak ada lagi tempat untuk menyimpannya.
  function keptDrafts(t: Task): { key: string; label: string; text: string }[] {
    const list = [
      { key: "title", label: "Judul", text: titleDraft !== null && titleDraft.trim() !== t.title ? titleDraft : "" },
      { key: "desc", label: "Deskripsi", text: descDraft !== null && descDraft !== t.description ? descDraft : "" },
      { key: "label", label: "Label baru", text: labelDraft.trim() },
      { key: "comment", label: "Komentar", text: comment.trim() ? comment : "" },
    ];
    return list.filter((d) => d.text !== "");
  }

  function readOnlyNote(t: Task) {
    if (t.canComment)
      return "Anda bisa membaca dan mengomentari task ini, tapi tidak bisa mengubah isinya.";
    return "Anda hanya bisa melihat task ini. Mengubah dan mengomentari task tidak tersedia untuk peran Anda di proyek ini.";
  }

  function readOnly(t: Task, isGone = false) {
    const kept = isGone ? keptDrafts(t) : [];
    return (
      <div className="td-grid">
        <div className="td-top">
          {!isGone && topNotes(t)}
          {!isGone && <p className="td-readonly-note">{readOnlyNote(t)}</p>}
          {kept.length > 0 && (
            <section className="td-kept" aria-labelledby={`${ids}-kept`}>
              <h3 id={`${ids}-kept`} className="td-sh">
                Isian Anda yang belum tersimpan
              </h3>
              <p className="hint">Isian ini hilang setelah dialog ditutup. Salin dulu kalau masih perlu.</p>
              {kept.map((d) => (
                <div key={d.key} className="td-field">
                  <label htmlFor={`${ids}-kept-${d.key}`} className="td-label">
                    {d.label}
                  </label>
                  <textarea
                    id={`${ids}-kept-${d.key}`}
                    className="td-textarea"
                    rows={d.key === "title" || d.key === "label" ? 1 : 3}
                    readOnly
                    value={d.text}
                  />
                </div>
              ))}
            </section>
          )}
          <p className="td-title-text">{t.title}</p>
          <div className="td-field">
            <span className="td-label">Deskripsi</span>
            {t.description ? <p className="td-pre">{t.description}</p> : <p className="hint">Belum ada deskripsi.</p>}
          </div>
        </div>
        <aside className="td-side" aria-label="Rincian task">
          <dl className="td-dl">
            <div>
              <dt>Status</dt>
              <dd>{COLUMN_NAMES[t.columnId] ?? t.columnId}</dd>
            </div>
            <div>
              <dt>Penanggung jawab</dt>
              <dd>{t.assignee ? assigneeName(t.assignee) : "Belum ada"}</dd>
            </div>
            <div>
              <dt>Tenggat</dt>
              <dd>
                {t.due ? (
                  <>
                    {formatDue(t.due)} {dueHint(t.due)}
                  </>
                ) : (
                  "Tanpa tenggat"
                )}
              </dd>
            </div>
            <div>
              <dt>Prioritas</dt>
              <dd>
                <PriorityChip priority={t.priority} />
              </dd>
            </div>
            <div>
              <dt>Label</dt>
              <dd>
                {t.labels.length > 0 ? (
                  <ul className="td-labels">
                    {t.labels.map((l) => (
                      <li key={l} className="td-label-chip">
                        {l}
                      </li>
                    ))}
                  </ul>
                ) : (
                  "Tidak ada"
                )}
              </dd>
            </div>
          </dl>
          {sideFooter(t, !isGone)}
        </aside>
        <div className="td-bottom">
          {comments(t, !isGone)}
          {activity(t)}
        </div>
      </div>
    );
  }

  function sideFooter(t: Task, live = true) {
    return (
      <div className="td-side-foot">
        <p className="hint">
          Dibuat oleh {t.createdBy.publicKey === me ? "Anda" : t.createdBy.name}, {formatDateTime(t.createdAt)}
        </p>
        {live && t.canDelete && (
          <button
            type="button"
            className="btn btn-ghost btn-sm td-delete"
            onClick={() => {
              setDeleteError(null);
              setConfirmDelete(true);
            }}
          >
            <IconTrash size={16} aria-hidden="true" />
            Hapus task
          </button>
        )}
      </div>
    );
  }

  function avatar(p: Person) {
    return (
      <span className="td-av" aria-hidden="true">
        {initials(p.name)}
      </span>
    );
  }

  function comments(t: Task, live = true) {
    const sending = pending === "comment";
    const canWrite = live && t.canComment === true;
    return (
      <section className="td-section" aria-labelledby={`${ids}-comments`}>
        <h3 id={`${ids}-comments`} className="td-sh">
          Komentar {t.comments.length > 0 && <span className="td-count">{t.comments.length}</span>}
        </h3>
        {t.comments.length === 0 ? (
          <p className="hint">{canWrite ? "Belum ada komentar. Tulis yang pertama di bawah." : "Belum ada komentar."}</p>
        ) : (
          <ul className="td-list">
            {t.comments.map((c) => (
              <li key={c.id} className="td-comment">
                {avatar(c.author)}
                <div className="td-entry">
                  <p className="td-entry-head">
                    <strong>{c.author.publicKey === me ? `${c.author.name} (Anda)` : c.author.name}</strong>
                    <span className="td-time">{formatDateTime(c.at)}</span>
                  </p>
                  <p className="td-pre">{c.body}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <div className="td-composer">
            <label htmlFor={`${ids}-comment`} className="sr-only">
              Tulis komentar
            </label>
            <textarea
              id={`${ids}-comment`}
              className="td-textarea"
              rows={3}
              placeholder="Tulis komentar"
              aria-describedby={`${ids}-comment-hint`}
              value={comment}
              onChange={(e) => {
                setComment(e.target.value);
                setUnsaved(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.ctrlKey) {
                  e.preventDefault();
                  void sendComment();
                }
              }}
            />
            <div className="td-row-actions">
              <span className="hint" id={`${ids}-comment-hint`}>
                Ctrl+Enter untuk mengirim.
              </span>
              <button
                type="button"
                className="btn btn-sm td-send"
                disabled={!comment.trim() || sending}
                aria-busy={sending || undefined}
                onClick={() => void sendComment()}
              >
                {sending ? "Mengirim..." : "Kirim"}
              </button>
            </div>
            {fieldError("comment", true)}
          </div>
        )}
      </section>
    );
  }

  function activity(t: Task) {
    const entries = t.activity
      .filter((a) => a.kind !== "commented")
      .map((a, i) => ({ a, i }))
      .sort((x, y) => (x.a.at === y.a.at ? y.i - x.i : x.a.at < y.a.at ? 1 : -1));
    const shown = allActivity ? entries : entries.slice(0, ACTIVITY_PREVIEW);
    return (
      <section className="td-section" aria-labelledby={`${ids}-activity`}>
        <h3 id={`${ids}-activity`} className="td-sh">
          Aktivitas
        </h3>
        {entries.length === 0 ? (
          <p className="hint">Belum ada aktivitas.</p>
        ) : (
          <ul className="td-list">
            {shown.map(({ a, i }) => (
              <li key={`${a.at}-${i}`} className="td-log">
                {avatar(a.actor)}
                <p>
                  {activitySentence(a, me, people)}
                  <span className="td-time">{formatDateTime(a.at)}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
        {entries.length > ACTIVITY_PREVIEW && (
          <button type="button" className="link-btn td-link" onClick={() => setAllActivity((v) => !v)}>
            {allActivity ? "Tampilkan yang terbaru saja" : `Tampilkan semua aktivitas (${entries.length})`}
          </button>
        )}
      </section>
    );
  }

  return (
    <RadixDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) void requestClose();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dlg-overlay" />
        <RadixDialog.Content
          ref={contentRef}
          className="td-dlg"
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            const active = document.activeElement;
            if (active === titleRef.current && titleDraft !== null && titleDraft !== task?.title) {
              e.preventDefault();
              setTitleDraft(null);
              titleHeld.settle(task?.title ?? "");
              setTitleProblem(null);
            } else if (active === labelRef.current && labelDraft) {
              e.preventDefault();
              setLabelDraft("");
              setLabelProblem(null);
            } else if (active instanceof HTMLSelectElement && active.dataset.field) {
              // Pilihan lewat panah yang belum disimpan: Escape membatalkannya dulu.
              const field = active.dataset.field as SelectField;
              if (selDraft[field] !== undefined && !inflight.current[field]) {
                e.preventDefault();
                setSelDraft((d) => ({ ...d, [field]: undefined }));
              }
            }
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            // Setelah dihapus, board yang memindahkan fokus (onDeleted).
            if (deleted.current) return;
            if (opener.current?.isConnected) {
              opener.current.focus();
              return;
            }
            // Kartu pembuka bisa sudah dirender ulang di kolom lain setelah status berubah.
            document.querySelector<HTMLElement>(`[data-open-task="${CSS.escape(taskId)}"]`)?.focus();
          }}
        >
          <div className="td-head">
            <RadixDialog.Title className="td-crumb">
              {board && (
                <>
                  <span className="td-project">{board.project.name}</span>
                  <span className="td-sep" aria-hidden="true">
                    /
                  </span>
                </>
              )}
              <span className="td-code">{task?.code ?? "Detail task"}</span>
              {task && <span className="sr-only">: {task.title}</span>}
            </RadixDialog.Title>
            <p className="td-status" aria-live="polite">
              {status}
            </p>
            <button type="button" className="td-close" aria-label="Tutup detail task" onClick={() => void requestClose()}>
              <IconX size={20} aria-hidden="true" />
            </button>
          </div>

          <div aria-live="polite">
            {gone && task && (
              <div className="notice td-gone">
                <IconAlertTriangle size={18} aria-hidden="true" />
                <div>
                  <strong>
                    {GONE_TITLE[gone]}
                  </strong>
                  {gone === "project" && (
                    <p>Anda tidak punya akses lagi ke proyek ini, misalnya karena dikeluarkan dari timnya.</p>
                  )}
                  <p>
                    {keptDrafts(task).length > 0
                      ? "Isian Anda yang belum tersimpan masih ada di bawah. Salin dulu kalau masih perlu."
                      : gone === "revoked"
                        ? "Task tetap bisa dibaca, tapi perubahan tidak bisa disimpan lagi."
                        : "Yang tampil di bawah adalah isi terakhirnya. Perubahan tidak bisa disimpan lagi."}
                  </p>
                  <div className="td-row-actions">
                    <button ref={goneCloseRef} type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
                      Tutup
                    </button>
                  </div>
                </div>
              </div>
            )}
            {unsaved && !gone && (
              <div className="notice td-unsaved">
                <div>
                  <strong>{unsaved}</strong>
                  <div className="td-row-actions">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setUnsaved(null)}>
                      Lanjut mengedit
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
                      Tutup tanpa menyimpan
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {body()}

          {task && (
            <ConfirmDialog
              open={confirmDelete}
              onOpenChange={(open) => {
                if (!open) setConfirmDelete(false);
              }}
              title={`Hapus task ${task.code}?`}
              confirmLabel={`Hapus ${task.code}`}
              busyLabel="Menghapus..."
              busy={deleting}
              onConfirm={() => void deleteTask()}
              error={
                deleteError && (
                  <ErrorAlert
                    title={
                      deleteError.code === "forbidden" || deleteError.code === "not_found"
                        ? errorTitle("title", deleteError)
                        : "Task belum terhapus"
                    }
                  >
                    <p>{deleteError.message}</p>
                  </ErrorAlert>
                )
              }
            >
              <p>
                "{task.title}" hilang dari board proyek dan dari Task saya. Setelah board tersambung ke laptop rekan,
                task ini juga hilang di board mereka. Mira belum punya cara mengembalikannya.
              </p>
            </ConfirmDialog>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
