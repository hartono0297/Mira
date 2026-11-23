import { IconDots, IconTrash } from "@tabler/icons-react";
import { useId, type RefObject } from "react";
import { MenuList, Popover } from "./TaskPopover";
import { TEKS_DIALOG } from "./teksDialog";

type Props = {
  open: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onOpenChange: (open: boolean) => void;
  onDelete: () => void;
};

// Tombol Lainnya (titik tiga) di kepala dialog. Isinya sekarang hanya Hapus
// task, jadi tombol ini hanya dipasang untuk yang boleh menghapus.
export function TaskMoreMenu({ open, buttonRef, onOpenChange, onDelete }: Props) {
  const id = useId();
  return (
    <div className="td-more">
      <button
        ref={buttonRef}
        type="button"
        className="td-icon-btn"
        aria-label={TEKS_DIALOG.lainnya}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-pop` : undefined}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            onOpenChange(true);
          }
        }}
      >
        <IconDots size={20} aria-hidden="true" />
      </button>
      {open && (
        <Popover id={`${id}-pop`} anchorRef={buttonRef} align="end" onDismiss={() => onOpenChange(false)}>
          <MenuList
            label={TEKS_DIALOG.lainnya}
            items={[
              {
                value: "delete",
                label: TEKS_DIALOG.hapusTask,
                danger: true,
                icon: <IconTrash size={17} aria-hidden="true" />,
              },
            ]}
            onPick={() => onDelete()}
          />
        </Popover>
      )}
    </div>
  );
}
