// Reaksi di pesan (v0.5.1): chip di bawah pesan, reaksi cepat di bilah aksi, dan pemilih
// emoji yang melayang di dekat tombol pembukanya.
import { IconMoodPlus } from "@tabler/icons-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { OfficeSticker, ReactionView } from "../../api/chat";
import { EmojiPicker } from "../../components/emoji/EmojiPicker";
import { emojiName, findEmoji, QUICK_REACTIONS } from "../../components/emoji/emojiData";
import { REACTION as RX } from "../../i18n/chat-reaction";
import { getLang } from "../../i18n/core";
import { StickerImage } from "./StickerImage";
import { emoteName, joinNames } from "./text";
import "./reactions.css";

export type EmoteMap = Map<string, OfficeSticker>;

// Nama emoji untuk pembaca layar dalam bahasa aktif ("jempol", "thumbs up"). Emote kantor dan
// emoji yang tidak ada di data tetap apa adanya.
export function spokenEmoji(emoji: string): string {
  const entry = findEmoji(emoji);
  return entry ? emojiName(entry, getLang()) : emoji;
}

// Nama orang yang memberi reaksi, "Anda" untuk saya.
export function reactorNames(r: ReactionView, me: string): string[] {
  return r.people.map((p) => (p.publicKey === me ? RX.you : p.name));
}

// "Rina", "Rina dan Dimas", "Rina, Dimas, dan Sari", lalu "Rina, Dimas, dan 2 lainnya".
export function reactorSummary(r: ReactionView, me: string): string {
  const names = reactorNames(r, me);
  const total = Math.max(r.count, names.length);
  if (names.length === total && total <= 3) return joinNames(names, RX);
  const shown = names.slice(0, 2);
  const rest = total - shown.length;
  if (shown.length === 0) return RX.people(rest);
  return joinNames([...shown, RX.others(rest)], RX);
}

// Label chip untuk pembaca layar: "jempol 3. Rina, Dimas, Anda." Reaksi saya terbaca dari
// aria-pressed dan nama "Anda" di daftar.
export function reactionLabel(r: ReactionView, me: string): string {
  const names = reactorNames(r, me).join(", ") || RX.people(r.count);
  return RX.chip(spokenEmoji(r.emoji), r.count, names);
}

// Emoji Unicode apa adanya; ":nama:" emote kantor sebagai gambar kecil, atau teksnya kalau
// emote itu tidak (lagi) ada di katalog.
export function EmojiGlyph({ emoji, emotes }: { emoji: string; emotes: EmoteMap }) {
  const name = emoteName(emoji);
  const sticker = name ? emotes.get(name) : undefined;
  if (sticker) return <StickerImage hash={sticker.hash} alt={emoji} size="inline" ready={sticker.ready} />;
  return <span className={name ? "rx-emote-text" : "rx-emoji"}>{emoji}</span>;
}

// Lapisan melayang (portal, posisi tetap) di dekat elemen pembuka: di bawah atau di atasnya,
// mana yang muat, dan selalu di dalam jendela.
type FloatingProps = {
  anchor: HTMLElement;
  prefer: "above" | "below";
  align: "start" | "center" | "end";
  className?: string;
  id?: string;
  "aria-hidden"?: boolean;
  children: ReactNode;
};

const EDGE = 8;
const GAP = 6;

function FloatingLayer({ anchor, prefer, align, className, children, ...rest }: FloatingProps) {
  const own = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    function place() {
      const el = own.current;
      if (!el || !anchor.isConnected) return;
      const a = anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const below = a.bottom + GAP;
      const above = a.top - GAP - h;
      const fitsBelow = below + h <= vh - EDGE;
      const fitsAbove = above >= EDGE;
      let top = prefer === "below" ? (fitsBelow || !fitsAbove ? below : above) : fitsAbove || !fitsBelow ? above : below;
      top = Math.max(EDGE, Math.min(top, vh - h - EDGE));
      let left = align === "start" ? a.left : align === "end" ? a.right - w : a.left + a.width / 2 - w / 2;
      left = Math.max(EDGE, Math.min(left, vw - w - EDGE));
      setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, prefer, align]);

  return createPortal(
    <div ref={own} className={className} style={{ position: "fixed", left: pos.left, top: pos.top }} {...rest}>
      {children}
    </div>,
    document.body,
  );
}

