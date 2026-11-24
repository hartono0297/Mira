import {
  IconArrowBackUp,
  IconAt,
  IconBookmarkPlus,
  IconChecks,
  IconCopy,
  IconDots,
  IconMoodPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import type { ConversationSummary, MessageView } from "../../api/chat";
import { MenuButton, menuItems, SEPARATOR, useContextMenu } from "../../components/ContextMenu";
import { initials } from "../../components/initials";
import { CHAT, CHAT_TEXT } from "../../i18n/chat";
import { REACTION as RX } from "../../i18n/chat-reaction";
import { useConversationActions, usePersonMenu } from "./ChatActions";
import { DeliveryStatus, type DeliveryStatusHandle } from "./DeliveryStatus";
import { FileCard } from "./FileCard";
import { MENU } from "./menuText";
import { PersonName } from "./PersonName";
import { QuickReactions, ReactionBar, ReactionPicker, type EmoteMap } from "./ReactionBar";
import { StickerImage } from "./StickerImage";
import { authorName, deliveryLine, formatTime, fullTime, isEmojiOnly, segmentMessage } from "./text";

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
  // Saya boleh memberi atau menghapus reaksi di percakapan ini (ConversationView.canReact).
  canReact: boolean;
  // Emote kantor aktif menurut nama, dan emoji yang baru dipakai di laptop ini.
  emotes: EmoteMap;
  recent: string[];
  // Selesai setelah tersimpan dan percakapan dimuat ulang. false kalau gagal.
  onReact: (message: MessageView, emoji: string, on: boolean) => Promise<boolean>;
  onSaveSticker: (message: MessageView) => void;
  onReply: (message: MessageView) => void;
  onDelete: (message: MessageView) => void;
  onJump: (messageId: string) => void;
  onReload: () => void;
  // Hasil salin untuk pembaca layar. error: tampil juga di panel percakapan.
  onAnnounce: (text: string, error?: boolean) => void;
};

