// Bagian Subtask di dialog detail task (design/v04-detail-task.html, arah A).
// Komponen memanggil boardApi sendiri dan meneruskan TaskDetail hasilnya ke
// onChange. Semua perubahan dikirim satu per satu lewat satu antrean, jadi dua
// perubahan tidak pernah berjalan bersamaan; kontrol subtask yang sedang
// menunggu dinonaktifkan (aria-disabled, supaya fokus tidak hilang).
//
// Baris yang bisa diubah punya menu klik kanan (juga Shift+F10 dan tombol Menu)
// berisi aksi yang sama dengan kontrol di baris. Klik kanan di kolom judul tetap
// memberi menu teks global. Menu baris tidak dibuka selama baris diseret atau
// dari dalam menu penanggung jawab.
//
// Escape di bagian ini tidak menutup dialog selama ada yang bisa dibatalkan:
// judul dengan ketikan atau judul yang dibuka lewat Ganti nama (data-escape-local,
// ditangani TaskDetail), isian subtask baru, dan menu penanggung jawab
// (useLocalEscape). Isian dengan ketikan yang belum terkirim ditandai
// data-unsaved supaya dialog memperingatkan sebelum tutup.
import {
  IconArrowDown,
  IconArrowUp,
  IconGripVertical,
  IconPencil,
  IconPlus,
  IconSquare,
  IconSquareCheck,
  IconTrash,
  IconUserPlus,
} from "@tabler/icons-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { toAppError } from "../../api";
import { boardApi, type Person, type Subtask, type TaskDetail } from "../../api/board";
import { menuItems, SEPARATOR } from "../../components/ContextMenu";
import { initials } from "../../components/initials";
import { MenuList, Popover, type MenuItem } from "./TaskPopover";
import { useLocalEscape } from "./TimerMini";
import { TEKS_MENU } from "./teksMenu";
import { SUBTASK_MAX, SUBTASK_TITLE_MAX, teksSubtask as T } from "./teksSubtask";
import { boardMenuItems, submenu, useBoardMenu, type BoardMenuEntry } from "./useBoardMenu";
import { useListDrag } from "./useListDrag";
import "./subtasks.css";

export type SubtasksProps = {
  task: TaskDetail;
  me: string;
  assignees: Person[];
  canEdit: boolean;
  onChange: (next: TaskDetail) => void;
  onError: (message: string) => void;
};

type Part = "title" | "check" | "who" | "del";
type FocusTarget = { id: string; part: Part } | { id: null; part: "add" | "new" };

function findRow(root: HTMLElement | null, id: string): HTMLElement | null {
  if (!root) return null;
  return Array.from(root.querySelectorAll<HTMLElement>("[data-row-id]")).find((el) => el.dataset.rowId === id) ?? null;
}

