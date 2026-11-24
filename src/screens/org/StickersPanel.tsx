// Tab Sticker di halaman Organisasi, khusus superadmin (v0.5.1, docs/plans/chat-sticker.md).
// Katalog dibaca dari stickerCatalog.ts, salinan yang sama dengan kolom pesan, dan dimuat
// ulang setelah setiap aksi. Tidak ada paket bawaan: semua sticker diunggah kantor sendiri.
import { IconAlertTriangle, IconPlus } from "@tabler/icons-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import {
  chatApi,
  STICKER_MAX_KEYWORDS,
  STICKER_NAME_PATTERN,
  STICKER_PACK_MAX_CHARS,
  type OfficeSticker,
  type OfficeStickerState,
  type PickedSticker,
} from "../../api/chat";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { STICKER_ORG_TEXT as T } from "../../i18n/org-stickers";
import { reloadStickerCatalog, useStickerCatalog } from "../chat/stickerCatalog";
import { StickerImage } from "../chat/StickerImage";
import { formatSize } from "../chat/text";
import type { OrgPage } from "./context";
import "./stickers.css";

// Label tab untuk OrgScreen, dibaca saat daftar tab dibuat supaya ikut bahasa aktif.
export const stickersTabLabel = () => T.tab;

// Sama dengan batas kata kunci di inti Rust (chat/stickers.rs).
const KEYWORD_MAX_CHARS = 24;

type Values = { name: string; pack: string; keywords: string[] };

type DialogState =
  | { kind: "add"; picked: PickedSticker }
  | { kind: "edit"; sticker: OfficeSticker }
  | { kind: "delete"; sticker: OfficeSticker }
  | null;

type Pack = { name: string; stickers: OfficeSticker[] };

function chars(value: string): number {
  return [...value].length;
}

// Saran nama dari nama file: huruf kecil, selain [a-z0-9_] jadi garis bawah.
export function suggestName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return name.length >= 2 ? name : "";
}

