import { IconChevronDown, IconLoader2 } from "@tabler/icons-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import { chatApi, type ProjectChatView } from "../../api/chat";
import { ErrorAlert } from "../../components/ErrorAlert";
import { CHAT_DIALOGS } from "../../i18n/chat-dialogs";
import { MemberPanelActions, MemberRow } from "./GroupMembers";
import { usePeopleDirectory } from "./PeoplePicker";

type ProjectChatState = {
  view: ProjectChatView | null;
  loading: boolean;
  error: AppError | null;
  reload: () => Promise<void>;
};

// Anggota chat proyek dari inti Rust, hanya selama daftar terbuka: dimuat saat dibuka dan
// saat refreshKey berubah (jumlah anggota, status bukan anggota lagi). Daftar terakhir
// tetap ditampilkan selama memuat ulang.
function useProjectChatView(conv: string, active: boolean, refreshKey: string): ProjectChatState {
  const [view, setView] = useState<ProjectChatView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const next = await chatApi.projectChat(conv);
      if (n === seq.current) setView(next);
    } catch (err) {
      if (n === seq.current) setError(toAppError(err));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [conv]);

  useEffect(() => {
    if (!active) return;
    void reload();
    return () => {
      // Jawaban yang datang sesudah daftar ditutup atau unmount diabaikan.
      seq.current++;
      setLoading(false);
    };
  }, [reload, active, refreshKey]);

  return { view, loading, error, reload };
}

type Props = {
  conv: string;
  memberCount: number;
  former: boolean;
};

// Tombol "Proyek · N anggota" dan daftar anggota (hanya baca) yang terbuka di bawahnya.
// Anggota chat proyek selalu anggota proyek; mengubahnya lewat Board, bukan di sini.
export function ProjectMembers({ conv, memberCount, former }: Props) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();
  const departments = usePeopleDirectory(open);
  const { view, loading, error, reload } = useProjectChatView(conv, open, `${memberCount}|${former}`);
  const T = CHAT_DIALOGS.projectMembers;
  const M = CHAT_DIALOGS.members;

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  const members = view?.members ?? [];
  const count = view ? members.length : memberCount;

  let content;
  if (!view && !error) {
    content = (
      <p className="conv-group-state" role="status">
        <IconLoader2 size={16} className="conv-spin" aria-hidden="true" />
        {M.loading}
      </p>
    );
  } else if (!view) {
    content = (
      <ErrorAlert title={M.loadFailed}>
        <p>{error?.message}</p>
        <button
          type="button"
          className="btn btn-ghost btn-sm conv-retry"
          onClick={() => void reload()}
          disabled={loading}
          aria-busy={loading || undefined}
        >
          {loading ? M.retrying : M.retry}
        </button>
      </ErrorAlert>
    );
  } else if (members.length === 0) {
    content = <p className="conv-group-state">{T.empty}</p>;
  } else {
    content = (
      <ul className="conv-members">
        {members.map((m) => (
          <MemberRow
            key={m.person.publicKey}
            person={m.person}
            me={m.me}
            department={departments.get(m.person.publicKey)}
            chip={m.manager ? T.manager : undefined}
          />
        ))}
      </ul>
    );
  }

  // Catatan ikut data terbaru dari inti Rust; sebelum ada, ikut ringkasan percakapan.
  const isFormer = view ? view.former : former;
  let note: string | null = null;
  if (isFormer) note = T.former;
  else if (view?.canManage) note = T.canManage;
  else if (view) note = T.managed;

  return (
    <div className="conv-group-wrap">
      <button
        ref={buttonRef}
        type="button"
        className="conv-members-btn"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {T.button(memberCount)}
        <IconChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="conv-group-pop member-pop"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        >
          <p id={titleId} className="conv-pop-title">
            {T.panelTitle(count)}
          </p>
          {view && error && (
            <p className="conv-group-stale" role="status">
              {M.stale}
            </p>
          )}
          <MemberPanelActions close={close}>{content}</MemberPanelActions>
          <hr className="conv-group-sep" />
          <p className="conv-pop-note">
            {T.always}
            {note && ` ${note}`}
          </p>
        </div>
      )}
    </div>
  );
}