export function Subtasks({ task, me, assignees, canEdit, onChange, onError }: SubtasksProps) {
  const ids = useId();
  const headId = `${ids}-h`;
  const hintId = `${ids}-hint`;
  const titleErrId = `${ids}-titleerr`;
  const newHintId = `${ids}-newhint`;
  const newErrId = `${ids}-newerr`;

  // Ketikan judul per subtask. Selalu menang atas data dari rekan sampai disimpan atau dibatalkan.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  // Jumlah perubahan yang menunggu per subtask.
  const [busy, setBusy] = useState<Record<string, number>>({});
  // Centang yang sedang dikirim, ditampilkan langsung.
  const [doneShown, setDoneShown] = useState<Record<string, boolean>>({});
  // Urutan sementara selama pindah dikirim.
  const [order, setOrder] = useState<string[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newError, setNewError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // Subtask yang kolom judulnya dibuka lewat Ganti nama di menu, sampai kolom itu
  // kehilangan fokus. Escape di sana hanya keluar dari kolom, tidak menutup dialog.
  const [renaming, setRenaming] = useState<string | null>(null);
  // Subtask yang judulnya baru saja dikosongkan: pesan tampil di bawah barisnya sampai diketik lagi.
  const [emptiedId, setEmptiedId] = useState<string | null>(null);
  const [live, setLive] = useState("");

  const alive = useRef(true);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pendingMoves = useRef(0);
  const sentTitle = useRef<Record<string, string>>({});
  const focusNext = useRef<FocusTarget | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const newRef = useRef<HTMLDivElement>(null);
  const taskRef = useRef(task);
  taskRef.current = task;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const rows = useMemo(() => {
    if (!order) return task.subtasks;
    const pos = new Map(order.map((id, i) => [id, i]));
    const far = Number.MAX_SAFE_INTEGER;
    return [...task.subtasks].sort((a, b) => (pos.get(a.id) ?? far) - (pos.get(b.id) ?? far));
  }, [task.subtasks, order]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const isDone = (s: Subtask) => doneShown[s.id] ?? s.done;
  const doneCount = rows.filter(isDone).length;
  const total = rows.length;

  // Fokus ke baris atau tombol tujuan setelah daftar dirender ulang.
  useLayoutEffect(() => {
    const f = focusNext.current;
    const root = sectionRef.current;
    if (!f || !root) return;
    const el =
      f.id === null
        ? root.querySelector<HTMLElement>(`[data-part="${f.part}"]`)
        : findRow(root, f.id)?.querySelector<HTMLElement>(`[data-part="${f.part}"]`) ?? null;
    if (!el) return;
    focusNext.current = null;
    if (document.activeElement !== el) el.focus();
  });

  // Pengumuman untuk pembaca layar. Spasi tak terputus bergantian supaya
  // kalimat yang sama tetap diumumkan lagi.
  function say(text: string) {
    if (!alive.current) return;
    setLive((prev) => (prev === text ? `${text} ` : text));
  }

  function bump(key: string, by: number) {
    if (!alive.current) return;
    setBusy((b) => {
      const n = (b[key] ?? 0) + by;
      const next = { ...b };
      if (n > 0) next[key] = n;
      else delete next[key];
      return next;
    });
  }

  // Satu antrean untuk semua perubahan. Hasil diteruskan ke onChange, error ke onError.
  function run(key: string, call: () => Promise<TaskDetail>, after?: (ok: boolean) => void) {
    bump(key, 1);
    const work = async () => {
      let ok = false;
      try {
        const next = await call();
        ok = true;
        if (alive.current) onChangeRef.current(next);
      } catch (err) {
        if (alive.current) onErrorRef.current(toAppError(err).message);
      }
      if (alive.current) after?.(ok);
      bump(key, -1);
    };
    queue.current = queue.current.then(work);
    return queue.current;
  }

  const pid = task.projectId;
  const tid = task.id;

  function nameOf(p: Person): string {
    const listed = assignees.some((a) => a.publicKey === p.publicKey);
    if (!listed) return T.former(p.name, p.publicKey === me);
    return p.publicKey === me ? T.you(p.name) : p.name;
  }

  function dropDraft(id: string, expected?: string) {
    setDrafts((d) => {
      if (!(id in d) || (expected !== undefined && d[id] !== expected)) return d;
      const next = { ...d };
      delete next[id];
      return next;
    });
  }

  function commitTitle(id: string) {
    const draft = draftsRef.current[id];
    if (draft === undefined || sentTitle.current[id] === draft) return;
    const s = taskRef.current.subtasks.find((x) => x.id === id);
    if (!s) {
      dropDraft(id);
      return;
    }
    const value = draft.trim();
    if (value === s.title) {
      dropDraft(id, draft);
      return;
    }
    if (!value) {
      dropDraft(id, draft);
      setEmptiedId(id);
      say(T.errTitleEmpty);
      return;
    }
    if (value.length > SUBTASK_TITLE_MAX) {
      onErrorRef.current(T.errTooLong(value.length));
      return;
    }
    sentTitle.current[id] = draft;
    void run(
      id,
      () => boardApi.updateSubtask(pid, tid, id, { title: value }),
      (ok) => {
        delete sentTitle.current[id];
        if (!ok) return;
        dropDraft(id, draft);
        say(T.saidSaved);
      },
    );
  }

  function revertTitle(id: string) {
    dropDraft(id);
    say(T.saidReverted);
  }

  function toggle(s: Subtask) {
    if (!canEdit || busy[s.id]) return;
    const next = !isDone(s);
    setDoneShown((o) => ({ ...o, [s.id]: next }));
    const done = rows.filter((r) => (r.id === s.id ? next : isDone(r))).length;
    const count = rows.length;
    void run(
      s.id,
      () => boardApi.updateSubtask(pid, tid, s.id, { done: next }),
      (ok) => {
        setDoneShown((o) => {
          const c = { ...o };
          delete c[s.id];
          return c;
        });
        if (ok) say(next ? T.saidDone(done, count) : T.saidReopened(done, count));
      },
    );
  }

  function assign(s: Subtask, person: Person | null) {
    setMenuFor(null);
    if (busy[s.id]) return;
    const key = person?.publicKey ?? null;
    if ((s.assignee?.publicKey ?? null) === key) return;
    void run(
      s.id,
      () => boardApi.updateSubtask(pid, tid, s.id, { assignee: key }),
      (ok) => {
        if (ok) say(person ? T.saidAssigned(s.title, nameOf(person)) : T.saidUnassigned(s.title));
      },
    );
  }

  function remove(s: Subtask) {
    if (busy[s.id]) return;
    void run(
      s.id,
      () => boardApi.deleteSubtask(pid, tid, s.id),
      (ok) => {
        if (!ok) return;
        dropDraft(s.id);
        const list = rowsRef.current;
        const i = list.findIndex((r) => r.id === s.id);
        const next = list[i + 1] ?? list[i - 1];
        focusNext.current = next && next.id !== s.id ? { id: next.id, part: "title" } : { id: null, part: "add" };
        say(T.saidDeleted(s.title));
      },
    );
  }

  // Pindah ke posisi `to` (indeks setelah pindah). Urutan tampil langsung berubah.
  function move(id: string, to: number) {
    const list = rowsRef.current.map((r) => r.id);
    const from = list.indexOf(id);
    if (from < 0 || to === from || to < 0 || to >= list.length) return;
    list.splice(from, 1);
    list.splice(to, 0, id);
    setOrder(list);
    const title = rowsRef.current[from].title;
    say(T.saidMoved(title, to + 1, list.length));
    pendingMoves.current += 1;
    void run(
      id,
      () => boardApi.moveSubtask(pid, tid, id, to),
      (ok) => {
        pendingMoves.current -= 1;
        if (!ok || pendingMoves.current === 0) setOrder(null);
      },
    );
  }

  // Ganti nama dari menu: fokus ke kolom judul baris itu dengan seluruh teks terpilih.
  function rename(id: string) {
    const input = findRow(sectionRef.current, id)?.querySelector<HTMLInputElement>('[data-part="title"]');
    if (!input) return;
    setRenaming(id);
    input.focus();
    input.select();
  }

  // Escape tanpa ketikan setelah Ganti nama: keluar dari kolom judul, fokus
  // kembali ke kotak centang baris itu. Blur kolom mengakhiri mode ganti nama.
  function endRename(id: string) {
    findRow(sectionRef.current, id)?.querySelector<HTMLElement>('[data-part="check"]')?.focus();
    setRenaming((r) => (r === id ? null : r));
  }

  // Pindah naik atau turun dari menu. Seperti Alt + panah, fokus tetap di
  // kontrol baris yang tadi terfokus (menu sudah mengembalikan fokus ke sana).
  function moveBy(s: Subtask, delta: -1 | 1) {
    if (busy[s.id]) return;
    const i = rowsRef.current.findIndex((r) => r.id === s.id);
    const to = i + delta;
    if (i < 0 || to < 0 || to >= rowsRef.current.length) return;
    const active = document.activeElement;
    const inRow = active instanceof HTMLElement && !!findRow(sectionRef.current, s.id)?.contains(active);
    const part = (inRow ? ((active as HTMLElement).dataset.part as Part | undefined) : undefined) ?? "check";
    if (part === "title") commitTitle(s.id);
    focusNext.current = { id: s.id, part };
    move(s.id, to);
  }

  function rowMenu(s: Subtask, i: number, waiting: boolean, done: boolean): BoardMenuEntry[] {
    const M = TEKS_MENU.subtask;
    const wait = waiting ? M.menunggu : false;
    const current = s.assignee?.publicKey ?? null;
    const former = s.assignee && isFormer(s.assignee) ? s.assignee : null;
    // Saya paling atas, lalu anggota lain, lalu penanggung jawab lama yang bukan anggota lagi.
    const people = [
      ...assignees.filter((p) => p.publicKey === me),
      ...assignees.filter((p) => p.publicKey !== me),
      ...(former ? [former] : []),
    ];
    return boardMenuItems(
      {
        id: "toggle",
        label: done ? M.batalCentang : M.centang,
        icon: done ? <IconSquare size={16} /> : <IconSquareCheck size={16} />,
        disabled: wait,
        onSelect: () => toggle(s),
      },
      { id: "rename", label: M.gantiNama, icon: <IconPencil size={16} />, disabled: wait, onSelect: () => rename(s.id) },
      submenu({
        id: "assign",
        label: M.tugaskan,
        menuLabel: M.tugaskanMenu(s.title),
        icon: <IconUserPlus size={16} />,
        disabled: wait,
        items: menuItems(
          ...people.map((p) => ({
            id: `who-${p.publicKey}`,
            label: nameOf(p),
            disabled: wait || (p.publicKey === current && TEKS_MENU.kartu.penanggungJawabSekarang),
            onSelect: () => assign(s, p),
          })),
          SEPARATOR,
          {
            id: "who-none",
            label: T.whoNone,
            disabled: wait || (current === null && TEKS_MENU.kartu.belumAdaPenanggungJawab),
            onSelect: () => assign(s, null),
          },
        ),
      }),
      {
        id: "up",
        label: M.naik,
        icon: <IconArrowUp size={16} />,
        disabled: wait || (i === 0 && M.sudahAtas),
        onSelect: () => moveBy(s, -1),
      },
      {
        id: "down",
        label: M.turun,
        icon: <IconArrowDown size={16} />,
        disabled: wait || (i === rows.length - 1 && M.sudahBawah),
        onSelect: () => moveBy(s, 1),
      },
      SEPARATOR,
      { id: "delete", label: M.hapus, icon: <IconTrash size={16} />, danger: true, disabled: wait, onSelect: () => remove(s) },
    );
  }

  const drag = useListDrag(
    listRef,
    (id, index) => move(id, index),
    () => say(T.saidDragCancelled),
  );

  // Menu baris tidak dibuka selama baris diseret. Seret yang masih tertunda
  // (tombol kiri ditahan, belum lewat ambang) dibatalkan dan menu dibuka.
  function menuBlocked(): boolean {
    if (drag.isDragging()) return true;
    drag.cancelPending();
    return false;
  }

  function onRowKeyDown(e: ReactKeyboardEvent<HTMLLIElement>, s: Subtask) {
    if (!canEdit || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const target = e.target as HTMLElement;
    if (target.closest("[role=menu]")) return;
    e.preventDefault();
    e.stopPropagation();
    const part = (target.dataset.part as Part | undefined) ?? "title";
    if (part === "title") commitTitle(s.id);
    const i = rowsRef.current.findIndex((r) => r.id === s.id);
    const to = e.key === "ArrowUp" ? i - 1 : i + 1;
    if (to < 0) {
      say(T.saidTop);
      return;
    }
    if (to >= rowsRef.current.length) {
      say(T.saidBottom);
      return;
    }
    focusNext.current = { id: s.id, part };
    move(s.id, to);
  }

  // Ketikan yang berbeda dari judul tersimpan. Hanya saat ini Escape membatalkan
  // ketikan; tanpa ketikan, Escape menutup dialog seperti biasa, kecuali kolom
  // dibuka lewat Ganti nama.
  function titleDirty(s: Subtask): boolean {
    const draft = drafts[s.id];
    return draft !== undefined && draft !== s.title;
  }

  function onTitleKeyDown(e: ReactKeyboardEvent<HTMLInputElement>, s: Subtask) {
    if (e.altKey) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commitTitle(s.id);
    } else if (e.key === "Escape" && titleDirty(s)) {
      e.preventDefault();
      e.stopPropagation();
      revertTitle(s.id);
    } else if (e.key === "Escape" && renaming === s.id) {
      e.preventDefault();
      e.stopPropagation();
      endRename(s.id);
    }
  }

  function openAdd() {
    setAdding(true);
    setNewError(null);
    focusNext.current = { id: null, part: "new" };
  }

  function closeAdd() {
    setAdding(false);
    setNewTitle("");
    setNewError(null);
    focusNext.current = { id: null, part: "add" };
  }

  function submitNew() {
    if (addBusy) return;
    const raw = newTitle;
    const value = raw.trim();
    if (!value) {
      setNewError(T.errEmpty);
      return;
    }
    if (value.length > SUBTASK_TITLE_MAX) {
      setNewError(T.errTooLong(value.length));
      return;
    }
    if (taskRef.current.subtasks.length >= SUBTASK_MAX) {
      setNewError(T.errTooMany);
      return;
    }
    setNewError(null);
    setAddBusy(true);
    void run(
      "new",
      () => boardApi.addSubtask(pid, tid, value, null),
      (ok) => {
        setAddBusy(false);
        if (!ok) return;
        setNewTitle((cur) => (cur === raw ? "" : cur));
        say(T.saidAdded(value));
      },
    );
  }

  function onNewKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      submitNew();
    }
  }

  // Escape di isian subtask baru hanya menutup isian, fokus kembali ke tombol tambah.
  useLocalEscape(newRef, adding, closeAdd);

  // Garis sisip: sebelum baris tujuan, atau sesudah baris terakhir.
  const dragFrom = drag.dragId ? rows.findIndex((r) => r.id === drag.dragId) : -1;
  let lineBefore: string | null = null;
  let lineAfter: string | null = null;
  if (drag.dragId && drag.dropIndex !== null && drag.dropIndex !== dragFrom) {
    const others = rows.filter((r) => r.id !== drag.dragId);
    if (drag.dropIndex < others.length) lineBefore = others[drag.dropIndex].id;
    else lineAfter = others[others.length - 1]?.id ?? null;
  }

  function rowEditable(s: Subtask, i: number) {
    const waiting = !!busy[s.id];
    const done = isDone(s);
    const value = drafts[s.id] ?? s.title;
    const dirty = titleDirty(s);
    const escapeLocal = dirty || renaming === s.id;
    const emptied = emptiedId === s.id;
    const cls = [
      "td-sub",
      "is-editable",
      done && "is-done",
      waiting && "is-busy",
      drag.dragId === s.id && "is-dragging",
      lineBefore === s.id && "drop-before",
      lineAfter === s.id && "drop-after",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <SubtaskRow
        key={s.id}
        className={cls}
        rowId={s.id}
        waiting={waiting}
        menuLabel={TEKS_MENU.subtask.menu(s.title)}
        menuItems={rowMenu(s, i, waiting, done)}
        menuBlocked={menuBlocked}
        onKeyDown={(e) => onRowKeyDown(e, s)}
      >
        <span
          className="td-handle"
          aria-hidden="true"
          title={T.dragHandle}
          data-handle
          onPointerDown={(e) => drag.onHandlePointerDown(e, s.id)}
        >
          <IconGripVertical size={16} />
        </span>
        <input
          type="checkbox"
          className="td-check"
          data-part="check"
          checked={done}
          aria-label={T.checkLabel(s.title)}
          aria-disabled={waiting || undefined}
          onChange={() => toggle(s)}
        />
        <input
          type="text"
          className="td-sub-title"
          data-part="title"
          value={value}
          aria-label={T.titleLabel(i + 1, total)}
          aria-describedby={emptied ? `${titleErrId} ${hintId}` : hintId}
          data-escape-local={escapeLocal || undefined}
          data-unsaved={dirty ? "true" : undefined}
          onChange={(e) => {
            const v = e.target.value;
            setDrafts((d) => ({ ...d, [s.id]: v }));
            if (emptied) setEmptiedId(null);
          }}
          onKeyDown={(e) => onTitleKeyDown(e, s)}
          onBlur={() => {
            commitTitle(s.id);
            setRenaming((r) => (r === s.id ? null : r));
          }}
        />
        <WhoMenu
          subtask={s}
          me={me}
          assignees={assignees}
          nameOf={nameOf}
          open={menuFor === s.id}
          waiting={waiting}
          onOpen={(v) => setMenuFor(v ? s.id : null)}
          onPick={(p) => assign(s, p)}
        />
        <button
          type="button"
          className="td-del"
          data-part="del"
          aria-label={T.deleteLabel(s.title)}
          title={T.deleteLabel(s.title)}
          aria-disabled={waiting || undefined}
          onClick={() => remove(s)}
        >
          <IconTrash size={16} aria-hidden="true" />
        </button>
        {emptied && (
          <p className="td-sub-err td-sub-rowmsg" id={titleErrId}>
            {T.errTitleEmpty}
          </p>
        )}
      </SubtaskRow>
    );
  }

  function rowReadOnly(s: Subtask) {
    const who = s.assignee ? nameOf(s.assignee) : null;
    return (
      <li key={s.id} className={`td-sub${s.done ? " is-done" : ""}`} data-row-id={s.id}>
        <span aria-hidden="true" />
        <input
          type="checkbox"
          className="td-check"
          data-part="check"
          checked={s.done}
          disabled
          readOnly
          aria-label={T.checkLabel(s.title)}
        />
        <span className="td-sub-text" data-part="title">
          {s.title}
        </span>
        {who && s.assignee ? (
          <span className="td-who td-who-static" title={who}>
            <span className={`td-av td-av-sm${isFormer(s.assignee) ? " td-av-former" : ""}`} aria-hidden="true">
              {initials(s.assignee.name)}
            </span>
            <span className="sr-only">{T.whoStatic(who)}</span>
          </span>
        ) : (
          <span aria-hidden="true" />
        )}
        <span aria-hidden="true" />
      </li>
    );
  }

  function isFormer(p: Person) {
    return !assignees.some((a) => a.publicKey === p.publicKey);
  }

  const pct = total ? Math.round((doneCount / total) * 100) : 0;

  return (
    <section ref={sectionRef} className="td-sec td-subs-sec" aria-labelledby={headId}>
      <div className="td-sec-head">
        <h3 className="td-sh" id={headId}>
          {T.heading}
        </h3>
        {total > 0 && (
          <span className="td-progress">
            <span
              className="td-bar"
              role="progressbar"
              aria-label={T.progressLabel}
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={doneCount}
              aria-valuetext={T.progressText(doneCount, total)}
            >
              <i style={{ width: `${pct}%` }} />
            </span>
            <span className="td-sub-count" aria-hidden="true">
              {T.progressShort(doneCount, total)}
            </span>
          </span>
        )}
      </div>

      {total > 0 ? (
        <ul className="td-subs" ref={listRef}>
          {rows.map((s, i) => (canEdit ? rowEditable(s, i) : rowReadOnly(s)))}
        </ul>
      ) : (
        <p className="td-sub-empty">{canEdit ? T.emptyEditable : T.emptyReadOnly}</p>
      )}

      {canEdit &&
        (adding ? (
          <div className="td-sub-newwrap" ref={newRef}>
            <div className="td-sub td-sub-new">
              <span aria-hidden="true" />
              <span className="td-check-ph" aria-hidden="true" />
              <input
                type="text"
                className="td-input td-sub-input"
                data-part="new"
                data-unsaved={newTitle.trim() ? "true" : undefined}
                value={newTitle}
                placeholder={T.newPlaceholder}
                aria-label={T.newLabel}
                aria-invalid={newError ? true : undefined}
                aria-describedby={newError ? `${newErrId} ${newHintId}` : newHintId}
                aria-busy={addBusy || undefined}
                onChange={(e) => {
                  setNewTitle(e.target.value);
                  if (newError) setNewError(null);
                }}
                onKeyDown={onNewKeyDown}
              />
            </div>
            {newError && (
              <p className="td-sub-err" id={newErrId} role="alert">
                {newError}
              </p>
            )}
            <p className="td-sub-hint" id={newHintId}>
              {T.newHint}
            </p>
          </div>
        ) : (
          <button type="button" className="td-sub-add" data-part="add" onClick={openAdd}>
            <IconPlus size={18} aria-hidden="true" />
            {T.addButton}
          </button>
        ))}

      {canEdit && total > 0 && (
        <p className="td-sub-hint" id={hintId}>
          {T.hint}
        </p>
      )}

      <p className="sr-only" aria-live="polite">
        {live}
      </p>
    </section>
  );
}

