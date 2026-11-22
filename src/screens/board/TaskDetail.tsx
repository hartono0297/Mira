import * as RadixDialog from "@radix-ui/react-dialog";
import { IconGitMerge, IconTrash, IconX } from "@tabler/icons-react";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
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
export function TaskDetail({ projectId, taskId, onClose, onChanged }: Props) {
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

  const ids = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const dueRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
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

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [t, b] = await Promise.all([boardApi.getTask(projectId, taskId), boardApi.getBoard(projectId)]);
      if (!alive.current) return;
      apply(mine, t);
      setBoard(b);
      setLoadError(null);
    } catch (err) {
      if (alive.current) setLoadError(toAppError(err));
    } finally {
      if (alive.current) setLoading(false);
    }
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
      if (ok && alive.current) setTitleDraft(null);
      return ok;
    });
  }

  function commitDescription(): Promise<boolean> {
    return once("description", async () => {
      if (!task || descDraft === null) return true;
      if (descDraft === task.description) {
        setDescDraft(null);
        return true;
      }
      const ok = await update("description", { description: descDraft });
      if (ok && alive.current) setDescDraft(null);
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
        return true;
      }
      const ok = await update("due", { due: value });
      if (ok && alive.current) setDueDraft(null);
      return ok;
    });
  }

  async function requestClose() {
    if (!task) {
      onClose();
      return;
    }
    const ok = (await commitTitle(true)) && (await commitDescription()) && (await commitDue());
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

  async function changeStatus(columnId: ColumnId) {
    await run(
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
      onChangedRef.current();
      onClose();
    } catch (err) {
      if (alive.current) setDeleteError(toAppError(err));
    } finally {
      if (alive.current) setDeleting(false);
    }
  }

  function fieldError(field: Field, keepsInput = false) {
    const err = errors[field];
    if (!err) return null;
    return (
      <ErrorAlert title={errorTitle(field, err)}>
        <p>{err.message}</p>
        {keepsInput && err.code !== "forbidden" && err.code !== "not_found" && <p>Isian Anda masih ada. Coba lagi.</p>}
      </ErrorAlert>
    );
  }

  const me = board?.me ?? "";
  const people: Person[] = board?.assignees ?? [];
  const nameOf = (p: Person) => (p.publicKey === me ? `${p.name} (Anda)` : p.name);

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
    const titleValue = titleDraft ?? t.title;
    const descValue = descDraft ?? t.description;
    const descDirty = descDraft !== null && descDraft !== t.description;
    const dueValue = dueDraft ?? t.due ?? "";
    const assigneeKnown = t.assignee === null || people.some((p) => p.publicKey === t.assignee?.publicKey);
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
              onChange={(e) => {
                setTitleDraft(e.target.value);
                setTitleProblem(null);
              }}
              onBlur={() => void commitTitle()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitTitle();
                }
              }}
            />
            {titleProblem && (
              <div id={`${ids}-title-err`}>
                <FieldError text={titleProblem} />
              </div>
            )}
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
              onChange={(e) => setDescDraft(e.target.value)}
              onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
                if (e.key === "Enter" && e.ctrlKey) {
                  e.preventDefault();
                  void commitDescription();
                }
              }}
            />
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
                  onClick={() => setDescDraft(null)}
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
            <select
              id={`${ids}-status`}
              className="td-input"
              value={t.columnId}
              onChange={(e) => void changeStatus(e.target.value as ColumnId)}
            >
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
            <select
              id={`${ids}-assignee`}
              className="td-input"
              value={t.assignee?.publicKey ?? ""}
              onChange={(e) => void update("assignee", { assignee: e.target.value || null })}
            >
              <option value="">Belum ada</option>
              {!assigneeKnown && t.assignee && <option value={t.assignee.publicKey}>{nameOf(t.assignee)}</option>}
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
              onChange={(e) => {
                setDueDraft(e.target.value);
                setDueProblem(null);
              }}
              onBlur={() => void commitDue()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitDue();
                }
              }}
            />
            {dueDraft === null && dueHint(t.due)}
            {dueProblem && (
              <div id={`${ids}-due-err`}>
                <FieldError text={dueProblem} />
              </div>
            )}
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
            <select
              id={`${ids}-prio`}
              className="td-input"
              value={t.priority}
              onChange={(e) => void update("priority", { priority: e.target.value as Priority })}
            >
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
                  aria-describedby={`${ids}-labels-hint`}
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
            {labelProblem && <FieldError text={labelProblem} />}
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

  function readOnly(t: Task) {
    return (
      <div className="td-grid">
        <div className="td-top">
          {topNotes(t)}
          <p className="td-readonly-note">
            Anda hanya bisa melihat task ini. Mengubah dan mengomentari task butuh peran anggota aktif di organisasi,
            bukan tamu.
          </p>
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
              <dd>{t.assignee ? nameOf(t.assignee) : "Belum ada"}</dd>
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
          {sideFooter(t)}
        </aside>
        <div className="td-bottom">
          {comments(t)}
          {activity(t)}
        </div>
      </div>
    );
  }

  function sideFooter(t: Task) {
    return (
      <div className="td-side-foot">
        <p className="hint">
          Dibuat oleh {t.createdBy.publicKey === me ? "Anda" : t.createdBy.name}, {formatDateTime(t.createdAt)}
        </p>
        {t.canDelete && (
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

  function comments(t: Task) {
    const sending = pending === "comment";
    return (
      <section className="td-section" aria-labelledby={`${ids}-comments`}>
        <h3 id={`${ids}-comments`} className="td-sh">
          Komentar {t.comments.length > 0 && <span className="td-count">{t.comments.length}</span>}
        </h3>
        {t.comments.length === 0 ? (
          <p className="hint">{t.canEdit ? "Belum ada komentar. Tulis yang pertama di bawah." : "Belum ada komentar."}</p>
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
        {t.canEdit && (
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
          className="td-dlg"
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            const active = document.activeElement;
            if (active === titleRef.current && titleDraft !== null && titleDraft !== task?.title) {
              e.preventDefault();
              setTitleDraft(null);
              setTitleProblem(null);
            } else if (active === labelRef.current && labelDraft) {
              e.preventDefault();
              setLabelDraft("");
              setLabelProblem(null);
            }
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (opener.current?.isConnected) opener.current.focus();
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
            {unsaved && (
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
