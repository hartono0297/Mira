// Pemilih emoji (v0.5.1): kolom cari, tab kategori, dan kisi emoji. Komponen
// umum, tidak tahu soal Chat. Pemanggil mengatur posisi lewat className (komponen
// ini position: absolute di dalam pembungkus pemanggil) dan mengembalikan fokus
// ke tombol pemicu di onClose.
//
// Keyboard: Tab dan Shift+Tab berputar di kolom cari, tab kategori, dan kisi.
// Di tab kategori panah kiri/kanan, Home, End pindah kategori; panah bawah masuk
// ke kisi. Di kisi panah menggerakkan sorotan (roving tabindex), Home/End ke
// emoji pertama/terakhir, Enter atau Spasi memilih, huruf apa pun pindah ke
// kolom cari. Esc menutup dari mana saja.
//
// Klik di luar menutup, kecuali klik pada elemen ber-aria-expanded="true": itu
// tombol pemicu yang sedang membuka pemilih ini, dan tombol itu sendiri yang
// menutupnya. Tanpa pengecualian ini, klik pada pemicu menutup lalu langsung
// membuka lagi.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLang, type Lang } from "../../i18n/core";
import { EMOJI_TEXT } from "../../i18n/emoji";
import {
  CATEGORY_ICON,
  EMOJI_CATEGORIES,
  emojiInCategory,
  emojiName,
  findEmoji,
  normalizeSearch,
  searchEmoji,
  type EmojiCategory,
  type EmojiEntry,
} from "./emojiData";
import "./emoji-picker.css";

export type EmojiEmote = { name: string; render: () => ReactNode };

export type EmojiPickerProps = {
  onPick: (emoji: string) => void; // emoji Unicode, atau ":nama:" untuk emote kantor
  onClose: () => void; // Esc, klik di luar, atau setelah memilih kalau closeOnPick
  recent: string[]; // dari StickerCatalog.recentEmoji
  emotes?: EmojiEmote[]; // emote kantor, tab "Emote kantor"
  closeOnPick?: boolean; // bawaan true
  labelledBy?: string;
  className?: string;
};

type TabId = "recent" | "office" | EmojiCategory;

type Item = { key: string; value: string; label: string; char?: string; emote?: EmojiEmote };

// Jumlah kolom kisi. Panah atas/bawah melompat sebanyak ini.
export const EMOJI_COLUMNS = 9;
const SEARCH_LIMIT = 40;
const EMOTE = /^:([a-z0-9_]{2,32}):$/;
const TAB_ICON: Record<"recent" | "office", string> = { recent: "🕘", office: "🏢" };

function entryItem(entry: EmojiEntry, lang: Lang): Item {
  return { key: entry.char, value: entry.char, label: emojiName(entry, lang), char: entry.char };
}

function emoteItem(emote: EmojiEmote): Item {
  const value = `:${emote.name}:`;
  return { key: value, value, label: value, emote };
}

function unique(items: Item[]): Item[] {
  const seen = new Set<string>();
  return items.filter((it) => (seen.has(it.key) ? false : (seen.add(it.key), true)));
}

