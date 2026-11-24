import { IconArrowBackUp, IconDoorExit, IconLock, IconPaperclip, IconPlugConnectedX, IconSend, IconX } from "@tabler/icons-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { toAppError, type AppError } from "../../api";
import { chatApi, type ConversationSummary, type MessageView, type Person, type PickedFile } from "../../api/chat";
import { ErrorAlert } from "../../components/ErrorAlert";
import { CHAT } from "../../i18n/chat";
import { useNetworkOptional, validStatus } from "../shell/NetworkContext";
import {
  authorName,
  baseName,
  conversationTarget,
  filterMembers,
  formatSize,
  mentionQuery,
  mentionsInText,
  messagePreview,
  type MentionQuery,
} from "./text";

// Permintaan Sebut dari luar kolom pesan (menu pesan, menu orang). `n` membedakan
// permintaan yang sama berturut-turut.
export type MentionRequest = { person: Person; n: number };

type Props = {
  summary: ConversationSummary;
  me: string;
  members: Person[];
  replyTo: MessageView | null;
  onCancelReply: () => void;
  onSent: (message: MessageView) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  mentionRequest?: MentionRequest | null;
};

// Rekan chat pribadi sedang offline menurut status jaringan. Tanpa data
// jaringan (atau rekan belum pernah terlihat) banner tidak ditampilkan.
function usePeerOffline(summary: ConversationSummary): boolean {
  const network = useNetworkOptional();
  const status = validStatus(network?.data ?? null);
  if (summary.kind !== "dm" || !summary.peer || !status) return false;
  const peer = status.peers.find((p) => p.publicKey === summary.peer?.publicKey);
  return !!peer && !peer.online;
}

function blockedReason(summary: ConversationSummary): string {
  if (summary.postBlockedReason) return summary.postBlockedReason;
  // Chat proyek tidak bisa diarsipkan lagi (v0.4); yang lama mungkin masih diarsipkan.
  if (summary.archived && summary.kind === "project") return CHAT.composer.projectArchived;
  if (summary.archived) return CHAT.composer.channelArchived;
  return CHAT.composer.cannotPost;
}

// Percakapan yang saya sudah bukan anggotanya lagi: alasan menurut bagiannya.
export function formerText(summary: ConversationSummary): string {
  const t = CHAT.composer;
  const reason =
    summary.kind === "group" || summary.section === "grup"
      ? t.formerGroup
      : summary.kind === "project" || summary.section === "proyek"
        ? t.formerProject
        : summary.section === "departemen"
          ? t.formerDepartment
          : t.formerChannel;
  return `${reason} ${t.formerKept}`;
}

// Sisipkan "@Nama " di posisi kursor, dengan spasi pemisah kalau huruf sebelumnya bukan spasi.
export function insertMention(text: string, caret: number, name: string): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before === "" || /\s$/.test(before) ? "" : " ";
  const insert = `${lead}@${name} `;
  const rest = after.startsWith(" ") ? after.slice(1) : after;
  return { text: before + insert + rest, caret: before.length + insert.length };
}

