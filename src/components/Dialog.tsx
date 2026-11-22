import * as RadixDialog from "@radix-ui/react-dialog";
import { useLayoutEffect, useRef, type ReactNode } from "react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  // Elemen yang menerima fokus pertama. Bawaan Radix: elemen pertama yang bisa difokus.
  onOpenAutoFocus?: (event: Event) => void;
};

// Dialog modal: fokus terkunci di dalam, Escape dan tombol Batal menutup,
// fokus kembali ke tombol pembuka.
export function Dialog({ open, onOpenChange, title, description, children, onOpenAutoFocus }: Props) {
  // Dialog dibuka lewat state, bukan Dialog.Trigger, jadi Radix tidak tahu
  // tombol pembukanya. Tombol itu dicatat di sini dan difokus lagi saat dialog tutup.
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dlg-overlay" />
        <RadixDialog.Content
          className="dlg"
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (opener.current?.isConnected) opener.current.focus();
          }}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <RadixDialog.Title className="dlg-title">{title}</RadixDialog.Title>
          {description && <RadixDialog.Description className="dlg-desc">{description}</RadixDialog.Description>}
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogClose = RadixDialog.Close;
