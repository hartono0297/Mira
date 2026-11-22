import { useCallback, useLayoutEffect, useRef, type FocusEvent, type RefObject } from "react";

// Data board diganti saat muat ulang (misalnya rekan memindah atau menghapus
// kartu). Kalau elemen yang sedang difokus ikut hilang dari halaman, fokus
// jatuh ke body dan pengguna keyboard kehilangan tempatnya. Hook ini mencatat
// elemen terakhir yang difokus di dalam root, lalu setelah render memindahkan
// fokus ke pengganti terdekat:
//   1. butir yang sama di tempat barunya ([data-rescue="<id>"]),
//   2. butir di posisi yang sama dalam kelompoknya ([data-rescue-group]),
//   3. elemen cadangan kelompok (opsi `spare`), lalu `fallback`.
// Fokus hanya dipindah kalau elemen lamanya sudah lepas dari halaman dan
// fokus sekarang ada di body, jadi klik pengguna ke tempat lain tidak direbut.

type Last = { el: HTMLElement; key: string | null; group: string | null; index: number };

type Options = {
  // Elemen di dalam kelompok yang dipakai kalau kelompoknya kosong, misalnya tombol Tambah task.
  spare?: string;
  fallback?: RefObject<HTMLElement | null>;
  // Ditunda selama dialog terbuka: fokus sedang dikunci di dalam dialog.
  paused?: boolean;
};

function firstFocusable(item: Element | null | undefined): HTMLElement | null {
  return item?.querySelector<HTMLElement>("button, [href], input, textarea, select") ?? null;
}

export function useFocusRescue(root: RefObject<HTMLElement | null>, { spare, fallback, paused = false }: Options = {}) {
  const last = useRef<Last | null>(null);

  const onFocus = useCallback((e: FocusEvent<HTMLElement>) => {
    const el = e.target as HTMLElement;
    // Event React ikut naik dari dialog (portal) yang dipasang di dalam komponen; abaikan.
    if (!e.currentTarget.contains(el)) return;
    const item = el.closest<HTMLElement>("[data-rescue]");
    const groupEl = el.closest<HTMLElement>("[data-rescue-group]");
    const items = groupEl ? Array.from(groupEl.querySelectorAll<HTMLElement>("[data-rescue]")) : [];
    last.current = {
      el,
      key: item?.dataset.rescue ?? null,
      group: groupEl?.dataset.rescueGroup ?? null,
      index: item ? items.indexOf(item) : -1,
    };
  }, []);

  useLayoutEffect(() => {
    const l = last.current;
    const container = root.current;
    if (!l || paused || !container || l.el.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body) {
      last.current = null;
      return;
    }
    let target: HTMLElement | null = null;
    if (l.key) target = firstFocusable(container.querySelector(`[data-rescue="${l.key}"]`));
    if (!target && l.group) {
      const groupEl = container.querySelector<HTMLElement>(`[data-rescue-group="${l.group}"]`);
      const items = groupEl ? groupEl.querySelectorAll<HTMLElement>("[data-rescue]") : null;
      if (items && items.length > 0 && l.index >= 0) target = firstFocusable(items[Math.min(l.index, items.length - 1)]);
      if (!target && spare) target = groupEl?.querySelector<HTMLElement>(spare) ?? null;
    }
    target ??= fallback?.current ?? null;
    last.current = null;
    target?.focus();
  });

  return onFocus;
}