// Paket dirapikan seperti nama grup di inti Rust: spasi di ujung dibuang, spasi berurutan jadi satu.
function cleanPack(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

// Kata kunci dipisah koma atau spasi, huruf kecil, tanpa duplikat.
export function parseKeywords(raw: string): string[] {
  const words = raw
    .split(/[\s,]+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0);
  return [...new Set(words)];
}

function samePlace(a: Values, b: Values): boolean {
  return a.name === b.name && a.pack === b.pack && a.keywords.join(",") === b.keywords.join(",");
}

export function StickersPanel({ page }: { page: OrgPage }) {
  const { catalog, error } = useStickerCatalog();
  // Selesai memuat paling tidak sekali: membedakan "masih memuat" dari "inti tidak mengirim data".
  const [loaded, setLoaded] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<AppError | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  // Fokus setelah barisnya hilang atau pindah paket: "add" ke tombol Tambah sticker, id ke tombol Ubah.
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const addButton = useRef<HTMLButtonElement | null>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    let alive = true;
    void reloadStickerCatalog().finally(() => {
      if (alive) setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const valid = !!catalog && Array.isArray(catalog.office);
  const office = useMemo(() => (valid ? catalog.office : []), [valid, catalog]);

  useEffect(() => {
    if (!returnTo) return;
    const target = returnTo === "add" ? addButton.current : editButtons.current.get(returnTo);
    if (target) {
      target.focus();
      setReturnTo(null);
    }
  }, [returnTo, office]);

  const packs = useMemo(() => {
    const list: Pack[] = [];
    for (const s of office) {
      const last = list[list.length - 1];
      if (last && last.name === s.pack) last.stickers.push(s);
      else list.push({ name: s.pack, stickers: [s] });
    }
    return list;
  }, [office]);

  const busy = page.pending !== null;
  const canManage = valid && catalog.canManage;

  const retry = async () => {
    setRetrying(true);
    await reloadStickerCatalog();
    setRetrying(false);
  };

  const pick = async () => {
    if (picking || busy) return;
    setPicking(true);
    setPickError(null);
    try {
      const picked = await chatApi.pickSticker();
      if (picked) setDialog({ kind: "add", picked });
    } catch (err) {
      setPickError(toAppError(err));
    } finally {
      setPicking(false);
    }
  };

  const setState = async (s: OfficeSticker, state: OfficeStickerState) => {
    const hide = state === "hidden";
    await page.act(
      `sticker:${s.id}`,
      () => chatApi.updateOfficeSticker(s.id, s.pack, s.name, s.keywords, state),
      hide ? T.hiddenOk(s.name) : T.shownOk(s.name),
      hide ? T.hideFail(s.name) : T.showFail(s.name),
    );
    await reloadStickerCatalog();
  };

  // Paket bukan record sendiri: Sembunyikan semua dan Tampilkan semua memperbarui setiap sticker.
  const setPackState = async (pack: Pack, state: "active" | "hidden") => {
    const targets = pack.stickers.filter((s) => s.state !== state);
    const hide = state === "hidden";
    await page.act(
      `pack:${pack.name}`,
      async () => {
        for (const s of targets) {
          await chatApi.updateOfficeSticker(s.id, s.pack, s.name, s.keywords, state);
        }
      },
      hide ? T.hiddenAllOk(pack.name, targets.length) : T.shownAllOk(pack.name, targets.length),
      hide ? T.hideAllFail(pack.name) : T.showAllFail(pack.name),
    );
    await reloadStickerCatalog();
  };

  const close = () => setDialog(null);
  const packNames = packs.map((p) => p.name);

  return (
    <section className="set-section stk" aria-labelledby="stickers-title">
      <div className="org-head">
        <div>
          <h2 id="stickers-title" className="set-title">
            {T.title}
          </h2>
          <p className="hint stk-intro">{T.intro}</p>
        </div>
        {canManage && (
          <div className="org-head-actions">
            <button
              type="button"
              className="btn"
              ref={addButton}
              disabled={busy}
              aria-busy={picking || undefined}
              onClick={() => void pick()}
            >
              <IconPlus size={18} aria-hidden="true" />
              {picking ? T.picking : T.add}
            </button>
          </div>
        )}
      </div>

      <div aria-live="polite" className="stk-live">
        {pickError && (
          <ErrorAlert title={T.pickFail}>
            <p>{pickError.message}</p>
          </ErrorAlert>
        )}
      </div>

      {!valid && !error && !loaded && (
        <p className="hint" role="status">
          {T.loading}
        </p>
      )}

      {!valid && (!!error || loaded) && (
        <div role="alert">
          <ErrorAlert title={T.loadErrorTitle}>
            <p>{error ? toAppError(error).message : T.loadErrorEmpty}</p>
            <button
              type="button"
              className="btn btn-ghost org-retry"
              disabled={retrying}
              aria-busy={retrying || undefined}
              onClick={() => void retry()}
            >
              {T.retry}
            </button>
          </ErrorAlert>
        </div>
      )}

      {valid && !!error && <p className="hint">{T.stale(toAppError(error).message)}</p>}

      {valid && !canManage && (
        <div className="notice">
          <IconAlertTriangle size={18} aria-hidden="true" />
          <p>{T.forbidden}</p>
        </div>
      )}

      {canManage && office.length === 0 && (
        <div className="org-empty">
          <p>{T.empty}</p>
        </div>
      )}

      {canManage && packs.length > 0 && (
        <ul className="stk-packs" aria-label={T.packList}>
          {packs.map((p) => (
            <PackGroup
              key={p.name}
              pack={p}
              busy={busy}
              pending={page.pending}
              editRef={(id, el) => {
                if (el) editButtons.current.set(id, el);
                else editButtons.current.delete(id);
              }}
              onPackState={(state) => void setPackState(p, state)}
              onState={(s, state) => void setState(s, state)}
              onEdit={(s) => setDialog({ kind: "edit", sticker: s })}
              onDelete={(s) => setDialog({ kind: "delete", sticker: s })}
            />
          ))}
        </ul>
      )}

      {dialog?.kind === "add" && (
        <AddDialog
          page={page}
          picked={dialog.picked}
          office={office}
          packs={packNames}
          onClose={close}
        />
      )}
      {dialog?.kind === "edit" && (
        <EditDialog
          page={page}
          sticker={dialog.sticker}
          office={office}
          packs={packNames}
          onSaved={(id) => setReturnTo(id)}
          onClose={close}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteDialog
          page={page}
          sticker={dialog.sticker}
          onDeleted={() => setReturnTo("add")}
          onClose={close}
        />
      )}
    </section>
  );
}

function PackGroup({
  pack,
  busy,
  pending,
  editRef,
  onPackState,
  onState,
  onEdit,
  onDelete,
}: {
  pack: Pack;
  busy: boolean;
  pending: string | null;
  editRef: (id: string, el: HTMLButtonElement | null) => void;
  onPackState: (state: "active" | "hidden") => void;
  onState: (s: OfficeSticker, state: OfficeStickerState) => void;
  onEdit: (s: OfficeSticker) => void;
  onDelete: (s: OfficeSticker) => void;
}) {
  const headingId = useId();
  const hidden = pack.stickers.filter((s) => s.state === "hidden").length;
  const active = pack.stickers.length - hidden;
  const working = pending === `pack:${pack.name}`;

  return (
    <li className="stk-pack">
      <div className="stk-pack-head">
        <div className="stk-pack-title">
          <h3 id={headingId} className="stk-pack-name">
            {pack.name}
          </h3>
          <span className="stk-pack-count">{T.packCount(pack.stickers.length, hidden)}</span>
        </div>
        <div className="stk-actions">
          {active > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              aria-busy={working || undefined}
              onClick={() => onPackState("hidden")}
            >
              {T.hideAll}
              <span className="sr-only">{T.srPack(pack.name)}</span>
            </button>
          )}
          {hidden > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              aria-busy={working || undefined}
              onClick={() => onPackState("active")}
            >
              {T.showAll}
              <span className="sr-only">{T.srPack(pack.name)}</span>
            </button>
          )}
        </div>
      </div>
      <ul className="row-list" aria-label={T.stickerList(pack.name)}>
        {pack.stickers.map((s) => (
          <StickerRow
            key={s.id}
            sticker={s}
            busy={busy}
            working={pending === `sticker:${s.id}`}
            editRef={(el) => editRef(s.id, el)}
            onToggle={() => onState(s, s.state === "hidden" ? "active" : "hidden")}
            onEdit={() => onEdit(s)}
            onDelete={() => onDelete(s)}
          />
        ))}
      </ul>
    </li>
  );
}

function StickerRow({
  sticker: s,
  busy,
  working,
  editRef,
  onToggle,
  onEdit,
  onDelete,
}: {
  sticker: OfficeSticker;
  busy: boolean;
  working: boolean;
  editRef: (el: HTMLButtonElement | null) => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const hidden = s.state === "hidden";
  return (
    <li className={`stk-row${hidden ? " stk-row-hidden" : ""}`}>
      {/* Nama tertulis di sebelahnya, jadi gambar kecil ini tidak dibacakan dua kali. */}
      <span className="stk-thumb" aria-hidden="true">
        <StickerImage hash={s.hash} alt={`:${s.name}:`} size="thumb" ready={s.ready} />
      </span>
      <div className="stk-main">
        <div className="stk-name-line">
          <span className="stk-name">:{s.name}:</span>
          <span className={`stk-state ${hidden ? "stk-state-hidden" : "stk-state-active"}`}>
            {hidden ? T.hidden : T.active}
          </span>
        </div>
        <p className="stk-keywords">{s.keywords.length > 0 ? T.keywordsLine(s.keywords.join(", ")) : T.noKeywords}</p>
        {s.nameTaken && (
          <p className="stk-warn">
            <IconAlertTriangle size={16} aria-hidden="true" />
            <span>
              <strong>{T.nameTaken}.</strong> {T.nameTakenHint}
            </span>
          </p>
        )}
        {!s.ready && (
          <p className="stk-warn">
            <IconAlertTriangle size={16} aria-hidden="true" />
            <span>{T.notReady}</span>
          </p>
        )}
      </div>
      <div className="stk-actions">
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} ref={editRef} onClick={onEdit}>
          {T.edit}
          {" "}
          <span className="sr-only">{T.srSticker(s.name)}</span>
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy}
          aria-busy={working || undefined}
          onClick={onToggle}
        >
          {hidden ? T.show : T.hide}
          {" "}
          <span className="sr-only">{T.srSticker(s.name)}</span>
        </button>
        <button type="button" className="btn btn-ghost btn-sm stk-del" disabled={busy} onClick={onDelete}>
          {T.remove}
          {" "}
          <span className="sr-only">{T.srSticker(s.name)}</span>
        </button>
      </div>
    </li>
  );
}

