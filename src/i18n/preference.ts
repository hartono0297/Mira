// Menyimpan pilihan bahasa per laptop. Sumber kebenaran: pengaturan lokal di
// inti Rust (kunci app.language), sama seperti mode tema. Salinan di
// localStorage hanya supaya frame pertama sudah memakai bahasa yang benar.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, isTauri, toAppError, type AppError } from "../api";
import { DEFAULT_LANG, getLang, parseLang, setLang, useLang, type Lang } from "./core";

export const LANG_SETTING_KEY = "app.language";
export const LANG_CACHE_KEY = "mira.lang";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readCachedLang(storage: StorageLike | null = defaultStorage()): Lang {
  try {
    return parseLang(storage?.getItem(LANG_CACHE_KEY) ?? DEFAULT_LANG);
  } catch {
    return DEFAULT_LANG;
  }
}

export function writeCachedLang(lang: Lang, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(LANG_CACHE_KEY, lang);
  } catch {
    // Storage diblokir: hanya frame pertama yang mungkin memakai bahasa bawaan.
  }
}

// Dipanggil di main.tsx sebelum render pertama.
export function bootLang(): void {
  setLang(readCachedLang());
}

let userChose = false;

// Membaca pilihan tersimpan dari inti Rust sekali saat aplikasi dibuka.
export async function loadStoredLang(): Promise<void> {
  if (!isTauri()) return;
  try {
    const stored = await api.getSetting(LANG_SETTING_KEY);
    if (userChose) return;
    const lang = parseLang(stored ?? DEFAULT_LANG);
    writeCachedLang(lang);
    setLang(lang);
  } catch {
    // Tetap memakai salinan lokal; memilih bahasa lagi akan mencoba menyimpan.
  }
}

export type LangSaveError = { error: AppError; kept: Lang };

// Penyimpanan app.language berurutan untuk seluruh aplikasi, supaya tulisan tiba
// di inti Rust sesuai urutan klik. Tanpa ini, klik cepat id -> en -> id bisa
// berakhir dengan "en" tersimpan sementara layar memakai "id".
let saveQueue: Promise<unknown> = Promise.resolve();

function queueSave(lang: Lang): Promise<unknown> {
  const save = saveQueue.then(() => api.setSetting(LANG_SETTING_KEY, lang));
  saveQueue = save.catch(() => undefined);
  return save;
}

// Untuk pemilih bahasa: ganti langsung berlaku, lalu disimpan ke inti Rust.
// Kalau gagal tersimpan, bahasa dikembalikan ke pilihan terakhir yang tersimpan.
export function useLanguageChoice() {
  const lang = useLang();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<LangSaveError | null>(null);
  const confirmed = useRef<Lang>(getLang());
  const latest = useRef(0);

  useEffect(() => {
    if (!saving && !error) confirmed.current = lang;
  }, [lang, saving, error]);

  const choose = useCallback(async (next: Lang) => {
    if (next === getLang()) return;
    userChose = true;
    const id = ++latest.current;
    setError(null);
    setLang(next);
    writeCachedLang(next);
    if (!isTauri()) return;
    setSaving(true);
    try {
      await queueSave(next);
      // Antrean berurutan: yang berhasil terakhir adalah isi inti Rust sekarang,
      // walaupun sudah ada pilihan yang lebih baru di belakangnya.
      confirmed.current = next;
    } catch (err) {
      if (id === latest.current) {
        const kept = confirmed.current;
        setLang(kept);
        writeCachedLang(kept);
        setError({ error: toAppError(err), kept });
      }
    } finally {
      if (id === latest.current) setSaving(false);
    }
  }, []);

  return { lang, choose, saving, error };
}
