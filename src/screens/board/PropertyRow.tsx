import { IconCalendar, IconChevronDown, IconPlus } from "@tabler/icons-react";
import { useId, type ReactNode, type RefObject } from "react";
import { Popover } from "./TaskPopover";

// Ikon di kanan bingkai menandai jenis aksinya: memilih dari daftar, memilih
// tanggal, atau menambah.
export type PropertyIcon = "chevron" | "calendar" | "plus";

const ICONS = { chevron: IconChevronDown, calendar: IconCalendar, plus: IconPlus } as const;

type Props = {
  label: string;
  value: ReactNode;
  wide?: boolean;
  icon?: PropertyIcon;
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
// diubah berupa tombol berbingkai (.td-box); klik, Enter, Spasi, atau panah
// bawah membuka pilihannya. Nama aksesibel tombol = label lalu nilai, misalnya
// "Status To do". Kelas td-pv tetap dipasang karena dipakai skrip e2e.
export function PropertyRow({ label, value, wide, icon = "chevron", editor }: Props) {
  const id = useId();
  const Icon = ICONS[icon];
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
              className="td-pv td-box"
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
              <span className="td-pv-val">{value}</span>
              <Icon size={16} className="td-box-ic" data-icon={icon} aria-hidden="true" />
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
