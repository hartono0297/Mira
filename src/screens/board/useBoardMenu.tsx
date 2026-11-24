// Menu klik kanan board dengan sub-menu. Dibangun di atas menu bersama
// (src/components/ContextMenu), yang hanya punya daftar datar.
//
// Item sub-menu (submenu(...)) tampil dengan tanda › di kanan. Memilihnya
// (klik, Enter, Spasi, atau panah kanan) mengganti isi menu di tempat yang
// sama dengan daftar pilihannya. Baris pertama sub-menu adalah Kembali (juga
// panah kiri), tetapi fokus awal ada di pilihan pertama sesudahnya, seperti
// sub-menu biasa. Esc menutup semuanya dan fokus kembali ke elemen asal.
import { IconChevronLeft } from "@tabler/icons-react";
import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { toAppError, type AppError } from "../../api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { isTextField, SEPARATOR, useContextMenu, type ContextMenuHandle, type MenuAction, type MenuEntry } from "../../components/ContextMenu";
import { isDisabled, isSeparator } from "../../components/ContextMenu/items";
import { MenuPopup, type MenuAnchor } from "../../components/ContextMenu/MenuPopup";
import { TEKS } from "./teks";
import { TEKS_MENU } from "./teksMenu";
import "./board-menu.css";

export type SubMenu = {
  submenu: true;
  id: string;
  // Teks item di menu utama, misalnya "Pindahkan ke".
  label: string;
  // Nama sub-menu untuk pembaca layar, misalnya "Pindahkan TES-1 ke".
  menuLabel: string;
  icon?: ReactNode;
  disabled?: boolean | string;
  // Isi sub-menu. Item dengan `confirm` meminta konfirmasi dulu lewat
  // ConfirmDialog, sama dengan item menu utama.
  items: MenuEntry[];
};

export type BoardMenuEntry = MenuEntry | SubMenu;

export function submenu(def: Omit<SubMenu, "submenu">): SubMenu {
  return { submenu: true, ...def };
}

function isSub(e: BoardMenuEntry): e is SubMenu {
  return "submenu" in e;
}

// Sama dengan menuItems bersama, tetapi menerima sub-menu. Sub-menu tanpa
// isi dibuang.
export function boardMenuItems(...entries: (BoardMenuEntry | false | null | undefined)[]): BoardMenuEntry[] {
  const out: BoardMenuEntry[] = [];
  for (const e of entries) {
    if (!e) continue;
    if (isSub(e) && !e.items.some((i) => !isSeparator(i))) continue;
    const sep = !isSub(e) && isSeparator(e);
    const last = out[out.length - 1];
    if (sep && (out.length === 0 || (!isSub(last) && isSeparator(last)))) continue;
    out.push(e);
  }
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (isSub(last) || !isSeparator(last)) break;
    out.pop();
  }
  return out;
}

type Point = { x: number; y: number };

// Cara menu utama dibuka, supaya Kembali membukanya lagi dengan cara yang
// sama: dari baris (klik kanan, Shift+F10) atau dari tombol "..." (openAt).
type Origin = { kind: "row"; area: HTMLElement } | { kind: "button"; el: HTMLElement; align: "start" | "end" };

type OpenSub = {
  id: string;
  anchor: MenuAnchor;
  // Pojok kiri atas menu utama (koordinat jendela). Sub-menu tampil di sini,
  // dan menu utama kembali ke sini setelah Kembali.
  at: Point | null;
  returnTo: HTMLElement | null;
  // Tombol "..." pembuka menu: klik di sana diurus tombolnya (buka-tutup).
  owner: HTMLElement | null;
  // Dialog modal tempat menu utama dirender, atau null.
  container: HTMLElement | null;
};

// Penanda tampilan sub-menu di kanan item. Hanya tampilan (aria-hidden di menu
// bersama); atribut pintasan dibuang lagi setelah menu tergambar.
const SUB_MARK = "›";
const BACK_ID = "__back";
// Jarak minimum dari tepi jendela atau dialog, sama dengan MenuPopup.
const EDGE = 8;