type SubtaskRowProps = {
  className: string;
  rowId: string;
  waiting: boolean;
  menuLabel: string;
  menuItems: BoardMenuEntry[];
  // true: klik kanan atau Shift+F10 ini tidak membuka menu baris (baris sedang diseret).
  menuBlocked: () => boolean;
  onKeyDown: (e: ReactKeyboardEvent<HTMLLIElement>) => void;
  children: ReactNode;
};

function isMenuKey(e: ReactKeyboardEvent): boolean {
  return e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
}

// Klik kanan atau Shift+F10 dari menu lain di dalam baris (menu penanggung
// jawab) milik menu itu, bukan menu baris.
function inNestedMenu(e: { target: EventTarget | null; currentTarget: HTMLElement }): boolean {
  const nested = e.target instanceof Element ? e.target.closest("[role=menu]") : null;
  return !!nested && e.currentTarget.contains(nested);
}

// Satu baris subtask yang bisa diubah, dengan menu klik kanannya sendiri (satu
// hook per baris). Pembungkus menu tidak punya kotak (display: contents), jadi
// grid baris tidak berubah. Klik kanan yang tidak membuka menu baris tetap
// dicegah, supaya menu bawaan webview tidak muncul.
function SubtaskRow({ className, rowId, waiting, menuLabel, menuItems: items, menuBlocked, onKeyDown, children }: SubtaskRowProps) {
  const menu = useBoardMenu({ label: menuLabel, items });
  return (
    <li
      className={className}
      data-row-id={rowId}
      aria-busy={waiting || undefined}
      onContextMenu={(e) => {
        if (inNestedMenu(e) || menuBlocked()) {
          e.preventDefault();
          return;
        }
        menu.triggerProps.onContextMenu(e);
      }}
      onKeyDown={(e) => {
        onKeyDown(e);
        if (isMenuKey(e) && (inNestedMenu(e) || menuBlocked())) {
          e.preventDefault();
          return;
        }
        menu.triggerProps.onKeyDown(e);
      }}
    >
      {children}
      {menu.element}
    </li>
  );
}