type BarProps = {
  reactions: ReactionView[];
  me: string;
  canReact: boolean;
  emotes: EmoteMap;
  // "Reaksi untuk pesan Sari pukul 09.12" dan "Beri reaksi ke pesan ...".
  label: string;
  addLabel: string;
  // Emoji yang reaksinya sedang disimpan: klik diabaikan sampai data baru datang.
  pending: ReadonlySet<string>;
  onToggle: (emoji: string, on: boolean) => void;
  onAdd: (anchor: HTMLElement) => void;
  // Pemilih emoji sedang terbuka dari tombol "+" ini.
  addExpanded?: boolean;
};

// Chip reaksi di bawah pesan. Klik menambah atau menghapus reaksi saya. Arahkan kursor atau
// fokus untuk melihat siapa saja. Tanpa hak memberi reaksi, chip tetap bisa difokus dan
// dibaca, tetapi tidak bisa ditekan.
export function ReactionBar({
  reactions,
  me,
  canReact,
  emotes,
  label,
  addLabel,
  pending,
  onToggle,
  onAdd,
  addExpanded = false,
}: BarProps) {
  const [tip, setTip] = useState<{ emoji: string; anchor: HTMLElement } | null>(null);
  const tipId = useId();
  if (reactions.length === 0) return null;
  const shown = tip ? reactions.find((r) => r.emoji === tip.emoji) : undefined;

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    // Esc menyembunyikan keterangan tanpa memindahkan fokus.
    if (e.key === "Escape" && tip) {
      e.preventDefault();
      e.stopPropagation();
      setTip(null);
    }
  }

  return (
    <>
      <ul className="rx-bar" aria-label={label}>
        {reactions.map((r) => (
          <li key={r.emoji}>
            <button
              type="button"
              className={`rx-chip${r.mine ? " rx-chip-mine" : ""}${canReact ? "" : " rx-chip-static"}`}
              aria-pressed={r.mine}
              aria-disabled={canReact ? undefined : true}
              aria-busy={pending.has(r.emoji) || undefined}
              aria-label={reactionLabel(r, me)}
              data-rx-emoji={r.emoji}
              onClick={canReact && !pending.has(r.emoji) ? () => onToggle(r.emoji, !r.mine) : undefined}
              onMouseEnter={(e) => setTip({ emoji: r.emoji, anchor: e.currentTarget })}
              onMouseLeave={() => setTip((t) => (t?.emoji === r.emoji ? null : t))}
              onFocus={(e) => setTip({ emoji: r.emoji, anchor: e.currentTarget })}
              onBlur={() => setTip((t) => (t?.emoji === r.emoji ? null : t))}
              onKeyDown={onKeyDown}
            >
              <EmojiGlyph emoji={r.emoji} emotes={emotes} />
              <span className="rx-count">{r.count}</span>
            </button>
          </li>
        ))}
        {canReact && (
          <li>
            <button
              type="button"
              className="rx-chip rx-add"
              aria-label={addLabel}
              title={addLabel}
              aria-haspopup="dialog"
              aria-expanded={addExpanded}
              onClick={(e) => onAdd(e.currentTarget)}
            >
              <IconMoodPlus size={16} aria-hidden="true" />
            </button>
          </li>
        )}
      </ul>
      {tip && shown && tip.anchor.isConnected && (
        // Isinya sama dengan label chip, jadi disembunyikan dari pembaca layar.
        <FloatingLayer anchor={tip.anchor} prefer="above" align="center" className="rx-tip" id={tipId} aria-hidden>
          <span>{RX.tip(reactorSummary(shown, me), shown.emoji)}</span>
          {!canReact && <span className="rx-tip-note">{RX.tipReadOnly}</span>}
        </FloatingLayer>
      )}
    </>
  );
}

type QuickProps = {
  reactions: ReactionView[];
  label: string;
  moreLabel: string;
  onToggle: (emoji: string, on: boolean) => void;
  onMore: (anchor: HTMLElement) => void;
  moreRef?: { current: HTMLButtonElement | null };
  moreExpanded?: boolean;
  pending: ReadonlySet<string>;
};

