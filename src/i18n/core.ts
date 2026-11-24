// Inti pilihan bahasa Mira (v0.4): bahasa Indonesia (bawaan) dan Inggris.
//
// Cara pakai singkat (rinciannya di docs/plans/v04-english.md):
// - Kamus per modul ada di src/i18n/<modul>.id.ts dan <modul>.en.ts. Berkas .id
//   adalah sumber kebenaran; berkas .en bertipe Dict<typeof id>, jadi kunci yang
//   hilang atau tanda tangan fungsi yang berbeda langsung gagal di tsc.
// - defineText(id, en) memberi objek yang selalu membaca bahasa aktif saat
//   propertinya dibaca. Kode lama seperti MENU.reply tetap jalan tanpa diubah.
// - Saat bahasa berganti, akar aplikasi (main.tsx) render ulang, sehingga semua
//   komponen ikut render ulang. Nilai yang di-memo (useMemo, useCallback, state
//   awal) harus memasukkan useLang() ke dependensinya.
import { useSyncExternalStore } from "react";

export type Lang = "id" | "en";

export const LANGS: readonly Lang[] = ["id", "en"];
export const DEFAULT_LANG: Lang = "id";

// Nama bahasa selalu ditulis dalam bahasanya sendiri, supaya orang yang salah
// pilih tetap bisa menemukan jalan kembali.
export const LANG_NAMES: Record<Lang, string> = {
  id: "Bahasa Indonesia",
  en: "English",
};

let current: Lang = DEFAULT_LANG;
const listeners = new Set<() => void>();

export function parseLang(value: unknown): Lang {
  return value === "en" || value === "id" ? value : DEFAULT_LANG;
}

export function getLang(): Lang {
  return current;
}

export function setLang(next: Lang): void {
  if (next === current) return;
  current = next;
  if (typeof document !== "undefined") document.documentElement.lang = next;
  for (const fn of [...listeners]) fn();
}

export function subscribeLang(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// Bahasa aktif sebagai state React: komponen yang memakainya render ulang saat
// bahasa berganti.
export function useLang(): Lang {
  return useSyncExternalStore(subscribeLang, getLang, getLang);
}

// Locale untuk Intl. Bahasa Inggris memakai en-GB: tanggal ditulis hari dulu
// lalu bulan (24 November 2026) dan jam 24 jam, sama dengan kebiasaan kantor.
export function locale(lang: Lang = current): string {
  return lang === "en" ? "en-GB" : "id-ID";
}

// Jamak bahasa Inggris. Bahasa Indonesia tidak membedakan, jadi kamus .id cukup
// menulis kalimatnya langsung.
export function plural(n: number, one: string, other: string): string {
  return n === 1 ? one : other;
}

// Tipe kamus terjemahan: bentuk sama dengan kamus .id, string boleh berbeda,
// fungsi harus punya parameter yang sama.
export type Dict<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => R
  : T extends string
    ? string
    : T extends readonly (infer U)[]
      ? readonly Dict<U>[]
      : T extends object
        ? { readonly [K in keyof T]: Dict<T[K]> }
        : T;

function isPlainObject(v: unknown): v is object {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function view(pick: () => object, target: object): object {
  const nested = new Map<PropertyKey, object>();
  const read = (key: PropertyKey): unknown => {
    const value = Reflect.get(pick(), key);
    if (!isPlainObject(value)) return value;
    let child = nested.get(key);
    if (!child) {
      child = view(() => Reflect.get(pick(), key) as object, value);
      nested.set(key, child);
    }
    return child;
  };
  return new Proxy(target, {
    get(_t, key) {
      return read(key);
    },
    has(_t, key) {
      return Reflect.has(pick(), key);
    },
    ownKeys() {
      return Reflect.ownKeys(pick());
    },
    getOwnPropertyDescriptor(_t, key) {
      const d = Reflect.getOwnPropertyDescriptor(pick(), key);
      return d ? { value: read(key), writable: false, enumerable: d.enumerable, configurable: true } : undefined;
    },
    set() {
      return false;
    },
  });
}

// Objek teks yang mengikuti bahasa aktif. Bentuknya sama dengan kamus .id.
export function defineText<T extends object>(id: T, en: Dict<T>): Dict<T> {
  const byLang: Record<Lang, object> = { id, en: en as object };
  return view(() => byLang[current], id) as Dict<T>;
}

// Kamus mentah untuk bahasa tertentu, misalnya di tes.
export function pickText<T extends object>(id: T, en: Dict<T>, lang: Lang = current): Dict<T> {
  return (lang === "en" ? en : id) as Dict<T>;
}
