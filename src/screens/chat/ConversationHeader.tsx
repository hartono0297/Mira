import { IconArchive, IconArchiveOff, IconBell, IconBellOff, IconDots, IconTrash, type Icon } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { chatApi, type ConversationSummary } from "../../api/chat";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { initials } from "../../components/initials";
import { conversationTitle, scopeLabel } from "./text";

type Props = {
  summary: ConversationSummary;
  onChanged: () => void;
  onGone: () => void;
};

type Action = "mute" | "archive" | "delete";

type MenuItem = { key: Action; label: string; icon: Icon; danger?: boolean };

const ERROR_TITLES: Record<Action, string> = {
  mute: "Notifikasi belum bisa diubah",
  archive: "Arsip belum bisa diubah",
  delete: "Channel belum bisa dihapus",
};

export function ConversationHeader({ summary, onChanged, onGone }: Props) {
  const title = conversationTitle(summary);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<{ action: Action; error: AppError } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<AppError | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const menuId = useId();
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Ganti percakapan: tutup menu dan buang error lama.
  useEffect(() => {
    setOpen(false);
    setError(null);
    setConfirmDelete(false);
    setDeleteError(null);
  }, [summary.id]);

  const items: MenuItem[] = [
    summary.muted
      ? { key: "mute", label: "Nyalakan notifikasi", icon: IconBell }
      : { key: "mute", label: "Bisukan notifikasi", icon: IconBellOff },
  ];
  if (summary.kind === "channel" && summary.canArchive) {
    items.push(
      summary.archived
        ? { key: "archive", label: "Kembalikan dari arsip", icon: IconArchiveOff }
        : { key: "archive", label: "Arsipkan channel", icon: IconArchive },
    );
  }
  if (summary.kind === "channel" && summary.canDelete && !summary.isUmum) {
    items.push({ key: "delete", label: "Hapus channel", icon: IconTrash, danger: true });
  }

  function menuItems(): HTMLButtonElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
  }

  useEffect(() => {
    if (!open) return;
    menuItems()[0]?.focus();
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function close(focusButton: boolean) {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }

  function onMenuKey(e: KeyboardEvent<HTMLUListElement>) {
    const list = menuItems();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (at + 1) % list.length;
    else if (e.key === "ArrowUp") next = (at - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    } else if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    if (next !== null) {
      e.preventDefault();
      list[next]?.focus();
    }
  }

  async function run(action: Action, work: () => Promise<unknown>): Promise<boolean> {
    setBusy(action);
    setError(null);
    try {
      await work();
      return true;
    } catch (err) {
      if (alive.current) setError({ action, error: toAppError(err) });
      return false;
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function pick(key: Action) {
    close(true);
    if (key === "delete") {
      setDeleteError(null);
      setConfirmDelete(true);
      return;
    }
    const ok =
      key === "mute"
        ? await run("mute", () => chatApi.setMuted(summary.id, !summary.muted))
        : await run("archive", () => chatApi.setArchived(summary.id, !summary.archived));
    if (ok) onChanged();
  }

  async function deleteChannel() {
    setBusy("delete");
    setDeleteError(null);
    try {
      await chatApi.deleteChannel(summary.id);
      if (!alive.current) return;
      setConfirmDelete(false);
      onChanged();
      onGone();
    } catch (err) {
      if (alive.current) setDeleteError(toAppError(err));
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  return (
    <header className="conv-head">
      <div className="conv-head-row">
        {summary.kind === "dm" && (
          <span className="conv-avatar" aria-hidden="true">
            {initials(title)}
          </span>
        )}
        <div className="conv-head-text">
          <h2 className="conv-title">{title}</h2>
          <p className="conv-scope">
            <span>{scopeLabel(summary)}</span>
            {summary.archived && <span className="chip">Diarsipkan</span>}
            {summary.muted && (
              <span className="chip conv-chip-muted">
                <IconBellOff size={12} aria-hidden="true" />
                Dibisukan
              </span>
            )}
          </p>
        </div>
        <div className="conv-menu">
          <button
            ref={buttonRef}
            type="button"
            className="conv-icon-btn"
            aria-label={`Menu ${title}`}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            aria-busy={busy !== null || undefined}
            onClick={() => setOpen((v) => !v)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && !e.altKey) {
                e.preventDefault();
                setOpen(true);
              }
            }}
          >
            <IconDots size={18} aria-hidden="true" />
          </button>
          {open && (
            <ul ref={menuRef} id={menuId} role="menu" aria-label={`Menu ${title}`} className="conv-menu-list" onKeyDown={onMenuKey}>
              {items.map((item) => {
                const Glyph = item.icon;
                return (
                  <li key={item.key} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className={item.danger ? "conv-menu-item conv-menu-danger" : "conv-menu-item"}
                      onClick={() => void pick(item.key)}
                    >
                      <Glyph size={16} aria-hidden="true" />
                      {item.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      <div aria-live="polite">
        {error && (
          <div className="conv-head-error">
            <ErrorAlert title={ERROR_TITLES[error.action]}>
              <p>{error.error.message}</p>
            </ErrorAlert>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Hapus channel ${title}?`}
        confirmLabel="Hapus channel"
        busyLabel="Menghapus..."
        busy={busy === "delete"}
        onConfirm={() => void deleteChannel()}
        error={deleteError && <ErrorAlert title={ERROR_TITLES.delete}><p>{deleteError.message}</p></ErrorAlert>}
      >
        <p>
          Semua pesan di {title} dihapus untuk semua anggota. Tindakan ini tidak bisa dibatalkan.
        </p>
      </ConfirmDialog>
    </header>
  );
}
