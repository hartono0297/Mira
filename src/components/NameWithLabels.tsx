import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { LabelRef } from "../api/org";
import { COMPONENTS_TEXT as T } from "../i18n/components";
import "./name-with-labels.css";

// Batas label di samping nama (keputusan usulan v0.3 bagian 6, opsi A).
export const MAX_LABELS_SHOWN = 3;

type ChipsProps = {
  // Label aktif orang itu, misalnya PersonView.labels dari orgApi.people().
  labels: readonly LabelRef[];
  // Paling banyak berapa label yang tampil. Sisanya diringkas menjadi "+2".
  max?: number;
  // Semua label tampil, tanpa "+N" (chat: kepala pesan pribadi, anggota, profil).
  all?: boolean;
  // Chip boleh turun baris dan teks label panjang boleh patah, supaya banyak label
  // tidak mendorong elemen lain atau membuat gulir ke samping.
  wrap?: boolean;
  // "+N" menjadi tombol yang bisa difokus, dengan kotak berisi sisa label saat diarahkan
  // kursor, difokus, atau diklik (chat). Bawaan: "+N" hanya tampilan dengan title, seperti
  // di Organisasi dan Board. Jangan dipakai di dalam tombol (tombol di dalam tombol).
  moreFocusable?: boolean;
  className?: string;
};

// Kotak-kotak label saja, tanpa nama. Dipakai NameWithLabels dan tempat yang menulis
// namanya sendiri (judul pesan pribadi, baris daftar percakapan).
export function LabelChips({ labels, max = MAX_LABELS_SHOWN, all, wrap, moreFocusable, className }: ChipsProps) {
  const limit = all ? labels.length : Math.max(0, max);
  const shown = labels.slice(0, limit);
  const rest = labels.slice(limit);
  if (shown.length === 0) return null;
  const classes = ["nwl-labels", wrap ? "nwl-wrap" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={classes}>
      {shown.map((l, i) => (
        <span key={l.id} className="lab">
          {l.name}
          {i < shown.length - 1 && <span className="sr-only">, </span>}
        </span>
      ))}
      {rest.length > 0 &&
        (moreFocusable ? (
          <MoreLabels rest={rest} />
        ) : (
          <span className="lab lab-more" title={rest.map((l) => l.name).join(", ")}>
            <span aria-hidden="true">+{rest.length}</span>
            <span className="sr-only">{T.labels.more(rest.length)}</span>
          </span>
        ))}
    </span>
  );
}

// Jeda sebelum kotak tertutup saat kursor keluar, supaya kursor sempat pindah dari "+N"
// ke kotaknya (yang ada di portal, bukan di dalam "+N").
const LEAVE_DELAY = 120;

// "+N" yang bisa difokus. Saat diarahkan kursor, difokus, atau diklik, kotak kecil
// menampilkan semua label sisanya. Esc menutup kotak tanpa memindah fokus.
// Nama aksesibel tombol sudah menyebut semua sisa label, jadi kotaknya hanya tampilan.
function MoreLabels({ rest }: { rest: readonly LabelRef[] }) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const leaveTimer = useRef<number | undefined>(undefined);
  const open = !dismissed && (hover || focus || pinned);
  const names = rest.map((l) => l.name).join(", ");

  const enter = () => {
    window.clearTimeout(leaveTimer.current);
    setHover(true);
  };
  const leave = () => {
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => {
      setHover(false);
      setDismissed(false);
    }, LEAVE_DELAY);
  };
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  // Esc ditangkap di window (fase capture) selama kotak terbuka, sebelum Radix Dialog
  // menangkapnya di document. Jadi Esc pertama hanya menutup kotak ini, bukan dialog atau
  // panel di belakangnya; Esc berikutnya sampai ke sana seperti biasa.
  useEffect(() => {
    if (!open) return;
    const onEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setDismissed(true);
      setPinned(false);
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="lab lab-more lab-more-btn"
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocus={() => setFocus(true)}
        onBlur={() => {
          setFocus(false);
          setPinned(false);
          setDismissed(false);
        }}
        onClick={(e) => {
          // Di dalam baris berlabel (pemilih orang), klik ini tidak ikut mencentang.
          e.preventDefault();
          if (dismissed) {
            setDismissed(false);
            setPinned(true);
          } else {
            setPinned((v) => !v);
          }
        }}
      >
        <span aria-hidden="true">+{rest.length}</span>
        <span className="sr-only">{T.labels.more(rest.length)}</span>
        <span className="sr-only">: {names}</span>
      </button>
      {open && buttonRef.current && (
        <LabelTip anchor={buttonRef.current} onMouseEnter={enter} onMouseLeave={leave}>
          {rest.map((l) => (
            <span key={l.id} className="lab">
              {l.name}
            </span>
          ))}
        </LabelTip>
      )}
    </>
  );
}

const GAP = 4;
const EDGE = 8;

// Kotak sisa label di portal dengan posisi tetap, supaya tidak terpotong wadah yang
// bergulir (daftar orang, panel anggota). Di bawah "+N" kalau muat, selain itu di atasnya,
// dan selalu di dalam jendela.
function LabelTip({
  anchor,
  children,
  onMouseEnter,
  onMouseLeave,
}: {
  anchor: HTMLElement;
  children: ReactNode;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const own = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);

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
      const aboveTop = a.top - GAP - h;
      const above = below + h > vh - EDGE && aboveTop >= EDGE;
      const top = Math.max(EDGE, Math.min(above ? aboveTop : below, vh - h - EDGE));
      const left = Math.max(EDGE, Math.min(a.left, vw - w - EDGE));
      setPos((p) => (p && p.left === left && p.top === top && p.above === above ? p : { left, top, above }));
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  return createPortal(
    <span
      ref={own}
      aria-hidden="true"
      className={pos?.above ? "lab-tip lab-tip-above" : "lab-tip"}
      // Sebelum diukur: tidak terlihat, supaya tidak berkedip di pojok jendela.
      style={{ position: "fixed", left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? undefined : "hidden" }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </span>,
    document.body,
  );
}

type Props = ChipsProps & {
  name: string;
  // Teks tambahan sesudah nama, misalnya " (Anda)".
  suffix?: string;
};

// Nama orang dengan paling banyak tiga label profil di sampingnya (atau semuanya kalau
// `all`). Label hanya teks di kotak lembut. Pembaca layar mendengar "Rina, label Arsitek, Senior".
export function NameWithLabels({ name, labels, max = MAX_LABELS_SHOWN, all, wrap, moreFocusable, suffix, className }: Props) {
  const hasLabels = labels.length > 0 && (all || max > 0);
  const classes = ["nwl", wrap ? "nwl-wrap-all" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={classes}>
      <span className="nwl-name">
        {name}
        {suffix && <span className="nwl-suffix">{suffix}</span>}
        {/* Di dalam span nama, supaya nama aksesibel jadi "Rina, label ..." tanpa spasi sebelum koma. */}
        {hasLabels && <span className="sr-only">{T.labels.prefix(labels.length)}</span>}
      </span>
      {hasLabels && <LabelChips labels={labels} max={max} all={all} wrap={wrap} moreFocusable={moreFocusable} />}
    </span>
  );
}
