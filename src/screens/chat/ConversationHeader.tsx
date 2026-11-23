import { IconBellOff, IconLock, IconUserPlus, IconUsers } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { ConversationSummary } from "../../api/chat";
import { MenuButton } from "../../components/ContextMenu";
import { ErrorAlert } from "../../components/ErrorAlert";
import { initials } from "../../components/initials";
import type { ConvRequest } from "./ChatActions";
import { ACTION_ERRORS, useConversationMenu, type ActionError } from "./conversationMenu";
import { AddPeopleDialog, GroupMembers, RenameGroupDialog, type GroupState } from "./GroupMembers";
import { ProjectMembers } from "./ProjectMembers";
import { conversationTitle, scopeLabel } from "./text";

type Props = {
  summary: ConversationSummary;
  // Data grup dari panel percakapan (useGroupView). Untuk selain grup: group null.
  groupState: GroupState;
  // Permintaan dari menu sidebar untuk percakapan ini (sudah disaring per percakapan).
  request?: ConvRequest | null;
  onRequestDone?: () => void;
  onChanged: () => void;
  onGone: () => void;
};

type GroupDialog = "rename" | "add";

export function ConversationHeader({ summary, groupState, request = null, onRequestDone, onChanged, onGone }: Props) {
  const title = conversationTitle(summary);
  const [error, setError] = useState<ActionError | null>(null);
  const isGroup = summary.kind === "group";
  // Chat proyek tampil seperti grup, tetapi anggotanya diatur di Board: tanpa tambah, keluar,
  // ganti nama, atau hapus. Menunya hanya Bisukan (dan Kembalikan untuk arsip lama).
  const isProject = summary.kind === "project";
  const groupLike = isGroup || isProject;
  const group = groupState.group;
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // Dialog grup yang diminta (dari menu ini atau dari sidebar) sebelum data grup selesai dimuat.
  const [pending, setPending] = useState<GroupDialog | null>(null);

  // Ganti percakapan: buang error dan dialog lama.
  useEffect(() => {
    setError(null);
    setAdding(false);
    setRenaming(false);
    setPending(null);
  }, [summary.id]);

  // Permintaan dari sidebar: disimpan sebagai dialog tertunda, lalu permintaannya selesai.
  const requestN = request?.n;
  const requestAction = request?.action;
  useEffect(() => {
    if (requestN === undefined || !requestAction) return;
    setPending(requestAction);
    onRequestDone?.();
    // Satu kali per permintaan: hanya n yang dipantau.
  }, [requestN]);

  // Buka dialog tertunda begitu data grup siap. Kalau data grup gagal dimuat, permintaan
  // dibuang; GroupMembers sudah menampilkan error-nya.
  useEffect(() => {
    if (!pending) return;
    if (group) {
      const allowed = !summary.former && (pending === "rename" ? group.canRename : group.canAdd);
      if (allowed) (pending === "rename" ? setRenaming : setAdding)(true);
      setPending(null);
    } else if (!groupState.loading) {
      setPending(null);
    }
  }, [pending, group, groupState.loading, summary.former]);

  const menu = useConversationMenu({
    summary,
    onChanged,
    onGone,
    onRename: () => setPending("rename"),
    onAdd: () => setPending("add"),
    onError: setError,
  });

  return (
    <header className="conv-head">
      {/* Klik kanan atau Shift+F10 di kepala membuka menu yang sama dengan tombol "...". */}
      <div className="conv-head-row" {...menu.triggerProps}>
        {summary.kind === "dm" && (
          <span className="conv-avatar" aria-hidden="true">
            {initials(title)}
          </span>
        )}
        {groupLike && (
          <span className="conv-head-icon" aria-hidden="true">
            <IconUsers size={20} />
          </span>
        )}
        <div className={groupLike ? "conv-head-text conv-head-group" : "conv-head-text"}>
          <h2 className="conv-title">{title}</h2>
          {isGroup && (
            <GroupMembers
              memberCount={summary.memberCount}
              title={title}
              state={groupState}
              onChanged={onChanged}
              onGone={onGone}
            />
          )}
          {isProject && (
            <ProjectMembers conv={summary.id} memberCount={summary.memberCount} former={summary.former} />
          )}
          <p className="conv-scope">
            {!groupLike && <span>{scopeLabel(summary)}</span>}
            {summary.locked && (
              <span className="chip conv-chip-muted">
                <IconLock size={12} aria-hidden="true" />
                Hanya-baca
              </span>
            )}
            {summary.former && <span className="chip">Bukan anggota lagi</span>}
            {summary.archived && <span className="chip">Diarsipkan</span>}
            {summary.muted && (
              <span className="chip conv-chip-muted">
                <IconBellOff size={12} aria-hidden="true" />
                Dibisukan
              </span>
            )}
          </p>
        </div>
        {isGroup && group?.canAdd && !summary.former && (
          <button type="button" className="btn btn-ghost btn-sm conv-add" onClick={() => setAdding(true)}>
            <IconUserPlus size={16} aria-hidden="true" />
            Tambah orang
          </button>
        )}
        <MenuButton menu={menu} label={`Menu ${title}`} className="conv-icon-btn" />
      </div>
      <div aria-live="polite">
        {error && (
          <div className="conv-head-error">
            <ErrorAlert title={ACTION_ERRORS[error.action]}>
              <p>{error.error.message}</p>
            </ErrorAlert>
          </div>
        )}
      </div>
      {isGroup && group && (
        <>
          <AddPeopleDialog
            open={adding}
            onOpenChange={setAdding}
            group={group}
            onAdded={() => {
              setAdding(false);
              void groupState.reload();
              onChanged();
            }}
          />
          <RenameGroupDialog
            open={renaming}
            onOpenChange={setRenaming}
            conv={summary.id}
            name={group.name}
            onRenamed={() => {
              setRenaming(false);
              void groupState.reload();
              onChanged();
            }}
          />
        </>
      )}
      {menu.element}
    </header>
  );
}
