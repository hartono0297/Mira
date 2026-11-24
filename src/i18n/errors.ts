// Pesan error inti Rust dalam bahasa aktif.
//
// Inti Rust selalu mengirim { code, message } dengan pesan bahasa Indonesia
// (src-tauri/src/error.rs). Protokol dan data tidak diubah; terjemahan terjadi
// di tampilan, di call() setiap modul src/api:
// - Bahasa Indonesia: error dikembalikan apa adanya.
// - Bahasa Inggris: pesan yang persis dikenal (errors-rust.*.ts, `messages`)
//   diganti kalimat Inggrisnya; pesan berargumen dicocokkan lewat `patterns`;
//   selain itu dipakai kalimat umum per kode (errors.*.ts, `byCode`), dan
//   kalimat umum `generic` untuk kode yang tidak dikenal. Kode tidak berubah.
import type { AppError } from "../api/types";
import { defineText, getLang } from "./core";
import rustEn from "./errors-rust.en";
import rustId from "./errors-rust.id";
import en from "./errors.en";
import id from "./errors.id";

export const ERROR_TEXT = defineText(id, en);

// Kode buatan tampilan: pesannya sudah dibentuk dalam bahasa aktif.
const BUILT_IN_UI = new Set(["no_tauri", "unknown"]);

type PatternFn = (...args: string[]) => string;
type Pattern = { re: RegExp; order: number[]; en: PatternFn };

let staticMap: Map<string, string> | null = null;
let patternList: Pattern[] | null = null;

function collect(idPart: unknown, enPart: unknown, out: Map<string, string>): void {
  if (typeof idPart === "string" && typeof enPart === "string") {
    out.set(idPart, enPart);
    return;
  }
  if (idPart && typeof idPart === "object" && enPart && typeof enPart === "object") {
    for (const key of Object.keys(idPart)) {
      collect((idPart as Record<string, unknown>)[key], (enPart as Record<string, unknown>)[key], out);
    }
  }
}

function messages(): Map<string, string> {
  if (!staticMap) {
    staticMap = new Map();
    collect(rustId.messages, rustEn.messages, staticMap);
  }
  return staticMap;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Regex dibentuk dari fungsi kamus Indonesia: argumen diganti penanda, lalu
// setiap penanda menjadi grup tangkap.
function buildPattern(idFn: PatternFn, enFn: PatternFn): Pattern {
  const marks = Array.from({ length: idFn.length }, (_, i) => `\u0000${i}\u0000`);
  const sample = idFn(...marks);
  const order: number[] = [];
  let source = "";
  let last = 0;
  for (const m of sample.matchAll(/\u0000(\d+)\u0000/g)) {
    source += escapeRe(sample.slice(last, m.index)) + "([\\s\\S]+?)";
    order.push(Number(m[1]));
    last = (m.index ?? 0) + m[0].length;
  }
  source += escapeRe(sample.slice(last));
  return { re: new RegExp(`^${source}$`), order, en: enFn };
}

function patterns(): Pattern[] {
  if (!patternList) {
    const idP = rustId.patterns as unknown as Record<string, PatternFn>;
    const enP = rustEn.patterns as unknown as Record<string, PatternFn>;
    patternList = Object.keys(idP).map((key) => buildPattern(idP[key], enP[key]));
  }
  return patternList;
}

// Pesan Rust bahasa Indonesia ke bahasa Inggris. null kalau tidak dikenal.
export function translateRustMessage(message: string): string | null {
  const exact = messages().get(message);
  if (exact !== undefined) return exact;
  for (const p of patterns()) {
    const m = p.re.exec(message);
    if (!m) continue;
    const args: string[] = [];
    p.order.forEach((argIndex, i) => {
      const part = m[i + 1];
      // Bagian yang juga pesan Rust (misalnya alasan alamat ditolak) ikut diterjemahkan.
      args[argIndex] = messages().get(part) ?? part;
    });
    return p.en(...args);
  }
  return null;
}

// Kalimat Inggris umum untuk sebuah kode error.
export function englishForCode(code: string): string {
  const byCode = en.byCode as Record<string, string>;
  return Object.prototype.hasOwnProperty.call(byCode, code) ? byCode[code] : en.generic;
}

// Dipakai di call() setiap modul src/api untuk error dari inti Rust.
export function localizeError(err: AppError): AppError {
  if (getLang() === "id" || BUILT_IN_UI.has(err.code)) return err;
  const message = translateRustMessage(err.message) ?? englishForCode(err.code);
  return { code: err.code, message };
}

// Jumlah pesan statis dan pola yang dipetakan (untuk tes dan laporan).
export function mappedCounts(): { messages: number; patterns: number } {
  return { messages: messages().size, patterns: patterns().length };
}
