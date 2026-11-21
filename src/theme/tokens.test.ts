import { describe, expect, it } from "vitest";
import { themeCss, themes } from "./tokens";

describe("token tema", () => {
  it("versi terang dan gelap punya peran yang sama persis", () => {
    for (const theme of Object.values(themes)) {
      expect(Object.keys(theme.dark).sort()).toEqual(Object.keys(theme.light).sort());
    }
  });

  it("nilai Bata sesuai design/tema-c.html", () => {
    expect(themes.bata.light.bg).toBe("#FFFFFF");
    expect(themes.bata.light.accent).toBe("#B4472A");
    expect(themes.bata.dark.bg).toBe("#1E1714");
    expect(themes.bata.dark.accent).toBe("#F08A64");
    expect(themes.bata.dark["on-accent"]).toBe("#2A1F1A");
  });

  it("menghasilkan CSS per atribut data-theme", () => {
    const css = themeCss(themes.bata);
    expect(css).toContain(':root[data-theme="light"]{');
    expect(css).toContain(':root[data-theme="dark"]{');
    expect(css).toContain("--accent:#B4472A;");
    expect(css).toContain("--accent:#F08A64;");
  });
});