export function Composer({ summary, me, members, replyTo, onCancelReply, onSent, inputRef, mentionRequest = null }: Props) {
  const title = conversationTarget(summary);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [attachError, setAttachError] = useState<AppError | null>(null);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const offline = usePeerOffline(summary);
  const ids = useId();
  const listId = `${ids}-mentions`;
  const alive = useRef(true);
  const pendingCaret = useRef<number | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Ganti percakapan: draf, lampiran, dan error milik percakapan lama dibuang.
  useEffect(() => {
    setText("");
    setFiles([]);
    setError(null);
    setAttachError(null);
    setMention(null);
  }, [summary.id]);

  // Tinggi kolom ikut isi sampai batas CSS (max-height), lalu bergulir.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    if (pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [text, inputRef]);

  // Sebut dari luar: sisipkan di posisi kursor terakhir lalu fokus ke kolom pesan.
  const handledMention = useRef<number | null>(null);
  useEffect(() => {
    if (!mentionRequest || handledMention.current === mentionRequest.n) return;
    handledMention.current = mentionRequest.n;
    const el = inputRef.current;
    if (!el) return;
    const current = el.value;
    const next = insertMention(current, el.selectionStart ?? current.length, mentionRequest.person.name);
    pendingCaret.current = next.caret;
    setText(next.text);
    setMention(null);
    el.focus();
  }, [mentionRequest, inputRef]);

  const suggestions = mention ? filterMembers(members, mention.query, me) : [];
  const listOpen = suggestions.length > 0;
  const activeIndex = Math.min(active, Math.max(suggestions.length - 1, 0));

  // Bukan anggota lagi: satu catatan tenang menggantikan kolom pesan.
  if (summary.former) {
    return (
      <div className="conv-composer conv-composer-blocked">
        <p className="conv-former">
          <IconDoorExit size={16} aria-hidden="true" />
          {formerText(summary)}
        </p>
      </div>
    );
  }

  if (!summary.canPost) {
    return (
      <div className="conv-composer conv-composer-blocked">
        <p className="conv-blocked">
          <IconLock size={16} aria-hidden="true" />
          {blockedReason(summary)}
        </p>
      </div>
    );
  }

  function updateMention(value: string, caret: number) {
    const next = mentionQuery(value, caret);
    setMention(next);
    if (!next || next.query !== mention?.query) setActive(0);
  }

  function onChange(e: ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
  }

  function pick(person: Person) {
    if (!mention) return;
    const caret = inputRef.current?.selectionStart ?? text.length;
    const insert = `@${person.name} `;
    const next = text.slice(0, mention.start) + insert + text.slice(caret);
    pendingCaret.current = mention.start + insert.length;
    setText(next);
    setMention(null);
    inputRef.current?.focus();
  }

  const empty = text.trim() === "" && files.length === 0;

  async function send() {
    if (sending || empty) return;
    setSending(true);
    setError(null);
    const mentions = mentionsInText(text, members.filter((m) => m.publicKey !== me)).map((m) => m.publicKey);
    try {
      const paths = files.map((f) => f.path);
      const sent = await chatApi.send(summary.id, text.trim(), replyTo?.id ?? null, mentions, paths);
      if (!alive.current) return;
      setText("");
      setFiles([]);
      setMention(null);
      onSent(sent);
    } catch (err) {
      if (alive.current) setError(toAppError(err));
    } finally {
      if (alive.current) setSending(false);
    }
  }

  async function attach() {
    setAttachError(null);
    try {
      // Dialog pilih file dibuka inti Rust; daftar kosong berarti dibatalkan.
      const picked = await chatApi.pickFiles();
      if (!alive.current) return;
      setFiles((current) => [...current, ...picked.filter((p) => !current.some((c) => c.path === p.path))]);
    } catch (err) {
      if (alive.current) setAttachError(toAppError(err));
    }
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (listOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((activeIndex + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((activeIndex - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(suggestions[activeIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMention(null);
        return;
      }
    }
    if (e.key === "Escape" && replyTo) {
      e.preventDefault();
      e.stopPropagation();
      onCancelReply();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  const placeholder = CHAT.composer.placeholder(title);

  return (
    <div className="conv-composer">
      {offline && summary.peer && (
        <p className="conv-offline">
          <IconPlugConnectedX size={16} aria-hidden="true" />
          {CHAT.composer.offline(summary.peer.name)}
        </p>
      )}
      {replyTo && (
        <div className="conv-reply-chip">
          <IconArrowBackUp size={16} aria-hidden="true" />
          <p className="conv-reply-text" id={`${ids}-reply`}>
            <span className="conv-reply-label" title={CHAT.composer.replying(authorName(replyTo))}>
              {CHAT.composer.replying(authorName(replyTo))}
            </span>
            <span className="conv-reply-preview" title={messagePreview(replyTo, 400)}>
              {messagePreview(replyTo)}
            </span>
          </p>
          <button type="button" className="conv-icon-btn conv-icon-sm" onClick={onCancelReply} aria-label={CHAT.composer.cancelReply}>
            <IconX size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      {files.length > 0 && (
        <ul className="conv-attach-list" aria-label={CHAT.composer.attachments}>
          {files.map((f) => {
            const name = f.name || baseName(f.path);
            return (
              <li key={f.path} className="conv-attach" title={`${name}, ${formatSize(f.size)}`}>
                <IconPaperclip size={14} aria-hidden="true" />
                <span className="conv-attach-name">{name}</span>
                <span className="conv-attach-size">{formatSize(f.size)}</span>
                <button
                  type="button"
                  className="conv-icon-btn conv-icon-sm"
                  onClick={() => setFiles((current) => current.filter((p) => p.path !== f.path))}
                  aria-label={CHAT.composer.removeAttachment(name)}
                  disabled={sending}
                >
                  <IconX size={14} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div aria-live="polite">
        {error && (
          <ErrorAlert title={CHAT.composer.sendError}>
            <p>
              {error.message} {CHAT.composer.sendErrorKept}
            </p>
          </ErrorAlert>
        )}
        {attachError && (
          <ErrorAlert title={CHAT.composer.attachError}>
            <p>{attachError.message}</p>
          </ErrorAlert>
        )}
      </div>
      <div className="conv-input-row">
        <button
          type="button"
          className="conv-icon-btn conv-attach-btn"
          onClick={() => void attach()}
          aria-label={CHAT.composer.attach}
          disabled={sending}
        >
          <IconPaperclip size={18} aria-hidden="true" />
        </button>
        <div className="conv-input-wrap">
          <label htmlFor={`${ids}-input`} className="sr-only">
            {CHAT.composer.inputLabel(title)}
          </label>
          <textarea
            id={`${ids}-input`}
            ref={inputRef}
            className="conv-input"
            rows={1}
            value={text}
            placeholder={placeholder}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onClick={(e) => updateMention(text, e.currentTarget.selectionStart ?? text.length)}
            onBlur={() => setMention(null)}
            readOnly={sending}
            aria-describedby={replyTo ? `${ids}-reply ${ids}-hint` : `${ids}-hint`}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={listOpen}
            aria-controls={listOpen ? listId : undefined}
            aria-activedescendant={listOpen ? `${listId}-${activeIndex}` : undefined}
          />
          <span id={`${ids}-hint`} className="sr-only">
            {CHAT.composer.hint}
          </span>
          {listOpen && (
            <ul id={listId} role="listbox" aria-label={CHAT.composer.mentionList} className="conv-mentions">
              {suggestions.map((p, i) => (
                <li
                  key={p.publicKey}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={i === activeIndex ? "conv-mention-opt conv-mention-opt-active" : "conv-mention-opt"}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(p);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  {p.name}
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          className="btn conv-send"
          onClick={() => void send()}
          aria-disabled={empty || sending || undefined}
          aria-busy={sending || undefined}
        >
          <IconSend size={16} aria-hidden="true" />
          {sending ? CHAT.composer.sending : CHAT.composer.send}
        </button>
      </div>
    </div>
  );
}
