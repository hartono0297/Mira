// Setiap kamus .id punya pasangan .en dengan kunci dan bentuk yang sama.
// tsc sudah memeriksa tipe lewat Dict<typeof id>; tes ini memeriksa isi nyata,
// termasuk kunci tambahan di .en dan nilai kosong.
import { describe, expect, it } from "vitest";

const idFiles = import.meta.glob<{ default: object }>("./*.id.ts", { eager: true });
const enFiles = import.meta.glob<{ default: object }>("./*.en.ts", { eager: true });

const EM_DASH = "\u2014";

type Problem = string;

// Tipe parameter tidak terlihat saat dijalankan, jadi beberapa kombinasi dicoba:
// angka 2 untuk jamak dan hitungan, string untuk nama dan judul.
function sampleArgSets(length: number): unknown[][] {
  const pick = (f: (i: number) => unknown) => Array.from({ length }, (_, i) => f(i));
  return [
    pick(() => "Contoh"),
    pick(() => 2),
    pick((i) => (i % 2 === 0 ? 2 : "Contoh")),
    pick((i) => (i % 2 === 0 ? "Contoh" : 2)),
  ];
}

function render(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "function") {
    for (const args of sampleArgSets(value.length)) {
      try {
        const out = (value as (...a: unknown[]) => unknown)(...args);
        if (typeof out === "string") return out;
      } catch {
        // Coba kombinasi berikutnya.
      }
    }
  }
  return null;
}

function compare(id: unknown, en: unknown, path: string, out: Problem[]): void {
  if (Array.isArray(id)) {
    if (!Array.isArray(en)) return void out.push(`${path}: .en bukan array`);
    if (id.length !== en.length) out.push(`${path}: panjang array berbeda (${id.length} vs ${en.length})`);
    id.forEach((v, i) => compare(v, en[i], `${path}[${i}]`, out));
    return;
  }
  if (id !== null && typeof id === "object") {
    if (en === null || typeof en !== "object") return void out.push(`${path}: .en bukan objek`);
    const a = Object.keys(id);
    const b = Object.keys(en as object);
    for (const k of a) if (!(k in (en as object))) out.push(`${path}.${k}: tidak ada di .en`);
    for (const k of b) if (!(k in id)) out.push(`${path}.${k}: hanya ada di .en`);
    for (const k of a) if (k in (en as object)) compare((id as never)[k], (en as never)[k], `${path}.${k}`, out);
    return;
  }
  if (typeof id !== typeof en) return void out.push(`${path}: tipe berbeda (${typeof id} vs ${typeof en})`);
  if (typeof id === "function" && (id as () => void).length !== (en as () => void).length) {
    out.push(`${path}: jumlah parameter berbeda`);
  }
  for (const [lang, v] of [
    ["id", id],
    ["en", en],
  ] as const) {
    const text = render(v);
    if (typeof v === "string" || typeof v === "function") {
      if (text === null) out.push(`${path} (${lang}): fungsi tidak menghasilkan string`);
      else if (typeof v === "string" && text.trim() === "" && v !== "") out.push(`${path} (${lang}): kosong`);
      else if (text?.includes(EM_DASH)) out.push(`${path} (${lang}): memakai em dash`);
    }
  }
}

const names = Object.keys(idFiles).map((p) => p.replace(/^\.\//, "").replace(/\.id\.ts$/, ""));

describe("kamus bahasa", () => {
  it("ada minimal satu kamus", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it("setiap .en punya pasangan .id", () => {
    const orphan = Object.keys(enFiles)
      .map((p) => p.replace(/^\.\//, "").replace(/\.en\.ts$/, ""))
      .filter((n) => !names.includes(n));
    expect(orphan).toEqual([]);
  });

  it.each(names)("%s: kunci .id dan .en sama, tanpa nilai kosong atau em dash", (name) => {
    const id = idFiles[`./${name}.id.ts`]?.default;
    const en = enFiles[`./${name}.en.ts`]?.default;
    expect(en, `src/i18n/${name}.en.ts belum ada`).toBeDefined();
    const problems: Problem[] = [];
    compare(id, en, name, problems);
    expect(problems).toEqual([]);
  });
});
