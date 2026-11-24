import { IconX } from "@tabler/icons-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { CalTask } from "../../api/calendar";
import { CAL_VIEW } from "../../i18n/calendar-view";
import { CalChip } from "./CalChip";
import { dayLong, taskKey, type DayKey } from "./calendarModel";
import type { ChipHandlers } from "./viewTypes";

type Props = ChipHandlers & {
  day: DayKey;
  tasks: CalTask[];
  today: DayKey;
  colors: Map<string, number>;
  draggingKey: string | null;
  // Tombol yang membuka daftar: posisi popover dan tujuan fokus saat ditutup.
  opener: HTMLElement;
  // returnFocus: fokus dikembalikan ke tombol pembuka.
  onClose: (returnFocus: boolean) => void;
};

const GAP = 4;
const EDGE = 8;

// Elemen lain yang boleh menerima fokus atau klik tanpa menutup daftar: menu
// klik kanan chip dan detail task yang dibuka dari chip di dalam daftar.
function elsewhereLayer(node: EventTarget | null): boolean {
  return node instanceof Element && !!node.closest('[role="menu"], [role="dialog"], [role="alertdialog"]');
}

// Daftar semua task satu hari, dibuka dari "+N lagi" (atau tombol jumlah di
// tampilan sempit). Popover non-modal: fokus masuk ke chip pertama, Esc, tombol
// Tutup, dan klik di luar menutupnya dan mengembalikan fokus ke pembuka; fokus
// yang pindah ke tempat lain dengan Tab hanya menutupnya.
export function DayMore({ day, tasks, today, colors, draggingKey, opener, onClose, ...handlers }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Posisi tetap di layar, di bawah pembuka; naik ke atas kalau tidak muat,
  // dan selalu di dalam jendela (tidak ada gulir samping di layar sempit).
  useLayoutEffect(() => {
    function place() {
      const panel = ref.current;
      if (!panel) return;
      const a = opener.getBoundingClientRect();
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const left = Math.max(EDGE, Math.min(a.left, vw - w - EDGE));
      const below = a.bottom + GAP;
      const top = below + h <= vh - EDGE || a.top - GAP - h < EDGE ? Math.min(below, Math.max(EDGE, vh - h - EDGE)) : a.top - GAP - h;
      setPos({ left, top });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [opener, tasks.length]);

  // Fokus masuk sekali saat dibuka.
  useEffect(() => {
    const panel = ref.current;
    const first = panel?.querySelector<HTMLElement>("[data-cal-task]") ?? panel?.querySelector<HTMLElement>("button");
    first?.focus();
  }, []);

  useEffect(() => {
    function onPointer(e: PointerEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t) || opener.contains(t) || elsewhereLayer(t)) return;
      closeRef.current(false);
      // Klik di area yang tidak bisa difokus memindah fokus ke body; kembalikan ke pembuka.
      window.setTimeout(() => {
        const active = document.activeElement;
        if ((!active || active === document.body) && opener.isConnected) opener.focus();
      }, 0);
    }
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [opener]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    onClose(true);
  }

  const dragging = draggingKey !== null;

  return (
    <div
      ref={ref}
      className={`cv-more${dragging ? " cv-more-dragging" : ""}`}
      role="dialog"
      aria-labelledby={headingId}
      style={pos}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        const next = e.relatedTarget;
        if (!next || ref.current?.contains(next as Node) || elsewhereLayer(next)) return;
        onClose(false);
      }}
    >
      <div className="cv-more-head">
        <h2 id={headingId} className="cv-more-title">
          {dayLong(day)}
        </h2>
        <button type="button" className="cv-more-close" aria-label={CAL_VIEW.daftarHari.tutup} onClick={() => onClose(true)}>
          <IconX size={16} aria-hidden="true" />
        </button>
      </div>
      <ul className="cv-more-list">
        {tasks.map((t) => (
          <li key={taskKey(t)}>
            <CalChip item={t} colorIndex={colors.get(t.projectId) ?? 0} today={today} dragging={draggingKey === taskKey(t)} {...handlers} />
          </li>
        ))}
      </ul>
    </div>
  );
}
