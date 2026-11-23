import { useEffect, useId, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import { chatApi, type NotifyMode } from "../../api/chat";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { systemName } from "../../platform";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: NotifyMode;
  onSaved: (mode: NotifyMode) => void;
};

export const NOTIFY_OPTIONS: { mode: NotifyMode; label: string; desc: string }[] = [
  { mode: "all", label: "Semua pesan baru", desc: "Setiap pesan dari rekan, kecuali di percakapan yang Anda bisukan." },
  {
    mode: "mentions",
    label: "Hanya chat pribadi dan yang menyebut saya",
    desc: "Pesan di channel muncul hanya kalau nama Anda disebut dengan @.",
  },
  { mode: "off", label: "Mati", desc: "Tidak ada notifikasi. Pesan baru tetap terlihat di daftar chat." },
];

// Pengaturan notifikasi chat untuk laptop ini. Tersimpan begitu pilihan diganti.
export function NotifySettings({ open, onOpenChange, mode, onSaved }: Props) {
  const [value, setValue] = useState<NotifyMode>(mode);
  const [saved, setSaved] = useState("");
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
    setSaved("");
    setError(null);
  }, [open]);

  async function choose(next: NotifyMode) {
    const mine = ++seq.current;
    setValue(next);
    setSaved("");
    setError(null);
    try {
      await chatApi.setNotify(next);
      if (mine !== seq.current) return;
      lastSaved.current = next;
      setSaved(`Tersimpan: ${NOTIFY_OPTIONS.find((o) => o.mode === next)?.label}.`);
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
      title="Notifikasi chat"
      description={`Notifikasi muncul di ${systemName()} saat jendela Mira tidak sedang di depan. Pengaturan ini hanya untuk laptop ini.`}
    >
      <fieldset className="chat-opts">
        <legend className="sr-only">Kirim notifikasi untuk</legend>
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
        {saved && <p className="chat-saved">{saved}</p>}
        {error && (
          <ErrorAlert title="Pengaturan notifikasi belum tersimpan">
            <p>{error.message}</p>
            <p>Pilihan dikembalikan seperti semula. Coba pilih lagi.</p>
          </ErrorAlert>
        )}
      </div>
      <div className="dlg-actions">
        <DialogClose asChild>
          <button type="button" className="btn btn-ghost">
            Tutup
          </button>
        </DialogClose>
      </div>
    </Dialog>
  );
}
