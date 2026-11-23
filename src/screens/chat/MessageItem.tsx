import { IconArrowBackUp, IconAt, IconChecks, IconCopy, IconDots, IconTrash } from "@tabler/icons-react";
import { useRef, type MouseEvent } from "react";
import type { ConversationSummary, MessageView } from "../../api/chat";
import { MenuButton, menuItems, SEPARATOR, useContextMenu } from "../../components/ContextMenu";
import { initials } from "../../components/initials";
import { useConversationActions, usePersonMenu } from "./ChatActions";
import { DeliveryStatus, type DeliveryStatusHandle } from "./DeliveryStatus";
import { FileCard } from "./FileCard";
import { MENU } from "./menuText";
import { PersonName } from "./PersonName";
import { authorName, deliveryLine, formatTime, fullTime, segmentMentions } from "./text";

type Props = {
  message: MessageView;
  grouped: boolean;
  me: string;
  kind: ConversationSummary["kind"];
  flash: boolean;
  // Percakapan bisa ditulis: Balas hanya ada kalau kolom pesan tampil.
  canReply: boolean;
  // Pesan asli dari kutipan balasan ada di daftar yang sedang dimuat.
  replyLoaded: boolean;
  onReply: (message: MessageView) => void;
  onDelete: (message: MessageView) => void;
  onJump: (messageId: string) => void;
  onReload: () => void;
  // Hasil salin untuk pembaca layar. error: tampil juga di panel percakapan.
  onAnnounce: (text: string, error?: boolean) => void;
};

export function messageDomId(id: string): string {
  return `conv-msg-${id}`;
}