// Reaksi cepat di bilah aksi pesan: satu tab stop, panah kiri dan kanan (Home, End) untuk
// berpindah. Tombol terakhir "Beri reaksi lain" membuka pemilih emoji.
export function QuickReactions({
  reactions,
  label,
  moreLabel,
  onToggle,
  onMore,
  moreRef,
  moreExpanded = false,
  pending,
}: QuickProps) {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const count = QUICK_REACTIONS.length + 1;

  function move(e: KeyboardEvent<HTMLDivElement>) {
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (active + 1) % count;
    else if (e.key === "ArrowLeft") next = (active - 1 + count) % count;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = count - 1;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    refs.current[next]?.focus();
  }

  return (
    <div className="rx-quick" role="toolbar" aria-label={label} onKeyDown={move}>
      {QUICK_REACTIONS.map((emoji, i) => {
        const mine = !!reactions.find((r) => r.emoji === emoji)?.mine;
        return (
          <button
            key={emoji}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            className={`conv-action rx-quick-btn${mine ? " rx-quick-mine" : ""}`}
            tabIndex={i === active ? 0 : -1}
            aria-pressed={mine}
            aria-busy={pending.has(emoji) || undefined}
            aria-label={RX.quick(spokenEmoji(emoji))}
            title={RX.quick(spokenEmoji(emoji))}
            onFocus={() => setActive(i)}
            onClick={() => {
              if (!pending.has(emoji)) onToggle(emoji, !mine);
            }}
          >
            <span aria-hidden="true">{emoji}</span>
          </button>
        );
      })}
      <button
        ref={(el) => {
          refs.current[count - 1] = el;
          if (moreRef) moreRef.current = el;
        }}
        type="button"
        className="conv-action rx-quick-btn"
        tabIndex={active === count - 1 ? 0 : -1}
        aria-label={moreLabel}
        title={RX.moreShort}
        aria-haspopup="dialog"
        aria-expanded={moreExpanded}
        onFocus={() => setActive(count - 1)}
        onClick={(e) => onMore(e.currentTarget)}
      >
        <IconMoodPlus size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

type PickerLayerProps = {
  anchor: HTMLElement;
  label: string;
  recent: string[];
  emotes: EmoteMap;
  onPick: (emoji: string) => void;
  // outside: ditutup karena klik di luar pemilih. Fokus lalu ikut ke tempat yang diklik.
  onClose: (reason: "outside" | "other") => void;
};

// Pemilih emoji untuk satu pesan, melayang di dekat tombol pembukanya.
export function ReactionPicker({ anchor, label, recent, emotes, onPick, onClose }: PickerLayerProps) {
  const labelId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  // Hanya tombol pembuka ini yang tidak dihitung klik di luar; tombol itu sendiri yang menutup.
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);
  // EmojiPicker menutup di pointerdown (fase capture di document). Pendengar di window
  // berjalan lebih dulu, jadi alasan tutup sudah tercatat saat onClose dipanggil.
  const outside = useRef(false);
  useEffect(() => {
    function onDown(e: Event) {
      const t = e.target;
      outside.current = t instanceof Node && !!boxRef.current && !boxRef.current.contains(t);
      window.setTimeout(() => {
        outside.current = false;
      }, 0);
    }
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, []);
  const list = [...emotes.values()].map((s) => ({
    name: s.name,
    render: () => <StickerImage hash={s.hash} alt={`:${s.name}:`} size="inline" ready={s.ready} />,
  }));
  return (
    <FloatingLayer anchor={anchor} prefer="below" align="end" className="rx-picker-layer">
      <div ref={boxRef}>
        <span id={labelId} className="sr-only">
          {label}
        </span>
        <EmojiPicker
          className="rx-picker"
          onPick={onPick}
          onClose={() => onClose(outside.current ? "outside" : "other")}
          recent={recent}
          emotes={list}
          labelledBy={labelId}
          anchorRef={anchorRef}
        />
      </div>
    </FloatingLayer>
  );
}
