// Pemilih sticker di kolom pesan (v0.5.1, docs/plans/chat-sticker.md bagian 7).
// Tab Kantor (per paket) dan Punya saya, pencarian nama dan kata kunci, kisi thumbnail
// dengan panah, Enter mengirim langsung. Di Punya saya: unggah dan hapus sticker pribadi.
import { IconLoader2, IconSearch, IconTrash, IconUpload } from "@tabler/icons-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { toAppError, type AppError } from "../../api";
import {
  chatApi,
  STICKER_MAX_KEYWORDS,
  STICKER_NAME_PATTERN,
  type MessageView,
  type PickedSticker,
  type StickerCatalog,
  type StickerSource,
} from "../../api/chat";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { STICKER_TEXT } from "../../i18n/chat-sticker";
import { reloadStickerCatalog, useStickerCatalog } from "./stickerCatalog";
import { StickerImage } from "./StickerImage";
import { formatSize } from "./text";
import "./sticker-picker.css";

// Jumlah kolom kisi. Tetap, supaya panah atas dan bawah bisa dihitung tanpa mengukur layar.
export const STICKER_COLUMNS = 5;
const KEYWORD_MAX_CHARS = 24;

export type StickerTab = "office" | "mine";

type Item = {
  key: string;
  name: string;
  hash: string;
  ready: boolean;
  source: StickerSource;
};

type Group = { title: string | null; items: Item[] };

type Props = {
  conv: string;
  replyTo: string | null;
  onSent: (message: MessageView) => void;
  // escape: tutup lewat Esc (fokus kembali ke tombol Sticker). outside: klik di luar panel.
  onClose: (reason: "escape" | "outside") => void;
  // Tombol pembuka: klik di sana tidak dihitung klik di luar (tombol itu sendiri menutup).
  anchorRef: RefObject<HTMLElement | null>;
};

function matches(query: string, name: string, keywords: string[]): boolean {
  if (!query) return true;
  return name.includes(query) || keywords.some((k) => k.includes(query));
}

// Query pencarian: huruf kecil, tanpa titik dua di depan dan belakang (":kopi:" sama dengan "kopi").
export function stickerQuery(raw: string): string {
  return raw.trim().toLowerCase().replace(/^:+|:+$/g, "");
}

export function stickerGroups(catalog: StickerCatalog | null, tab: StickerTab, query: string): Group[] {
  if (!catalog) return [];
  if (tab === "mine") {
    const items = catalog.mine
      .filter((s) => matches(query, s.name, s.keywords))
      .map<Item>((s) => ({
        key: s.id,
        name: s.name,
        hash: s.hash,
        ready: true,
        source: { kind: "mine", id: s.id },
      }));
    return items.length ? [{ title: null, items }] : [];
  }
  // Superadmin juga menerima sticker yang disembunyikan; itu tidak bisa dikirim.
  const groups: Group[] = [];
  for (const s of catalog.office) {
    if (s.state !== "active" || !matches(query, s.name, s.keywords)) continue;
    let last = groups[groups.length - 1];
    if (!last || last.title !== s.pack) {
      last = { title: s.pack, items: [] };
      groups.push(last);
    }
    last.items.push({ key: s.id, name: s.name, hash: s.hash, ready: s.ready, source: { kind: "office", id: s.id } });
  }
  return groups;
}

// Baris logis kisi: setiap paket mulai di baris baru, STICKER_COLUMNS per baris.
// Isinya indeks datar item.
export function gridRows(groups: Group[], columns = STICKER_COLUMNS): number[][] {
  const rows: number[][] = [];
  let n = 0;
  for (const g of groups) {
    for (let i = 0; i < g.items.length; i += columns) {
      const row: number[] = [];
      for (let j = i; j < Math.min(i + columns, g.items.length); j++) row.push(n + j);
      rows.push(row);
    }
    n += g.items.length;
  }
  return rows;
}

