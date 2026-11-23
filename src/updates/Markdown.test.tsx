import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { notesFor } from "../whats-new";
import { Markdown, parseMarkdown } from "./Markdown";

describe("Markdown sederhana", () => {
  it("memecah paragraf, daftar, dan subjudul", () => {
    const src = "Baris satu\nbaris dua.\n\n## Baru\n\n- Butir A\n  lanjutan\n* Butir B\nParagraf akhir.\r\n";
    expect(parseMarkdown(src)).toEqual([
      { kind: "p", text: "Baris satu baris dua." },
      { kind: "h", text: "Baru" },
      { kind: "ul", items: ["Butir A lanjutan", "Butir B"] },
      { kind: "p", text: "Paragraf akhir." },
    ]);
  });

  it("merender elemen React, dan HTML di catatan tetap teks biasa", () => {
    const { container } = render(<Markdown source={'## Judul\n\n- <img src=x onerror="alert(1)">\n\n<b>tebal</b>'} />);
    expect(screen.getByRole("heading", { level: 3, name: "Judul" })).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent('<img src=x onerror="alert(1)">');
    expect(screen.getByText("<b>tebal</b>")).toBeInTheDocument();
    expect(container.querySelector("img, b")).toBeNull();
  });

  it("tingkat subjudul bisa diatur", () => {
    render(<Markdown source="## Sub" headingLevel={4} />);
    expect(screen.getByRole("heading", { level: 4, name: "Sub" })).toBeInTheDocument();
  });

  it("catatan 0.3.0 dibundel dan hanya memakai paragraf, daftar, dan subjudul", () => {
    const text = notesFor("0.3.0");
    expect(text).not.toBeNull();
    expect(notesFor("v0.3.0")).toBe(text);
    expect(notesFor("9.9.9")).toBeNull();
    expect(notesFor(null)).toBeNull();
    expect(text).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
    for (const line of (text as string).split(/\r?\n/)) {
      expect(line).not.toMatch(/[*_`[\]<>]/);
    }
  });
});
