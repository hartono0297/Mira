import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error tanpa paket @types/node (lihat vite.config.ts)
import { readdirSync, readFileSync } from "node:fs";
// @ts-expect-error tanpa paket @types/node
import process from "node:process";
import { NO_TAURI_ERROR, toAppError, type AppError, type AppErrorCode } from "../api";
import { setLang } from "./core";
import rustId from "./errors-rust.id";
import en from "./errors.en";
import id from "./errors.id";
import { englishForCode, localizeError, mappedCounts, translateRustMessage } from "./errors";

afterEach(() => setLang("id"));

// Semua kode di AppErrorCode. Tipe Record memaksa daftar ini lengkap.
const APP_CODES: Record<AppErrorCode, true> = {
  invalid_name: true,
  name_required: true,
  org_exists: true,
  keystore: true,
  key_mismatch: true,
  database: true,
  internal: true,
  invalid_setting: true,
  forbidden: true,
  not_found: true,
  invite_invalid: true,
  invite_not_found: true,
  invite_expired: true,
  invite_used: true,
  invite_revoked: true,
  no_peer_found: true,
  peer_unreachable: true,
  already_in_org: true,
  removed: true,
  last_superadmin: true,
  invalid_address: true,
  network: true,
  no_tauri: true,
  unknown: true,
};

