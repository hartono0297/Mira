import { IconBell, IconBellOff, IconChevronDown, IconChevronRight, IconPlus } from "@tabler/icons-react";
import { useId, useState, type ReactNode } from "react";
import type { AppError } from "../../api";
import type { ChatOverview, ConversationSummary } from "../../api/chat";
import { initials } from "../../components/initials";
import { NO_SCOPE_NOTE } from "./NewChannelDialog";
import { badgeCount, groupConversations, scopeLabel, unreadText } from "./ListFormat";

type Props = {
  overview: ChatOverview;
  currentId: string | null;
  // Muat ulang terakhir gagal: daftar lama tetap tampil dengan catatan kecil.
  staleError: AppError | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onNewChannel: () => void;
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
  onNewDirect,
  onNotify,
}: Props) {
  const [showArchived, setShowArchived] = useState(false);
  const ids = useId();
  const { channels, directs, archived } = groupConversations(overview);
  // Percakapan diarsipkan yang sedang dibuka membuat bagiannya ikut terbuka.
  const archivedOpen = showArchived || archived.some((c) => c.id === currentId);

  const row = (c: ConversationSummary) => (
    <li key={c.id}>
      <ListRow summary={c} current={c.id === currentId} onSelect={onSelect} />
    </li>
  );

  return (
    <nav className="chat-list" aria-label="Daftar percakapan">
      <div className="chat-list-head">
        <h1 id="page-title" className="page-title">
          Chat
        </h1>
        <div className="chat-list-tools">
          {overview.canCreateChannel && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onNewChannel}>
              <IconPlus size={16} aria-hidden="true" />
              Channel baru
            </button>
          )}
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

      <Section id={`${ids}-ch`} title="Channel">
        {channels.length > 0 ? (
          <ul className="chat-rows">{channels.map(row)}</ul>
        ) : (
          <p className="chat-note">Belum ada channel.</p>
        )}
        {overview.canDirectMessage && !overview.canCreateChannel && <p className="chat-note">{NO_SCOPE_NOTE}</p>}
      </Section>

      <Section id={`${ids}-dm`} title="Pesan pribadi">
        {directs.length > 0 ? (
          <ul className="chat-rows">{directs.map(row)}</ul>
        ) : (
          overview.canDirectMessage && <p className="chat-note">Belum ada pesan pribadi.</p>
        )}
        {overview.canDirectMessage ? (
          <button type="button" className="btn btn-ghost btn-sm chat-new" onClick={onNewDirect}>
            <IconPlus size={16} aria-hidden="true" />
            Pesan baru
          </button>
        ) : (
          <p className="chat-note">Tamu tidak punya chat pribadi. Bicara lewat channel proyek.</p>
        )}
      </Section>

      {archived.length > 0 && (
        <div className="chat-sec">
          <h2 className="chat-lbl">
            <button
              type="button"
              className="chat-fold"
              aria-expanded={archivedOpen}
              aria-controls={`${ids}-ar`}
              aria-label={`Diarsipkan, ${archived.length} percakapan`}
              onClick={() => setShowArchived(!archivedOpen)}
            >
              {archivedOpen ? (
                <IconChevronDown size={16} aria-hidden="true" />
              ) : (
                <IconChevronRight size={16} aria-hidden="true" />
              )}
              Diarsipkan
              <span className="chat-fold-count">{archived.length}</span>
            </button>
          </h2>
          <div id={`${ids}-ar`} hidden={!archivedOpen}>
            <ul className="chat-rows">{archived.map(row)}</ul>
          </div>
        </div>
      )}
    </nav>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="chat-sec" aria-labelledby={id}>
      <h2 id={id} className="chat-lbl">
        {title}
      </h2>
      {children}
    </section>
  );
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
  const hint =
    c.kind === "channel" && c.scope && c.scope.kind !== "org" ? scopeLabel(c.scope.kind, c.scope.name) : null;
  // Nama lengkap untuk pembaca layar. Lencana dan ikon di dalam tombol hanya tampilan.
  const label = [
    c.kind === "channel" ? `Channel ${c.name}` : `Pesan pribadi dengan ${c.name}`,
    hint,
    c.muted ? "dibisukan" : "",
    unreadText(c.unread, c.mentionUnread),
  ]
    .filter(Boolean)
    .join(", ");
  const count = Math.max(c.unread, c.mentionUnread);

  return (
    <button
      type="button"
      className={`chat-row${unread ? " chat-row-unread" : ""}${c.muted ? " chat-row-muted" : ""}`}
      aria-current={current ? "true" : undefined}
      aria-label={label}
      onClick={() => onSelect(c.id)}
      title={c.kind === "channel" ? `#${c.name}` : c.name}
    >
      {c.kind === "dm" ? (
        <span className="chat-av" aria-hidden="true">
          {initials(c.name)}
        </span>
      ) : (
        <span className="chat-hash" aria-hidden="true">
          #
        </span>
      )}
      <span className="chat-row-text">
        <span className="chat-row-name">{c.name}</span>
        {hint && <span className="chat-row-hint">{hint}</span>}
      </span>
      {c.muted && <IconBellOff size={15} className="chat-row-mute" aria-hidden="true" />}
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