type WhoMenuProps = {
  subtask: Subtask;
  me: string;
  assignees: Person[];
  nameOf: (p: Person) => string;
  open: boolean;
  waiting: boolean;
  onOpen: (open: boolean) => void;
  onPick: (p: Person | null) => void;
};

// Tombol avatar penanggung jawab dengan menu pilihan satu orang, memakai
// Popover dan MenuList yang sama dengan menu properti dialog. Panah memilih,
// Enter atau Spasi menetapkan, Escape menutup menu saja dan fokus kembali ke tombol.
const NONE = "";

function WhoMenu({ subtask: s, assignees, nameOf, open, waiting, onOpen, onPick }: WhoMenuProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const current = s.assignee?.publicKey ?? NONE;
  const former = s.assignee && !assignees.some((a) => a.publicKey === s.assignee?.publicKey) ? s.assignee : null;
  const people = [...assignees, ...(former ? [former] : [])];
  const items: MenuItem[] = [
    { value: NONE, label: T.whoNone, icon: <span className="td-who-item-none" aria-hidden="true" /> },
    ...people.map((p) => ({
      value: p.publicKey,
      label: nameOf(p),
      icon: (
        <span className={`td-av td-av-sm${p === former ? " td-av-former" : ""}`} aria-hidden="true">
          {initials(p.name)}
        </span>
      ),
    })),
  ];

  useLocalEscape(wrapRef, open, () => {
    onOpen(false);
    buttonRef.current?.focus();
  });

  const label = s.assignee ? T.whoLabel(s.title, nameOf(s.assignee)) : T.whoEmptyLabel(s.title);

  return (
    <div className="td-who-wrap" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`td-who${s.assignee ? "" : " td-who-empty"}`}
        data-part="who"
        aria-label={label}
        title={s.assignee ? nameOf(s.assignee) : T.whoEmptyLabel(s.title)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-disabled={waiting || undefined}
        onClick={() => {
          if (!waiting) onOpen(!open);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !e.altKey && !waiting) {
            e.preventDefault();
            onOpen(true);
          }
        }}
      >
        {s.assignee ? (
          <span className={`td-av td-av-sm${former ? " td-av-former" : ""}`} aria-hidden="true">
            {initials(s.assignee.name)}
          </span>
        ) : (
          <IconUserPlus size={14} aria-hidden="true" />
        )}
      </button>
      {open && (
        <Popover id={menuId} anchorRef={buttonRef} align="end" onDismiss={() => onOpen(false)}>
          <MenuList
            label={T.whoMenuLabel(s.title)}
            items={items}
            checked={current}
            onPick={(value) => {
              buttonRef.current?.focus();
              onPick(value === NONE ? null : (people.find((p) => p.publicKey === value) ?? null));
            }}
          />
        </Popover>
      )}
    </div>
  );
}