// Indeks tujuan untuk tombol panah, Home, dan End. null kalau tombolnya bukan navigasi kisi.
export function moveInGrid(rows: number[][], index: number, key: string): number | null {
  const total = rows.reduce((sum, r) => sum + r.length, 0);
  if (total === 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return total - 1;
  if (key === "ArrowLeft") return Math.max(0, index - 1);
  if (key === "ArrowRight") return Math.min(total - 1, index + 1);
  if (key !== "ArrowUp" && key !== "ArrowDown") return null;
  const r = rows.findIndex((row) => row.includes(index));
  if (r === -1) return 0;
  const col = rows[r].indexOf(index);
  const target = rows[key === "ArrowUp" ? r - 1 : r + 1];
  if (!target) return index;
  return target[Math.min(col, target.length - 1)];
}

// Saran nama dari nama file: huruf kecil, selain [a-z0-9_] jadi garis bawah.
export function suggestStickerName(fileName: string): string {
  const base = fileName.replace(/\.[^.]*$/, "").replace(/\.sticker$/, "");
  const name = base
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 32)
    .replace(/_$/, "");
  return name.length >= 2 ? name : "";
}

// Kata kunci dari isian: dipisah koma atau spasi, huruf kecil, tanpa duplikat.
export function parseKeywords(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.toLowerCase().split(/[\s,]+/)) {
    if (part && !out.includes(part)) out.push(part);
  }
  return out;
}

type FormErrors = { name?: string; keywords?: string };

function validateForm(name: string, keywords: string[]): FormErrors {
  const T = STICKER_TEXT.form;
  const errors: FormErrors = {};
  if (!STICKER_NAME_PATTERN.test(name)) errors.name = T.nameInvalid;
  const long = keywords.find((k) => [...k].length > KEYWORD_MAX_CHARS);
  if (keywords.length > STICKER_MAX_KEYWORDS) errors.keywords = T.tooManyKeywords(STICKER_MAX_KEYWORDS);
  else if (long) errors.keywords = T.keywordTooLong(long);
  return errors;
}

type UploadFormProps = {
  picked: PickedSticker;
  onSaved: () => void;
  onCancel: () => void;
};

function UploadForm({ picked, onSaved, onCancel }: UploadFormProps) {
  const T = STICKER_TEXT.form;
  const ids = useId();
  const [name, setName] = useState(() => suggestStickerName(picked.name));
  const [keywords, setKeywords] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<AppError | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const keywordsRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    nameRef.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const clean = name.trim();
    const words = parseKeywords(keywords);
    const found = validateForm(clean, words);
    setErrors(found);
    if (found.name) return nameRef.current?.focus();
    if (found.keywords) return keywordsRef.current?.focus();
    setSaving(true);
    setSaveError(null);
    try {
      await chatApi.addMySticker(picked.path, clean, words);
      await reloadStickerCatalog();
      if (alive.current) onSaved();
    } catch (err) {
      if (alive.current) setSaveError(toAppError(err));
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  const details = T.details(formatSize(picked.size), picked.width, picked.height);
  return (
    <form
      className="cmp-stk-form"
      aria-labelledby={`${ids}-title`}
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !saving) {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
      noValidate
    >
      <h3 id={`${ids}-title`} className="cmp-stk-form-title">
        {T.title}
      </h3>
      <p className="cmp-stk-form-file">
        {picked.frames > 1 ? `${details}, ${T.frames(picked.frames)}` : details}
      </p>
      <div className="field">
        <label htmlFor={`${ids}-name`}>{T.name}</label>
        <input
          id={`${ids}-name`}
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={32}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? `${ids}-name-err ${ids}-name-hint` : `${ids}-name-hint`}
          readOnly={saving}
        />
        <p id={`${ids}-name-hint`} className="hint">
          {T.nameHint}
        </p>
        {errors.name && (
          <div id={`${ids}-name-err`}>
            <FieldError text={errors.name} />
          </div>
        )}
      </div>
      <div className="field">
        <label htmlFor={`${ids}-kw`}>{T.keywords}</label>
        <input
          id={`${ids}-kw`}
          ref={keywordsRef}
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          autoComplete="off"
          aria-invalid={errors.keywords ? true : undefined}
          aria-describedby={errors.keywords ? `${ids}-kw-err ${ids}-kw-hint` : `${ids}-kw-hint`}
          readOnly={saving}
        />
        <p id={`${ids}-kw-hint`} className="hint">
          {T.keywordsHint(STICKER_MAX_KEYWORDS)}
        </p>
        {errors.keywords && (
          <div id={`${ids}-kw-err`}>
            <FieldError text={errors.keywords} />
          </div>
        )}
      </div>
      <div aria-live="polite">
        {saveError && (
          <ErrorAlert title={T.saveError}>
            <p>{saveError.message}</p>
          </ErrorAlert>
        )}
      </div>
      <div className="cmp-stk-form-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={saving}>
          {T.cancel}
        </button>
        <button type="submit" className="btn btn-sm" disabled={saving} aria-busy={saving || undefined}>
          {saving ? T.saving : T.save}
        </button>
      </div>
    </form>
  );
}

