import type { LabelRef } from "../api/org";
import "./name-with-labels.css";

// Batas label di samping nama (keputusan usulan v0.3 bagian 6, opsi A).
export const MAX_LABELS_SHOWN = 3;

type Props = {
  name: string;
  // Label aktif orang itu, misalnya PersonView.labels dari orgApi.people().
  labels: readonly LabelRef[];
  // Paling banyak berapa label yang tampil. Sisanya diringkas menjadi "+2".
  max?: number;
  // Teks tambahan sesudah nama, misalnya " (Anda)".
  suffix?: string;
  className?: string;
};

// Nama orang dengan paling banyak tiga label profil di sampingnya. Label hanya
// teks di kotak lembut. Pembaca layar mendengar "Rina, label Arsitek, Senior".
export function NameWithLabels({ name, labels, max = MAX_LABELS_SHOWN, suffix, className }: Props) {
  const limit = Math.max(0, max);
  const shown = labels.slice(0, limit);
  const rest = labels.slice(limit);
  return (
    <span className={className ? `nwl ${className}` : "nwl"}>
      <span className="nwl-name">
        {name}
        {suffix && <span className="nwl-suffix">{suffix}</span>}
        {/* Di dalam span nama, supaya nama aksesibel jadi "Rina, label ..." tanpa spasi sebelum koma. */}
        {shown.length > 0 && <span className="sr-only">, label </span>}
      </span>
      {shown.length > 0 && (
        <span className="nwl-labels">
          {shown.map((l, i) => (
            <span key={l.id} className="lab">
              {l.name}
              {i < shown.length - 1 && <span className="sr-only">, </span>}
            </span>
          ))}
          {rest.length > 0 && (
            <span className="lab lab-more" title={rest.map((l) => l.name).join(", ")}>
              <span aria-hidden="true">+{rest.length}</span>
              <span className="sr-only">, dan {rest.length} label lain</span>
            </span>
          )}
        </span>
      )}
    </span>
  );
}
