// Angka "yang menunggu Anda" di menu sidebar dan daftar proyek (badge opsi C,
// design/usulan-v0.3.html bagian 6). Angka tampil untuk mata, artinya ditulis
// untuk pembaca layar, jadi nama tombolnya menjadi misalnya "Chat, 3 belum dibaca".
// Di atas 99 ditulis "99+". Nol atau kurang: tidak tampil apa pun.

export const COUNT_CAP = 99;

export function formatCount(count: number): string {
  return count > COUNT_CAP ? `${COUNT_CAP}+` : String(count);
}

// Teks untuk pembaca layar, misalnya "3 belum dibaca" atau "lebih dari 99 belum dibaca".
export function countText(count: number, meaning: string): string {
  return count > COUNT_CAP ? `lebih dari ${COUNT_CAP} ${meaning}` : `${count} ${meaning}`;
}

type Props = {
  count: number;
  // Arti angkanya, tanpa angka: "belum dibaca", "task tenggat hari ini atau lewat".
  meaning: string;
  className?: string;
};

export function SidebarCount({ count, meaning, className }: Props) {
  if (!Number.isFinite(count) || count <= 0) return null;
  return (
    <span className={className ? `side-count ${className}` : "side-count"}>
      <span aria-hidden="true">{formatCount(Math.floor(count))}</span>
      <span className="sr-only">, {countText(Math.floor(count), meaning)}</span>
    </span>
  );
}
