import type { ReactNode } from "react";
import { Dialog, DialogClose } from "./Dialog";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  onConfirm: () => void;
  danger?: boolean;
  error?: ReactNode;
};

// Konfirmasi untuk tindakan yang tidak bisa dibatalkan. Fokus awal di tombol
// Batal supaya Enter tidak langsung menjalankan tindakan.
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  busyLabel,
  busy,
  onConfirm,
  danger = true,
  error,
}: Props) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={title}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        const root = (e.target as HTMLElement | null) ?? null;
        root?.querySelector<HTMLButtonElement>("[data-cancel]")?.focus();
      }}
    >
      <div className="dlg-desc">{children}</div>
      <div aria-live="polite">{error}</div>
      <div className="dlg-actions">
        <DialogClose asChild>
          <button type="button" className="btn btn-ghost" data-cancel disabled={busy}>
            Batal
          </button>
        </DialogClose>
        <button
          type="button"
          className={`btn${danger ? " btn-danger" : ""}`}
          onClick={onConfirm}
          disabled={busy}
          aria-busy={busy || undefined}
        >
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
