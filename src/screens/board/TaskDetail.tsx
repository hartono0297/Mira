import * as RadixDialog from "@radix-ui/react-dialog";
import {
  IconAlertTriangle,
  IconCircle,
  IconCircleCheck,
  IconGitMerge,
  IconLock,
  IconProgress,
  IconUserOff,
  IconX,
} from "@tabler/icons-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
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
import { DetailTabs } from "./DetailTabs";
import { DuePicker } from "./DuePicker";
import { dueParts, parseDueInput } from "./dueText";
import { COLUMN_NAMES, COLUMN_ORDER, columnLabel, formatDateTime, PRIORITY_LABELS } from "./format";
import { LabelPicker } from "./LabelPicker";
import { PropertyRow } from "./PropertyRow";
import { Subtasks } from "./Subtasks";
import { activitySentence } from "./taskActivity";
import { TaskKopiThanks } from "./TaskKopiThanks";
import { TaskMoreMenu } from "./TaskMoreMenu";
import { MenuList, type MenuItem } from "./TaskPopover";
import { MAX_LABEL_LEN, MAX_LABELS, TEKS_DIALOG as T, teksDialog } from "./teksDialog";
import { TimeSection } from "./TimeSection";
import { TimerMini } from "./TimerMini";
import { useHeld } from "./useHeld";
import "./field.css";
import "./task.css";

type Field = "title" | "description" | "status" | "assignee" | "due" | "priority" | "labels" | "comment";

// Nama, judul, dan teks lain dari T dibaca saat dipakai (bukan saat modul dimuat)
// supaya mengikuti bahasa aktif.
function fieldName(field: Field): string {
  const names: Record<Field, string> = {
    title: T.judul,
    description: T.deskripsi,
    status: T.status,
    assignee: T.penanggungJawab,
    due: T.tenggat,
    priority: T.prioritas,
    labels: T.label,
    comment: T.komentar,
  };
  return names[field];
}

const PRIORITIES: Priority[] = ["none", "low", "medium", "high"];
const ACTIVITY_PREVIEW = 6;

const STATUS_ICON: Record<ColumnId, typeof IconCircle> = {
  todo: IconCircle,
  doing: IconProgress,
  done: IconCircleCheck,
};

type Props = {
  projectId: string;
  taskId: string;
  onClose: () => void;
  onChanged: () => void;
  // Dipanggil setelah task terhapus, sebelum onClose. Board memindahkan fokus dan mengumumkannya.
  onDeleted?: (taskId: string, code: string) => void;
};

// Nilai properti yang sedang disimpan, tampil lebih dulu (optimistis). "" = dikosongkan.
type PickField = "status" | "assignee" | "priority" | "due";
// Pilihan kecil yang sedang terbuka.
type PopKey = PickField | "labels" | "more";
// Bagian dari komponen lain (subtask, waktu, timer di kepala) yang melapor error lewat onError.
type Section = "subtasks" | "time" | "timer";
type Tab = "comments" | "activity";

// Task atau proyeknya hilang saat muat ulang, biasanya karena perubahan dari laptop lain.
// "revoked": izin mengubah dicabut saat masih ada draf yang belum tersimpan.
type Gone = "task" | "project" | "revoked";

function goneTitle(gone: Gone): string {
  const titles: Record<Gone, string> = {
    task: T.goneTask,
    project: T.goneProject,
    revoked: T.goneRevoked,
  };
  return titles[gone];
}

// Pemberitahuan saat menutup dengan isian yang belum tersimpan. "Lanjut mengedit"
// memindah fokus ke tempat yang perlu diurus.
type Unsaved = { message: string; focus: "failed" | "comment" | "draft" };

function sectionTitle(section: Section): string {
  const titles: Record<Section, string> = {
    subtasks: T.subtaskBelumTersimpan,
    time: T.waktuBelumTersimpan,
    timer: T.timerBelumTersimpan,
  };
  return titles[section];
}

function errorTitle(field: Field, error: AppError): string {
  if (error.code === "forbidden") return T.tidakBerizin;
  if (error.code === "not_found") return T.taskTidakAdaLagi;
  if (field === "comment") return T.komentarBelumTerkirim;
  return teksDialog.belumTersimpan(fieldName(field));
}

// Ketikan yang belum terkirim di subtask, catatan waktu, dan timer ditandai
// data-unsaved="true" oleh komponennya sendiri.
function findUnsaved(root: HTMLElement | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>('[data-unsaved="true"]') ?? null;
}

// WebView2 (Chromium) mendukung field-sizing. Selain itu tinggi diatur lewat skrip.
const FIELD_SIZING =
  typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");

function useAutoHeight(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || FIELD_SIZING) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [ref, value]);
}

export function PriorityChip({ priority }: { priority: Priority }) {
  return <span className={`td-prio td-prio-${priority}`}>{PRIORITY_LABELS[priority]}</span>;
}