export function EmojiPicker({
  onPick,
  onClose,
  recent,
  emotes = [],
  closeOnPick = true,
  labelledBy,
  className,
}: EmojiPickerProps) {
  const lang = useLang();
  const uid = useId();
  const gridId = `${uid}-grid`;
  const headingId = `${uid}-heading`;

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tablistRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});
  const cellRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const closeRef = useRef(onClose);

  const tabs = useMemo<TabId[]>(
    () => [
      ...(recent.length > 0 ? (["recent"] as const) : []),
      ...(emotes.length > 0 ? (["office"] as const) : []),
      ...EMOJI_CATEGORIES,
    ],
    [recent.length, emotes.length],
  );

  const [tab, setTab] = useState<TabId>(() => (recent.length > 0 ? "recent" : EMOJI_CATEGORIES[0]));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const current: TabId = tabs.includes(tab) ? tab : tabs[0];
  const trimmed = query.trim();
  const searching = normalizeSearch(query) !== "";

  const items = useMemo<Item[]>(() => {
    if (searching) {
      const q = normalizeSearch(query);
      const emoteHits = emotes
        .map((e) => ({ e, n: normalizeSearch(e.name) }))
        .filter(({ n }) => n.includes(q))
        .sort((a, b) => Number(!a.n.startsWith(q)) - Number(!b.n.startsWith(q)))
        .map(({ e }) => emoteItem(e));
      return unique([...emoteHits, ...searchEmoji(query, SEARCH_LIMIT).map((e) => entryItem(e, lang))]);
    }
    if (current === "office") return unique(emotes.map(emoteItem));
    if (current === "recent") {
      const byName = new Map(emotes.map((e) => [e.name, e]));
      const out: Item[] = [];
      for (const value of recent) {
        const m = EMOTE.exec(value);
        if (m) {
          const emote = byName.get(m[1]);
          if (emote) out.push(emoteItem(emote));
          continue;
        }
        const entry = findEmoji(value);
        out.push(entry ? entryItem(entry, lang) : { key: value, value, label: value, char: value });
      }
      return unique(out);
    }
    return emojiInCategory(current).map((e) => entryItem(e, lang));
  }, [searching, query, emotes, current, recent, lang]);

  const activeIdx = Math.min(active, Math.max(0, items.length - 1));

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onDown(e: Event) {
      const root = rootRef.current;
      const target = e.target;
      if (!root || !(target instanceof Node) || root.contains(target)) return;
      if (target instanceof Element && target.closest('[aria-expanded="true"]')) return;
      closeRef.current();
    }
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  function resetGrid() {
    setActive(0);
    if (gridRef.current) gridRef.current.scrollTop = 0;
  }

  function pick(item: Item) {
    onPick(item.value);
    if (closeOnPick) onClose();
  }

  function focusCell(i: number) {
    setActive(i);
    const el = cellRefs.current[i];
    el?.focus();
    el?.scrollIntoView?.({ block: "nearest" });
  }

  function selectTab(next: TabId) {
    setTab(next);
    setQuery("");
    resetGrid();
  }

  function focusSearch() {
    inputRef.current?.focus();
  }

  function onRootKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const zones = [inputRef.current, tabRefs.current[current] ?? null, items.length > 0 ? cellRefs.current[activeIdx] : null].filter(
      (z): z is HTMLInputElement | HTMLButtonElement => z !== null,
    );
    const focused = document.activeElement;
    let at = 0;
    if (tablistRef.current?.contains(focused)) at = 1;
    else if (gridRef.current?.contains(focused)) at = 2;
    const pos = Math.max(0, Math.min(at, zones.length - 1));
    const next = (pos + (e.shiftKey ? -1 : 1) + zones.length) % zones.length;
    e.preventDefault();
    zones[next].focus();
  }

  function onInputKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" && items.length > 0) {
      e.preventDefault();
      focusCell(activeIdx);
    } else if (e.key === "Enter" && searching && items.length > 0) {
      e.preventDefault();
      pick(items[0]);
    }
  }

  function onTabsKey(e: KeyboardEvent<HTMLDivElement>) {
    const i = tabs.indexOf(current);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else if (e.key === "ArrowDown" && items.length > 0) {
      e.preventDefault();
      focusCell(activeIdx);
      return;
    }
    if (next < 0) return;
    e.preventDefault();
    selectTab(tabs[next]);
    tabRefs.current[tabs[next]]?.focus();
  }

  function onGridKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const n = items.length;
    if (n === 0) return;
    const i = activeIdx;
    const lastRow = Math.floor((n - 1) / EMOJI_COLUMNS);
    let next = -1;
    switch (e.key) {
      case "ArrowRight":
        next = Math.min(i + 1, n - 1);
        break;
      case "ArrowLeft":
        next = Math.max(i - 1, 0);
        break;
      case "ArrowDown":
        next = Math.floor(i / EMOJI_COLUMNS) < lastRow ? Math.min(i + EMOJI_COLUMNS, n - 1) : i;
        break;
      case "ArrowUp":
        if (i < EMOJI_COLUMNS) {
          e.preventDefault();
          focusSearch();
          return;
        }
        next = i - EMOJI_COLUMNS;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = n - 1;
        break;
      case "Backspace":
        e.preventDefault();
        setQuery((q) => q.slice(0, -1));
        resetGrid();
        focusSearch();
        return;
      default:
        // Huruf yang diketik saat fokus di kisi masuk ke kolom cari.
        if (e.key.length === 1 && e.key !== " ") {
          e.preventDefault();
          setQuery((q) => q + e.key);
          resetGrid();
          focusSearch();
        }
        return;
    }
    e.preventDefault();
    focusCell(next);
  }

  const T = EMOJI_TEXT;
  const heading = searching ? T.results(trimmed) : T.category[current];
  const emptyText = searching ? T.noResults(trimmed) : T.emptyRecent;
  const rows: Item[][] = [];
  for (let i = 0; i < items.length; i += EMOJI_COLUMNS) rows.push(items.slice(i, i + EMOJI_COLUMNS));

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={labelledBy ? undefined : T.dialog}
      aria-labelledby={labelledBy}
      className={className ? `emoji-picker ${className}` : "emoji-picker"}
      onKeyDown={onRootKey}
    >
      <input
        ref={inputRef}
        className="emoji-search"
        type="text"
        value={query}
        aria-label={T.search}
        placeholder={T.searchPlaceholder}
        aria-controls={gridId}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          resetGrid();
        }}
        onKeyDown={onInputKey}
      />

      <div ref={tablistRef} className="emoji-tabs" role="tablist" aria-label={T.categories} onKeyDown={onTabsKey}>
        {tabs.map((t) => {
          const label = T.category[t];
          return (
            <button
              key={t}
              ref={(el) => {
                tabRefs.current[t] = el;
              }}
              type="button"
              role="tab"
              id={`${uid}-tab-${t}`}
              className="emoji-tab"
              aria-selected={!searching && t === current}
              aria-controls={gridId}
              aria-label={label}
              title={label}
              tabIndex={t === current ? 0 : -1}
              onClick={() => selectTab(t)}
            >
              <span className="emoji-tab-icon" aria-hidden="true">
                {t === "recent" || t === "office" ? TAB_ICON[t] : CATEGORY_ICON[t]}
              </span>
            </button>
          );
        })}
      </div>

      <div id={headingId} className="emoji-heading">
        {heading}
      </div>

      {items.length > 0 ? (
        <div ref={gridRef} id={gridId} className="emoji-grid" role="grid" aria-labelledby={headingId} onKeyDown={onGridKey}>
          {rows.map((row, r) => (
            <div key={r} role="row" className="emoji-row">
              {row.map((item, c) => {
                const i = r * EMOJI_COLUMNS + c;
                return (
                  <div key={item.key} role="gridcell">
                    <button
                      ref={(el) => {
                        cellRefs.current[i] = el;
                      }}
                      type="button"
                      className="emoji-cell"
                      tabIndex={i === activeIdx ? 0 : -1}
                      aria-label={item.label}
                      title={item.label}
                      onFocus={() => setActive(i)}
                      onClick={() => pick(item)}
                    >
                      {item.emote ? (
                        <span className="emoji-emote" aria-hidden="true">
                          {item.emote.render()}
                        </span>
                      ) : (
                        <span className="emoji-glyph" aria-hidden="true">
                          {item.char}
                        </span>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        <p id={gridId} className="emoji-empty" role="status">
          {emptyText}
        </p>
      )}
    </div>
  );
}
