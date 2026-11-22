import { IconArrowDown, IconArrowUp, IconInfoCircle } from "@tabler/icons-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { signingApi, type Candidate, type ImportedPdf, type RequestDetail, type SignMode } from "../../api/signing";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { formatSize, kindLabel, modeHint, modeLabel } from "./labels";

export const TITLE_MAX = 200;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imported: ImportedPdf | null;
  onCreated: (detail: RequestDetail) => void;
};

export function titleFromFileName(name: string): string {
  return name.replace(/\.pdf$/i, "").trim().slice(0, TITLE_MAX);
}

function byName(a: Candidate, b: Candidate): number {
  if (a.isMe !== b.isMe) return a.isMe ? -1 : 1;
  return a.displayName.localeCompare(b.displayName, "id");
}

type Move = { key: string; dir: "up" | "down" };

// Koma tersembunyi supaya pembaca layar membaca "Nama, Tamu", bukan "NamaTamu".
function GuestChip() {
  return (
    <>
      <span className="sr-only">, {kindLabel("guest")}</span>
      <span className="chip" aria-hidden="true">
        {kindLabel("guest")}
      </span>
    </>
  );
}

export function NewRequestDialog({ open, onOpenChange, imported, onCreated }: Props) {
  const [title, setTitle] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [signersError, setSignersError] = useState<string | null>(null);
  const [mode, setMode] = useState<SignMode>("sequential");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<AppError | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const moveRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const pendingFocus = useRef<Move | null>(null);
  const loadSeq = useRef(0);

  const ids = {
    title: useId(),
    titleHint: useId(),
    titleError: useId(),
    signers: useId(),
    signersError: useId(),
    mode: useId(),
    order: useId(),
  };

  const loadCandidates = useCallback(async () => {
    const mine = ++loadSeq.current;
    setLoadError(null);
    setCandidates(null);
    try {
      const list = await signingApi.listCandidates();
      if (mine !== loadSeq.current) return;
      const sorted = [...list].sort(byName);
      setCandidates(sorted);
      // Diri sendiri tercentang bawaan, kecuali pengguna sudah memilih sendiri.
      setOrder((prev) => (prev.length ? prev : sorted.filter((c) => c.isMe).map((c) => c.publicKey)));
    } catch (err) {
      if (mine !== loadSeq.current) return;
      setLoadError(toAppError(err));
    }
  }, []);

  // Isi dibuat ulang setiap kali dialog dibuka untuk PDF baru.
  useEffect(() => {
    if (!open) {
      loadSeq.current++;
      return;
    }
    setTitle(imported ? titleFromFileName(imported.fileName) : "");
    setTitleError(null);
    setOrder([]);
    setSignersError(null);
    setMode("sequential");
    setSaving(false);
    setSaveError(null);
    void loadCandidates();
  }, [open, imported, loadCandidates]);

  // Setelah baris dipindah, fokus tetap di tombol yang sama. Kalau tombol itu
  // nonaktif karena baris sudah di ujung, fokus pindah ke tombol arah sebaliknya.
  useLayoutEffect(() => {
    const move = pendingFocus.current;
    if (!move) return;
    pendingFocus.current = null;
    const same = moveRefs.current.get(`${move.key}:${move.dir}`);
    const other = moveRefs.current.get(`${move.key}:${move.dir === "up" ? "down" : "up"}`);
    (same && !same.disabled ? same : other)?.focus();
  }, [order]);

  const byKey = new Map((candidates ?? []).map((c) => [c.publicKey, c]));
  const chosen = order.map((k) => byKey.get(k)).filter((c): c is Candidate => Boolean(c));
  const hasOthers = chosen.some((c) => !c.isMe);

  function toggle(key: string, checked: boolean) {
    setSignersError(null);
    setOrder((prev) => (checked ? (prev.includes(key) ? prev : [...prev, key]) : prev.filter((k) => k !== key)));
  }

  function move(key: string, dir: "up" | "down") {
    setOrder((prev) => {
      const i = prev.indexOf(key);
      const j = dir === "up" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    pendingFocus.current = { key, dir };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving || !imported) return;
    const clean = title.trim();
    const tErr = clean.length === 0 ? "Isi judul dokumen." : clean.length > TITLE_MAX ? `Judul paling panjang ${TITLE_MAX} karakter.` : null;
    const sErr = chosen.length === 0 ? "Pilih minimal satu penanda tangan." : null;
    setTitleError(tErr);
    setSignersError(sErr);
    setSaveError(null);
    if (tErr) {
      titleRef.current?.focus();
      return;
    }
    if (sErr) {
      document.getElementById(ids.signers)?.querySelector<HTMLInputElement>("input")?.focus();
      return;
    }
    setSaving(true);
    try {
      const detail = await signingApi.createRequest({
        title: clean,
        fileHash: imported.fileHash,
        mode,
        signers: chosen.map((c) => c.publicKey),
      });
      setSaving(false);
      onCreated(detail);
    } catch (err) {
      setSaving(false);
      setSaveError(toAppError(err));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
      title="Minta tanda tangan"
      description={
        imported ? (
          <>
            <span className="sign-file-name">{imported.fileName}</span>, {formatSize(imported.size)}
          </>
        ) : undefined
      }
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        titleRef.current?.focus();
      }}
    >
      <form className="sign-form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={ids.title}>Judul dokumen</label>
          <input
            ref={titleRef}
            id={ids.title}
            value={title}
            maxLength={TITLE_MAX}
            onChange={(e) => {
              setTitle(e.target.value);
              setTitleError(null);
            }}
            aria-invalid={titleError ? true : undefined}
            aria-describedby={titleError ? `${ids.titleHint} ${ids.titleError}` : ids.titleHint}
            disabled={saving}
          />
          <p id={ids.titleHint} className="hint">
            Tampil di daftar dan di halaman catatan PDF. Paling panjang {TITLE_MAX} karakter.
          </p>
          {titleError && (
            <div id={ids.titleError}>
              <FieldError text={titleError} />
            </div>
          )}
        </div>

        <fieldset
          id={ids.signers}
          className="sign-set"
          aria-describedby={signersError ? ids.signersError : undefined}
          disabled={saving}
        >
          <legend className="sign-legend">Penanda tangan</legend>
          {!candidates && !loadError && (
            <p className="hint" role="status">
              Memuat daftar anggota...
            </p>
          )}
          {loadError && (
            <div role="alert">
              <ErrorAlert title="Daftar anggota belum terbaca">
                <p>{loadError.message}</p>
                <button type="button" className="btn btn-ghost btn-sm sign-inline-btn" onClick={() => void loadCandidates()}>
                  Coba lagi
                </button>
              </ErrorAlert>
            </div>
          )}
          {candidates && candidates.length === 0 && (
            <p className="sign-empty-small">Belum ada anggota di direktori laptop ini.</p>
          )}
          {candidates && candidates.length > 0 && (
            <ul className="sign-pick">
              {candidates.map((c) => {
                const checked = order.includes(c.publicKey);
                return (
                  <li key={c.publicKey}>
                    <label className="sign-pick-row">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => toggle(c.publicKey, e.target.checked)}
                      />
                      <span className="sign-pick-name">{c.isMe ? `${c.displayName} (Anda)` : c.displayName}</span>
                      {c.kind === "guest" && <GuestChip />}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {signersError && (
            <div id={ids.signersError}>
              <FieldError text={signersError} />
            </div>
          )}
        </fieldset>

        <fieldset className="sign-set" disabled={saving}>
          <legend className="sign-legend">Cara menandatangani</legend>
          <div className="sign-opts">
            {(["sequential", "parallel"] as const).map((m) => (
              <label key={m} className="sign-opt">
                <input
                  type="radio"
                  name={ids.mode}
                  value={m}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                  aria-labelledby={`${ids.mode}-${m}`}
                  aria-describedby={`${ids.mode}-${m}-desc`}
                />
                <span>
                  <span id={`${ids.mode}-${m}`} className="sign-opt-title">
                    {modeLabel(m)}
                  </span>
                  <span id={`${ids.mode}-${m}-desc`} className="sign-opt-desc">
                    {modeHint(m)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {mode === "sequential" && chosen.length > 1 && (
          <div className="sign-set">
            <h3 id={ids.order} className="sign-legend">
              Urutan
            </h3>
            <ol className="sign-order" aria-labelledby={ids.order}>
              {chosen.map((c, i) => (
                <li key={c.publicKey} className="sign-order-row">
                  <span className="sign-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="sign-order-name">
                    {c.isMe ? `${c.displayName} (Anda)` : c.displayName}
                    {c.kind === "guest" && <GuestChip />}
                  </span>
                  <span className="sign-order-btns">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      ref={(el) => {
                        moveRefs.current.set(`${c.publicKey}:up`, el);
                      }}
                      onClick={() => move(c.publicKey, "up")}
                      disabled={saving || i === 0}
                      aria-label={`Naikkan ${c.displayName}`}
                    >
                      <IconArrowUp size={16} aria-hidden="true" />
                      Naikkan
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      ref={(el) => {
                        moveRefs.current.set(`${c.publicKey}:down`, el);
                      }}
                      onClick={() => move(c.publicKey, "down")}
                      disabled={saving || i === chosen.length - 1}
                      aria-label={`Turunkan ${c.displayName}`}
                    >
                      <IconArrowDown size={16} aria-hidden="true" />
                      Turunkan
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {hasOthers && (
          <div className="sign-note">
            <IconInfoCircle size={18} aria-hidden="true" />
            <p>
              Permintaan tersimpan di laptop ini. Rekan baru menerimanya setelah pengiriman lewat jaringan tersedia di
              Mira.
            </p>
          </div>
        )}

        <div aria-live="polite">
          {saveError && (
            <ErrorAlert title="Permintaan belum dibuat">
              <p>{saveError.message}</p>
            </ErrorAlert>
          )}
        </div>

        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={saving}>
              Batal
            </button>
          </DialogClose>
          <button type="submit" className="btn" disabled={saving || !imported || !candidates} aria-busy={saving || undefined}>
            {saving ? "Membuat permintaan..." : "Buat permintaan"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
