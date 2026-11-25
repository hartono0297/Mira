import { IconBell, IconBellOff, IconChevronDown, IconLock, IconPlus, IconUsers } from "@tabler/icons-react";
import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AppError } from "../../api";
import {
  CHAT_SECTIONS,
  chatApi,
  type ChatOverview,
  type ChatSection,
  type ConversationSummary,
} from "../../api/chat";
import { ErrorAlert } from "../../components/ErrorAlert";
import { Avatar } from "../../components/Avatar";
import { LabelChips } from "../../components/NameWithLabels";
import { CHAT } from "../../i18n/chat";
import { CHAT_DIVISION } from "../../i18n/chat-division";
import { COMPONENTS_TEXT } from "../../i18n/components";
import type { ConvRequest } from "./ChatActions";
import { ACTION_ERRORS, useConversationMenu, type ActionError } from "./conversationMenu";
import { isDivisionChat, withDivisionOrder } from "./divisionOrder";
import {
  SECTION_TITLES,
  badgeCount,
  groupConversations,
  sectionOf,
  sectionUnread,
  unreadText,
} from "./ListFormat";
import { useLabelsOf } from "./PeopleLabels";

type Props = {
  overview: ChatOverview;
  currentId: string | null;
  // Percakapan yang baru dibuat atau dibuka lewat dialog (grup baru, pesan pribadi baru). Kalau
  // bagiannya terlipat, bagian itu dibuka sekali begitu percakapannya ada di daftar.
  revealId: string | null;
  onRevealed: () => void;
  // Muat ulang terakhir gagal: daftar lama tetap tampil dengan catatan kecil.
  staleError: AppError | null;
  onSelect: (id: string) => void;
  // Menu baris: Ganti nama atau Tambah orang dijalankan kepala percakapan setelah percakapannya dibuka.
  onRequest: (conv: string, action: ConvRequest["action"]) => void;
  // Aksi menu berhasil: muat ulang daftar.
  onChanged: () => void;
  // Channel dihapus atau keluar dari grup lewat menu baris.
  onRemoved: (conv: string) => void;
  onRetry: () => void;
  onNewChannel: () => void;
  onNewGroup: () => void;
  onNewDirect: () => void;
  onNotify: () => void;
};

// Gagal simpan diabaikan: lipatan tetap berlaku selama layar terbuka.
function saveFolded(next: ChatSection[]) {
  chatApi.setFolded(next).catch(() => {});
}

