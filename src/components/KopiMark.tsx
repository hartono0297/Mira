import { IconCoffee } from "@tabler/icons-react";
import { KOPI_TEXT as T } from "../i18n/kopi";
import { kopiTierName, kopiTierRank } from "./kopiText";
import { useKopi } from "./useKopi";
import "./kopi.css";

type Props = {
  publicKey: string;
  className?: string;
};

// Ikon kopi kecil di samping nama. Tingkatan dibedakan oleh jumlah garis di
// kanan cangkir (Anak baru tanpa garis, Legenda tiga garis), bukan hanya warna.
// Tidak tampil kalau fitur mati atau orang itu belum punya Kopi.
export function KopiMark({ publicKey, className }: Props) {
  const { overview, badgeOf } = useKopi();
  if (!overview?.enabled) return null;
  const badge = badgeOf(publicKey);
  if (!badge || badge.score <= 0) return null;
  const rank = kopiTierRank(badge.tier);
  const label = T.mark.label(kopiTierName(badge.tier), badge.peer + badge.work);
  return (
    <span
      className={`kopi-mark kopi-r${rank}${className ? ` ${className}` : ""}`}
      role="img"
      aria-label={label}
      title={label}
      data-tier={badge.tier}
    >
      <IconCoffee size={14} stroke={2} aria-hidden="true" />
      {rank > 0 && (
        <span className="kopi-mark-steps" aria-hidden="true">
          {Array.from({ length: rank }, (_, i) => (
            <span key={i} />
          ))}
        </span>
      )}
    </span>
  );
}
