import { IconDots } from "@tabler/icons-react";
import { useCallback, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { toAppError, type AppError } from "../../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { ErrorAlert } from "../ErrorAlert";
import { isDisabled, isSeparator, type MenuAction, type MenuEntry } from "./items";
import { MenuPopup, type MenuAnchor } from "./MenuPopup";

type Options = {
  // Nama menu untuk pembaca layar, misalnya "Aksi untuk laporan.docx".
  label: string;
  items: MenuEntry[];
};

type OpenState = { anchor: MenuAnchor; returnTo: HTMLElement | null; owner: HTMLElement | null };

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

// Kolom teks punya menu sendiri (Potong, Salin, Tempel), jadi menu baris
// tidak mengambil alih klik kanan di dalamnya.
export function isTextField(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return ["text", "search", "email", "url", "tel", "password", "number", ""].includes(target.type);
  }
  return false;
}

function isMenuKey(e: KeyboardEvent): boolean {
  return e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
}

// Elemen yang menerima fokus lagi setelah menu ditutup: elemen terfokus yang
// diklik kanan, atau elemen pertama yang bisa difokus di baris itu.
function focusTarget(target: EventTarget | null, area: HTMLElement): HTMLElement | null {
  const el = target instanceof Element ? target.closest<HTMLElement>(FOCUSABLE) : null;
  if (el && area.contains(el)) return el;
  if (area.matches(FOCUSABLE)) return area;
  return area.querySelector<HTMLElement>("[data-menu-focus]") ?? area.querySelector<HTMLElement>(FOCUSABLE);
}

export type ContextMenuHandle = {
  // Sebarkan ke elemen baris: <li {...menu.triggerProps}>.
  triggerProps: {
    onContextMenu: (e: MouseEvent<HTMLElement>) => void;
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  };
  // Buka menu di bawah elemen ini (dipakai MenuButton).
  openAt: (el: HTMLElement, align?: "start" | "end") => void;
  close: () => void;
  isOpen: boolean;
  menuId: string;
  hasItems: boolean;
  // Render sekali di dalam komponen: menu (lewat portal) dan dialog konfirmasi.
  element: ReactNode;
};

// Menu klik kanan untuk satu baris. Dibuka dengan klik kanan, tombol Menu,
// Shift+F10, atau tombol "..." (MenuButton) yang memakai item yang sama.
export function useContextMenu({ label, items }: Options): ContextMenuHandle {
  const menuId = useId();
  const [open, setOpen] = useState<OpenState | null>(null);
  const [confirming, setConfirming] = useState<MenuAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  // Chromium juga mengirim event contextmenu setelah Shift+F10. Event itu
  // diabaikan kalau menu baru saja dibuka dari keyboard.
  const keyboardAt = useRef(0);
  const hasItems = items.some((e) => !isSeparator(e));

  const openRef = useRef<OpenState | null>(null);
  openRef.current = open;

  const close = useCallback((restoreFocus: boolean) => {
    const current = openRef.current;
    if (restoreFocus && current?.returnTo?.isConnected) current.returnTo.focus();
    openRef.current = null;
    setOpen(null);
  }, []);

  const select = useCallback(
    (item: MenuAction) => {
      if (isDisabled(item)) return;
      // Fokus kembali dulu, baru aksi berjalan. Dialog yang dibuka aksi
      // mencatat elemen terfokus sebagai pembukanya dan mengembalikan fokus ke sana.
      close(true);
      if (item.confirm) {
        setError(null);
        setConfirming(item);
        return;
      }
      void item.onSelect();
    },
    [close],
  );

  const onContextMenu = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      if (e.defaultPrevented) return;
      if (isTextField(e.target)) return;
      e.preventDefault();
      if (Date.now() - keyboardAt.current < 400) return;
      if (!hasItems) return;
      const area = e.currentTarget;
      const rect = area.getBoundingClientRect();
      // Event dari keyboard (tanpa posisi kursor yang masuk akal) dibuka di bawah baris.
      const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      const anchor: MenuAnchor =
        inside && (e.clientX !== 0 || e.clientY !== 0)
          ? { kind: "point", x: e.clientX, y: e.clientY }
          : { kind: "element", rect, align: "start" };
      setOpen({ anchor, returnTo: focusTarget(e.target, area), owner: null });
    },
    [hasItems],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (!isMenuKey(e) || isTextField(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      keyboardAt.current = Date.now();
      if (!hasItems) return;
      const from = e.target instanceof HTMLElement ? e.target : e.currentTarget;
      setOpen({
        anchor: { kind: "element", rect: from.getBoundingClientRect(), align: "start" },
        returnTo: focusTarget(e.target, e.currentTarget),
        owner: null,
      });
    },
    [hasItems],
  );

  const openAt = useCallback(
    (el: HTMLElement, align: "start" | "end" = "end") => {
      if (!hasItems) return;
      setOpen({ anchor: { kind: "element", rect: el.getBoundingClientRect(), align }, returnTo: el, owner: el });
    },
    [hasItems],
  );

  async function runConfirmed() {
    if (!confirming || busy) return;
    setBusy(true);
    setError(null);
    try {
      await confirming.onSelect();
      setConfirming(null);
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(false);
    }
  }

  const element = (
    <>
      {open && (
        <MenuPopup
          id={menuId}
          label={label}
          items={items}
          anchor={open.anchor}
          owner={open.owner}
          onClose={close}
          onSelect={select}
        />
      )}
      {confirming?.confirm && (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setConfirming(null);
          }}
          title={confirming.confirm.title}
          confirmLabel={confirming.confirm.confirmLabel}
          busyLabel={confirming.confirm.busyLabel}
          busy={busy}
          danger={confirming.danger ?? true}
          onConfirm={() => void runConfirmed()}
          error={error && <ErrorAlert title={`${confirming.label} gagal`}>{error.message}</ErrorAlert>}
        >
          {confirming.confirm.body}
        </ConfirmDialog>
      )}
    </>
  );

  return {
    triggerProps: { onContextMenu, onKeyDown },
    openAt,
    close: () => close(true),
    isOpen: open !== null,
    menuId,
    hasItems,
    element,
  };
}

type ButtonProps = {
  menu: ContextMenuHandle;
  // Nama tombol untuk pembaca layar, misalnya "Aksi untuk laporan.docx".
  label: string;
  disabled?: boolean;
  className?: string;
  icon?: ReactNode;
};

// Tombol "..." di baris: membuka menu yang sama dengan klik kanan, jadi
// setiap aksi tetap terjangkau tanpa klik kanan.
export function MenuButton({ menu, label, disabled, className, icon }: ButtonProps) {
  if (!menu.hasItems) return null;
  return (
    <button
      type="button"
      className={className ?? "btn btn-ghost btn-sm cmenu-more"}
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={menu.isOpen}
      aria-controls={menu.isOpen ? menu.menuId : undefined}
      disabled={disabled}
      onClick={(e) => {
        if (menu.isOpen) menu.close();
        else menu.openAt(e.currentTarget);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          if (!menu.isOpen) menu.openAt(e.currentTarget);
        }
      }}
    >
      {icon ?? <IconDots size={18} aria-hidden="true" />}
    </button>
  );
}