export function ConversationList({
  overview,
  currentId,
  revealId,
  onRevealed,
  staleError,
  onSelect,
  onRequest,
  onChanged,
  onRemoved,
  onRetry,
  onNewChannel,
  onNewGroup,
  onNewDirect,
  onNotify,
}: Props) {
  // Dibaca sekali saat dipasang; setelah itu layar ini yang memegang lipatan.
  const [folded, setFolded] = useState<ChatSection[]>(() => overview.folded);
  const ids = useId();
  const groups = withDivisionOrder(groupConversations(overview.conversations));
  // Error aksi langsung dari menu baris (Bisukan, Arsipkan, dan seterusnya).
  const [actionError, setActionError] = useState<ActionError | null>(null);

  function toggle(section: ChatSection) {
    const next = CHAT_SECTIONS.filter((s) => (s === section ? !folded.includes(s) : folded.includes(s)));
    setFolded(next);
    saveFolded(next);
  }

  // Hanya aksi pengguna (grup baru, pesan pribadi baru) yang membuka bagian terlipat. Pindah
  // otomatis, misalnya kembali ke #umum setelah percakapan dihapus, tidak mengubah lipatan.
  // Percakapan yang belum ada di ringkasan ditunggu sampai muncul.
  useEffect(() => {
    if (!revealId) return;
    const target = overview.conversations.find((c) => c.id === revealId);
    if (!target) return;
    const section = sectionOf(target);
    setFolded((prev) => {
      if (!prev.includes(section)) return prev;
      const next = prev.filter((s) => s !== section);
      saveFolded(next);
      return next;
    });
    onRevealed();
  }, [revealId, overview.conversations, onRevealed]);

  const rows = (list: ConversationSummary[]) => (
    <ul className="chat-rows">
      {list.map((c) => (
        <ListRow
          key={c.id}
          summary={c}
          current={c.id === currentId}
          onSelect={onSelect}
          onRequest={onRequest}
          onChanged={onChanged}
          onRemoved={onRemoved}
          onError={setActionError}
        />
      ))}
    </ul>
  );

  const addButton = (label: string, onClick: () => void) => (
    <button type="button" className="btn btn-ghost btn-sm chat-new" onClick={onClick}>
      <IconPlus size={16} aria-hidden="true" />
      {label}
    </button>
  );

  const note = (text: string) => <p className="chat-note">{text}</p>;

  // Isi tiap bagian: baris, catatan kosong, lalu tombol buat atau catatan siapa yang membuat.
  function body(section: ChatSection, list: ConversationSummary[]): ReactNode {
    const has = list.length > 0;
    switch (section) {
      case "umum":
        return (
          <>
            {has ? rows(list) : note(CHAT.list.noOrgChannel)}
            {overview.canCreateOrgChannel
              ? addButton(CHAT.list.newOrgChannel, onNewChannel)
              : note(CHAT.list.orgChannelBySuperadmin)}
          </>
        );
      case "departemen":
        return has
          ? rows(list)
          : note(
              overview.myDepartment
                ? CHAT.list.noDeptChannel(overview.myDepartment.name)
                : CHAT.list.noDepartment,
            );
      case "proyek":
        return (
          <>
            {has ? rows(list) : note(CHAT.list.noProjects)}
            {overview.isGuest
              ? note(CHAT.list.guestProjects)
              : overview.otherProjects > 0 && note(CHAT.list.otherProjects)}
          </>
        );
      case "grup":
        return (
          <>
            {has ? rows(list) : note(CHAT.list.noGroups)}
            {overview.canCreateGroup && addButton(CHAT.list.newGroup, onNewGroup)}
          </>
        );
      case "pribadi":
        return (
          <>
            {has ? rows(list) : note(CHAT.list.noDirect)}
            {overview.canDirectMessage && addButton(CHAT.list.newDirect, onNewDirect)}
          </>
        );
    }
  }

  // Panah atas dan bawah, Home, End berpindah antarbaris percakapan, melewati bagian yang
  // dilipat. Tab tetap urut biasa.
  function onRowKey(e: KeyboardEvent<HTMLElement>) {
    const target = e.target as HTMLElement;
    if (!target.classList.contains("chat-row")) return;
    const all = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(".chat-row")).filter(
      (r) => !r.closest("[hidden]"),
    );
    const at = all.indexOf(target as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = Math.min(at + 1, all.length - 1);
    else if (e.key === "ArrowUp") next = Math.max(at - 1, 0);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = all.length - 1;
    if (next === null || at === -1) return;
    e.preventDefault();
    all[next]?.focus();
  }

  return (
    <nav className="chat-list" aria-label={CHAT.list.label} onKeyDown={onRowKey}>
      <div className="chat-list-head">
        <h1 id="page-title" className="page-title">
          {CHAT.title}
        </h1>
        <div className="chat-list-tools">
          <button
            type="button"
            className="chat-icon-btn"
            onClick={onNotify}
            aria-label={CHAT.list.notify}
            title={CHAT.list.notify}
          >
            <IconBell size={18} aria-hidden="true" />
          </button>
        </div>
      </div>

      {staleError && (
        <div className="chat-stale" role="status">
          <p>
            {CHAT.list.stale} {staleError.message}
          </p>
          <button type="button" className="link-btn" onClick={onRetry}>
            {CHAT.retry}
          </button>
        </div>
      )}

      <div aria-live="polite">
        {actionError && (
          <div className="chat-action-error">
            <ErrorAlert title={ACTION_ERRORS[actionError.action]}>
              <p>
                {actionError.title}: {actionError.error.message}
              </p>
              <button type="button" className="link-btn" onClick={() => setActionError(null)}>
                {CHAT.close}
              </button>
            </ErrorAlert>
          </div>
        )}
      </div>

      {CHAT_SECTIONS.map((section) => {
        const list = groups[section];
        // Tamu tidak punya departemen, channel umum, grup, atau pesan pribadi. Bagian yang
        // ternyata berisi tetap tampil, supaya tidak ada percakapan yang tersembunyi.
        if (overview.isGuest && section !== "proyek" && list.length === 0) return null;
        return (
          <Section
            key={section}
            id={`${ids}-${section}`}
            title={SECTION_TITLES[section]}
            list={list}
            folded={folded.includes(section)}
            onToggle={() => toggle(section)}
          >
            {body(section, list)}
          </Section>
        );
      })}
    </nav>
  );
}

