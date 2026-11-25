import { describe, expect, it } from "vitest";
import { applySuggestion, emojiQueryAt } from "./emojiSuggest";

// Kursor di akhir teks, kecuali disebut lain.
const at = (text: string, caret = text.length) => emojiQueryAt(text, caret);

describe("emojiQueryAt", () => {
  it("mengenali :nama di awal teks dan setelah spasi atau baris baru", () => {
    expect(at(":ko")).toEqual({ start: 0, query: "ko" });
    expect(at("halo :jem")).toEqual({ start: 5, query: "jem" });
    expect(at("baris satu\n:kopi")).toEqual({ start: 11, query: "kopi" });
    expect(at("tab\t:ok")).toEqual({ start: 4, query: "ok" });
  });

  it("menerima angka dan garis bawah, dan membuat huruf kecil", () => {
    expect(at(":thumbs_up")).toEqual({ start: 0, query: "thumbs_up" });
    expect(at(":100")).toEqual({ start: 0, query: "100" });
    expect(at(":JemPol")).toEqual({ start: 0, query: "jempol" });
  });

  it("perlu minimal dua karakter", () => {
    expect(at(":")).toBeNull();
    expect(at(":k")).toBeNull();
    expect(at("halo :")).toBeNull();
  });

  it("menolak titik dua di tengah kata, jam, atau tautan", () => {
    expect(at("halo:ko")).toBeNull();
    expect(at("rapat 10:30")).toBeNull();
    expect(at("https://contoh")).toBeNull();
  });

  it("berhenti di karakter selain huruf, angka, dan garis bawah", () => {
    expect(at(":kopi panas")).toBeNull();
    expect(at(":kopi:")).toBeNull();
    expect(at(":ko-pi")).toBeNull();
  });

  it("memakai posisi kursor, bukan akhir teks", () => {
    const text = "halo :jem lagi";
    expect(emojiQueryAt(text, 9)).toEqual({ start: 5, query: "jem" });
    expect(emojiQueryAt(text, 8)).toEqual({ start: 5, query: "je" });
    expect(emojiQueryAt(text, 7)).toBeNull();
    expect(emojiQueryAt(text, 14)).toBeNull();
  });

  it("aman untuk kursor di luar teks", () => {
    expect(emojiQueryAt(":ko", -1)).toBeNull();
    expect(emojiQueryAt(":ko", 10)).toBeNull();
    expect(emojiQueryAt("", 0)).toBeNull();
  });
});

describe("applySuggestion", () => {
  it("mengganti :nama dengan emoji dan meletakkan kursor setelahnya", () => {
    expect(applySuggestion("halo :jem", 5, 9, "👍 ")).toEqual({ text: "halo 👍 ", caret: 5 + "👍 ".length });
  });

  it("menjaga teks setelah kursor", () => {
    expect(applySuggestion("halo :jem lagi", 5, 9, "👍")).toEqual({ text: "halo 👍 lagi", caret: 7 });
  });

  it("bisa menyisipkan emote kantor", () => {
    const { text, caret } = applySuggestion(":ko", 0, 3, ":kopi_pagi: ");
    expect(text).toBe(":kopi_pagi: ");
    expect(caret).toBe(text.length);
  });

  it("membatasi posisi yang di luar teks", () => {
    expect(applySuggestion("abc", -2, 99, "x")).toEqual({ text: "x", caret: 1 });
    expect(applySuggestion("abc", 2, 1, "x")).toEqual({ text: "abxc", caret: 3 });
  });
});
