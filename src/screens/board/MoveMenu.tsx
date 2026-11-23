import { IconArrowsMove } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

export type MoveOption = { key: string; label: string; run: () => void };

type Props = {
  code: string;
  options: MoveOption[];
};

// Tombol "Pindahkan" per kartu: alternatif keyboard untuk drag-and-drop.
// Panah atas/bawah memilih, Enter menjalankan, Escape menutup dan fokus
// kembali ke tombol.
export function MoveMenu({ code, options }: Props) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const menuId = useId();

  function items(): HTMLButtonElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
  }

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function close(focusButton: boolean) {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }

  function onMenuKey(e: KeyboardEvent<HTMLUListElement>) {
    // Shift+F10 dan tombol Menu di menu ini tidak membuka menu kartu di atasnya.
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (at + 1) % list.length;
    else if (e.key === "ArrowUp") next = (at - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    } else if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    if (next !== null) {
      e.preventDefault();
      e.stopPropagation();
      list[next]?.focus();
    }
  }

  return (
    <div
      className="mv"
      data-no-drag
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        // Fokus pindah ke luar (misalnya menu kartu dari klik kanan): menu ditutup.
        // Tanpa relatedTarget (klik di bagian yang tidak bisa difokus) diputuskan oleh mousedown.
        if (!open || !next || e.currentTarget.contains(next)) return;
        setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="mv-btn"
        aria-label={`Pindahkan ${code}`}
        title="Pindahkan"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !e.altKey) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <IconArrowsMove size={16} aria-hidden="true" />
      </button>
      {open && (
        <ul ref={menuRef} id={menuId} role="menu" aria-label={`Pindahkan ${code}`} className="mv-menu" onKeyDown={onMenuKey}>
          {options.map((o) => (
            <li key={o.key} role="none">
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="mv-item"
                onClick={() => {
                  setOpen(false);
                  o.run();
                }}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
