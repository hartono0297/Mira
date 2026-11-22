import { IconArrowBackUp, IconTrash } from "@tabler/icons-react";
import type { ConversationSummary, MessageView } from "../../api/chat";
import { initials } from "../../components/initials";
import { DeliveryStatus } from "./DeliveryStatus";
import { FileCard } from "./FileCard";
import { authorName, formatTime, fullTime, segmentMentions } from "./text";

type Props = {
  message: MessageView;
  grouped: boolean;
  me: string;
  kind: ConversationSummary["kind"];
  flash: boolean;
  // Pesan asli dari kutipan balasan ada di daftar yang sedang dimuat.
  replyLoaded: boolean;
  onReply: (message: MessageView) => void;
  onDelete: (message: MessageView) => void;
  onJump: (messageId: string) => void;
  onReload: () => void;
};

export function messageDomId(id: string): string {
  return `conv-msg-${id}`;
}

export function MessageItem({ message, grouped, me, kind, flash, replyLoaded, onReply, onDelete, onJump, onReload }: Props) {
  const name = authorName(message);
  const time = formatTime(message.at);
  const reply = message.replyTo;
  const replyAuthor = reply?.author ? (reply.author.publicKey === me ? "Anda" : reply.author.name) : null;
  const replyText = reply ? (reply.deleted ? "Pesan dihapus" : reply.preview) : "";

  return (
    <li
      id={messageDomId(message.id)}
      className={`conv-msg${grouped ? " conv-msg-grouped" : ""}${flash ? " conv-msg-flash" : ""}`}
      tabIndex={-1}
    >
      <div className="conv-gutter">
        {grouped ? (
          <time className="conv-gutter-time" dateTime={message.at} title={fullTime(message.at)} aria-hidden="true">
            {time}
          </time>
        ) : (
          <span className="conv-avatar" aria-hidden="true">
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
            <span className="conv-author">{name}</span>
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
                    <FileCard messageId={message.id} file={f} onDownloaded={onReload} />
                  </li>
                ))}
              </ul>
            )}
            {message.mine && message.status && (
              <DeliveryStatus messageId={message.id} status={message.status} kind={kind} />
            )}
          </>
        )}
      </div>

      {!message.deleted && (
        <div className="conv-actions" role="group" aria-label={`Aksi pesan ${name} pukul ${time}`}>
          <button
            type="button"
            className="conv-action"
            onClick={() => onReply(message)}
            aria-label={`Balas pesan ${name} pukul ${time}`}
          >
            <IconArrowBackUp size={16} aria-hidden="true" />
            <span>Balas</span>
          </button>
          {message.canDelete && (
            <button
              type="button"
              className="conv-action"
              onClick={() => onDelete(message)}
              aria-label={`Hapus pesan ${name} pukul ${time}`}
            >
              <IconTrash size={16} aria-hidden="true" />
              <span>Hapus</span>
            </button>
          )}
        </div>
      )}
    </li>
  );
}