// Detail task sebagai dialog modal, satu kolom seperti dokumen (arah A di
// design/v04-detail-task.html). Selalu terbuka selama dipasang; pemanggil
// melepasnya lewat onClose. Fokus terkunci di dalam, fokus kembali ke pembuka.
// Urutan Escape: pulihkan isian yang sedang diubah, tutup pilihan kecil, lalu tutup dialog.
export function TaskDetail({ projectId, taskId, onClose, onChanged, onDeleted }: Props) {
  const [task, setTask] = useState<Task | null>(null);
  const [board, setBoard] = useState<BoardView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Field, AppError>>>({});
  const [sectionErr, setSectionErr] = useState<Partial<Record<Section, string>>>({});
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState<Field | null>(null);

  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [titleProblem, setTitleProblem] = useState<string | null>(null);
  const [descDraft, setDescDraft] = useState<string | null>(null);
  const [dueDraft, setDueDraft] = useState("");
  const [dueProblem, setDueProblem] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [labelProblem, setLabelProblem] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [unsaved, setUnsaved] = useState<Unsaved | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<AppError | null>(null);
  const [allActivity, setAllActivity] = useState(false);
  const [picked, setPicked] = useState<Partial<Record<PickField, string>>>({});
  const [pop, setPop] = useState<PopKey | null>(null);
  const [tab, setTab] = useState<Tab>("comments");
  const [gone, setGone] = useState<Gone | null>(null);
  // Nilai server saat ketikan dimulai. Kalau server berubah selama draf belum
  // disimpan, pengguna diberi tahu sebelum ketikannya menimpa perubahan rekan.
  const [titleBase, setTitleBase] = useState<string | null>(null);
  const [descBase, setDescBase] = useState<string | null>(null);
  const titleHeld = useHeld(task?.title ?? "");
  const descHeld = useHeld(task?.description ?? "");

  const ids = useId();
  const deleted = useRef(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const dueInputRef = useRef<HTMLInputElement>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Fokus yang dipindah setelah render berikutnya, saat elemen tujuannya sudah ada.
  const focusNext = useRef<(() => HTMLElement | null) | null>(null);
  const goneCloseRef = useRef<HTMLButtonElement>(null);
  const anchors: Record<PopKey, RefObject<HTMLButtonElement | null>> = {
    status: useRef<HTMLButtonElement>(null),
    assignee: useRef<HTMLButtonElement>(null),
    priority: useRef<HTMLButtonElement>(null),
    due: useRef<HTMLButtonElement>(null),
    labels: useRef<HTMLButtonElement>(null),
    more: useRef<HTMLButtonElement>(null),
  };
  const hasTask = useRef(false);
  hasTask.current = task !== null;
  const wasEditable = useRef(false);
  wasEditable.current = task?.canEdit === true;
  const hasDrafts = useRef(false);
  hasDrafts.current =
    titleDraft !== null ||
    descDraft !== null ||
    dueDraft.trim() !== "" ||
    labelDraft.trim() !== "" ||
    comment.trim() !== "";
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

  // Muat ulang tidak menyentuh draf (judul, deskripsi, tenggat, label, komentar):
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
      const revokedNow =
        wasEditable.current && !canEditNow && (hasDrafts.current || findUnsaved(contentRef.current) !== null);
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

  useAutoHeight(titleRef, titleDraft ?? titleHeld.value);
  useAutoHeight(descRef, descDraft ?? descHeld.value);

  useLayoutEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    target()?.focus();
  });

  // Pilihan kecil ditutup saat tampilan berganti ke hanya-baca atau task hilang.
  const editable = !!task && task.canEdit && !gone;
  useEffect(() => {
    if (gone) setPop(null);
    else if (!editable) setPop((p) => (p === "more" ? p : null));
  }, [editable, gone]);

  async function run(field: Field, work: () => Promise<Task>, done: string): Promise<boolean> {
    const mine = ++seq.current;
    setPending(field);
    // Kepala hanya mengumumkan hasil. Dikosongkan dulu supaya hasil yang sama
    // ("Prioritas tersimpan.") dibacakan lagi pada simpan berikutnya.
    setStatus("");
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
    run(field, () => boardApi.updateTask(projectId, taskId, patch), teksDialog.tersimpan(fieldName(field)));

  function commitTitle(closing = false): Promise<boolean> {
    return once("title", async () => {
      if (!task || titleDraft === null) return true;
      const submitted = titleDraft;
      const value = submitted.trim();
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
        setTitleProblem(T.judulKosong);
        return false;
      }
      setTitleProblem(null);
      const ok = await update("title", { title: value });
      if (ok && alive.current) {
        // Ketikan yang masuk selama menyimpan tetap ada sebagai draf baru.
        setTitleDraft((d) => (d === submitted ? null : d));
        titleHeld.settle(value);
      }
      return ok;
    });
  }

  function commitDescription(): Promise<boolean> {
    return once("description", async () => {
      if (!task || descDraft === null) return true;
      const submitted = descDraft;
      if (submitted === task.description) {
        setDescDraft((d) => (d === submitted ? null : d));
        descHeld.settle(task.description);
        return true;
      }
      const ok = await update("description", { description: submitted });
      if (ok && alive.current) {
        setDescDraft((d) => (d === submitted ? null : d));
        descHeld.settle(submitted);
      }
      return ok;
    });
  }

  function restoreDescription() {
    setDescDraft(null);
    descHeld.settle(task?.description ?? "");
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
    const ok = (await commitTitle(true)) && (await commitDescription());
    if (!alive.current) return;
    if (!ok) {
      setUnsaved({ message: T.adaYangGagal, focus: "failed" });
      return;
    }
    if (comment.trim()) {
      setUnsaved({ message: T.komentarBelumDikirim, focus: "comment" });
      return;
    }
    if (findUnsaved(contentRef.current)) {
      setUnsaved({ message: T.ketikanBelumDisimpan, focus: "draft" });
      return;
    }
    onClose();
  }

  // "Lanjut mengedit": pemberitahuan ditutup dan fokus pindah ke isian yang
  // belum tersimpan, supaya fokus tidak hilang bersama tombolnya.
  function keepEditing() {
    const kind = unsaved?.focus;
    setUnsaved(null);
    if (kind === "comment") {
      setTab("comments");
      focusNext.current = () => commentRef.current;
    } else if (kind === "draft") {
      focusNext.current = () => findUnsaved(contentRef.current) ?? commentRef.current ?? descRef.current;
    } else {
      focusNext.current = () =>
        (titleDraft !== null ? titleRef.current : null) ??
        (descDraft !== null ? descRef.current : null) ??
        descRef.current;
    }
  }

  function savedPick(t: Task, field: PickField): string {
    if (field === "status") return t.columnId;
    if (field === "assignee") return t.assignee?.publicKey ?? "";
    if (field === "due") return t.due ?? "";
    return t.priority;
  }

  function openPop(key: PopKey) {
    setPop(key);
    if (key === "labels") setLabelProblem(null);
  }

  function closePop(refocus: boolean) {
    const key = pop;
    setPop(null);
    if (refocus && key) anchors[key].current?.focus();
  }

  // Menyimpan pilihan dari daftar. Nilai tujuan tampil selama menyimpan;
  // kalau gagal, baris kembali ke nilai tersimpan dan error tampil di bawahnya.
  function pick(field: PickField, value: string): Promise<boolean> {
    closePop(true);
    return once(field, async () => {
      if (!task) return true;
      if (value === savedPick(task, field)) return true;
      setPicked((d) => ({ ...d, [field]: value }));
      let ok: boolean;
      if (field === "status") ok = await changeStatus(value as ColumnId);
      else if (field === "assignee") ok = await update("assignee", { assignee: value || null });
      else if (field === "due") ok = await update("due", { due: value || null });
      else ok = await update("priority", { priority: value as Priority });
      if (alive.current) setPicked((d) => ({ ...d, [field]: undefined }));
      return ok;
    });
  }

  function changeStatus(columnId: ColumnId): Promise<boolean> {
    return run(
      "status",
      async () => {
        const view = await boardApi.moveTask(projectId, taskId, columnId, 0);
        if (alive.current) setBoard(view);
        return boardApi.getTask(projectId, taskId);
      },
      teksDialog.statusTersimpan(COLUMN_NAMES[columnId]),
    );
  }

  async function submitDue() {
    const parsed = parseDueInput(dueDraft);
    if (parsed.iso === null) {
      setDueProblem(parsed.problem);
      dueInputRef.current?.focus();
      return;
    }
    setDueProblem(null);
    const ok = await pick("due", parsed.iso);
    if (ok && alive.current) setDueDraft("");
  }

  async function addLabel() {
    if (!task) return;
    const value = labelDraft.trim();
    if (!value) return;
    if (value.length > MAX_LABEL_LEN) {
      setLabelProblem(teksDialog.labelTerlaluPanjang());
      return;
    }
    if (task.labels.length >= MAX_LABELS) {
      setLabelProblem(teksDialog.sudahBanyakLabel());
      return;
    }
    if (task.labels.some((l) => l.toLowerCase() === value.toLowerCase())) {
      setLabelProblem(teksDialog.labelSudahAda(value));
      return;
    }
    setLabelProblem(null);
    const ok = await update("labels", { labels: [...task.labels, value] });
    if (ok && alive.current) setLabelDraft("");
  }

  async function toggleLabel(label: string, on: boolean) {
    if (!task) return;
    setLabelProblem(null);
    if (on && task.labels.length >= MAX_LABELS) {
      setLabelProblem(teksDialog.sudahBanyakLabel());
      return;
    }
    const next = on ? [...task.labels, label] : task.labels.filter((l) => l !== label);
    await update("labels", { labels: next });
  }

  async function sendComment() {
    const body = comment.trim();
    if (!body || pending === "comment") return;
    const ok = await run("comment", () => boardApi.addComment(projectId, taskId, body), T.komentarTerkirim);
    if (ok && alive.current) {
      setComment((c) => (c.trim() === body ? "" : c));
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

  // Subtask, waktu, dan timer menyimpan sendiri lalu mengirim TaskDetail baru dari inti.
  // Draf di dialog ini tidak disentuh.
  function childChange(section: Section) {
    return (next: Task) => {
      apply(++seq.current, next);
      setSectionErr((s) => ({ ...s, [section]: undefined }));
      onChangedRef.current();
    };
  }

  function childError(section: Section) {
    return (message: string) => {
      if (alive.current) setSectionErr((s) => ({ ...s, [section]: message }));
    };
  }

  // Wilayah aria-live selalu dipasang supaya error yang muncul belakangan ikut dibacakan.
  function fieldError(field: Field, keepsInput = false) {
    const err = errors[field];
    return (
      <div className="td-live" aria-live="polite">
        {err && (
          <ErrorAlert title={errorTitle(field, err)}>
            <p>{err.message}</p>
            {keepsInput && err.code !== "forbidden" && err.code !== "not_found" && <p>{T.isianMasihAda}</p>}
          </ErrorAlert>
        )}
      </div>
    );
  }

  function sectionAlert(section: Section) {
    const message = sectionErr[section];
    return (
      <div className="td-live" aria-live="polite">
        {message && (
          <ErrorAlert title={sectionTitle(section)}>
            <p>{message}</p>
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
  const nameOf = (p: Person) => teksDialog.namaOrang(p.name, p.publicKey === me);
  // Penanggung jawab yang sudah bukan anggota proyek (misalnya dikeluarkan dari
  // proyek) tetap tampil dengan keterangan, supaya tidak hilang diam-diam.
  const isFormer = (p: Person | null) => !!p && !!board && !people.some((x) => x.publicKey === p.publicKey);
  // Satu pasang kurung saja: "Budi (bukan anggota proyek lagi)", "Budi (Anda, bukan anggota proyek lagi)".
  const assigneeName = (p: Person) => teksDialog.namaOrang(p.name, p.publicKey === me, isFormer(p));

  function avatar(p: Person, small = false) {
    return (
      <span className={`td-av${small ? " td-av-sm" : ""}`} aria-hidden="true">
        {initials(p.name)}
      </span>
    );
  }

  function body() {
    if (loading && !task) {
      return (
        <p className="hint" role="status">
          {T.memuatTask}
        </p>
      );
    }
    if (!task) {
      const isGone = loadError?.code === "not_found";
      return (
        <div role="alert">
          <ErrorAlert title={isGone ? T.taskTidakAdaLagi : T.taskBelumTerbaca}>
            <p>{loadError?.message ?? T.intiTidakMengirim}</p>
            <p>{isGone ? T.mungkinSudahDihapus : T.cobaBacaLagi}</p>
            <div className="td-row-actions">
              {!isGone && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setLoading(true);
                    void load();
                  }}
                >
                  {T.cobaLagi}
                </button>
              )}
              <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
                {T.tutupSingkat}
              </button>
            </div>
          </ErrorAlert>
        </div>
      );
    }
    return doc(task, gone ? "gone" : task.canEdit ? "edit" : "read");
  }

  function topNotes(t: Task) {
    return (
      <>
        {t.merged && (
          <p className="td-merged">
            <IconGitMerge size={16} aria-hidden="true" />
            <span>
              <strong>{T.sudahDigabung}</strong> {T.sudahDigabungIsi}
            </span>
          </p>
        )}
        {loadError && <p className="hint">{teksDialog.dataLama(loadError.message)}</p>}
      </>
    );
  }

  // Isian yang belum tersimpan saat task hilang. Ditampilkan sebagai teks yang
  // bisa dipilih dan disalin, karena tidak ada lagi tempat untuk menyimpannya.
  function keptDrafts(t: Task): { key: string; label: string; text: string }[] {
    const list = [
      {
        key: "title",
        label: T.judul,
        text: titleDraft !== null && titleDraft.trim() !== t.title ? titleDraft : "",
      },
      {
        key: "desc",
        label: T.deskripsi,
        text: descDraft !== null && descDraft !== t.description ? descDraft : "",
      },
      { key: "label", label: T.labelBaru, text: labelDraft.trim() },
      {
        key: "comment",
        label: T.komentar,
        text: comment.trim() ? comment : "",
      },
    ];
    return list.filter((d) => d.text !== "");
  }

  function readOnlyNote(t: Task) {
    return t.canComment ? T.bisaKomentarSaja : T.lihatSaja;
  }

  function doc(t: Task, mode: "edit" | "read" | "gone") {
    const edit = mode === "edit";
    const kept = mode === "gone" ? keptDrafts(t) : [];
    return (
      <>
        <div className="td-top">
          {mode !== "gone" && topNotes(t)}
          {mode === "read" && (
            <p className="td-readonly-note">
              <IconLock size={16} data-icon="lock" aria-hidden="true" />
              <span>{readOnlyNote(t)}</span>
            </p>
          )}
          {kept.length > 0 && (
            <section className="td-kept" aria-labelledby={`${ids}-kept`}>
              <h3 id={`${ids}-kept`} className="td-sh">
                {T.drafJudul}
              </h3>
              <p className="hint">{T.drafPetunjuk}</p>
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
          {edit ? titleEditor(t) : <p className="td-title-text">{t.title}</p>}
          {properties(t, edit)}
          {mode !== "gone" && <TaskKopiThanks projectId={projectId} task={t} me={me} />}
          {/* Keterangan, bukan isian: tanpa bingkai, gembok menandai tidak bisa diubah. */}
          <p className="td-ro">
            <IconLock size={14} data-icon="lock" aria-hidden="true" />
            <span>
              {teksDialog.dibuatOleh(
                t.createdBy.publicKey === me ? T.anda : t.createdBy.name,
                formatDateTime(t.createdAt),
              )}
            </span>
          </p>
        </div>
        <div className="td-slot">
          <Subtasks
            task={t}
            me={me}
            assignees={people}
            canEdit={edit}
            onChange={childChange("subtasks")}
            onError={childError("subtasks")}
          />
          {sectionAlert("subtasks")}
        </div>
        {description(t, edit)}
        <div className="td-slot">
          <TimeSection task={t} me={me} canEdit={edit} onChange={childChange("time")} onError={childError("time")} />
          {sectionAlert("time")}
        </div>
        {talk(t, mode !== "gone")}
      </>
    );
  }

  function titleEditor(t: Task) {
    const titleValue = titleDraft ?? titleHeld.value;
    const titleMoved =
      titleDraft !== null && titleBase !== null && t.title !== titleBase && titleDraft.trim() !== t.title;
    return (
      <div className="td-field">
        <textarea
          ref={titleRef}
          className="td-title"
          rows={1}
          value={titleValue}
          maxLength={200}
          aria-label={T.judulTask}
          aria-invalid={titleProblem ? true : undefined}
          aria-describedby={titleProblem ? `${ids}-title-err` : undefined}
          onFocus={titleHeld.hold}
          onChange={(e) => {
            if (titleDraft === null) setTitleBase(titleValue);
            // Judul satu baris: baris baru dari tempelan diganti spasi.
            setTitleDraft(e.target.value.replace(/\r?\n/g, " "));
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
          {titleMoved && <p className="td-moved">{teksDialog.judulDiubahRekan(t.title)}</p>}
        </div>
        {fieldError("title", true)}
      </div>
    );
  }

  // Label lain yang sudah dipakai di proyek ini, untuk dicentang tanpa mengetik ulang.
  function projectLabels(): string[] {
    const seen = new Map<string, string>();
    for (const c of board?.columns ?? []) {
      for (const card of c.tasks) {
        for (const l of card.labels) if (!seen.has(l.toLowerCase())) seen.set(l.toLowerCase(), l);
      }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, "id"));
  }

  function properties(t: Task, edit: boolean) {
    const now = new Date();
    const shown = (field: PickField) => picked[field] ?? savedPick(t, field);
    const columnId = shown("status") as ColumnId;
    const priority = shown("priority") as Priority;
    const dueIso = shown("due");
    const assigneeKey = shown("assignee");
    const assignee =
      assigneeKey === ""
        ? null
        : (people.find((p) => p.publicKey === assigneeKey) ??
          (t.assignee?.publicKey === assigneeKey ? t.assignee : { publicKey: assigneeKey, name: T.anggotaLain }));
    const columns =
      board?.columns.map((c) => ({ id: c.id, name: columnLabel(c.id, c.name) })) ??
      COLUMN_ORDER.map((id) => ({ id, name: COLUMN_NAMES[id] }));
    const columnName = columns.find((c) => c.id === columnId)?.name ?? COLUMN_NAMES[columnId] ?? columnId;
    const StatusIcon = STATUS_ICON[columnId] ?? IconCircle;

    const editor = (key: PopKey, popup: "menu" | "dialog", content: () => ReactNode) =>
      edit
        ? {
            popup,
            open: pop === key,
            buttonRef: anchors[key],
            onOpen: () => openPop(key),
            onClose: () => setPop((p) => (p === key ? null : p)),
            content: pop === key ? content() : null,
          }
        : undefined;

    const empty = (text: string) => <span className="td-pv-empty">{text}</span>;

    const statusValue = (
      <>
        <StatusIcon size={17} className="td-pv-ic" aria-hidden="true" />
        <span>{columnName}</span>
      </>
    );
    const priorityValue =
      priority === "none" ? empty(PRIORITY_LABELS.none) : <PriorityChip priority={priority} />;
    const assigneeValue = assignee ? (
      <>
        {avatar(assignee, true)}
        <span>{assigneeName(assignee)}</span>
      </>
    ) : (
      empty(T.belumAda)
    );
    let dueValue = empty(edit ? T.belumAda : T.tanpaTenggat);
    if (dueIso) {
      const d = dueParts(dueIso, now);
      dueValue = (
        <>
          <span>{d.date}</span>
          {d.rel && (
            <>
              <span className="td-pv-sub" aria-hidden="true">
                ·
              </span>
              <span className={`td-pv-sub${d.late ? " td-late" : ""}`}>{d.rel}</span>
            </>
          )}
        </>
      );
    }
    const labelsValue =
      t.labels.length > 0 ? (
        <span className="td-chips">
          {/* Koma tersembunyi dan spasi: nama tombol terbaca "kontrak, legal", bukan "kontraklegal". */}
          {t.labels.map((l, i) => (
            <Fragment key={l}>
              {i > 0 && (
                <>
                  <span className="sr-only">,</span>{" "}
                </>
              )}
              <span className="td-lbl">{l}</span>
            </Fragment>
          ))}
        </span>
      ) : (
        empty(edit ? T.belumAda : T.tidakAdaLabel)
      );

    const assigneeItems = (): MenuItem[] => {
      const items: MenuItem[] = people.map((p) => ({
        value: p.publicKey,
        label: nameOf(p),
        icon: avatar(p, true),
      }));
      if (t.assignee && isFormer(t.assignee)) {
        items.unshift({
          value: t.assignee.publicKey,
          label: assigneeName(t.assignee),
          icon: avatar(t.assignee, true),
        });
      }
      items.push({
        value: "",
        label: T.tanpaPenanggungJawab,
        icon: <IconUserOff size={17} aria-hidden="true" />,
      });
      return items;
    };

    return (
      <div role="group" aria-label={T.rincianTask}>
        <dl className="td-props">
          <PropertyRow
            label={T.status}
            value={statusValue}
            editor={editor("status", "menu", () => (
              <MenuList
                label={T.status}
                checked={columnId}
                items={columns.map((c) => {
                  const Icon = STATUS_ICON[c.id] ?? IconCircle;
                  return {
                    value: c.id,
                    label: c.name,
                    icon: <Icon size={17} aria-hidden="true" />,
                  };
                })}
                onPick={(v) => void pick("status", v)}
              />
            ))}
          />
          <PropertyRow
            label={T.prioritas}
            value={priorityValue}
            editor={editor("priority", "menu", () => (
              <MenuList
                label={T.prioritas}
                checked={priority}
                items={PRIORITIES.map((p) => ({
                  value: p,
                  label: PRIORITY_LABELS[p],
                }))}
                onPick={(v) => void pick("priority", v)}
              />
            ))}
          />
          <PropertyRow
            label={T.penanggungJawab}
            value={assigneeValue}
            editor={editor("assignee", "menu", () => (
              <MenuList
                label={T.penanggungJawab}
                checked={assigneeKey}
                items={assigneeItems()}
                onPick={(v) => void pick("assignee", v)}
              />
            ))}
          />
          <PropertyRow
            label={T.tenggat}
            icon="calendar"
            value={dueValue}
            editor={editor("due", "dialog", () => (
              <DuePicker
                value={dueIso || null}
                draft={dueDraft}
                problem={dueProblem}
                inputRef={dueInputRef}
                now={now}
                onDraft={(text) => {
                  setDueDraft(text);
                  setDueProblem(null);
                }}
                onPick={(iso) => {
                  setDueDraft("");
                  setDueProblem(null);
                  void pick("due", iso ?? "");
                }}
                onSubmitDraft={() => void submitDue()}
              />
            ))}
          />
          <PropertyRow
            label={T.label}
            wide
            icon="plus"
            value={labelsValue}
            editor={editor("labels", "dialog", () => (
              <LabelPicker
                current={t.labels}
                known={projectLabels()}
                draft={labelDraft}
                problem={labelProblem}
                busy={pending === "labels"}
                inputRef={labelInputRef}
                onToggle={(l, on) => void toggleLabel(l, on)}
                onDraft={(text) => {
                  setLabelDraft(text);
                  setLabelProblem(null);
                }}
                onAdd={() => void addLabel()}
              />
            ))}
          />
        </dl>
        {edit && (
          <>
            {fieldError("status")}
            {fieldError("priority")}
            {fieldError("assignee")}
            {fieldError("due")}
            {fieldError("labels", true)}
          </>
        )}
      </div>
    );
  }

  function description(t: Task, edit: boolean) {
    const headId = `${ids}-desc-h`;
    if (!edit) {
      return (
        <section className="td-sec">
          <h3 className="td-sh" id={headId}>
            {T.deskripsi}
          </h3>
          {t.description ? (
            <p className="td-pre">{t.description}</p>
          ) : (
            <p className="td-empty">{T.belumAdaDeskripsi}</p>
          )}
        </section>
      );
    }
    const descValue = descDraft ?? descHeld.value;
    const descDirty = descDraft !== null && descDraft !== t.description;
    const descMoved = descDirty && descBase !== null && t.description !== descBase;
    return (
      <section className="td-sec">
        <h3 className="td-sh" id={headId}>
          {T.deskripsi}
        </h3>
        <textarea
          ref={descRef}
          className="td-desc td-box td-box-text"
          aria-labelledby={headId}
          value={descValue}
          placeholder={T.deskripsiPlaceholder}
          onFocus={descHeld.hold}
          onBlur={descHeld.release}
          onChange={(e) => {
            if (descDraft === null) setDescBase(descValue);
            setDescDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.ctrlKey) {
              e.preventDefault();
              void commitDescription();
            }
          }}
        />
        <div className="td-live" aria-live="polite">
          {descMoved && <p className="td-moved">{T.deskripsiDiubahRekan}</p>}
        </div>
        {descDirty && (
          <div className="td-row-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={pending === "description"}
              aria-busy={pending === "description" || undefined}
              onClick={() => {
                // Tombol ini hilang setelah tersimpan, jadi fokus pindah ke deskripsi lebih dulu.
                descRef.current?.focus();
                void commitDescription();
              }}
            >
              {pending === "description" ? T.menyimpan : T.simpanDeskripsi}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={pending === "description"}
              onClick={() => {
                descRef.current?.focus();
                restoreDescription();
              }}
            >
              {T.batalkanPerubahan}
            </button>
            <span className="hint">{T.ctrlEnterMenyimpan}</span>
          </div>
        )}
        {fieldError("description", true)}
      </section>
    );
  }

  function talk(t: Task, live: boolean) {
    const entries = t.activity
      .filter((a) => a.kind !== "commented")
      .map((a, i) => ({ a, i }))
      .sort((x, y) => (x.a.at === y.a.at ? y.i - x.i : x.a.at < y.a.at ? 1 : -1));
    return (
      <DetailTabs
        label={T.komentarDanAktivitas}
        tabs={[
          { id: "comments", label: T.tabKomentar, count: t.comments.length },
          { id: "activity", label: T.tabAktivitas, count: entries.length },
        ]}
        active={tab}
        onChange={(id) => setTab(id as Tab)}
      >
        {tab === "comments" ? comments(t, live) : activity(entries)}
      </DetailTabs>
    );
  }

  function comments(t: Task, live: boolean) {
    const sending = pending === "comment";
    const canWrite = live && t.canComment === true;
    return (
      <>
        {t.comments.length === 0 ? (
          <p className="td-empty">{canWrite ? T.belumAdaKomentarTulis : T.belumAdaKomentar}</p>
        ) : (
          <ul className="td-list">
            {t.comments.map((c) => (
              <li key={c.id} className="td-comment">
                {avatar(c.author)}
                <div className="td-entry">
                  <p className="td-entry-head">
                    <strong>{nameOf(c.author)}</strong>
                    <span className="td-time">{formatDateTime(c.at)}</span>
                  </p>
                  <p className="td-pre td-ctext">{c.body}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <div className="td-composer">
            <label htmlFor={`${ids}-comment`} className="sr-only">
              {T.tulisKomentar}
            </label>
            <textarea
              ref={commentRef}
              id={`${ids}-comment`}
              className="td-textarea"
              rows={2}
              placeholder={T.tulisKomentar}
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
            <div className="td-row-actions td-composer-row">
              <span className="hint" id={`${ids}-comment-hint`}>
                {T.ctrlEnterMengirim}
              </span>
              <button
                type="button"
                className="btn btn-sm td-send"
                disabled={!comment.trim() || sending}
                aria-busy={sending || undefined}
                onClick={() => void sendComment()}
              >
                {sending ? T.mengirim : T.kirim}
              </button>
            </div>
            {fieldError("comment", true)}
          </div>
        )}
      </>
    );
  }

  function activity(entries: { a: Task["activity"][number]; i: number }[]) {
    const shown = allActivity ? entries : entries.slice(0, ACTIVITY_PREVIEW);
    return (
      <>
        {entries.length === 0 ? (
          <p className="td-empty">{T.belumAdaAktivitas}</p>
        ) : (
          <ul className="td-list td-acts">
            {shown.map(({ a, i }) => (
              <li key={`${a.at}-${i}`} className="td-log">
                {avatar(a.actor, true)}
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
            {allActivity ? T.aktivitasTerbaru : teksDialog.semuaAktivitas(entries.length)}
          </button>
        )}
      </>
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
        {/* Overlay sendiri (z-index 49) supaya konfirmasi hapus (.dlg-overlay 50) menutupi dialog ini. */}
        <RadixDialog.Overlay className="td-overlay" />
        <RadixDialog.Content
          ref={contentRef}
          className="td-dlg"
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            const active = document.activeElement as HTMLElement | null;
            // 1. Bagian yang menangani Escape-nya sendiri, misalnya judul subtask yang sedang
            //    diubah atau menu di dalam bagian Subtask. Radix mendengar Escape lebih dulu
            //    (fase capture), jadi atributnya masih terpasang saat diperiksa di sini.
            if (active?.closest("[data-escape-local]")) {
              e.preventDefault();
              return;
            }
            // 2. Pulihkan isian yang sedang diubah.
            if (active && active === titleRef.current && titleDraft !== null && titleDraft !== task?.title) {
              e.preventDefault();
              setTitleDraft(null);
              titleHeld.settle(task?.title ?? "");
              setTitleProblem(null);
              return;
            }
            if (active && active === descRef.current && descDraft !== null && descDraft !== task?.description) {
              e.preventDefault();
              restoreDescription();
              return;
            }
            if (active && active === labelInputRef.current && labelDraft) {
              e.preventDefault();
              setLabelDraft("");
              setLabelProblem(null);
              return;
            }
            if (active && active === dueInputRef.current && dueDraft) {
              e.preventDefault();
              setDueDraft("");
              setDueProblem(null);
              return;
            }
            // 3. Tutup pilihan kecil, fokus kembali ke tombolnya.
            if (pop) {
              e.preventDefault();
              closePop(true);
            }
            // 4. Selain itu Radix menutup dialog (lewat requestClose).
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
                  <span aria-hidden="true">/</span>
                </>
              )}
              <span className="td-code">{task?.code ?? T.judulDialogCadangan}</span>
              {task && <span className="sr-only">: {task.title}</span>}
            </RadixDialog.Title>
            <p className="td-status" aria-live="polite">
              {status}
            </p>
            {task && !gone && (
              <TimerMini
                task={task}
                me={me}
                canEdit={task.canEdit}
                onChange={childChange("timer")}
                onError={childError("timer")}
              />
            )}
            {task && !gone && task.canDelete && (
              <TaskMoreMenu
                open={pop === "more"}
                buttonRef={anchors.more}
                onOpenChange={(open) => setPop(open ? "more" : null)}
                onDelete={() => {
                  // Fokus ke Lainnya dulu, supaya konfirmasi mengembalikan fokus ke sana saat Batal.
                  setPop(null);
                  anchors.more.current?.focus();
                  setDeleteError(null);
                  setConfirmDelete(true);
                }}
              />
            )}
            <button type="button" className="td-icon-btn" aria-label={T.tutup} onClick={() => void requestClose()}>
              <IconX size={20} aria-hidden="true" />
            </button>
          </div>

          {/* Satu wilayah aria-live untuk keterangan task hilang dan isian belum tersimpan.
              Pesan timer punya wilayahnya sendiri (sectionAlert), jadi tidak dibungkus live lagi. */}
          <div className="td-notices">
            <div className="td-live" aria-live="polite">
              {gone && task && (
                <div className="notice td-gone">
                  <IconAlertTriangle size={18} aria-hidden="true" />
                  <div>
                    <strong>{goneTitle(gone)}</strong>
                    {gone === "project" && <p>{T.goneProjectSebab}</p>}
                    <p>
                      {keptDrafts(task).length > 0
                        ? T.goneAdaDraf
                        : gone === "revoked"
                          ? T.goneRevokedIsi
                          : T.goneIsiTerakhir}
                    </p>
                    <div className="td-row-actions">
                      <button ref={goneCloseRef} type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
                        {T.tutupSingkat}
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {unsaved && !gone && (
                <div className="notice td-unsaved">
                  <div>
                    <strong>{unsaved.message}</strong>
                    <div className="td-row-actions">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={keepEditing}>
                        {T.lanjutMengedit}
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
                        {T.tutupTanpaMenyimpan}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
            {!gone && sectionAlert("timer")}
          </div>

          <div className="td-body">
            <div className="td-doc">{body()}</div>
          </div>

          {task && (
            <ConfirmDialog
              open={confirmDelete}
              onOpenChange={(open) => {
                if (!open) setConfirmDelete(false);
              }}
              title={teksDialog.hapusJudul(task.code)}
              confirmLabel={teksDialog.hapusTombol(task.code)}
              busyLabel={T.menghapus}
              busy={deleting}
              onConfirm={() => void deleteTask()}
              error={
                deleteError && (
                  <ErrorAlert
                    title={
                      deleteError.code === "forbidden" || deleteError.code === "not_found"
                        ? errorTitle("title", deleteError)
                        : T.taskBelumTerhapus
                    }
                  >
                    <p>{deleteError.message}</p>
                  </ErrorAlert>
                )
              }
            >
              <p>
                {teksDialog.hapusIsi(
                  task.title,
                  task.subtasks?.length ?? 0,
                  task.comments.length,
                  task.timeEntries?.length ?? 0,
                )}
              </p>
            </ConfirmDialog>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
