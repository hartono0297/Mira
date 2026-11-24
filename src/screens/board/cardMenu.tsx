// Isi menu klik kanan kartu task di board (v0.4). Rancangan ada di
// docs/plans/v04-ctx-board.md. Aksinya sendiri milik ProjectBoard, supaya
// pengumuman, tampilan optimis, dan galat sama dengan tombol Pindahkan dan
// detail task.
import {
  IconArrowsMove,
  IconCalendarDue,
  IconCopy,
  IconFileText,
  IconFlag,
  IconPlayerPlay,
  IconPlayerStop,
  IconTrash,
  IconUserPlus,
} from "@tabler/icons-react";
import { menuItems, SEPARATOR, type MenuEntry } from "../../components/ContextMenu";
import type { BoardView, ColumnId, Priority, TaskCard, TaskPatch } from "../../api/board";
import type { Place } from "./boardMoves";
import { columnLabel, formatDue, PRIORITY_LABELS, todayIso } from "./format";
import { TEKS_DIALOG, teksDialog } from "./teksDialog";
import { TEKS_MENU } from "./teksMenu";
import { boardMenuItems, submenu, type BoardMenuEntry } from "./useBoardMenu";

const T = TEKS_MENU.kartu;

export type CardMenuActions = {
  open: () => void;
  move: (to: Place) => void;
  // done = pengumuman setelah berhasil.
  edit: (patch: TaskPatch, done: string) => void;
  timer: (start: boolean) => void;
  copy: () => void;
  // Dijalankan dari dialog konfirmasi; galatnya tampil di dialog itu.
  remove: () => Promise<void>;
};

type Args = {
  view: BoardView;
  task: TaskCard;
  // Tempat kartu sekarang: kolom, urutan, dan jumlah kartu di kolom itu.
  columnId: ColumnId;
  index: number;
  size: number;
  actions: CardMenuActions;
};

// Selama kartu diseret (useCardDrag memasang kelas ini di <html>), menu
// klik kanan kartu dan kolom tidak dibuka.
export function cardDragActive(): boolean {
  return document.documentElement.classList.contains("card-dragging");
}

const PRIORITY_ORDER: Priority[] = ["high", "medium", "low", "none"];

// Tanggal lokal n hari dari sekarang, YYYY-MM-DD.
function isoFromToday(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return todayIso(d);
}