// Pemilih emoji yang terbuka: tombol tempat ia melayang ("+" di chip atau Beri reaksi lain di bilah
// aksi, juga untuk item menu Beri reaksi) dan elemen yang menerima fokus lagi saat ditutup.
type PickerState = { anchor: HTMLElement; via: "add" | "more"; returnTo: HTMLElement | null };

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
  canReact,
  emotes,
  recent,
  onReact,
  onSaveSticker,
  onReply,
  onDelete,
  onJump,
  onReload,
  onAnnounce,
}: Props) {
  const name = authorName(message);
  const time = formatTime(message.at);
  const reply = message.replyTo;
  const replyAuthor = reply?.author ? (reply.author.publicKey === me ? CHAT_TEXT.you : reply.author.name) : null;
  const replyText = reply ? (reply.deleted ? CHAT_TEXT.deleted : reply.preview) : "";
  const live = !message.deleted;
  const conv = useConversationActions();
  const statusRef = useRef<DeliveryStatusHandle>(null);
  const hasStatus = live && message.mine && !!message.status && deliveryLine(message.status, kind) !== null;
  // Nama pengirim pesan orang lain membuka menu orang (klik, klik kanan, Shift+F10).
  // Pesan berurutan tidak menampilkan nama, jadi tanpa menu orang.
  const showPerson = !grouped && !message.mine;
  const nameRef = useRef<HTMLButtonElement>(null);
  const person = usePersonMenu(message.author);
  const liRef = useRef<HTMLLIElement>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const reactable = live && canReact;
  const sticker = live ? message.sticker : null;
  const stickerFile = sticker ? message.files.find((f) => f.hash === sticker.hash) : undefined;
  // Gambar pesan sticker tidak ditampilkan lagi sebagai kartu file.
  const files = sticker ? message.files.filter((f) => f.hash !== sticker.hash) : message.files;
  const known = (n: string) => emotes.has(n);

  // Reaksi yang sedang disimpan per emoji. Ref untuk klik ganda sebelum render berikutnya,
  // state untuk aria-busy.
  const pendingRef = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  // Chip yang terfokus hilang saat reaksi terakhirnya dilepas: fokus pindah ke chip sesudahnya,
  // sebelumnya, "+", Beri reaksi lain, atau pesannya, bukan ke body.
  const refocus = useRef<{ emoji: string; order: string[] } | null>(null);

  async function toggle(emoji: string, on: boolean) {
    if (pendingRef.current.has(emoji)) return;
    const i = message.reactions.findIndex((r) => r.emoji === emoji);
    const r = message.reactions[i];
    if (!on && r?.mine && r.count <= 1) {
      const order = [message.reactions[i + 1]?.emoji, message.reactions[i - 1]?.emoji].filter((e): e is string => !!e);
      refocus.current = { emoji, order };
    }
    pendingRef.current.add(emoji);
    setPending(new Set(pendingRef.current));
    const ok = await onReact(message, emoji, on);
    pendingRef.current.delete(emoji);
    setPending(new Set(pendingRef.current));
    if (!ok && refocus.current?.emoji === emoji) refocus.current = null;
  }

  useLayoutEffect(() => {
    const plan = refocus.current;
    if (!plan || message.reactions.some((r) => r.emoji === plan.emoji)) return;
    refocus.current = null;
    const active = document.activeElement;
    const li = liRef.current;
    // Fokus sudah dipindah pengguna ke tempat lain: dibiarkan.
    if (!li || (active && active !== document.body)) return;
    const chips = [...li.querySelectorAll<HTMLElement>("[data-rx-emoji]")];
    const target =
      plan.order.map((e) => chips.find((c) => c.dataset.rxEmoji === e)).find((c) => !!c) ??
      li.querySelector<HTMLElement>(".rx-add") ??
      moreRef.current ??
      li;
    target.focus({ preventScroll: true });
  }, [message.reactions]);

  function openPicker(anchor: HTMLElement, via: PickerState["via"]) {
    // Tombol pembuka ditekan lagi: pemilih ditutup.
    if (picker?.anchor === anchor) return closePicker("other");
    const active = document.activeElement;
    setPicker({ anchor, via, returnTo: active instanceof HTMLElement && active !== document.body ? active : anchor });
  }

  // Esc, memilih, atau tombol pembuka: fokus kembali. Klik di luar: fokus ikut ke yang diklik.
  function closePicker(reason: "outside" | "other") {
    const returnTo = picker?.returnTo;
    setPicker(null);
    if (reason === "other" && returnTo?.isConnected) returnTo.focus({ preventScroll: true });
  }

  function pick(emoji: string) {
    // Pemilih hanya menambah. Emoji yang sudah saya beri tetap (dilepas lewat chipnya).
    if (message.reactions.some((r) => r.emoji === emoji && r.mine)) return;
    void toggle(emoji, true);
  }

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
          reactable && {
            id: "react",
            label: MENU.react,
            icon: <IconMoodPlus size={16} />,
            // Menu sudah menutup dan mengembalikan fokus; pemilih melayang di tombol Reaksi lain.
            onSelect: () => openPicker(moreRef.current ?? liRef.current!, "more"),
          },
          !!message.text &&
            !sticker && {
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
          !!sticker &&
            sticker.ready &&
            !sticker.saved && {
              id: "save-sticker",
              label: MENU.saveSticker,
              icon: <IconBookmarkPlus size={16} />,
              onSelect: () => onSaveSticker(message),
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
      ref={liRef}
      className={`conv-msg${grouped ? " conv-msg-grouped" : ""}${flash ? " conv-msg-flash" : ""}${menu.isOpen || picker ? " conv-msg-menu-open" : ""}`}
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
                  <PersonName person={message.author} labelsMode="all" />
                </button>
              ) : (
                // Pesan saya tertulis "Anda", tetap dengan label profil saya.
                <PersonName person={message.mine ? { ...message.author, name } : message.author} labelsMode="all" />
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
              aria-label={CHAT.message.replyJump(replyAuthor ?? CHAT.message.replyUnknown, replyText)}
            >
              {replyAuthor && <span className="conv-quote-author">{replyAuthor}</span>}
              <span className={reply.deleted ? "conv-quote-text conv-deleted" : "conv-quote-text"}>{replyText}</span>
            </button>
          ) : (
            <div className="conv-quote">
              <span className="sr-only">{CHAT.message.replyTo}</span>
              {replyAuthor && <span className="conv-quote-author">{replyAuthor}</span>}
              <span className={reply.deleted ? "conv-quote-text conv-deleted" : "conv-quote-text"}>{replyText}</span>
            </div>
          ))}

        {message.deleted ? (
          <p className="conv-deleted">{CHAT_TEXT.deleted}</p>
        ) : (
          <>
            {sticker ? (
              <div className="conv-sticker">
                <span className="sr-only">{RX.sticker} </span>
                {sticker.ready ? (
                  <StickerImage hash={sticker.hash} alt={`:${sticker.name}:`} size="large" />
                ) : (
                  <>
                    <span className="conv-sticker-wait" role="img" aria-label={`:${sticker.name}:`}>
                      <span aria-hidden="true">:{sticker.name}:</span>
                    </span>
                    {stickerFile && stickerFile.state !== "local" && (
                      <p className="conv-sticker-note">
                        {stickerFile.state === "missing" ? RX.stickerMissing : RX.stickerFetching}
                      </p>
                    )}
                  </>
                )}
              </div>
            ) : (
              message.text && (
                <p className={isEmojiOnly(message.text, known) ? "conv-text conv-text-jumbo" : "conv-text"}>
                  {segmentMessage(message.text, message.mentions, me, known).map((s, i) => {
                    if (s.kind === "text") return <span key={i}>{s.text}</span>;
                    if (s.kind === "emote") {
                      const emote = emotes.get(s.name)!;
                      return <StickerImage key={i} hash={emote.hash} alt={s.text} size="inline" ready={emote.ready} />;
                    }
                    return (
                      <span
                        key={i}
                        className={s.isMe ? "conv-mention conv-mention-me" : "conv-mention"}
                        title={s.isMe ? CHAT.message.mentionsYou : undefined}
                      >
                        {s.text}
                      </span>
                    );
                  })}
                </p>
              )
            )}
            {files.length > 0 && (
              <ul className="conv-files" aria-label={CHAT.message.files}>
                {files.map((f) => (
                  <li key={f.hash}>
                    <FileCard messageId={message.id} file={f} onDownloaded={onReload} onAnnounce={onAnnounce} />
                  </li>
                ))}
              </ul>
            )}
            <ReactionBar
              reactions={message.reactions}
              me={me}
              canReact={canReact}
              emotes={emotes}
              label={RX.bar(name, time)}
              addLabel={RX.add(name, time)}
              pending={pending}
              onToggle={(emoji, on) => void toggle(emoji, on)}
              onAdd={(el) => openPicker(el, "add")}
              addExpanded={picker?.via === "add"}
            />
            {message.mine && message.status && (
              <DeliveryStatus ref={statusRef} messageId={message.id} status={message.status} kind={kind} />
            )}
          </>
        )}
      </div>

      {/* Setelah menu dari klik kanan ditutup, fokus kembali ke tombol pertama di bilah ini. */}
      {live && menu.hasItems && (
        <div className="conv-actions" role="group" aria-label={CHAT.message.actions(name, time)}>
          {reactable && (
            <QuickReactions
              reactions={message.reactions}
              label={RX.quickGroup(name, time)}
              moreLabel={RX.more(name, time)}
              pending={pending}
              onToggle={(emoji, on) => void toggle(emoji, on)}
              onMore={(el) => openPicker(el, "more")}
              moreRef={moreRef}
              moreExpanded={picker?.via === "more"}
            />
          )}
          {canReply && (
            <button
              type="button"
              className="conv-action conv-action-icon"
              onClick={() => onReply(message)}
              aria-label={CHAT.message.replyLabel(name, time)}
              title={MENU.reply}
              data-menu-focus
            >
              <IconArrowBackUp size={16} aria-hidden="true" />
            </button>
          )}
          {message.canDelete && (
            <button
              type="button"
              className="conv-action conv-action-icon"
              onClick={() => onDelete(message)}
              aria-label={CHAT.message.deleteLabel(name, time)}
              title={CHAT.message.delete}
              data-menu-focus={canReply ? undefined : true}
            >
              <IconTrash size={16} aria-hidden="true" />
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
      {picker && (
        <ReactionPicker
          anchor={picker.anchor}
          label={RX.picker(name, time)}
          recent={recent}
          emotes={emotes}
          onPick={pick}
          onClose={closePicker}
        />
      )}
    </li>
  );
}
