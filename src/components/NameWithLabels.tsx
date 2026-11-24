import { useLayoutEffect, useRef, useState } from "react";
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
  // "+N" hanya tampilan, tidak bisa difokus. Untuk tempat yang sudah berada di dalam
  // tombol (baris daftar percakapan): nama tombolnya yang menyebut semua label.
  staticMore?: boolean;
  className?: string;
};

// Kotak-kotak label saja, tanpa nama. Dipakai NameWithLabels dan tempat yang menulis
// namanya sendiri (judul pesan pribadi, baris daftar percakapan).
export function LabelChips({ labels, max = MAX_LABELS_SHOWN, all, wrap, staticMore, className }: ChipsProps) {
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
        (staticMore ? (
          <span className="lab lab-more">
            <span aria-hidden="true">+{rest.length}</span>
            <span className="sr-only">{T.labels.more(rest.length)}</span>
          </span>
        ) : (
          <MoreLabels rest={rest} />
        ))}
    </span>
  );
}

// "+N" yang bisa difokus. Saat diarahkan kursor, difokus, atau diklik, kotak kecil di
// bawahnya menampilkan semua label sisanya. Esc menutup kotak tanpa memindah fokus.
// Nama aksesibel tombol sudah menyebut semua sisa label, jadi kotaknya hanya tampilan.
function MoreLabels({ rest }: { rest: readonly LabelRef[] }) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [alignEnd, setAlignEnd] = useState(false);
  const tipRef = useRef<HTMLSpanElement>(null);
  const open = !dismissed && (hover || focus || pinned);
  const names = rest.map((l) => l.name).join(", ");

  // Kotak yang terpotong di tepi kanan jendela dipindah ke sisi kiri "+N".
  useLayoutEffect(() => {
    if (!open) {
      setAlignEnd(false);
      return;
    }
    const box = tipRef.current?.getBoundingClientRect();
    if (box && box.right > window.innerWidth - 8) setAlignEnd(true);
  }, [open]);

  return (
    <span
      className="lab-more-wrap"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setDismissed(false);
      }}
    >
      <button
        type="button"
        className="lab lab-more lab-more-btn"
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
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            // Esc pertama hanya menutup kotak ini, bukan dialog atau panel di sekitarnya.
            e.preventDefault();
            e.stopPropagation();
            setDismissed(true);
            setPinned(false);
          }
        }}
      >
        <span aria-hidden="true">+{rest.length}</span>
        <span className="sr-only">{T.labels.more(rest.length)}</span>
        <span className="sr-only">: {names}</span>
      </button>
      {open && (
        <span ref={tipRef} aria-hidden="true" className={alignEnd ? "lab-tip lab-tip-end" : "lab-tip"}>
          <span className="lab-tip-box">
            {rest.map((l) => (
              <span key={l.id} className="lab">
                {l.name}
              </span>
            ))}
          </span>
        </span>
      )}
    </span>
  );
}

type Props = Omit<ChipsProps, "staticMore"> & {
  name: string;
  // Teks tambahan sesudah nama, misalnya " (Anda)".
  suffix?: string;
};

// Nama orang dengan paling banyak tiga label profil di sampingnya (atau semuanya kalau
// `all`). Label hanya teks di kotak lembut. Pembaca layar mendengar "Rina, label Arsitek, Senior".
export function NameWithLabels({ name, labels, max = MAX_LABELS_SHOWN, all, wrap, suffix, className }: Props) {
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
      {hasLabels && <LabelChips labels={labels} max={max} all={all} wrap={wrap} />}
    </span>
  );
}
