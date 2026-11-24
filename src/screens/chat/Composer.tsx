import {
  IconArrowBackUp,
  IconDoorExit,
  IconLock,
  IconMoodSmile,
  IconPaperclip,
  IconPlugConnectedX,
  IconSend,
  IconSticker,
  IconX,
} from "@tabler/icons-react";
import {
  useCallback,
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
import {
  chatApi,
  type ConversationSummary,
  type MessageView,
  type OfficeSticker,
  type Person,
  type PickedFile,
} from "../../api/chat";
import { EmojiPicker, type EmojiEmote } from "../../components/emoji/EmojiPicker";
import { emojiName, searchEmoji } from "../../components/emoji/emojiData";
import { applySuggestion, emojiQueryAt } from "../../components/emoji/emojiSuggest";
import { ErrorAlert } from "../../components/ErrorAlert";
import { CHAT } from "../../i18n/chat";
import { STICKER_TEXT } from "../../i18n/chat-sticker";
import { useLang, type Lang } from "../../i18n/core";
import { useNetworkOptional, validStatus } from "../shell/NetworkContext";
import { officeEmoteMap, reloadStickerCatalog, useStickerCatalog } from "./stickerCatalog";
import { StickerImage } from "./StickerImage";
import { StickerPicker } from "./StickerPicker";
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

// Saran saat mengetik ":nama": emote kantor yang namanya diawali query, lalu emoji Unicode.
export type EmojiSuggestion =
  | { kind: "emote"; value: string; name: string; sticker: OfficeSticker }
  | { kind: "emoji"; value: string; name: string };

const EMOTE_SUGGESTIONS = 5;
const EMOJI_SUGGESTIONS = 8;
const EMOTE_TEXT = /^:[a-z0-9_]+:$/;

export function emojiSuggestions(query: string, emotes: Map<string, OfficeSticker>, lang: Lang): EmojiSuggestion[] {
  const q = query.toLowerCase();
  const office = [...emotes.values()]
    .filter((s) => s.name.startsWith(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, EMOTE_SUGGESTIONS)
    .map<EmojiSuggestion>((s) => ({ kind: "emote", value: `:${s.name}:`, name: s.name, sticker: s }));
  const emoji = searchEmoji(query, EMOJI_SUGGESTIONS).map<EmojiSuggestion>((e) => ({
    kind: "emoji",
    value: e.char,
    name: emojiName(e, lang),
  }));
  return [...office, ...emoji];
}

// Sisipkan emoji atau emote dari pemilih di rentang [start, end). Emote ":nama:" diberi spasi
// pemisah di kiri kalau perlu dan spasi di kanan, supaya terbaca sebagai emote, bukan teks.
export function insertEmoji(text: string, start: number, end: number, value: string): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  const before = text.slice(0, from);
  const after = text.slice(to);
  let insert = value;
  if (EMOTE_TEXT.test(value)) {
    const lead = before === "" || /\s$/.test(before) ? "" : " ";
    insert = `${lead}${value}${after.startsWith(" ") ? "" : " "}`;
  }
  return { text: before + insert + after, caret: before.length + insert.length };
}

// Mencatat emoji Unicode untuk daftar "Baru dipakai". Gagal dicatat tidak mengganggu menulis.
function noteEmojiUsed(emoji: string) {
  try {
    chatApi
      .emojiUsed(emoji)
      .then(() => reloadStickerCatalog())
      .catch(() => {});
  } catch {
    // chatApi tanpa emojiUsed (misalnya inti Rust tiruan di tes): abaikan.
  }
}

export function Composer({ summary, me, members, replyTo, onCancelReply, onSent, inputRef, mentionRequest = null }: Props) {
  const title = conversationTarget(summary);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [attachError, setAttachError] = useState<AppError | null>(null);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [emojiQuery, setEmojiQuery] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const [picker, setPicker] = useState<"emoji" | "sticker" | null>(null);
  // "Baru dipakai" dibekukan selama pemilih emoji terbuka: memilih emoji memuat ulang katalog,
  // dan urutan baru akan mencabut tombol yang sedang difokus.
  const [recentEmoji, setRecentEmoji] = useState<string[]>([]);
  const offline = usePeerOffline(summary);
  const lang = useLang();
  const { catalog } = useStickerCatalog();
  const ids = useId();
  const listId = `${ids}-mentions`;
  const alive = useRef(true);
  const pendingCaret = useRef<number | null>(null);
  // Rentang pilihan di kolom pesan saat pemilih emoji dibuka; maju setiap emoji disisipkan.
  const emojiRange = useRef<{ start: number; end: number } | null>(null);
  const emojiButton = useRef<HTMLButtonElement>(null);
  const stickerButton = useRef<HTMLButtonElement>(null);
  // Keadaan pemilih saat tombol pemicu mulai ditekan, sebelum klik di luar sempat menutupnya.
  const pickerAtPress = useRef<"emoji" | "sticker" | null>(null);

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
    setEmojiQuery(null);
    setPicker(null);
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
    setEmojiQuery(null);
    el.focus();
  }, [mentionRequest, inputRef]);

  // Pemilih ditutup: fokus kembali ke pemicunya, kecuali pengguna sudah pindah ke kontrol lain
  // (klik di luar). Ditunda satu giliran supaya fokus hasil klik itu sudah berpindah.
  const closePicker = useCallback(
    (focus: "input" | "sticker") => {
      setPicker(null);
      window.setTimeout(() => {
        if (!alive.current) return;
        const now = document.activeElement;
        if (now && now !== document.body) return;
        if (focus === "sticker") stickerButton.current?.focus();
        else inputRef.current?.focus();
      }, 0);
    },
    [inputRef],
  );
  const closeEmoji = useCallback(() => closePicker("input"), [closePicker]);
  const closeSticker = useCallback(
    (reason: "escape" | "outside") => {
      if (reason === "outside") setPicker(null);
      else closePicker("sticker");
    },
    [closePicker],
  );

  const emoteMap = officeEmoteMap(catalog ?? null);
  const emotes: EmojiEmote[] = [...emoteMap.values()].map((s) => ({
    name: s.name,
    render: () => <StickerImage hash={s.hash} alt={`:${s.name}:`} size="inline" ready={s.ready} />,
  }));

  // Saran mention didahulukan; saran emoji hanya kalau tidak ada rekan yang cocok.
  const memberSuggestions = mention ? filterMembers(members, mention.query, me) : [];
  const emojiItems =
    memberSuggestions.length === 0 && emojiQuery ? emojiSuggestions(emojiQuery.query, emoteMap, lang) : [];
  const listKind: "mention" | "emoji" | null =
    memberSuggestions.length > 0 ? "mention" : emojiItems.length > 0 ? "emoji" : null;
  const listSize = listKind === "mention" ? memberSuggestions.length : emojiItems.length;
  const listOpen = listKind !== null;
  const activeIndex = Math.min(active, Math.max(listSize - 1, 0));

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
    const nextEmoji = emojiQueryAt(value, caret);
    setMention(next);
    setEmojiQuery(nextEmoji);
    if (!next || next.query !== mention?.query || nextEmoji?.query !== emojiQuery?.query) setActive(0);
  }

  // Saran ":nama" dipilih: emoji Unicode apa adanya, emote kantor jadi ":nama: ".
  function pickEmoji(item: EmojiSuggestion) {
    if (!emojiQuery) return;
    const caret = inputRef.current?.selectionStart ?? text.length;
    const insert = item.kind === "emote" ? `${item.value} ` : item.value;
    const next = applySuggestion(text, emojiQuery.start, caret, insert);
    pendingCaret.current = next.caret;
    setText(next.text);
    setEmojiQuery(null);
    setMention(null);
    if (item.kind === "emoji") noteEmojiUsed(item.value);
    inputRef.current?.focus();
  }

  function togglePicker(which: "emoji" | "sticker") {
    // Dibaca dari saat tombol ditekan: klik di luar pemilih bisa sudah menutupnya.
    const wasOpen = pickerAtPress.current === which || picker === which;
    pickerAtPress.current = null;
    if (wasOpen) {
      setPicker(null);
      return;
    }
    if (which === "emoji") {
      const el = inputRef.current;
      const end = el?.value.length ?? text.length;
      emojiRange.current = { start: el?.selectionStart ?? end, end: el?.selectionEnd ?? end };
      setRecentEmoji(catalog?.recentEmoji ?? []);
    }
    setMention(null);
    setEmojiQuery(null);
    setPicker(which);
  }

  // Emoji atau emote dari pemilih disisipkan di posisi kursor; pemilih tetap terbuka.
  function onEmojiPick(value: string) {
    const current = inputRef.current?.value ?? text;
    const range = emojiRange.current ?? { start: current.length, end: current.length };
    const next = insertEmoji(current, range.start, range.end, value);
    emojiRange.current = { start: next.caret, end: next.caret };
    pendingCaret.current = next.caret;
    setText(next.text);
    if (!EMOTE_TEXT.test(value)) noteEmojiUsed(value);
  }

  function onStickerSent(message: MessageView) {
    closePicker("input");
    onSent(message);
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
      setEmojiQuery(null);
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
        setActive((activeIndex + 1) % listSize);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((activeIndex - 1 + listSize) % listSize);
        return;
      }
      if ((e.key === "Enter" && !e.nativeEvent.isComposing) || e.key === "Tab") {
        e.preventDefault();
        if (listKind === "mention") pick(memberSuggestions[activeIndex]);
        else pickEmoji(emojiItems[activeIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMention(null);
        setEmojiQuery(null);
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
        <div className="cmp-tools">
          <button
            type="button"
            className="conv-icon-btn conv-attach-btn"
            onClick={() => void attach()}
            aria-label={CHAT.composer.attach}
            disabled={sending}
          >
            <IconPaperclip size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            ref={emojiButton}
            className="conv-icon-btn conv-attach-btn"
            onPointerDown={() => {
              pickerAtPress.current = picker;
            }}
            onClick={() => togglePicker("emoji")}
            aria-label={STICKER_TEXT.composer.emoji}
            aria-haspopup="dialog"
            aria-expanded={picker === "emoji"}
            disabled={sending}
          >
            <IconMoodSmile size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            ref={stickerButton}
            className="conv-icon-btn conv-attach-btn"
            onPointerDown={() => {
              pickerAtPress.current = picker;
            }}
            onClick={() => togglePicker("sticker")}
            aria-label={STICKER_TEXT.composer.sticker}
            aria-haspopup="dialog"
            aria-expanded={picker === "sticker"}
            disabled={sending}
          >
            <IconSticker size={18} aria-hidden="true" />
          </button>
          {picker === "emoji" && (
            <EmojiPicker
              className="cmp-emoji-pop"
              anchorRef={emojiButton}
              onPick={onEmojiPick}
              onClose={closeEmoji}
              recent={recentEmoji}
              emotes={emotes}
              closeOnPick={false}
            />
          )}
          {picker === "sticker" && (
            <StickerPicker
              conv={summary.id}
              replyTo={replyTo?.id ?? null}
              onSent={onStickerSent}
              onClose={closeSticker}
              anchorRef={stickerButton}
            />
          )}
        </div>
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
            onBlur={() => {
              setMention(null);
              setEmojiQuery(null);
            }}
            readOnly={sending}
            aria-describedby={replyTo ? `${ids}-reply ${ids}-hint` : `${ids}-hint`}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={listOpen}
            aria-controls={listOpen ? listId : undefined}
            aria-activedescendant={listOpen ? `${listId}-${activeIndex}` : undefined}
          />
          <span id={`${ids}-hint`} className="sr-only">
            {CHAT.composer.hint} {STICKER_TEXT.composer.hint}
          </span>
          {listKind === "emoji" && (
            <ul
              id={listId}
              role="listbox"
              aria-label={STICKER_TEXT.composer.emojiList}
              className="conv-mentions cmp-emoji-list"
            >
              {emojiItems.map((item, i) => (
                <li
                  key={item.value}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  aria-label={item.kind === "emote" ? STICKER_TEXT.composer.emoteOption(item.name) : `${item.value} ${item.name}`}
                  className={i === activeIndex ? "conv-mention-opt conv-mention-opt-active" : "conv-mention-opt"}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickEmoji(item);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <span className="cmp-emoji-glyph" aria-hidden="true">
                    {item.kind === "emote" ? (
                      <StickerImage hash={item.sticker.hash} alt={item.value} size="inline" ready={item.sticker.ready} />
                    ) : (
                      item.value
                    )}
                  </span>
                  <span className="cmp-emoji-name" aria-hidden="true">
                    {item.kind === "emote" ? item.value : item.name}
                  </span>
                  {item.kind === "emote" && (
                    <span className="cmp-emoji-tag" aria-hidden="true">
                      {STICKER_TEXT.composer.emoteTag}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {listKind === "mention" && (
            <ul id={listId} role="listbox" aria-label={CHAT.composer.mentionList} className="conv-mentions">
              {memberSuggestions.map((p, i) => (
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
