import { IconBell, IconBellOff, IconChevronDown, IconLock, IconPlus, IconUsers } from "@tabler/icons-react";
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AppError } from "../../api";
import { CHAT_SECTIONS, type ChatOverview, type ChatSection, type ConversationSummary } from "../../api/chat";
import { initials } from "../../components/initials";
import {
  SECTION_TITLES,
  badgeCount,
  groupConversations,
  readFolded,
  sectionUnread,
  unreadText,
  writeFolded,
} from "./ListFormat";

type Props = {
  overview: ChatOverview;
  currentId: string | null;
  // Muat ulang terakhir gagal: daftar lama tetap tampil dengan catatan kecil.
  staleError: AppError | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onNewChannel: () => void;
  onNewGroup: () => void;
  onNewDirect: () => void;
  onNotify: () => void;
};

export function ConversationList({
  overview,
  currentId,
  staleError,
  onSelect,
  onRetry,
  onNewChannel,
  onNewGroup,
  onNewDirect,
  onNotify,
}: Props) {
  const [folded, setFolded] = useState<ChatSection[]>(readFolded);
  const ids = useId();
  const groups = groupConversations(overview.conversations);

  function toggle(section: ChatSection) {
    const next = folded.includes(section) ? folded.filter((s) => s !== section) : [...folded, section];
    setFolded(next);
    writeFolded(next);
  }

  const rows = (list: ConversationSummary[]) => (
    <ul className="chat-rows">
      {list.map((c) => (
        <li key={c.id}>
          <ListRow summary={c} current={c.id === currentId} onSelect={onSelect} />
        </li>
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
            {has ? rows(list) : note("Belum ada channel umum.")}
            {overview.canCreateOrgChannel
              ? addButton("Channel umum baru", onNewChannel)
              : note("Channel umum dibuat oleh superadmin.")}
          </>
        );
      case "departemen":
        return has
          ? rows(list)
          : note(
              overview.myDepartment
                ? `Belum ada channel untuk Departemen ${overview.myDepartment.name}.`
                : "Belum ada departemen.",
            );
      case "proyek":
        return (
          <>
            {has ? rows(list) : note("Belum ada proyek yang Anda ikuti.")}
            {overview.isGuest
              ? note("Sebagai Tamu, Anda hanya melihat channel proyek yang Anda ikuti.")
              : overview.otherProjects > 0 && note("Proyek lain tidak tampil karena Anda bukan anggotanya.")}
          </>
        );
      case "grup":
        return (
          <>
            {has ? rows(list) : note("Belum ada grup.")}
            {overview.canCreateGroup && addButton("Grup baru", onNewGroup)}
          </>
        );
      case "pribadi":
        return (
          <>
            {has ? rows(list) : note("Belum ada pesan pribadi.")}
            {overview.canDirectMessage && addButton("Pesan baru", onNewDirect)}
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
    <nav className="chat-list" aria-label="Daftar percakapan" onKeyDown={onRowKey}>
      <div className="chat-list-head">
        <h1 id="page-title" className="page-title">
          Chat
        </h1>
        <div className="chat-list-tools">
          <button
            type="button"
            className="chat-icon-btn"
            onClick={onNotify}
            aria-label="Pengaturan notifikasi chat"
            title="Pengaturan notifikasi chat"
          >
            <IconBell size={18} aria-hidden="true" />
          </button>
        </div>
      </div>

      {staleError && (
        <div className="chat-stale" role="status">
          <p>Daftar chat belum diperbarui. {staleError.message}</p>
          <button type="button" className="link-btn" onClick={onRetry}>
            Coba lagi
          </button>
        </div>
      )}

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
            pinned={list.some((c) => c.id === currentId)}
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
  pinned,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  list: ConversationSummary[];
  folded: boolean;
  // Percakapan yang sedang dibuka ada di bagian ini: bagian tetap terbuka.
  pinned: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const open = !folded || pinned;
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
          aria-disabled={pinned || undefined}
          title={pinned ? "Bagian ini tetap terbuka selama Anda membuka percakapan di dalamnya." : undefined}
          onClick={() => {
            if (!pinned) onToggle();
          }}
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
  if (c.kind === "dm") return `Pesan pribadi dengan ${c.name}`;
  if (c.kind === "group") return `Grup ${c.name}`;
  return `Channel ${c.name}`;
}

// Keadaan yang ditulis di bawah nama, supaya baris yang diredam tidak hanya dibedakan lewat warna.
function rowState(c: ConversationSummary): string | null {
  if (c.former) return "Bukan anggota lagi";
  if (c.archived) return "Diarsipkan";
  return null;
}

function ListRow({
  summary: c,
  current,
  onSelect,
}: {
  summary: ConversationSummary;
  current: boolean;
  onSelect: (id: string) => void;
}) {
  const unread = c.unread > 0 || c.mentionUnread > 0;
  const state = rowState(c);
  // Nama lengkap untuk pembaca layar. Lencana dan ikon di dalam tombol hanya tampilan.
  const label = [
    rowLabel(c),
    c.locked ? "hanya-baca" : "",
    state?.toLowerCase() ?? "",
    c.muted ? "dibisukan" : "",
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
  ].filter(Boolean);

  return (
    <button
      type="button"
      className={classes.join(" ")}
      aria-current={current ? "true" : undefined}
      aria-label={label}
      onClick={() => onSelect(c.id)}
      title={[shown, c.locked ? "hanya-baca" : "", state?.toLowerCase() ?? ""].filter(Boolean).join(", ")}
    >
      {c.kind === "dm" ? (
        <span className="chat-av" aria-hidden="true">
          {initials(c.name)}
        </span>
      ) : c.kind === "group" ? (
        <IconUsers size={18} className="chat-kind" aria-hidden="true" />
      ) : (
        <span className="chat-hash" aria-hidden="true">
          #
        </span>
      )}
      <span className="chat-row-text">
        <span className="chat-row-name">{c.name}</span>
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
  );
}
