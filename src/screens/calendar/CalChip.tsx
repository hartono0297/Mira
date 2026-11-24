import { IconAlertTriangle, IconCheck } from "@tabler/icons-react";
import { useEffect, useRef, type RefObject } from "react";
import type { CalTask } from "../../api/calendar";
import { CAL_VIEW } from "../../i18n/calendar-view";
import { PRIORITY_LABELS } from "../board/format";
import { isOverdue, taskKey, type DayKey } from "./calendarModel";
import type { ChipHandlers } from "./viewTypes";
import "./calendar-views.css";

type Props = ChipHandlers & {
  item: CalTask;
  // Indeks warna proyek 0..7 (garis kiri, kelas cc-p0..cc-p7).
  colorIndex: number;
  today: DayKey;
  dragging: boolean;
  // compact: sel Bulan, kolom Minggu, daftar satu hari. row: baris Agenda
  // yang juga menulis penanggung jawab dan prioritas.
  variant?: "compact" | "row";
};

// Satu task di kalender. Proyek ditandai dua kali: garis warna di kiri dan kode
// proyek yang tertulis (kode task selalu diawali kode proyek; kalau tidak,
// kode proyek ditulis terpisah). Nama aksesibel (aria-label) memuat semua yang
// terlihat dan arti ikonnya: "TES-3, Laporan bulanan, proyek Tes, lewat tenggat".
// Ditulis sebagai satu string karena spasi di tepi potongan sr-only bisa hilang.
export function CalChip({ item, colorIndex, today, dragging, variant = "compact", onOpen, onPointerDown, onContextMenu, onKeyDown }: Props) {
  const t = item.task;
  const txt = CAL_VIEW.chip;
  const done = t.columnId === "done";
  const late = isOverdue(item, today);
  const movable = t.canEdit === true;
  const showProject = !t.code.startsWith(`${item.projectCode}-`);
  const row = variant === "row";
  const cls = [
    "cc",
    `cc-p${((colorIndex % 8) + 8) % 8}`,
    row ? "cc-row" : "cc-compact",
    late ? "cc-late" : "",
    done ? "cc-done" : "",
    dragging ? "cc-dragging" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const priority = t.priority !== "none" ? PRIORITY_LABELS[t.priority] : null;
  const name =
    (showProject ? item.projectCode + txt.pemisahSr : "") +
    t.code +
    txt.pemisahSr +
    t.title +
    txt.proyekSr(item.projectName) +
    (row ? (t.assignee ? txt.untukSr(t.assignee.name) : txt.tanpaOrangSr) : "") +
    (row && priority ? txt.prioritasSr(priority) : "") +
    (late ? txt.lewatSr : "") +
    (done ? txt.selesaiSr : "");

  return (
    <button
      type="button"
      className={cls}
      aria-label={name}
      data-cal-task={taskKey(item)}
      data-movable={movable || undefined}
      onClick={() => onOpen(item)}
      onPointerDown={(e) => onPointerDown(e, item)}
      onContextMenu={(e) => onContextMenu(e, item)}
      onKeyDown={(e) => onKeyDown(e, item)}
    >
      <span className="cc-main">
        {late && <IconAlertTriangle className="cc-icon" size={14} aria-hidden="true" />}
        {done && <IconCheck className="cc-icon" size={14} aria-hidden="true" />}
        {/* Spasi di antara potongan: tidak terlihat di flex, tetapi teks salinan dan textContent tetap terpisah. */}
        {showProject && <span className="cc-proj">{item.projectCode}</span>}
        {showProject && " "}
        <span className="cc-code">{t.code}</span>{" "}
        <span className="cc-title">{t.title}</span>
      </span>
      {row && (
        <span className="cc-meta">
          {" "}
          <span className={`cc-who${t.assignee ? "" : " cc-nobody"}`}>{t.assignee ? t.assignee.name : txt.tanpaOrang}</span>
          {priority && " "}
          {priority && <span className={`cc-pri cc-pri-${t.priority}`}>{priority}</span>}
        </span>
      )}
    </button>
  );
}

// Fokus chip `focusKey` setelah render. Fokus hanya dipindah saat kuncinya
// berganti atau task itu pindah hari (Alt+Panah berturut-turut memasang ulang
// chip di sel lain), bukan setiap kali data dimuat ulang, supaya fokus yang
// sudah dipindah pengguna tidak ditarik kembali.
// Urutan pengganti kalau chip tidak bisa difokus: `fallback(day)` (misalnya
// tombol "+N lagi" atau tombol jumlah di tampilan sempit), lalu `root` sendiri
// (grup periode dengan tabIndex -1), misalnya saat task keluar dari rentang
// atau tenggatnya dihapus. Fokus tidak pernah jatuh ke body.
export function useFocusKey(
  root: RefObject<HTMLElement | null>,
  focusKey: string | null,
  byDay: Map<DayKey, CalTask[]>,
  fallback?: (day: DayKey) => HTMLElement[],
) {
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!focusKey) {
      last.current = null;
      return;
    }
    let day: DayKey | null = null;
    for (const [d, list] of byDay) {
      if (list.some((t) => taskKey(t) === focusKey)) {
        day = d;
        break;
      }
    }
    const sig = `${focusKey}@${day ?? ""}`;
    if (sig === last.current) return;
    last.current = sig;
    const el = root.current;
    if (!el) return;
    const chips = [...el.querySelectorAll<HTMLElement>("[data-cal-task]")].filter((c) => c.dataset.calTask === focusKey);
    const candidates = [...chips, ...(day && fallback ? fallback(day) : []), el];
    for (const c of candidates) {
      c.focus();
      if (document.activeElement === c) return;
    }
  });
}
