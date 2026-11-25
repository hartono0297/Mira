import { describe, expect, it } from "vitest";
import {
  EMOJI,
  EMOJI_CATEGORIES,
  QUICK_REACTIONS,
  emojiInCategory,
  findEmoji,
  normalizeSearch,
  searchEmoji,
} from "./emojiData";

const chars = (list: { char: string }[]) => list.map((e) => e.char);

describe("data emoji", () => {
  it("berisi 300 sampai 400 emoji, setiap kategori terisi", () => {
    expect(EMOJI.length).toBeGreaterThanOrEqual(300);
    expect(EMOJI.length).toBeLessThanOrEqual(400);
    for (const c of EMOJI_CATEGORIES) expect(emojiInCategory(c).length).toBeGreaterThan(0);
  });

  it("setiap entri satu grafem, tampil sebagai emoji, lengkap, dan tidak dobel", () => {
    // Intl.Segmenter belum ada di lib tsconfig (target lama), padahal ada di Node.
    const { Segmenter } = Intl as unknown as { Segmenter: new () => { segment(s: string): Iterable<unknown> } };
    const seg = new Segmenter();
    const seen = new Set<string>();
    for (const e of EMOJI) {
      expect([...seg.segment(e.char)], e.char).toHaveLength(1);
      expect(/\p{Emoji_Presentation}|️/u.test(e.char), e.char).toBe(true);
      expect(e.id && e.en && e.keywords.length > 0, e.char).toBeTruthy();
      expect(e.id, e.char).toBe(e.id.toLowerCase());
      const key = e.char.replace(/️/g, "");
      expect(seen.has(key), e.char).toBe(false);
      seen.add(key);
    }
  });

  it("emoji teks mendapat U+FE0F, dan pencarian per karakter tidak peduli selektor variasi", () => {
    expect(findEmoji("❤")?.char).toBe("❤️");
    expect(findEmoji("❤️")?.id).toBe("hati merah");
    expect(findEmoji("☀")?.char).toBe("☀️");
    expect(findEmoji("x")).toBeUndefined();
  });

  it("reaksi cepat ada di data", () => {
    expect(QUICK_REACTIONS).toEqual(["👍", "❤️", "😂", "🙏", "😮"]);
    for (const c of QUICK_REACTIONS) expect(findEmoji(c), c).toBeDefined();
  });
});

describe("searchEmoji", () => {
  it("menemukan nama Indonesia dan Inggris", () => {
    expect(searchEmoji("jempol")[0].char).toBe("👍");
    expect(searchEmoji("kopi")[0].char).toBe("☕");
    expect(searchEmoji("thumbs")[0].char).toBe("👍");
    expect(searchEmoji("coffee")[0].char).toBe("☕");
  });

  it("awalan nama lebih dulu, lalu kata kunci, lalu potongan kata", () => {
    // "senyum" adalah awalan nama 😀 dan kata kunci 🙂 ("senyum tipis" juga awalan).
    const hasil = chars(searchEmoji("senyum"));
    expect(hasil.slice(0, 2)).toEqual(["😀", "😃"]);
    // "makasih" hanya kata kunci 🙏.
    expect(chars(searchEmoji("makasih"))).toEqual(["🙏"]);
    // "pol" hanya potongan kata: jempol, jempol bawah.
    const potongan = chars(searchEmoji("pol"));
    expect(potongan).toContain("👍");
    // awalan kata di nama ("up" di "thumbs up") mendahului potongan ("cup").
    const up = chars(searchEmoji("up", 400));
    expect(up.indexOf("👍")).toBeLessThan(up.indexOf("🥤"));
  });

  it("tidak peduli huruf besar, aksen, dan garis bawah", () => {
    expect(chars(searchEmoji("JEMPOL"))).toEqual(chars(searchEmoji("jempol")));
    expect(searchEmoji("kópi")[0].char).toBe("☕");
    expect(searchEmoji("thumbs_up")[0].char).toBe("👍");
    expect(normalizeSearch("  Thumbs_Up ")).toBe("thumbs up");
  });

  it("menghormati batas dan kueri kosong", () => {
    expect(searchEmoji("a", 5)).toHaveLength(5);
    expect(searchEmoji("a").length).toBeLessThanOrEqual(40);
    expect(searchEmoji("   ")).toEqual([]);
    expect(searchEmoji("zzzz")).toEqual([]);
  });
});
