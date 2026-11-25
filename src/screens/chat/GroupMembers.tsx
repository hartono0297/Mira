import { IconChevronDown, IconDoorExit, IconLoader2 } from "@tabler/icons-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { toAppError, type AppError } from "../../api";
import { chatApi, type GroupMemberView, type GroupView, type Person } from "../../api/chat";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { MenuButton } from "../../components/ContextMenu";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { initials } from "../../components/initials";
import { CHAT_DIALOGS } from "../../i18n/chat-dialogs";
import {
  ChatActionsContext,
  ConversationActionsContext,
  useChatActions,
  useConversationActions,
  usePersonMenu,
  type ChatActions,
  type ConversationActions,
} from "./ChatActions";
import { MENU } from "./menuText";
import { GROUP_PICK_MAX, groupNameError, InlineError, normalizeGroupName, GROUP_NAME_MAX } from "./NewGroupDialog";
import { PeoplePicker, usePeopleDirectory } from "./PeoplePicker";
import { PersonName } from "./PersonName";
import "./profile.css";

export type GroupState = {
  group: GroupView | null;
  loading: boolean;
  error: AppError | null;
  reload: () => Promise<void>;
};

// Data grup (anggota, kandidat, hak). conv null: bukan grup, tidak memuat apa pun.
// refreshKey berubah saat ringkasan berubah (jumlah anggota, nama), lalu dimuat ulang.
export function useGroupView(conv: string | null, refreshKey: string): GroupState {
  const [group, setGroup] = useState<GroupView | null>(null);
  const [loading, setLoading] = useState(conv !== null);
  const [error, setError] = useState<AppError | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const n = ++seq.current;
    if (!conv) {
      setGroup(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await chatApi.group(conv);
      if (n === seq.current) setGroup(next);
    } catch (err) {
      if (n === seq.current) setError(toAppError(err));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [conv]);

  useEffect(() => {
    void reload();
    return () => {
      // Jawaban yang datang sesudah ganti percakapan atau unmount diabaikan.
      seq.current++;
    };
  }, [reload, refreshKey]);

  return { group, loading, error, reload };
}

// Menu orang di panel anggota (grup dan proyek). Aksi yang membawa pengguna ke tempat lain
// (Kirim pesan pribadi, Sebut, Lihat profil) menutup panel dulu dan mengembalikan fokus ke
// tombol anggota, baru aksinya jalan. Dialog profil mencatat tombol itu sebagai pembukanya,
// jadi fokus kembali ke sana saat profil ditutup (baris di panel sudah hilang).
export function MemberPanelActions({ close, children }: { close: () => void; children: ReactNode }) {
  const chat = useChatActions();
  const conv = useConversationActions();
  const closeRef = useRef(close);
  closeRef.current = close;
  const chatValue = useMemo<ChatActions | null>(
    () =>
      chat && {
        ...chat,
        openDm: (person: Person) => {
          closeRef.current();
          return chat.openDm(person);
        },
        showProfile: (person: Person) => {
          closeRef.current();
          chat.showProfile(person);
        },
      },
    [chat],
  );
  const convValue = useMemo<ConversationActions | null>(() => {
    if (!conv) return null;
    const mention = conv.mention;
    return {
      ...conv,
      mention:
        mention &&
        ((person: Person) => {
          closeRef.current();
          mention(person);
        }),
    };
  }, [conv]);
  return (
    <ChatActionsContext.Provider value={chatValue}>
      <ConversationActionsContext.Provider value={convValue}>{children}</ConversationActionsContext.Provider>
    </ChatActionsContext.Provider>
  );
}

type MemberRowProps = {
  person: Person;
  me: boolean;
  department: string | undefined;
  // Chip di kanan nama, misalnya "Pemilik grup".
  chip?: string;
  // Pemilik grup: membuka konfirmasi Keluarkan yang sama dengan tombol Keluarkan.
  onRemove?: () => void;
  children?: ReactNode;
};

// Satu baris anggota dengan menu orang: klik kanan, Shift+F10, tombol Menu, atau tombol "...".
export function MemberRow({ person, me, department, chip, onRemove, children }: MemberRowProps) {
  const menu = usePersonMenu(person, { onRemove });
  return (
    <li className="conv-member" {...menu.triggerProps}>
      <span className="pick-av" aria-hidden="true">
        {initials(person.name)}
      </span>
      <span className="pick-who">
        <span className="pick-name">
          {/* Semua label orang itu tampil; chip turun baris di panel yang sempit. */}
          <PersonName person={person} me={me} labelsMode="all" />
        </span>
        {department && <span className="pick-dept-line">{department}</span>}
      </span>
      {chip && <span className="chip chip-on">{chip}</span>}
      {children}
      <MenuButton menu={menu} label={MENU.personMenu(person.name)} className="member-more" />
      {menu.element}
    </li>
  );
}

type MembersProps = {
  memberCount: number;
  title: string;
  state: GroupState;
  onChanged: () => void;
  onGone: () => void;
};

// Tombol "Grup · N anggota" dan daftar anggota yang terbuka di bawahnya.
export function GroupMembers({ memberCount, title, state, onChanged, onGone }: MembersProps) {
  const [open, setOpen] = useState(false);
  const [toRemove, setToRemove] = useState<GroupMemberView | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<AppError | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();
  const departments = usePeopleDirectory(open);
  const alive = useRef(true);
  const dialogOpen = toRemove !== null || leaving;
  const dialogOpenRef = useRef(dialogOpen);
  dialogOpenRef.current = dialogOpen;
  const { group, loading, error, reload } = state;
  const T = CHAT_DIALOGS.groupMembers;
  const M = CHAT_DIALOGS.members;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    void reload();
    function onDown(e: MouseEvent) {
      if (dialogOpenRef.current) return;
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // reload sengaja tidak jadi dependensi: dimuat ulang sekali setiap panel dibuka.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close(focusButton: boolean) {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }

  async function removeMember() {
    if (!toRemove || !group) return;
    setBusy(true);
    setActionError(null);
    try {
      await chatApi.groupRemove(group.conv, toRemove.person.publicKey);
      if (!alive.current) return;
      setToRemove(null);
      void reload();
      onChanged();
    } catch (err) {
      if (alive.current) setActionError(toAppError(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function leave() {
    if (!group) return;
    setBusy(true);
    setActionError(null);
    try {
      await chatApi.groupLeave(group.conv);
      if (!alive.current) return;
      setLeaving(false);
      setOpen(false);
      onChanged();
      onGone();
    } catch (err) {
      if (alive.current) setActionError(toAppError(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const members = group?.members ?? [];
  const count = group ? members.length : memberCount;
  const iAmOwner = members.some((m) => m.me && m.owner);
  const removeName = toRemove?.person.name ?? "";

  let content;
  if (!group && loading) {
    content = (
      <p className="conv-group-state" role="status">
        <IconLoader2 size={16} className="conv-spin" aria-hidden="true" />
        {M.loading}
      </p>
    );
  } else if (!group) {
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
        {members.map((m) => {
          const askRemove = () => {
            setActionError(null);
            setToRemove(m);
          };
          return (
            <MemberRow
              key={m.person.publicKey}
              person={m.person}
              me={m.me}
              department={departments.get(m.person.publicKey)}
              chip={m.owner ? T.owner : undefined}
              onRemove={askRemove}
            >
              {m.canRemove && (
                <button
                  type="button"
                  className="conv-member-remove"
                  aria-label={T.removeLabel(m.person.name)}
                  onClick={askRemove}
                >
                  {T.remove}
                </button>
              )}
            </MemberRow>
          );
        })}
      </ul>
    );
  }

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
              close(true);
            }
          }}
        >
          <p id={titleId} className="conv-pop-title">
            {T.panelTitle(count)}
          </p>
          {group && error && (
            <p className="conv-group-stale" role="status">
              {M.stale}
            </p>
          )}
          <MemberPanelActions close={() => close(true)}>{content}</MemberPanelActions>
          {group?.canLeave && !group.former && (
            <>
              <hr className="conv-group-sep" />
              <button
                type="button"
                className="conv-leave"
                onClick={() => {
                  setActionError(null);
                  setLeaving(true);
                }}
              >
                <IconDoorExit size={16} aria-hidden="true" />
                {MENU.leaveGroup}
              </button>
            </>
          )}
        </div>
      )}
      <ConfirmDialog
        open={toRemove !== null}
        onOpenChange={(next) => {
          if (!next) setToRemove(null);
        }}
        title={MENU.removeTitle(removeName)}
        confirmLabel={MENU.removeConfirm}
        busyLabel={MENU.removeBusy}
        busy={busy}
        onConfirm={() => void removeMember()}
        error={
          actionError && (
            <ErrorAlert title={T.removeFailed(removeName)}>
              <p>{actionError.message}</p>
            </ErrorAlert>
          )
        }
      >
        <p>{MENU.removeBody(removeName)}</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title={MENU.leaveTitle(title)}
        confirmLabel={MENU.leaveConfirm}
        busyLabel={MENU.leaveBusy}
        busy={busy}
        onConfirm={() => void leave()}
        error={
          actionError && (
            <ErrorAlert title={MENU.leaveFailed}>
              <p>{actionError.message}</p>
            </ErrorAlert>
          )
        }
      >
        <p>{MENU.leaveBody}</p>
        {iAmOwner && members.length > 1 && <p>{MENU.leaveOwner}</p>}
      </ConfirmDialog>
    </div>
  );
}

type AddProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: GroupView;
  onAdded: () => void;
};

// "Tambah orang": pemilih yang sama dengan Grup baru, atas kandidat dari inti Rust.
export function AddPeopleDialog({ open, onOpenChange, group, onAdded }: AddProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const departments = usePeopleDirectory(open);
  const T = CHAT_DIALOGS.addPeople;

  const pickError =
    selected.length === 0
      ? T.pickNone
      : selected.length > GROUP_PICK_MAX
        ? CHAT_DIALOGS.newGroup.pickTooMany(GROUP_PICK_MAX)
        : null;

  function reset() {
    setSelected([]);
    setTried(false);
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setTried(true);
    if (pickError) return;
    setBusy(true);
    setError(null);
    try {
      await chatApi.groupAdd(group.conv, selected);
      reset();
      onAdded();
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(false);
    }
  }

  const count = selected.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) reset();
        onOpenChange(next);
      }}
      title={T.title(group.name)}
    >
      <form className="group-form" onSubmit={(e) => void submit(e)} noValidate>
        <PeoplePicker
          people={group.candidates}
          departments={departments}
          selected={selected}
          onChange={setSelected}
          disabled={busy}
          emptyText={T.empty}
          hint={count === 0 ? T.hintNone : T.hintSome(count)}
        />
        <div aria-live="polite">
          {tried && pickError && group.candidates.length > 0 && <InlineError text={pickError} />}
          {error && (
            <ErrorAlert title={T.failed}>
              <p>{error.message}</p>
            </ErrorAlert>
          )}
        </div>
        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={busy}>
              {CHAT_DIALOGS.common.cancel}
            </button>
          </DialogClose>
          {group.candidates.length > 0 && (
            <button
              type="submit"
              className="btn"
              aria-disabled={!!pickError || undefined}
              aria-busy={busy || undefined}
              disabled={busy}
            >
              {busy ? T.adding : T.add}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

type RenameProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conv: string;
  name: string;
  onRenamed: () => void;
};

export function RenameGroupDialog({ open, onOpenChange, conv, name, onRenamed }: RenameProps) {
  const [value, setValue] = useState(name);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const ids = useId();
  const T = CHAT_DIALOGS.renameGroup;

  // Setiap kali dibuka, kolom diisi nama sekarang.
  useEffect(() => {
    if (open) {
      setValue(name);
      setTried(false);
      setError(null);
    }
  }, [open, name]);

  const nameError = groupNameError(value);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setTried(true);
    if (nameError) return;
    const next = normalizeGroupName(value);
    if (next === name) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await chatApi.groupRename(conv, next);
      onRenamed();
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={T.title}
      description={T.description}
    >
      <form className="group-form" onSubmit={(e) => void submit(e)} noValidate>
        <div className="field">
          <label htmlFor={`${ids}-name`}>{CHAT_DIALOGS.newGroup.nameLabel}</label>
          <input
            id={`${ids}-name`}
            type="text"
            autoComplete="off"
            maxLength={GROUP_NAME_MAX}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={tried && !!nameError}
            aria-describedby={tried && nameError ? `${ids}-error` : undefined}
            disabled={busy}
          />
          {tried && nameError && <InlineError id={`${ids}-error`} text={nameError} />}
        </div>
        <div aria-live="polite">
          {error && (
            <ErrorAlert title={T.failed}>
              <p>{error.message}</p>
            </ErrorAlert>
          )}
        </div>
        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={busy}>
              {CHAT_DIALOGS.common.cancel}
            </button>
          </DialogClose>
          <button type="submit" className="btn" disabled={busy} aria-busy={busy || undefined}>
            {busy ? T.saving : T.save}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
