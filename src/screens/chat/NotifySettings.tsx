import { useEffect, useId, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import { chatApi, type NotifyMode } from "../../api/chat";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { CHAT_DIALOGS } from "../../i18n/chat-dialogs";
import { systemName } from "../../platform";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: NotifyMode;
  onSaved: (mode: NotifyMode) => void;
};

// Label dan keterangan dibaca saat dipakai (getter), jadi ikut bahasa aktif.
function option(mode: NotifyMode): { mode: NotifyMode; label: string; desc: string } {
  return {
    mode,
    get label() {
      return CHAT_DIALOGS.notify[mode].label;
    },
    get desc() {
      return CHAT_DIALOGS.notify[mode].desc;
    },
  };
}

export const NOTIFY_OPTIONS: { mode: NotifyMode; label: string; desc: string }[] = [
  option("all"),
  option("mentions"),
  option("off"),
];

// Pengaturan notifikasi chat untuk laptop ini. Tersimpan begitu pilihan diganti.
export function NotifySettings({ open, onOpenChange, mode, onSaved }: Props) {
  const T = CHAT_DIALOGS.notify;
  const [value, setValue] = useState<NotifyMode>(mode);
  // Pilihan yang baru tersimpan; teks "Tersimpan" dibuat saat render supaya ikut bahasa aktif.
  const [saved, setSaved] = useState<NotifyMode | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const seq = useRef(0);
  const lastSaved = useRef<NotifyMode>(mode);
  const name = useId();
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Setiap kali dibuka, mulai dari nilai yang tersimpan. Nilai yang berubah saat dialog
  // terbuka (hasil simpan sendiri) tidak menghapus pesan "Tersimpan".
  useEffect(() => {
    if (!open) return;
    setValue(modeRef.current);
    lastSaved.current = modeRef.current;
    setSaved(null);
    setError(null);
  }, [open]);

  async function choose(next: NotifyMode) {
    const mine = ++seq.current;
    setValue(next);
    setSaved(null);
    setError(null);
    try {
      await chatApi.setNotify(next);
      if (mine !== seq.current) return;
      lastSaved.current = next;
      setSaved(next);
      onSaved(next);
    } catch (err) {
      if (mine !== seq.current) return;
      setValue(lastSaved.current);
      setError(toAppError(err));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={T.title}
      description={T.description(systemName())}
    >
      <fieldset className="chat-opts">
        <legend className="sr-only">{T.legend}</legend>
        {NOTIFY_OPTIONS.map((o) => (
          <label key={o.mode} className="chat-opt">
            <input
              type="radio"
              name={name}
              value={o.mode}
              checked={value === o.mode}
              onChange={() => void choose(o.mode)}
            />
            <span>
              <span className="chat-opt-title">{o.label}</span>
              <span className="chat-opt-desc">{o.desc}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div aria-live="polite">
        {saved && <p className="chat-saved">{T.saved(T[saved].label)}</p>}
        {error && (
          <ErrorAlert title={T.failed}>
            <p>{error.message}</p>
            <p>{T.reverted}</p>
          </ErrorAlert>
        )}
      </div>
      <div className="dlg-actions">
        <DialogClose asChild>
          <button type="button" className="btn btn-ghost">
            {CHAT_DIALOGS.common.close}
          </button>
        </DialogClose>
      </div>
    </Dialog>
  );
}