export function MessageItem({
  message,
  grouped,
  me,
  kind,
  flash,
  canReply,
  replyLoaded,
  onReply,
  onDelete,
  onJump,
  onReload,
  onAnnounce,
}: Props) {
  const name = authorName(message);
  const time = formatTime(message.at);
  const reply = message.replyTo;
  const replyAuthor = reply?.author ? (reply.author.publicKey === me ? "Anda" : reply.author.name) : null;
  const replyText = reply ? (reply.deleted ? "Pesan dihapus" : reply.preview) : "";
  const live = !message.deleted;
  const conv = useConversationActions();
  const statusRef = useRef<DeliveryStatusHandle>(null);
  const hasStatus = live && message.mine && !!message.status && deliveryLine(message.status, kind) !== null;
  // Nama pengirim pesan orang lain membuka menu orang (klik, klik kanan, Shift+F10).
  // Pesan berurutan tidak menampilkan nama, jadi tanpa menu orang.
  const showPerson = !grouped && !message.mine;
  const nameRef = useRef<HTMLButtonElement>(null);
  const person = usePersonMenu(message.author);

  async function copyText() {
    try {
      if (!navigator.clipboard) throw new Error("clipboard");
      await navigator.clipboard.writeText(message.text);
      onAnnounce(MENU.copied);
    } catch {
      onAnnounce(MENU.copyFailed, true);
    }
  }

  const mention = conv?.mention;
  // Pesan dihapus tanpa item: klik kanan di sana tidak membuka menu pesan.
  const menu = useContextMenu({
    label: MENU.messageMenu(name, time),
    items: live
      ? menuItems(
          canReply && {
            id: "reply",
            label: MENU.reply,
            icon: <IconArrowBackUp size={16} />,
            onSelect: () => onReply(message),
          },
          !!message.text && {
            id: "copy",
            label: MENU.copyText,
            icon: <IconCopy size={16} />,
            onSelect: () => void copyText(),
          },
          !message.mine &&
            !!mention &&
            !!conv?.isMember(message.author.publicKey) && {
              id: "mention",
              label: MENU.mentionAuthor(message.author.name),
              icon: <IconAt size={16} />,
              onSelect: () => mention(message.author),
            },
          hasStatus && {
            id: "status",
            label: MENU.readStatus,
            icon: <IconChecks size={16} />,
            onSelect: () => statusRef.current?.open(),
          },
          SEPARATOR,
          message.canDelete && {
            id: "delete",
            label: MENU.deleteMessage,
            icon: <IconTrash size={16} />,
            danger: true,
            // Dialog konfirmasi milik panel percakapan, bukan konfirmasi menu.
            onSelect: () => onDelete(message),
          },
        )
      : [],
  });

  // Klik kanan di avatar: menu orang dibuka di bawah nama, lalu fokus kembali ke nama.
  function avatarMenu(e: MouseEvent<HTMLElement>) {
    if (e.defaultPrevented || !nameRef.current) return;
    e.preventDefault();
    person.openAt(nameRef.current, "start");
  }

  return (
    <li
      id={messageDomId(message.id)}
      className={`conv-msg${grouped ? " conv-msg-grouped" : ""}${flash ? " conv-msg-flash" : ""}${menu.isOpen ? " conv-msg-menu-open" : ""}`}
      tabIndex={-1}
      {...menu.triggerProps}
    >
      <div className="conv-gutter">
        {grouped ? (
          <time className="conv-gutter-time" dateTime={message.at} title={fullTime(message.at)} aria-hidden="true">
            {time}
          </time>
        ) : (
          <span className="conv-avatar" aria-hidden="true" onContextMenu={showPerson ? avatarMenu : undefined}>
            {initials(message.author.name)}
          </span>
        )}
      </div>
      <div className="conv-msg-body">
        {grouped ? (
          <span className="sr-only">
            {name}, {time}
          </span>
        ) : (
          <p className="conv-msg-head">
            <span className="conv-author">
              {showPerson && person.hasItems ? (
                <button
                  ref={nameRef}
                  type="button"
                  className="conv-author-btn"
                  aria-haspopup="menu"
                  aria-expanded={person.isOpen}
                  aria-controls={person.isOpen ? person.menuId : undefined}
                  onClick={(e) => (person.isOpen ? person.close() : person.openAt(e.currentTarget, "start"))}
                  {...person.triggerProps}
                >
                  <PersonName person={message.author} />
                </button>
              ) : message.mine ? (
                name
              ) : (
                <PersonName person={message.author} />
              )}
            </span>
            <time dateTime={message.at} title={fullTime(message.at)}>
              {time}
            </time>
          </p>
        )}

        {reply &&
          (replyLoaded ? (
            <button
              type="button"
              className="conv-quote conv-quote-link"
              onClick={() => onJump(reply.id)}
              aria-label={`Balasan untuk ${replyAuthor ?? "pesan"}: ${replyText}. Lihat pesan asli`}
            >
              {replyAuthor && <span className="conv-quote-author">{replyAuthor}</span>}
              <span className={reply.deleted ? "conv-quote-text conv-deleted" : "conv-quote-text"}>{replyText}</span>
            </button>
          ) : (
            <div className="conv-quote">
              <span className="sr-only">Balasan untuk </span>
              {replyAuthor && <span className="conv-quote-author">{replyAuthor}</span>}
              <span className={reply.deleted ? "conv-quote-text conv-deleted" : "conv-quote-text"}>{replyText}</span>
            </div>
          ))}

        {message.deleted ? (
          <p className="conv-deleted">Pesan dihapus</p>
        ) : (
          <>
            {message.text && (
              <p className="conv-text">
                {segmentMentions(message.text, message.mentions, me).map((s, i) =>
                  s.kind === "text" ? (
                    <span key={i}>{s.text}</span>
                  ) : (
                    <span
                      key={i}
                      className={s.isMe ? "conv-mention conv-mention-me" : "conv-mention"}
                      title={s.isMe ? "Menyebut Anda" : undefined}
                    >
                      {s.text}
                    </span>
                  ),
                )}
              </p>
            )}
            {message.files.length > 0 && (
              <ul className="conv-files" aria-label="Lampiran">
                {message.files.map((f) => (
                  <li key={f.hash}>
                    <FileCard messageId={message.id} file={f} onDownloaded={onReload} onAnnounce={onAnnounce} />
                  </li>
                ))}
              </ul>
            )}
            {message.mine && message.status && (
              <DeliveryStatus ref={statusRef} messageId={message.id} status={message.status} kind={kind} />
            )}
          </>
        )}
      </div>

      {/* Setelah menu dari klik kanan ditutup, fokus kembali ke tombol pertama di bilah ini. */}
      {live && menu.hasItems && (
        <div className="conv-actions" role="group" aria-label={`Aksi pesan ${name} pukul ${time}`}>
          {canReply && (
            <button
              type="button"
              className="conv-action"
              onClick={() => onReply(message)}
              aria-label={`Balas pesan ${name} pukul ${time}`}
              data-menu-focus
            >
              <IconArrowBackUp size={16} aria-hidden="true" />
              <span>Balas</span>
            </button>
          )}
          {message.canDelete && (
            <button
              type="button"
              className="conv-action"
              onClick={() => onDelete(message)}
              aria-label={`Hapus pesan ${name} pukul ${time}`}
              data-menu-focus={canReply ? undefined : true}
            >
              <IconTrash size={16} aria-hidden="true" />
              <span>Hapus</span>
            </button>
          )}
          <MenuButton
            menu={menu}
            label={MENU.messageMore(name, time)}
            className="conv-action conv-action-more"
            icon={<IconDots size={16} aria-hidden="true" />}
          />
        </div>
      )}
      {menu.element}
      {showPerson && person.element}
    </li>
  );
}