function Section({
  id,
  title,
  list,
  folded,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  list: ConversationSummary[];
  // Terlipat menyembunyikan semua baris, termasuk percakapan yang sedang dibuka di panel kanan.
  folded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const open = !folded;
  const { unread, mentions, loud } = sectionUnread(list);
  const showCount = !open && unread > 0;
  const label = showCount ? `${title}, ${unreadText(unread, mentions)}` : title;

  return (
    <section className="chat-sec" aria-label={title}>
      <h2 className="chat-lbl">
        <button
          type="button"
          className={`chat-fold${loud ? "" : " chat-fold-quiet"}`}
          aria-expanded={open}
          aria-controls={id}
          aria-label={label}
          onClick={onToggle}
        >
          <IconChevronDown size={16} className="chat-fold-icon" aria-hidden="true" />
          <span className="chat-fold-title">{title}</span>
          {showCount && mentions > 0 && (
            <span className="chat-at" aria-hidden="true">
              @
            </span>
          )}
          {showCount && (
            <span className="chat-badge" aria-hidden="true">
              {badgeCount(unread)}
            </span>
          )}
        </button>
      </h2>
      <div id={id} className="chat-sec-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

function rowLabel(c: ConversationSummary): string {
  if (c.kind === "dm") return CHAT.list.rowDirect(c.name);
  if (isDivisionChat(c)) return CHAT_DIVISION.row(c.name);
  if (c.kind === "group") return CHAT.list.rowGroup(c.name);
  if (c.kind === "project") return CHAT.list.rowProject(c.name);
  return CHAT.list.rowChannel(c.name);
}

// Keadaan yang ditulis di bawah nama, supaya baris yang diredam tidak hanya dibedakan lewat warna.
function rowState(c: ConversationSummary): string | null {
  if (c.former) return CHAT.state.former;
  if (c.archived) return CHAT.state.archived;
  return null;
}

type RowProps = {
  summary: ConversationSummary;
  current: boolean;
  onSelect: (id: string) => void;
  onRequest: (conv: string, action: ConvRequest["action"]) => void;
  onChanged: () => void;
  onRemoved: (conv: string) => void;
  onError: (error: ActionError | null) => void;
};

// Satu baris percakapan beserta menu klik kanannya (juga tombol Menu dan Shift+F10 di baris).
// Tidak ada tombol "..." per baris: semua aksinya juga ada di menu "..." kepala percakapan.
function ListRow({ summary: c, current, onSelect, onRequest, onChanged, onRemoved, onError }: RowProps) {
  const menu = useConversationMenu({
    summary: c,
    onOpen: () => onSelect(c.id),
    onChanged,
    onGone: () => onRemoved(c.id),
    onRename: () => onRequest(c.id, "rename"),
    onAdd: () => onRequest(c.id, "add"),
    onError,
  });
  const unread = c.unread > 0 || c.mentionUnread > 0;
  const state = rowState(c);
  // Pesan pribadi: label profil rekan, ringkas di baris kedua. Semua namanya ada di nama
  // tombol dan tooltip baris, karena "+N" di dalam tombol tidak bisa difokus sendiri.
  const labels = useLabelsOf(c.kind === "dm" ? (c.peer?.publicKey ?? "") : "");
  const labelText =
    labels.length > 0 ? COMPONENTS_TEXT.labels.prefix(labels.length) + labels.map((l) => l.name).join(", ") : "";
  // Nama lengkap untuk pembaca layar. Lencana dan ikon di dalam tombol hanya tampilan.
  const label = [
    rowLabel(c) + labelText,
    c.locked ? CHAT.list.readOnly : "",
    state?.toLowerCase() ?? "",
    c.muted ? CHAT.list.muted : "",
    unreadText(c.unread, c.mentionUnread),
  ]
    .filter(Boolean)
    .join(", ");
  const count = Math.max(c.unread, c.mentionUnread);
  const shown = c.kind === "channel" ? `#${c.name}` : c.name;
  const classes = [
    "chat-row",
    unread ? "chat-row-unread" : "",
    c.muted ? "chat-row-muted" : "",
    state ? "chat-row-dim" : "",
    menu.isOpen ? "chat-row-menu" : "",
    isDivisionChat(c) ? "chat-row-division" : "",
  ].filter(Boolean);

  return (
    <li {...menu.triggerProps}>
      <button
        type="button"
        className={classes.join(" ")}
        aria-current={current ? "true" : undefined}
        aria-label={label}
        onClick={() => onSelect(c.id)}
        title={[shown + labelText, c.locked ? CHAT.list.readOnly : "", state?.toLowerCase() ?? ""].filter(Boolean).join(", ")}
      >
        {c.kind === "dm" ? (
          <Avatar className="chat-av" name={c.name} publicKey={c.peer?.publicKey} />
        ) : c.kind === "group" || c.kind === "project" || isDivisionChat(c) ? (
          <IconUsers size={18} className="chat-kind" aria-hidden="true" />
        ) : (
          <span className="chat-hash" aria-hidden="true">
            #
          </span>
        )}
        <span className="chat-row-text">
          <span className="chat-row-name">{c.name}</span>
          {labels.length > 0 && <LabelChips className="chat-row-labels" labels={labels} max={2} />}
          {state && <span className="chat-row-hint">{state}</span>}
        </span>
        {c.locked && <IconLock size={15} className="chat-row-icon" aria-hidden="true" />}
        {c.muted && <IconBellOff size={15} className="chat-row-icon" aria-hidden="true" />}
        {c.mentionUnread > 0 && (
          <span className="chat-at" aria-hidden="true">
            @
          </span>
        )}
        {count > 0 && (
          <span className="chat-badge" aria-hidden="true">
            {badgeCount(count)}
          </span>
        )}
      </button>
      {menu.element}
    </li>
  );
}