export function StickerPicker({ conv, replyTo, onSent, onClose, anchorRef }: Props) {
  const T = STICKER_TEXT.picker;
  const { catalog: rawCatalog, error: loadError } = useStickerCatalog();
  const catalog = rawCatalog ?? null;
  const ids = useId();
  const [tab, setTab] = useState<StickerTab>("office");
  const [rawQuery, setRawQuery] = useState("");
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<AppError | null>(null);
  const [picked, setPicked] = useState<PickedSticker | null>(null);
  const [pickError, setPickError] = useState<AppError | null>(null);
  const [toRemove, setToRemove] = useState<Item | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<AppError | null>(null);
  const [retrying, setRetrying] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabRefs = useRef<Record<StickerTab, HTMLButtonElement | null>>({ office: null, mine: null });
  const focusItem = useRef<number | null>(null);
  const alive = useRef(true);
  const dialogOpen = useRef(false);
  dialogOpen.current = toRemove !== null;

  const query = stickerQuery(rawQuery);
  const groups = stickerGroups(catalog, tab, query);
  const items = groups.flatMap((g) => g.items);
  const rows = gridRows(groups);
  const activeIndex = Math.min(active, Math.max(items.length - 1, 0));
  const anyNotReady = items.some((i) => !i.ready);

  useEffect(() => {
    alive.current = true;
    searchRef.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);

  // Klik di luar panel menutup. Selama dialog konfirmasi terbuka, klik di dialog bukan di luar.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (dialogOpen.current) return;
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose("outside");
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose, anchorRef]);

  // Fokus ke sticker tertentu setelah kisi digambar ulang (sesudah unggah atau hapus).
  // Ditunda satu giliran supaya pemulihan fokus dialog konfirmasi selesai lebih dulu.
  useLayoutEffect(() => {
    if (focusItem.current === null) return;
    const index = Math.min(focusItem.current, items.length - 1);
    focusItem.current = null;
    window.setTimeout(() => {
      if (!alive.current) return;
      if (index >= 0) itemRefs.current[index]?.focus();
      else (uploadRef.current ?? searchRef.current)?.focus();
    }, 0);
  });

  function switchTab(next: StickerTab, focus = false) {
    setTab(next);
    setActive(0);
    setSendError(null);
    setPickError(null);
    if (next === "office") setPicked(null);
    if (focus) tabRefs.current[next]?.focus();
  }

  async function send(item: Item) {
    if (!item.ready || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const message = await chatApi.sendSticker(conv, item.source, replyTo);
      if (!alive.current) return;
      onSent(message);
    } catch (err) {
      if (alive.current) setSendError(toAppError(err));
    } finally {
      if (alive.current) setSending(false);
    }
  }

  async function upload() {
    setPickError(null);
    try {
      // Dialog pilih gambar milik Mira; null berarti dibatalkan. Gambar sudah diperiksa inti Rust.
      const result = await chatApi.pickSticker();
      if (!alive.current) return;
      if (result) setPicked(result);
      else uploadRef.current?.focus();
    } catch (err) {
      if (alive.current) setPickError(toAppError(err));
    }
  }

  async function confirmRemove() {
    if (!toRemove) return;
    const index = items.findIndex((i) => i.key === toRemove.key);
    setRemoving(true);
    setRemoveError(null);
    try {
      await chatApi.removeMySticker(toRemove.source.id);
      await reloadStickerCatalog();
      if (!alive.current) return;
      focusItem.current = Math.max(0, index);
      setActive(Math.max(0, index));
      setToRemove(null);
    } catch (err) {
      if (alive.current) setRemoveError(toAppError(err));
    } finally {
      if (alive.current) setRemoving(false);
    }
  }

  async function retry() {
    setRetrying(true);
    await reloadStickerCatalog();
    if (alive.current) setRetrying(false);
  }

  function onPanelKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Dialog konfirmasi di-portal ke luar panel, tapi event React-nya tetap naik ke sini.
    if (e.key !== "Escape" || dialogOpen.current) return;
    if (!panelRef.current?.contains(e.target as Node)) return;
    e.preventDefault();
    e.stopPropagation();
    onClose("escape");
  }

  function onItemKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.key === "Delete" && tab === "mine") {
      e.preventDefault();
      setRemoveError(null);
      setToRemove(items[index]);
      return;
    }
    const next = moveInGrid(rows, index, e.key);
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    itemRefs.current[next]?.focus();
  }

  function onTabKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    let next: StickerTab | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") next = tab === "office" ? "mine" : "office";
    else if (e.key === "Home") next = "office";
    else if (e.key === "End") next = "mine";
    if (!next) return;
    e.preventDefault();
    switchTab(next, true);
  }

  // Fokus pindah ke luar panel (Tab, Shift+Tab) menutup pemilih. Tanpa tujuan fokus (dialog
  // pilih gambar milik Windows, klik di area kosong) tidak dihitung; klik diurus onDown.
  function onPanelBlur(e: FocusEvent<HTMLDivElement>) {
    if (dialogOpen.current) return;
    const next = e.relatedTarget as Node | null;
    if (!next || panelRef.current?.contains(next) || anchorRef.current?.contains(next)) return;
    onClose("outside");
  }

  function onSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" && items.length > 0) {
      e.preventDefault();
      itemRefs.current[activeIndex]?.focus();
    }
  }

  const reasonId = `${ids}-notready`;
  let body;
  if (!catalog && loadError) {
    body = (
      <ErrorAlert title={T.loadError}>
        <p>{toAppError(loadError).message}</p>
        <button
          type="button"
          className="btn btn-ghost btn-sm cmp-stk-retry"
          onClick={() => void retry()}
          disabled={retrying}
          aria-busy={retrying || undefined}
        >
          {retrying ? T.retrying : T.retry}
        </button>
      </ErrorAlert>
    );
  } else if (!catalog) {
    body = (
      <p className="cmp-stk-state" role="status">
        <IconLoader2 size={16} className="conv-spin" aria-hidden="true" />
        {T.loading}
      </p>
    );
  } else if (items.length === 0) {
    const total = tab === "office" ? catalog.office.filter((s) => s.state === "active").length : catalog.mine.length;
    body = (
      <p className="cmp-stk-state">{total === 0 ? (tab === "office" ? T.emptyOffice : T.emptyMine) : T.noMatch(query)}</p>
    );
  } else {
    let n = 0;
    body = (
      <>
        {groups.map((g) => {
          const start = n;
          n += g.items.length;
          const headId = `${ids}-pack-${start}`;
          return (
            <section key={`${g.title ?? ""}-${start}`} className="cmp-stk-group" aria-labelledby={g.title ? headId : undefined}>
              {g.title && (
                <h3 id={headId} className="cmp-stk-pack">
                  {g.title}
                </h3>
              )}
              <ul className="cmp-stk-grid" role="list">
                {g.items.map((item, j) => {
                  const index = start + j;
                  const label = `:${item.name}:`;
                  return (
                    <li key={item.key} className="cmp-stk-cell">
                      <button
                        type="button"
                        ref={(el) => {
                          itemRefs.current[index] = el;
                        }}
                        className="cmp-stk-item"
                        tabIndex={index === activeIndex ? 0 : -1}
                        aria-label={label}
                        aria-disabled={!item.ready || sending || undefined}
                        aria-describedby={item.ready ? undefined : reasonId}
                        aria-keyshortcuts={tab === "mine" ? "Delete" : undefined}
                        title={item.ready ? label : `${label} ${T.notReady}`}
                        onClick={() => {
                          setActive(index);
                          void send(item);
                        }}
                        onFocus={() => setActive(index)}
                        onKeyDown={(e) => onItemKeyDown(e, index)}
                      >
                        <StickerImage hash={item.hash} alt={label} size="thumb" ready={item.ready} />
                        <span className="cmp-stk-name" aria-hidden="true">
                          {label}
                        </span>
                      </button>
                      {tab === "mine" && (
                        <button
                          type="button"
                          className="cmp-stk-remove"
                          tabIndex={-1}
                          aria-label={T.remove(item.name)}
                          title={T.remove(item.name)}
                          onClick={() => {
                            setRemoveError(null);
                            setToRemove(item);
                          }}
                        >
                          <IconTrash size={14} aria-hidden="true" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        {anyNotReady && (
          <p id={reasonId} className="cmp-stk-note">
            {T.notReadyNote}
          </p>
        )}
        {tab === "mine" && <p className="cmp-stk-note">{T.removeHint}</p>}
      </>
    );
  }

  const panelId = `${ids}-panel`;
  return (
    <div
      ref={panelRef}
      className="cmp-stk-picker cmp-pop"
      role="dialog"
      aria-label={T.label}
      aria-busy={sending || undefined}
      onKeyDown={onPanelKeyDown}
      onBlur={onPanelBlur}
    >
      <div className="cmp-stk-tabs" role="tablist" aria-label={T.tabs}>
        {(["office", "mine"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`${ids}-tab-${t}`}
            ref={(el) => {
              tabRefs.current[t] = el;
            }}
            className="cmp-stk-tab"
            aria-selected={tab === t}
            aria-controls={panelId}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => switchTab(t)}
            onKeyDown={onTabKeyDown}
          >
            {t === "office" ? T.office : T.mine}
          </button>
        ))}
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={`${ids}-tab-${tab}`} className="cmp-stk-panel">
        {picked && tab === "mine" ? (
          <UploadForm
            picked={picked}
            onCancel={() => {
              setPicked(null);
              window.setTimeout(() => uploadRef.current?.focus(), 0);
            }}
            onSaved={() => {
              setPicked(null);
              setRawQuery("");
              setActive(0);
              focusItem.current = 0;
            }}
          />
        ) : (
          <>
            <div className="cmp-stk-search">
              <IconSearch size={16} aria-hidden="true" />
              <label htmlFor={`${ids}-search`} className="sr-only">
                {T.search}
              </label>
              <input
                id={`${ids}-search`}
                ref={searchRef}
                type="search"
                value={rawQuery}
                placeholder={T.searchPlaceholder}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setRawQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onSearchKeyDown}
              />
            </div>
            {tab === "mine" && (
              <div className="cmp-stk-upload">
                <button
                  type="button"
                  ref={uploadRef}
                  className="btn btn-ghost btn-sm"
                  onClick={() => void upload()}
                  aria-describedby={`${ids}-upload-hint`}
                >
                  <IconUpload size={16} aria-hidden="true" />
                  {T.upload}
                </button>
                <p id={`${ids}-upload-hint`} className="cmp-stk-note">
                  {T.uploadHint}
                </p>
              </div>
            )}
            <div aria-live="polite" className="cmp-stk-live">
              {sending && (
                <p className="cmp-stk-state cmp-stk-sending" role="status">
                  <IconLoader2 size={16} className="conv-spin" aria-hidden="true" />
                  {T.sending}
                </p>
              )}
              {sendError && (
                <ErrorAlert title={T.sendError}>
                  <p>{sendError.message}</p>
                </ErrorAlert>
              )}
              {pickError && (
                <ErrorAlert title={T.pickError}>
                  <p>{pickError.message}</p>
                </ErrorAlert>
              )}
            </div>
            <div className="cmp-stk-scroll">{body}</div>
          </>
        )}
      </div>
      <ConfirmDialog
        open={toRemove !== null}
        onOpenChange={(open) => {
          if (!open) setToRemove(null);
        }}
        title={T.removeTitle}
        confirmLabel={T.removeConfirm}
        busyLabel={T.removing}
        busy={removing}
        onConfirm={() => void confirmRemove()}
        error={
          removeError && (
            <ErrorAlert title={T.removeError}>
              <p>{removeError.message}</p>
            </ErrorAlert>
          )
        }
      >
        <p>{T.removeBody(toRemove?.name ?? "")}</p>
      </ConfirmDialog>
    </div>
  );
}