export function cardMenuEntries({ view, task, columnId, index, size, actions }: Args): BoardMenuEntry[] {
  // Inti Rust memakai hak yang sama (boleh membuat task) untuk memindah dan mengubah task.
  const canEdit = view.canCreate;
  const code = task.code;

  const moveItems: MenuEntry[] = [
    ...view.columns.map((c) => ({
      id: `move-${c.id}`,
      label: columnLabel(c.id, c.name),
      disabled: c.id === columnId && T.sudahDiKolom,
      onSelect: () => actions.move({ columnId: c.id, index: 0 }),
    })),
    SEPARATOR,
    {
      id: "move-up",
      label: T.naik,
      disabled: index <= 0 && T.sudahAtas,
      onSelect: () => actions.move({ columnId, index: index - 1 }),
    },
    {
      id: "move-down",
      label: T.turun,
      disabled: index >= size - 1 && T.sudahBawah,
      onSelect: () => actions.move({ columnId, index: index + 1 }),
    },
  ];

  // Saya paling atas, lalu yang lain urut seperti datanya.
  const me = view.assignees.find((p) => p.publicKey === view.me);
  const people = me ? [me, ...view.assignees.filter((p) => p !== me)] : view.assignees;
  // Penanggung jawab sekarang yang sudah bukan anggota proyek tampil nonaktif
  // di bawah anggota, sama seperti menu subtask.
  const former = task.assignee && !view.assignees.some((p) => p.publicKey === task.assignee?.publicKey) ? task.assignee : null;
  const assignItems: MenuEntry[] = [
    ...people.map((p) => ({
      id: `assign-${p.publicKey}`,
      label: p === me ? T.anda(p.name) : p.name,
      disabled: task.assignee?.publicKey === p.publicKey && T.penanggungJawabSekarang,
      onSelect: () => actions.edit({ assignee: p.publicKey }, T.ditugaskan(code, p.name)),
    })),
    ...(former
      ? [
          {
            id: `assign-${former.publicKey}`,
            label: T.bukanAnggota(former.name, former.publicKey === view.me),
            disabled: T.penanggungJawabSekarang,
            onSelect: () => {},
          },
        ]
      : []),
    SEPARATOR,
    {
      id: "assign-none",
      label: T.tanpaPenanggungJawab,
      disabled: !task.assignee && T.belumAdaPenanggungJawab,
      onSelect: () => actions.edit({ assignee: null }, T.dilepas(code)),
    },
  ];

  const priorityItems: MenuEntry[] = PRIORITY_ORDER.map((p) => ({
    id: `priority-${p}`,
    label: PRIORITY_LABELS[p],
    disabled: task.priority === p && T.prioritasSekarang,
    onSelect: () => actions.edit({ priority: p }, T.prioritasDiubah(code, PRIORITY_LABELS[p])),
  }));

  // Tanggal dihitung saat dipilih, supaya tetap benar kalau board terbuka lewat tengah malam.
  const setDue = (days: number, label: string) => {
    const iso = isoFromToday(days);
    actions.edit({ due: iso }, T.tenggatDiubah(code, T.tanggalDengan(label, formatDue(iso))));
  };
  const dueItems = menuItems(
    { id: "due-today", label: T.hariIni, disabled: task.due === isoFromToday(0) && T.tenggatSekarang, onSelect: () => setDue(0, T.hariIni) },
    { id: "due-tomorrow", label: T.besok, disabled: task.due === isoFromToday(1) && T.tenggatSekarang, onSelect: () => setDue(1, T.besok) },
    SEPARATOR,
    {
      id: "due-clear",
      label: T.hapusTenggat,
      disabled: !task.due && T.belumAdaTenggat,
      onSelect: () => actions.edit({ due: null }, T.tenggatDihapus(code)),
    },
    { id: "due-other", label: T.tanggalLain, onSelect: actions.open },
  );

  const running = !!task.myTimerRunning;
  // Jumlah catatan waktu tidak ada di kartu; kalau kartu menunjukkan ada waktu, disebut tanpa angka.
  const hasTime = task.trackedSecs > 0 || task.timersRunningSince.length > 0;

  return boardMenuItems(
    { id: "open", label: T.buka, icon: <IconFileText size={16} />, onSelect: actions.open },
    SEPARATOR,
    canEdit && submenu({ id: "move", label: T.pindahkan, menuLabel: T.pindahkanMenu(code), icon: <IconArrowsMove size={16} />, items: moveItems }),
    canEdit && submenu({ id: "assign", label: T.tugaskan, menuLabel: T.tugaskanMenu(code), icon: <IconUserPlus size={16} />, items: assignItems }),
    canEdit && submenu({ id: "priority", label: T.prioritas, menuLabel: T.prioritasMenu(code), icon: <IconFlag size={16} />, items: priorityItems }),
    canEdit && submenu({ id: "due", label: T.tenggat, menuLabel: T.tenggatMenu(code), icon: <IconCalendarDue size={16} />, items: dueItems }),
    SEPARATOR,
    canEdit && {
      id: running ? "timer-stop" : "timer-start",
      label: running ? T.hentikanTimer : T.mulaiTimer,
      icon: running ? <IconPlayerStop size={16} /> : <IconPlayerPlay size={16} />,
      onSelect: () => actions.timer(!running),
    },
    { id: "copy", label: T.salinKode(code), icon: <IconCopy size={16} />, onSelect: actions.copy },
    SEPARATOR,
    !!task.canDelete && {
      id: "delete",
      label: T.hapus,
      icon: <IconTrash size={16} />,
      danger: true,
      confirm: {
        title: teksDialog.hapusJudul(code),
        body: <p>{T.hapusIsi(task.title, task.subtaskTotal, task.commentCount, hasTime)}</p>,
        confirmLabel: teksDialog.hapusTombol(code),
        busyLabel: TEKS_DIALOG.menghapus,
      },
      onSelect: actions.remove,
    },
  );
}