describe("localizeError", () => {
  it("bahasa Indonesia: error dari Rust dikembalikan apa adanya", () => {
    setLang("id");
    const err: AppError = { code: "invite_expired", message: "Pesan apa pun dari Rust." };
    expect(localizeError(err)).toBe(err);
  });

  it("pesan statis yang dikenal menjadi bahasa Inggris, kodenya tetap", () => {
    setLang("en");
    const out = localizeError({
      code: "invite_expired",
      message: "Kode undangan ini sudah kedaluwarsa. Minta kode baru ke admin departemen.",
    });
    expect(out).toEqual({
      code: "invite_expired",
      message: "This invite code has expired. Ask a department admin for a new one.",
    });
    expect(
      localizeError({ code: "forbidden", message: "Tamu tidak bisa membuat channel." }),
    ).toEqual({ code: "forbidden", message: "Guests can't create channels." });
  });

  it("pesan berargumen dicocokkan lewat pola", () => {
    setLang("en");
    expect(
      localizeError({ code: "pin_wrong", message: "PIN salah. Sisa 2 kali lagi sebelum dikunci sementara." }).message,
    ).toBe("Wrong PIN. 2 more tries before it's locked for a while.");
    expect(
      localizeError({ code: "pin_wrong", message: "PIN salah. Sisa 1 kali lagi sebelum dikunci sementara." }).message,
    ).toBe("Wrong PIN. 1 more try before it's locked for a while.");
    // Angka menit dipertahankan: src/screens/sign/pad/pin.ts membacanya dari pesan.
    expect(
      localizeError({ code: "pin_locked", message: "Terlalu banyak PIN salah. Coba lagi dalam sekitar 5 menit." }).message,
    ).toBe("Too many wrong PINs. Your signature is locked. Try again in about 5 minutes.");
    expect(
      localizeError({
        code: "pin_wrong",
        message: "PIN salah. Tanda tangan dikunci sementara, coba lagi dalam sekitar 1 menit.",
      }).message,
    ).toBe("Wrong PIN. Your signature is locked for a while. Try again in about 1 minute.");
    expect(
      localizeError({ code: "invalid_input", message: 'Kode PA sudah dipakai proyek "Atap Gedung". Pilih kode lain.' })
        .message,
    ).toBe('Code PA is already used by the project "Atap Gedung". Choose another code.');
    // Bagian depan pesan alamat juga pesan Rust, ikut diterjemahkan.
    expect(
      translateRustMessage(
        "Alamat tidak dikenali. Tulis alamat IP laptop rekan, misalnya 192.168.1.10 atau 192.168.1.10:47800, atau tempel tautan mira://peer dari laptop rekan.",
      ),
    ).toMatch(/^Address not recognized\. Enter the colleague's laptop IP address/);
  });

  it("pesan yang tidak dikenal memakai kalimat umum per kode", () => {
    setLang("en");
    expect(localizeError({ code: "network", message: "Pesan baru yang belum ada di tabel." })).toEqual({
      code: "network",
      message: en.byCode.network,
    });
    expect(localizeError({ code: "pin_locked", message: "Pesan lain." }).message).toBe(en.byCode.pin_locked);
  });

  it("kode yang tidak dikenal mendapat kalimat umum, kodenya tetap", () => {
    setLang("en");
    expect(localizeError({ code: "kode_baru", message: "Sesuatu gagal." })).toEqual({
      code: "kode_baru",
      message: "Something went wrong. Try again.",
    });
  });

  it("error buatan tampilan tidak diubah", () => {
    setLang("en");
    const unknown = toAppError(new Error("boom"));
    expect(unknown).toEqual({ code: "unknown", message: "Something unexpected went wrong: boom" });
    expect(localizeError(unknown)).toBe(unknown);
    expect(localizeError(NO_TAURI_ERROR)).toBe(NO_TAURI_ERROR);
  });

  it("NO_TAURI_ERROR dan toAppError mengikuti bahasa aktif", () => {
    setLang("id");
    expect(NO_TAURI_ERROR.message).toBe(
      "Halaman ini dibuka di browser biasa, jadi tidak bisa membaca data Mira di laptop ini.",
    );
    expect(toAppError("x").message).toBe("Terjadi kesalahan yang tidak dikenali: x");
    expect(toAppError(null).message).toBe("Terjadi kesalahan yang tidak dikenali.");
    setLang("en");
    expect(NO_TAURI_ERROR.message).toBe(en.byCode.no_tauri);
    expect(toAppError(null).message).toBe("Something unexpected went wrong.");
  });
});

describe("kamus error", () => {
  it("setiap kode AppErrorCode punya kalimat umum di kedua bahasa", () => {
    for (const code of Object.keys(APP_CODES)) {
      expect(Object.keys(id.byCode), code).toContain(code);
      expect(englishForCode(code)).not.toBe(en.generic);
    }
  });

  it("pesan Indonesia di tabel unik", () => {
    const all: string[] = [];
    for (const group of Object.values(rustId.messages)) all.push(...Object.values(group));
    expect(new Set(all).size).toBe(all.length);
    expect(mappedCounts().messages).toBe(all.length);
  });

  it("setiap pola cocok dengan pesan contohnya sendiri", () => {
    const patterns = rustId.patterns as unknown as Record<string, (...a: string[]) => string>;
    for (const [key, fn] of Object.entries(patterns)) {
      const args = Array.from({ length: fn.length }, (_, i) => `Nilai${i + 1}`);
      expect(translateRustMessage(fn(...args)), key).not.toBeNull();
    }
  });

  // Pesan di Rust berubah: tabel harus ikut diperbarui, kalau tidak pesan
  // barunya hanya mendapat kalimat umum di bahasa Inggris.
  it("setiap pesan di tabel masih ada di sumber Rust", () => {
    const root = `${process.cwd()}/src-tauri/src`;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }) as { name: string; isDirectory(): boolean }[]) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".rs")) files.push(path);
      }
    };
    walk(root);
    // Gabungkan sambungan baris "\" di string Rust dan buka escape tanda kutip.
    const source = files
      .map((f) => readFileSync(f, "utf8") as string)
      .join("\n")
      .replace(/\\\r?\n\s*/g, "")
      .replace(/\\"/g, '"');
    const missing: string[] = [];
    for (const group of Object.values(rustId.messages)) {
      for (const text of Object.values(group)) if (!source.includes(text)) missing.push(text);
    }
    const patterns = rustId.patterns as unknown as Record<string, (...a: string[]) => string>;
    for (const [key, fn] of Object.entries(patterns)) {
      const mark = "\u0000";
      const pieces = fn(...Array.from({ length: fn.length }, () => mark)).split(mark);
      for (const piece of pieces) if (piece.length > 3 && !source.includes(piece)) missing.push(`${key}: ${piece}`);
    }
    expect(missing).toEqual([]);
  });
});