type Problems = { name: string | null; pack: string | null; keywords: string | null };

function problemsOf(
  name: string,
  pack: string,
  keywords: string[],
  office: OfficeSticker[],
  currentId: string | null,
): Problems {
  let nameProblem: string | null = null;
  if (name.length === 0) nameProblem = T.nameEmpty;
  else if (!STICKER_NAME_PATTERN.test(name)) nameProblem = T.nameBad;
  else {
    const twin = office.find((o) => o.id !== currentId && o.name === name);
    if (twin) nameProblem = T.nameUsed(name, twin.pack);
  }

  let packProblem: string | null = null;
  if (chars(pack) === 0) packProblem = T.packEmpty;
  else if (chars(pack) > STICKER_PACK_MAX_CHARS) packProblem = T.packTooLong(STICKER_PACK_MAX_CHARS, chars(pack));

  let keywordProblem: string | null = null;
  if (keywords.length > STICKER_MAX_KEYWORDS) keywordProblem = T.keywordsTooMany(STICKER_MAX_KEYWORDS, keywords.length);
  else {
    const long = keywords.find((w) => chars(w) > KEYWORD_MAX_CHARS);
    if (long) keywordProblem = T.keywordTooLong(long, KEYWORD_MAX_CHARS);
  }
  return { name: nameProblem, pack: packProblem, keywords: keywordProblem };
}

