import { IconCheck } from "@tabler/icons-react";
import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";

type PopoverProps = {
  id: string;
  anchorRef: RefObject<HTMLElement | null>;
  // Dipanggil saat klik di luar atau fokus pindah ke luar. Escape ditangani
  // dialog (Radix mendengar Escape lebih dulu), lihat TaskDetail.
  onDismiss: () => void;
  align?: "start" | "end";
  children: ReactNode;
};

// Pilihan kecil yang menempel di bawah tombolnya. Dipasang di dalam dialog,
// jadi tetap di dalam kunci fokus Radix. Satu-satunya elemen dengan bayangan
// di dalam dialog.
export function Popover({ id, anchorRef, onDismiss, align = "start", children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const first =
      el.querySelector<HTMLElement>("[data-autofocus]") ??
      el.querySelector<HTMLElement>('[aria-checked="true"], [aria-pressed="true"]') ??
      el.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)");
    first?.focus();
    el.scrollIntoView?.({ block: "nearest" });
    function onDown(e: PointerEvent | MouseEvent) {
      const target = e.target as Node | null;
      if (!target || el?.contains(target) || anchorRef.current?.contains(target)) return;
      dismiss.current();
    }
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [anchorRef]);

  return (
    <div
      ref={ref}
      id={id}
      className={`td-pop${align === "end" ? " td-pop-end" : ""}`}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        // Tanpa relatedTarget (klik di bagian yang tidak bisa difokus) diputuskan oleh pointerdown.
        if (!next || ref.current?.contains(next) || anchorRef.current?.contains(next)) return;
        dismiss.current();
      }}
    >
      {children}
    </div>
  );
}

// Panah atas/bawah, Home, dan End memindah fokus di antara butir yang cocok.
export function moveFocus(e: KeyboardEvent<HTMLElement>, selector: string) {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(selector));
  if (items.length === 0) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement as HTMLElement);
  let next = 0;
  if (e.key === "End") next = items.length - 1;
  else if (e.key === "ArrowDown") next = i < 0 ? 0 : (i + 1) % items.length;
  else if (e.key === "ArrowUp") next = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
  items[next].focus();
}

export type MenuItem = { value: string; label: string; icon?: ReactNode; danger?: boolean };

type MenuProps = {
  label: string;
  items: MenuItem[];
  // Ada = menu pilihan satu (menuitemradio) dengan tanda centang di nilai ini.
  checked?: string;
  onPick: (value: string) => void;
};

// Menu dengan roving focus. Enter dan Spasi memilih lewat klik tombol bawaan.
export function MenuList({ label, items, checked, onPick }: MenuProps) {
  const radio = checked !== undefined;
  return (
    <div role="menu" aria-label={label} className="td-menu" onKeyDown={(e) => moveFocus(e, '[role^="menuitem"]')}>
      {items.map((it) => {
        const on = radio && it.value === checked;
        return (
          <button
            key={it.value}
            type="button"
            role={radio ? "menuitemradio" : "menuitem"}
            aria-checked={radio ? on : undefined}
            tabIndex={-1}
            className={`td-mi${it.danger ? " td-mi-danger" : ""}`}
            onClick={() => onPick(it.value)}
          >
            {it.icon}
            <span className="td-mi-text">{it.label}</span>
            {on && <IconCheck size={17} className="td-mi-check" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}
