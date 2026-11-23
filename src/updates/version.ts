// Perbandingan versi semver kecil: "0.3.0", "v0.10.1", "0.3.0-beta.1".
// Mengembalikan null kalau salah satu bukan versi yang bisa dibaca.

type Parsed = { core: [number, number, number]; pre: string[] };

const PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(value: string): Parsed | null {
  const m = PATTERN.exec(value.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

function comparePre(a: string[], b: string[]): number {
  // Versi tanpa label prarilis lebih baru dari versi yang sama dengan label.
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const na = /^\d+$/.test(a[i]) ? Number(a[i]) : null;
    const nb = /^\d+$/.test(b[i]) ? Number(b[i]) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (na !== null || nb !== null) {
      return na !== null ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  }
  const pre = comparePre(pa.pre, pb.pre);
  return pre === 0 ? 0 : pre < 0 ? -1 : 1;
}

// "Yang baru" tampil sekali: catatan untuk versi ini ada, dan versi yang terakhir
// dilihat kosong (naik dari v0.2.x) atau lebih lama. Tidak pernah saat turun versi.
export function shouldShowWhatsNew(seen: string | null, current: string, hasNotes: boolean): boolean {
  if (!hasNotes) return false;
  if (!seen || !seen.trim()) return true;
  const cmp = compareVersions(seen, current);
  // Isi yang tidak bisa dibaca dianggap belum pernah melihat.
  return cmp === null || cmp < 0;
}