function dialogOf(el: Element | null | undefined): HTMLElement | null {
  return el?.closest<HTMLElement>("[role=dialog]") ?? null;
}

function isMenuKey(e: KeyboardEvent): boolean {
  return e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
}

// Letakkan menu yang sudah tergambar di titik `at`, dijepit ke batas jendela
// atau dialog. Berbeda dengan penempatan titik di MenuPopup, menu tidak
// dibalik ke kiri atau ke atas: sub-menu yang lebih lebar tetap berimpit
// dengan menu utama, tidak melompat ke sisi lain.
function pin(el: HTMLElement, at: Point, container: HTMLElement | null) {
  const view = container ? container.getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const box = el.getBoundingClientRect();
  const x = Math.max(view.left + EDGE, Math.min(at.x, view.right - box.width - EDGE));
  const y = Math.max(view.top + EDGE, Math.min(at.y, view.bottom - box.height - EDGE));
  // Geser dari posisi sekarang, jadi titik acuan position: fixed di dalam
  // dialog (yang memakai transform) tidak perlu dihitung ulang.
  el.style.left = `${(parseFloat(el.style.left) || 0) + x - box.left}px`;
  el.style.top = `${(parseFloat(el.style.top) || 0) + y - box.top}px`;
}

// Shift+F10 di elemen asal: menu utama terbuka lagi lewat jalur baris biasa,
// dengan elemen asal dan perilaku klik di luar yang sama seperti semula.
function menuKeyAt(target: HTMLElement, area: HTMLElement): KeyboardEvent<HTMLElement> {
  return {
    key: "F10",
    shiftKey: true,
    target,
    currentTarget: area,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as KeyboardEvent<HTMLElement>;
}

export function useBoardMenu({ label, items }: { label: string; items: BoardMenuEntry[] }): ContextMenuHandle {
  const subMenuId = useId();
  const [sub, setSub] = useState<OpenSub | null>(null);
  const subRef = useRef(sub);
  subRef.current = sub;
  const subs = items.filter(isSub);
  const rootRef = useRef<ContextMenuHandle | null>(null);
  const originRef = useRef<Origin | null>(null);
  // Menu utama yang dibuka lagi oleh Kembali: posisi semula dan item
  // sub-menu yang difokus, dipulihkan pada render sesudahnya.
  const restoreRef = useRef<{ at: Point | null; container: HTMLElement | null; focusId: string } | null>(null);

  const openSub = useCallback((id: string) => {
    // Menu utama baru saja menutup dan fokus sudah kembali ke elemen asalnya.
    // Elemen menunya masih ada di DOM sampai render berikutnya. Tanpa elemen
    // asal, fokus masih di item menu yang segera hilang: itu bukan elemen asal.
    const menuEl = rootRef.current ? document.getElementById(rootRef.current.menuId) : null;
    const active = document.activeElement;
    const returnTo = active instanceof HTMLElement && active !== document.body && !menuEl?.contains(active) ? active : null;
    const r = menuEl?.getBoundingClientRect();
    const at = r && (r.width > 0 || r.height > 0) ? { x: r.left, y: r.top } : null;
    const anchor: MenuAnchor = at
      ? { kind: "point", x: at.x, y: at.y }
      : { kind: "element", rect: (returnTo ?? document.body).getBoundingClientRect(), align: "start" };
    const origin = originRef.current;
    setSub({
      id,
      anchor,
      at,
      returnTo,
      owner: origin?.kind === "button" && origin.el.isConnected ? origin.el : null,
      container: dialogOf(menuEl) ?? dialogOf(returnTo),
    });
  }, []);

  const rootItems: MenuEntry[] = items.map((e) =>
    isSub(e)
      ? ({ id: e.id, label: e.label, icon: e.icon, disabled: e.disabled, shortcut: SUB_MARK, onSelect: () => openSub(e.id) } satisfies MenuAction)
      : e,
  );
  const root = useContextMenu({ label, items: rootItems });
  rootRef.current = root;

  // Item sub-menu diberi aria-haspopup, dan tanda › bukan pintasan keyboard.
  const subIds = subs.map((s) => s.id).join("|");
  useLayoutEffect(() => {
    if (!root.isOpen || !subIds) return;
    const menuEl = document.getElementById(root.menuId);
    if (!menuEl) return;
    for (const id of subIds.split("|")) {
      const el = menuEl.querySelector<HTMLElement>(`[data-menu-item="${CSS.escape(id)}"]`);
      if (!el) continue;
      el.setAttribute("aria-haspopup", "menu");
      el.removeAttribute("aria-keyshortcuts");
    }
  });

  // Menu utama yang dibuka lagi oleh Kembali muncul di posisi semula (bukan
  // di bawah elemen asal) dengan fokus di item sub-menu tadi, bukan di item
  // pertama. Efek ini berjalan sesudah MenuPopup menempatkan dan memfokus.
  useLayoutEffect(() => {
    const want = restoreRef.current;
    if (!want) return;
    restoreRef.current = null;
    const el = root.isOpen ? document.getElementById(root.menuId) : null;
    if (!el) return;
    if (want.at) pin(el, want.at, want.container);
    el.querySelector<HTMLElement>(`[data-menu-item="${CSS.escape(want.focusId)}"]`)?.focus({ preventScroll: true });
  });

  const closeSub = useCallback((restoreFocus: boolean) => {
    const current = subRef.current;
    subRef.current = null;
    setSub(null);
    if (restoreFocus && current?.returnTo?.isConnected) current.returnTo.focus();
  }, []);

  const back = useCallback(() => {
    const current = subRef.current;
    closeSub(true);
    const menu = rootRef.current;
    if (!current || !menu) return;
    // Elemen asal bisa null: baris tanpa elemen yang bisa difokus.
    const el = current.returnTo?.isConnected ? current.returnTo : null;
    const origin = originRef.current;
    restoreRef.current = { at: current.at, container: current.container, focusId: current.id };
    if (origin?.kind === "button" && origin.el.isConnected && (!el || origin.el === el)) {
      menu.openAt(origin.el, origin.align);
    } else if (origin?.kind === "row" && origin.area.isConnected && (!el || origin.area.contains(el))) {
      menu.triggerProps.onKeyDown(menuKeyAt(el && !isTextField(el) ? el : origin.area, origin.area));
    } else if (el) {
      menu.openAt(el, "start");
    } else {
      restoreRef.current = null;
    }
  }, [closeSub]);

  const openDef = sub ? subs.find((s) => s.id === sub.id) : undefined;
  // Sub-menu bisa hilang selagi terbuka (misalnya hak berubah dari rekan).
  const orphan = !!sub && !openDef;
  useLayoutEffect(() => {
    if (orphan) closeSub(true);
  }, [orphan, closeSub]);

  // Sub-menu baru: letakkan di posisi menu utama, lalu fokus ke pilihan
  // pertama sesudah Kembali. MenuPopup sudah memfokus Kembali; efek ini
  // berjalan sesudahnya.
  useLayoutEffect(() => {
    if (!sub) return;
    const el = document.getElementById(subMenuId);
    if (!el) return;
    if (sub.at) pin(el, sub.at, sub.container);
    const all = el.querySelectorAll<HTMLElement>("[role=menuitem]");
    (all[1] ?? all[0])?.focus({ preventScroll: true });
  }, [sub, subMenuId]);

  const subItems: MenuEntry[] = openDef
    ? [{ id: BACK_ID, label: TEKS_MENU.kembali, icon: <IconChevronLeft size={16} />, onSelect: back }, SEPARATOR, ...openDef.items]
    : [];

  // Item sub-menu dengan `confirm` yang sedang menunggu jawaban, seperti
  // konfirmasi di menu bersama.
  const [confirming, setConfirming] = useState<MenuAction | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<AppError | null>(null);

  const selectSub = useCallback(
    (item: MenuAction) => {
      if (isDisabled(item)) return;
      if (item.id === BACK_ID) {
        item.onSelect();
        return;
      }
      // Fokus kembali dulu, baru aksi berjalan (sama dengan menu bersama).
      closeSub(true);
      if (item.confirm) {
        setConfirmError(null);
        setConfirming(item);
        return;
      }
      // Aksi tanpa konfirmasi tidak punya tempat menampilkan galat; layar
      // pemilik aksi yang memberi tahu pengguna. Di sini cukup tidak hilang diam-diam.
      try {
        Promise.resolve(item.onSelect()).catch((err: unknown) => console.error(`Aksi menu "${item.label}" gagal`, err));
      } catch (err) {
        console.error(`Aksi menu "${item.label}" gagal`, err);
      }
    },
    [closeSub],
  );

  async function runConfirmed() {
    const item = confirming;
    if (!item || confirmBusy) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      await item.onSelect();
      setConfirming(null);
    } catch (err) {
      setConfirmError(toAppError(err));
    } finally {
      setConfirmBusy(false);
    }
  }

  // Panah kanan di item sub-menu membukanya; panah kiri di sub-menu kembali.
  function onRootKeys(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== "ArrowRight" || !root.isOpen) return;
    const t = e.target as HTMLElement;
    if (!document.getElementById(root.menuId)?.contains(t)) return;
    const id = t.dataset.menuItem;
    if (!id || !subs.some((s) => s.id === id)) return;
    e.preventDefault();
    e.stopPropagation();
    t.click();
  }

  function onSubKeys(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== "ArrowLeft") return;
    e.preventDefault();
    e.stopPropagation();
    back();
  }

  // Membuka menu utama lagi (klik kanan, Shift+F10, tombol "...") selagi
  // sub-menu terbuka mulai dari menu utama, bukan dua menu sekaligus.
  const { onContextMenu, onKeyDown } = root.triggerProps;
  const triggerProps = {
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      if (!e.defaultPrevented && e.target instanceof Node && e.currentTarget.contains(e.target)) {
        if (subRef.current) closeSub(false);
        originRef.current = { kind: "row", area: e.currentTarget };
      }
      onContextMenu(e);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (isMenuKey(e) && e.target instanceof Node && e.currentTarget.contains(e.target) && !isTextField(e.target)) {
        if (subRef.current) closeSub(false);
        originRef.current = { kind: "row", area: e.currentTarget };
      }
      onKeyDown(e);
    },
  };

  const openAt = useCallback(
    (el: HTMLElement, align: "start" | "end" = "end", focusLast?: boolean) => {
      if (subRef.current) closeSub(false);
      originRef.current = { kind: "button", el, align };
      rootRef.current?.openAt(el, align, focusLast);
    },
    [closeSub],
  );

  const element = (
    <>
      <span className="bm-wrap" onKeyDownCapture={onRootKeys}>
        {root.element}
      </span>
      {sub && openDef && (
        <span className="bm-wrap" onKeyDownCapture={onSubKeys}>
          <MenuPopup
            id={subMenuId}
            label={openDef.menuLabel}
            items={subItems}
            anchor={sub.anchor}
            owner={sub.owner}
            container={sub.container}
            onClose={closeSub}
            onSelect={selectSub}
          />
        </span>
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
          busy={confirmBusy}
          danger={confirming.danger ?? true}
          onConfirm={() => void runConfirmed()}
          error={confirmError && <ErrorAlert title={TEKS.aksiGagal(confirming.label)}>{confirmError.message}</ErrorAlert>}
        >
          {confirming.confirm.body}
        </ConfirmDialog>
      )}
    </>
  );

  return {
    triggerProps,
    openAt,
    close: () => {
      if (subRef.current) closeSub(true);
      else root.close();
    },
    isOpen: root.isOpen || !!openDef,
    menuId: openDef ? subMenuId : root.menuId,
    hasItems: root.hasItems,
    element,
  };
}
