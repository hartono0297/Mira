import { IconChevronDown } from "@tabler/icons-react";
import { useId, type ReactNode, type RefObject } from "react";
import { Popover } from "./TaskPopover";

type Props = {
  label: string;
  value: ReactNode;
  wide?: boolean;
  // Tanpa editor: nilai tampil sebagai teks biasa (hanya-baca).
  editor?: {
    popup: "menu" | "dialog";
    open: boolean;
    buttonRef: RefObject<HTMLButtonElement | null>;
    onOpen: () => void;
    onClose: () => void;
    content: ReactNode;
  };
};

// Satu baris "label: nilai" di dalam <dl class="td-props">. Nilai yang bisa
// diubah berupa tombol; klik, Enter, Spasi, atau panah bawah membuka pilihannya.
// Nama aksesibel tombol = label lalu nilai, misalnya "Status To do".
export function PropertyRow({ label, value, wide, editor }: Props) {
  const id = useId();
  return (
    <div className={`td-prop${wide ? " td-prop-wide" : ""}`}>
      <dt id={`${id}-l`}>{label}</dt>
      <dd>
        {editor ? (
          <>
            <button
              ref={editor.buttonRef}
              id={`${id}-v`}
              type="button"
              className="td-pv"
              aria-haspopup={editor.popup}
              aria-expanded={editor.open}
              aria-controls={editor.open ? `${id}-pop` : undefined}
              aria-labelledby={`${id}-l ${id}-v`}
              onClick={() => (editor.open ? editor.onClose() : editor.onOpen())}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" && !editor.open) {
                  e.preventDefault();
                  editor.onOpen();
                }
              }}
            >
              {value}
              <IconChevronDown size={14} className="td-pv-caret" aria-hidden="true" />
            </button>
            {editor.open && (
              <Popover id={`${id}-pop`} anchorRef={editor.buttonRef} onDismiss={editor.onClose}>
                {editor.content}
              </Popover>
            )}
          </>
        ) : (
          <span className="td-pv-text">{value}</span>
        )}
      </dd>
    </div>
  );
}
