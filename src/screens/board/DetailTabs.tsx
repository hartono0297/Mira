import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export type DetailTab = { id: string; label: string; count: number };

type Props = {
  label: string;
  tabs: DetailTab[];
  active: string;
  onChange: (id: string) => void;
  children: ReactNode;
};

// Tab dengan roving tabindex: hanya tab aktif yang masuk urutan Tab, panah
// kiri/kanan (dan Home/End) pindah tab sekaligus menampilkannya.
export function DetailTabs({ label, tabs, active, onChange, children }: Props) {
  const id = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const i = tabs.findIndex((t) => t.id === active);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const tab = tabs[next];
    onChange(tab.id);
    refs.current[tab.id]?.focus();
  }

  return (
    // div biasa, bukan section berlabel: nama "Komentar dan aktivitas" cukup sekali, di tablist.
    <div className="td-sec">
      <div className="td-tabs" role="tablist" aria-label={label} onKeyDown={onKey}>
        {tabs.map((t) => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`${id}-tab-${t.id}`}
              className="td-tab"
              aria-selected={on}
              aria-controls={`${id}-panel`}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(t.id)}
            >
              {t.label} <span className="td-tab-n">{t.count}</span>
            </button>
          );
        })}
      </div>
      <div className="td-panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${active}`} tabIndex={0}>
        {children}
      </div>
    </div>
  );
}