// Isian nama, paket, dan kata kunci. Dipakai dialog Tambah sticker dan Ubah.
function StickerForm({
  initial,
  office,
  packs,
  currentId,
  busy,
  submitText,
  busyText,
  failTitle,
  error,
  onSubmit,
}: {
  initial: Values;
  office: OfficeSticker[];
  packs: string[];
  currentId: string | null;
  busy: boolean;
  submitText: string;
  busyText: string;
  failTitle: string;
  error: AppError | null;
  onSubmit: (values: Values) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [pack, setPack] = useState(initial.pack);
  const [words, setWords] = useState(initial.keywords.join(", "));
  const [tried, setTried] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const packRef = useRef<HTMLInputElement | null>(null);
  const wordsRef = useRef<HTMLInputElement | null>(null);
  const ids = {
    name: useId(),
    nameHint: useId(),
    nameErr: useId(),
    pack: useId(),
    packHint: useId(),
    packErr: useId(),
    packList: useId(),
    words: useId(),
    wordsHint: useId(),
    wordsErr: useId(),
  };

  const cleanName = name.trim();
  const cleanedPack = cleanPack(pack);
  const keywords = parseKeywords(words);
  const problems = problemsOf(cleanName, cleanedPack, keywords, office, currentId);
  const shown: Problems = tried ? problems : { name: null, pack: null, keywords: null };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (problems.name) return nameRef.current?.focus();
    if (problems.pack) return packRef.current?.focus();
    if (problems.keywords) return wordsRef.current?.focus();
    onSubmit({ name: cleanName, pack: cleanedPack, keywords });
  };

  const described = (hint: string, err: string, problem: string | null) => (problem ? `${hint} ${err}` : hint);

  return (
    <form className="dlg-form" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor={ids.name}>{T.nameLabel}</label>
        <input
          id={ids.name}
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          maxLength={64}
          aria-invalid={shown.name ? true : undefined}
          aria-describedby={described(ids.nameHint, ids.nameErr, shown.name)}
          readOnly={busy}
        />
        <p id={ids.nameHint} className="hint">
          {STICKER_NAME_PATTERN.test(cleanName) ? T.namePreview(cleanName) : T.nameHint}
        </p>
        {shown.name && (
          <div id={ids.nameErr}>
            <FieldError text={shown.name} />
          </div>
        )}
      </div>

      <div className="field">
        <label htmlFor={ids.pack}>{T.packLabel}</label>
        <input
          id={ids.pack}
          ref={packRef}
          value={pack}
          onChange={(e) => setPack(e.target.value)}
          list={packs.length > 0 ? ids.packList : undefined}
          autoComplete="off"
          aria-invalid={shown.pack ? true : undefined}
          aria-describedby={described(ids.packHint, ids.packErr, shown.pack)}
          readOnly={busy}
        />
        {packs.length > 0 && (
          <datalist id={ids.packList}>
            {packs.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        )}
        <p id={ids.packHint} className="hint">
          {T.packHint(STICKER_PACK_MAX_CHARS)}
        </p>
        {shown.pack && (
          <div id={ids.packErr}>
            <FieldError text={shown.pack} />
          </div>
        )}
      </div>

      <div className="field">
        <label htmlFor={ids.words}>{T.keywordsLabel}</label>
        <input
          id={ids.words}
          ref={wordsRef}
          value={words}
          onChange={(e) => setWords(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={shown.keywords ? true : undefined}
          aria-describedby={described(ids.wordsHint, ids.wordsErr, shown.keywords)}
          readOnly={busy}
        />
        <p id={ids.wordsHint} className="hint">
          {T.keywordsHint(STICKER_MAX_KEYWORDS)}
        </p>
        {shown.keywords && (
          <div id={ids.wordsErr}>
            <FieldError text={shown.keywords} />
          </div>
        )}
      </div>

      <div aria-live="polite">
        {error && (
          <ErrorAlert title={failTitle}>
            <p>{error.message}</p>
          </ErrorAlert>
        )}
      </div>
      <div className="dlg-actions">
        <DialogClose asChild>
          <button type="button" className="btn btn-ghost" disabled={busy}>
            {T.cancel}
          </button>
        </DialogClose>
        <button type="submit" className="btn" disabled={busy} aria-busy={busy || undefined}>
          {busy ? busyText : submitText}
        </button>
      </div>
    </form>
  );
}

function AddDialog({
  page,
  picked,
  office,
  packs,
  onClose,
}: {
  page: OrgPage;
  picked: PickedSticker;
  office: OfficeSticker[];
  packs: string[];
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const fileName = picked.path.split(/[\\/]/).pop() || picked.path;

  const add = async (v: Values) => {
    setBusy(true);
    setError(null);
    try {
      await chatApi.addOfficeSticker(picked.path, v.pack, v.name, v.keywords);
      page.notify(T.added(v.name, v.pack));
      await reloadStickerCatalog();
      onClose();
    } catch (err) {
      setError(toAppError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={T.addTitle}
    >
      <div className="stk-file">
        <p className="stk-file-title">{T.fileTitle}</p>
        <p className="stk-file-name">{fileName}</p>
        <p className="hint stk-file-facts">
          {T.fileFacts(formatSize(picked.size), picked.width, picked.height)},{" "}
          {picked.frames > 1 ? T.frames(picked.frames) : T.still}
        </p>
        <p className="hint">{T.previewNote}</p>
      </div>
      <StickerForm
        initial={{ name: suggestName(picked.name), pack: packs[0] ?? "", keywords: [] }}
        office={office}
        packs={packs}
        currentId={null}
        busy={busy}
        submitText={T.addSubmit}
        busyText={T.adding}
        failTitle={T.addFail}
        error={error}
        onSubmit={(v) => void add(v)}
      />
    </Dialog>
  );
}

function EditDialog({
  page,
  sticker,
  office,
  packs,
  onSaved,
  onClose,
}: {
  page: OrgPage;
  sticker: OfficeSticker;
  office: OfficeSticker[];
  packs: string[];
  onSaved: (id: string) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const initial: Values = { name: sticker.name, pack: sticker.pack, keywords: sticker.keywords };

  const save = async (v: Values) => {
    if (samePlace(v, initial)) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await chatApi.updateOfficeSticker(sticker.id, v.pack, v.name, v.keywords, sticker.state);
      page.notify(T.saved(v.name));
      await reloadStickerCatalog();
      // Pindah paket membuat baris dibuat ulang: fokus kembali ke tombol Ubah yang baru.
      onSaved(sticker.id);
      onClose();
    } catch (err) {
      setError(toAppError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={T.editTitle(sticker.name)}
    >
      <StickerForm
        initial={initial}
        office={office}
        packs={packs}
        currentId={sticker.id}
        busy={busy}
        submitText={T.saveSubmit}
        busyText={T.saving}
        failTitle={T.saveFail}
        error={error}
        onSubmit={(v) => void save(v)}
      />
    </Dialog>
  );
}

function DeleteDialog({
  page,
  sticker,
  onDeleted,
  onClose,
}: {
  page: OrgPage;
  sticker: OfficeSticker;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await chatApi.updateOfficeSticker(sticker.id, sticker.pack, sticker.name, sticker.keywords, "deleted");
      page.notify(T.deleted(sticker.name));
      await reloadStickerCatalog();
      onDeleted();
      onClose();
    } catch (err) {
      setError(toAppError(err));
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={T.deleteTitle(sticker.name)}
      confirmLabel={T.deleteConfirm(sticker.name)}
      busyLabel={T.deleting}
      busy={busy}
      onConfirm={() => void remove()}
      error={
        error && (
          <ErrorAlert title={T.deleteFail(sticker.name)}>
            <p>{error.message}</p>
          </ErrorAlert>
        )
      }
    >
      <p>{T.deleteBody}</p>
    </ConfirmDialog>
  );
}
