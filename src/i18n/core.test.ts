import { describe, expect, it } from "vitest";
import { defineText, getLang, locale, parseLang, plural, setLang, subscribeLang } from "./core";

describe("inti bahasa", () => {
  it("bawaan bahasa Indonesia dan parseLang menolak nilai asing", () => {
    expect(getLang()).toBe("id");
    expect(parseLang("en")).toBe("en");
    expect(parseLang("fr")).toBe("id");
    expect(parseLang(null)).toBe("id");
  });

  it("defineText membaca bahasa aktif saat properti dibaca, termasuk objek bersarang", () => {
    const T = defineText(
      { a: "Simpan", nested: { b: (n: number) => `${n} tugas` }, list: ["Senin"] },
      { a: "Save", nested: { b: (n: number) => `${n} ${plural(n, "task", "tasks")}` }, list: ["Monday"] },
    );
    const nested = T.nested;
    expect(T.a).toBe("Simpan");
    expect(nested.b(1)).toBe("1 tugas");
    setLang("en");
    expect(T.a).toBe("Save");
    // Objek bersarang yang disimpan lebih dulu tetap mengikuti bahasa aktif.
    expect(nested.b(1)).toBe("1 task");
    expect(nested.b(3)).toBe("3 tasks");
    expect(T.list[0]).toBe("Monday");
    expect({ ...T }.a).toBe("Save");
    expect(Object.keys(T)).toEqual(["a", "nested", "list"]);
  });

  it("setLang memberi tahu pelanggan dan mengubah lang dokumen", () => {
    let calls = 0;
    const off = subscribeLang(() => calls++);
    setLang("en");
    setLang("en");
    expect(calls).toBe(1);
    expect(document.documentElement.lang).toBe("en");
    expect(locale()).toBe("en-GB");
    off();
    setLang("id");
    expect(calls).toBe(1);
    expect(locale()).toBe("id-ID");
  });
});
