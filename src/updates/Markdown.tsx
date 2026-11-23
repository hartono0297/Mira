import type { ReactNode } from "react";

type Block = { kind: "p"; text: string } | { kind: "ul"; items: string[] } | { kind: "h"; text: string };

// Pengurai Markdown kecil untuk catatan rilis: paragraf, daftar "- " atau "* ",
// dan subjudul "#", "##", "###". Selain itu dibaca sebagai teks biasa. Hasilnya
// elemen React, jadi isi catatan tidak pernah dijalankan sebagai HTML.
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: string[] | null = null;

  const flushPara = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  const flushList = () => {
    if (list?.length) blocks.push({ kind: "ul", items: list });
    list = null;
  };

  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const heading = /^#{1,3}\s+(.*)$/.exec(line);
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (!line) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      blocks.push({ kind: "h", text: heading[1] });
    } else if (item) {
      flushPara();
      (list ??= []).push(item[1]);
    } else if (list && /^\s/.test(raw)) {
      // Baris lanjutan dari butir daftar sebelumnya.
      list[list.length - 1] += ` ${line}`;
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return blocks;
}

type Props = {
  source: string;
  // Tingkat subjudul mengikuti tempatnya: h3 di dalam bagian atau dialog berjudul h2.
  headingLevel?: 3 | 4;
};

export function Markdown({ source, headingLevel = 3 }: Props) {
  const Heading = `h${headingLevel}` as const;
  const out: ReactNode[] = parseMarkdown(source).map((b, i) => {
    if (b.kind === "h") {
      return (
        <Heading key={i} className="md-h">
          {b.text}
        </Heading>
      );
    }
    if (b.kind === "ul") {
      return (
        <ul key={i} className="md-ul">
          {b.items.map((item, j) => (
            <li key={j}>{item}</li>
          ))}
        </ul>
      );
    }
    return <p key={i}>{b.text}</p>;
  });
  return <div className="md">{out}</div>;
}
