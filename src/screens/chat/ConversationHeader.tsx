import { IconBellOff, IconLock, IconUserPlus, IconUsers } from "@tabler/icons-react";
import { useEffect, useRef, useState, type Ref } from "react";
import type { AppError } from "../../api";
import type { ConversationSummary } from "../../api/chat";
import { MenuButton } from "../../components/ContextMenu";
import { ErrorAlert } from "../../components/ErrorAlert";
import { initials } from "../../components/initials";
import { CHAT } from "../../i18n/chat";
import type { ConvRequest } from "./ChatActions";
import { ACTION_ERRORS, useConversationMenu, type ActionError } from "./conversationMenu";
import { AddPeopleDialog, GroupMembers, RenameGroupDialog, type GroupState } from "./GroupMembers";
import { ProjectMembers } from "./ProjectMembers";
import { conversationTitle, scopeLabel } from "./text";

type Props = {
  summary: ConversationSummary;
  // Data grup dari panel percakapan (useGroupView). Untuk selain grup: group null.
  groupState: GroupState;
  // Judul percakapan (tabIndex -1): tujuan fokus setelah panel lama hilang.
  titleRef?: Ref<HTMLHeadingElement>;
  // Permintaan dari menu sidebar untuk percakapan ini (sudah disaring per percakapan).
  request?: ConvRequest | null;
  onRequestDone?: () => void;
  onChanged: () => void;
  onGone: () => void;
};

type GroupDialog = "rename" | "add";

export function ConversationHeader({
  summary,
  groupState,
  titleRef,
  request = null,
  onRequestDone,
  onChanged,
  onGone,
}: Props) {
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
  // tetap disimpan dan error-nya tampil di bawah kepala dengan Coba lagi: dialog terbuka
  // setelah muat ulang berhasil. Batal membuang permintaan.
  const [retrying, setRetrying] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const groupErrorRef = useRef<HTMLDivElement>(null);
  // Kotak error grup hilang bersama tombolnya: fokus pindah dulu ke tombol menu "...", supaya
  // dialog yang terbuka sesudahnya juga mengembalikan fokus ke sana.
  const leaveGroupError = () => {
    if (groupErrorRef.current?.contains(document.activeElement)) {
      rowRef.current?.querySelector<HTMLElement>('button[aria-haspopup="menu"]')?.focus();
    }
  };
  useEffect(() => {
    if (!pending) return;
    if (group) {
      const allowed = !summary.former && (pending === "rename" ? group.canRename : group.canAdd);
      leaveGroupError();
      if (allowed) (pending === "rename" ? setRenaming : setAdding)(true);
      setPending(null);
    } else if (!groupState.loading && !groupState.error) {
      setPending(null);
    }
  }, [pending, group, groupState.loading, groupState.error, summary.former]);
  const groupFailed = pending !== null && !group && (groupState.error !== null || retrying);
  // Error terakhir tetap tampil selama Coba lagi berjalan (reload mengosongkan error).
  const [groupError, setGroupError] = useState<AppError | null>(null);
  useEffect(() => {
    if (groupState.error) setGroupError(groupState.error);
  }, [groupState.error]);

  async function retryGroup() {
    if (retrying) return;
    setRetrying(true);
    try {
      await groupState.reload();
    } finally {
      setRetrying(false);
    }
  }

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
      <div className="conv-head-row" ref={rowRef} {...menu.triggerProps}>
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
          <h2 className="conv-title" ref={titleRef} tabIndex={-1}>
            {title}
          </h2>
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
                {CHAT.state.readOnly}
              </span>
            )}
            {summary.former && <span className="chip">{CHAT.state.former}</span>}
            {summary.archived && <span className="chip">{CHAT.state.archived}</span>}
            {summary.muted && (
              <span className="chip conv-chip-muted">
                <IconBellOff size={12} aria-hidden="true" />
                {CHAT.state.muted}
              </span>
            )}
          </p>
        </div>
        {isGroup && group?.canAdd && !summary.former && (
          <button type="button" className="btn btn-ghost btn-sm conv-add" onClick={() => setAdding(true)}>
            <IconUserPlus size={16} aria-hidden="true" />
            {CHAT.header.addPeople}
          </button>
        )}
        <MenuButton menu={menu} label={CHAT.header.menu(title)} className="conv-icon-btn" />
      </div>
      <div aria-live="polite">
        {error && (
          <div className="conv-head-error">
            <ErrorAlert title={ACTION_ERRORS[error.action]}>
              <p>{error.error.message}</p>
            </ErrorAlert>
          </div>
        )}
        {groupFailed && (
          <div className="conv-head-error" ref={groupErrorRef}>
            <ErrorAlert title={CHAT.header.groupError}>
              {groupError && <p>{groupError.message}</p>}
              {pending && <p>{CHAT.header.groupWait[pending]}</p>}
              <div className="chat-alert-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void retryGroup()}
                  aria-disabled={retrying || undefined}
                  aria-busy={retrying || undefined}
                >
                  {retrying ? CHAT.reloading : CHAT.retry}
                </button>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    leaveGroupError();
                    setPending(null);
                  }}
                >
                  {CHAT.cancel}
                </button>
              </div>
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
