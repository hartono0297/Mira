// Fungsi murni pemilih sticker: kelompok paket, kisi untuk panah, saran nama, kata kunci.
// Perilaku layar (klik, keyboard, unggah, hapus) diuji lewat kolom pesan di Composer.test.tsx.
import { describe, expect, it } from "vitest";
import type { StickerCatalog } from "../../api/chat";
import {
  gridRows,
  moveInGrid,
  parseKeywords,
  stickerGroups,
  stickerQuery,
  suggestStickerName,
} from "./StickerPicker";

function office(id: string, pack: string, name: string, extra: { state?: "active" | "hidden"; keywords?: string[] } = {}) {
  return {
    id: id.repeat(32),
    pack,
    name,
    keywords: extra.keywords ?? [],
    hash: id.repeat(64),
    mime: "image/png",
    size: 100,
    state: extra.state ?? "active",
    ready: true,
    nameTaken: false,
  };
}

const catalog: StickerCatalog = {
  office: [
    office("1", "Kantor", "kopi", { keywords: ["ngopi", "pagi"] }),
    office("2", "Kantor", "rapat"),
    office("3", "Kantor", "rahasia", { state: "hidden" }),
    office("4", "Perayaan", "hore", { keywords: ["selamat"] }),
  ],
  mine: [
    { id: "9".repeat(32), name: "kucing", keywords: ["lucu"], hash: "9".repeat(64), mime: "image/gif", size: 10, addedAt: "" },
  ],
  canManage: true,
  recentEmoji: [],
};

describe("stickerGroups", () => {
  it("mengelompokkan sticker kantor aktif per paket, tanpa yang disembunyikan", () => {
    const groups = stickerGroups(catalog, "office", "");
    expect(groups.map((g) => [g.title, g.items.map((i) => i.name)])).toEqual([
      ["Kantor", ["kopi", "rapat"]],
      ["Perayaan", ["hore"]],
    ]);
    expect(groups[0].items[0].source).toEqual({ kind: "office", id: "1".repeat(32) });
  });

  it("mencari lewat nama dan kata kunci", () => {
    expect(stickerGroups(catalog, "office", "pagi").flatMap((g) => g.items.map((i) => i.name))).toEqual(["kopi"]);
    expect(stickerGroups(catalog, "office", "ra").flatMap((g) => g.items.map((i) => i.name))).toEqual(["rapat"]);
    expect(stickerGroups(catalog, "mine", "lucu")[0].items[0].source).toEqual({ kind: "mine", id: "9".repeat(32) });
    expect(stickerGroups(catalog, "mine", "zzz")).toEqual([]);
    expect(stickerGroups(null, "office", "")).toEqual([]);
  });

  it("query tanpa titik dua dan huruf kecil", () => {
    expect(stickerQuery("  :Kopi: ")).toBe("kopi");
  });
});

describe("kisi sticker", () => {
  // Paket A: 7 sticker (baris 5 + 2), paket B: 3 sticker.
  const groups = [
    { title: "A", items: Array.from({ length: 7 }) },
    { title: "B", items: Array.from({ length: 3 }) },
  ] as unknown as Parameters<typeof gridRows>[0];
  const rows = gridRows(groups, 5);

  it("setiap paket mulai di baris baru", () => {
    expect(rows).toEqual([[0, 1, 2, 3, 4], [5, 6], [7, 8, 9]]);
  });

  it("panah atas dan bawah menjaga kolom, dipotong ke baris yang lebih pendek", () => {
    expect(moveInGrid(rows, 3, "ArrowDown")).toBe(6);
    expect(moveInGrid(rows, 6, "ArrowDown")).toBe(8);
    expect(moveInGrid(rows, 9, "ArrowUp")).toBe(6);
    expect(moveInGrid(rows, 1, "ArrowUp")).toBe(1);
    expect(moveInGrid(rows, 9, "ArrowDown")).toBe(9);
  });

  it("kiri, kanan, Home, End, dan tombol lain", () => {
    expect(moveInGrid(rows, 0, "ArrowLeft")).toBe(0);
    expect(moveInGrid(rows, 4, "ArrowRight")).toBe(5);
    expect(moveInGrid(rows, 9, "ArrowRight")).toBe(9);
    expect(moveInGrid(rows, 4, "Home")).toBe(0);
    expect(moveInGrid(rows, 4, "End")).toBe(9);
    expect(moveInGrid(rows, 4, "a")).toBeNull();
    expect(moveInGrid([], 0, "ArrowDown")).toBeNull();
  });
});

describe("unggah sticker", () => {
  it("saran nama dari nama file", () => {
    expect(suggestStickerName("Kopi Susu.png")).toBe("kopi_susu");
    expect(suggestStickerName("hore.sticker.gif")).toBe("hore");
    expect(suggestStickerName("--Selamat Pagi!!.webp")).toBe("selamat_pagi");
    expect(suggestStickerName("é.png")).toBe("");
    expect(suggestStickerName(`${"a".repeat(31)} b.png`)).toBe("a".repeat(31));
  });

  it("kata kunci dipisah koma atau spasi, huruf kecil, tanpa duplikat", () => {
    expect(parseKeywords(" Kopi, susu  pagi,,kopi ")).toEqual(["kopi", "susu", "pagi"]);
    expect(parseKeywords("")).toEqual([]);
  });
});
