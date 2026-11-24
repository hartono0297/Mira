import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, isTauri, toAppError, type AppError } from "../api";
import { updateCheck, updateDownload, updateInfo, updateInstall, type UpdateInfo } from "../api/updater";
import { useLang } from "../i18n/core";
import { notesFor } from "../whats-new";
import { hasUpdate, initialUpdateState, isBusy, updateReducer, type UpdateState } from "./updateState";
import { shouldShowWhatsNew } from "./version";

export const AUTO_CHECK_KEY = "update.auto_check";
export const LAST_CHECK_KEY = "update.last_check";
export const WHATS_NEW_KEY = "whats_new.seen";
// Cek otomatis paling sering sekali per 20 jam, supaya membuka Mira berkali-kali
// sehari tidak berkali-kali menghubungi GitHub.
export const AUTO_CHECK_INTERVAL_MS = 20 * 60 * 60 * 1000;

export type WhatsNew = {
  version: string | null;
  notes: string | null;
  open: boolean;
  show: () => void;
  close: () => void;
};

export type UpdateContextValue = {
  // null selama versi belum terbaca (atau di luar aplikasi desktop).
  currentVersion: string | null;
  configured: boolean;
  state: UpdateState;
  hasUpdate: boolean;
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  autoCheck: boolean;
  setAutoCheck: (on: boolean) => Promise<void>;
  autoCheckError: AppError | null;
  whatsNew: WhatsNew;
};

const noop = async () => {};

// Nilai bawaan tanpa provider: tidak ada pembaruan, semua aksi tidak melakukan apa pun.
const inert: UpdateContextValue = {
  currentVersion: null,
  configured: false,
  state: initialUpdateState,
  hasUpdate: false,
  check: noop,
  download: noop,
  install: noop,
  autoCheck: true,
  setAutoCheck: noop,
  autoCheckError: null,
  whatsNew: { version: null, notes: null, open: false, show: () => {}, close: () => {} },
};

const UpdateContext = createContext<UpdateContextValue>(inert);

export function useUpdates(): UpdateContextValue {
  return useContext(UpdateContext);
}

// Membaca satu pengaturan. Gagal dibaca dikembalikan sebagai undefined, beda dari kosong (null).
async function readSetting(key: string): Promise<string | null | undefined> {
  try {
    const value = await api.getSetting(key);
    return typeof value === "string" ? value : null;
  } catch {
    return undefined;
  }
}

function isValidInfo(value: unknown): value is UpdateInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as UpdateInfo).currentVersion === "string" &&
    typeof (value as UpdateInfo).configured === "boolean"
  );
}

function checkIsDue(last: string | null, now: number): boolean {
  if (!last) return true;
  const at = Date.parse(last);
  // Waktu yang tidak terbaca atau di masa depan (jam laptop pernah maju) dianggap sudah lama.
  if (Number.isNaN(at) || at > now) return true;
  return now - at >= AUTO_CHECK_INTERVAL_MS;
}

type Props = {
  children: ReactNode;
  // Untuk tes: jam yang bisa diatur.
  now?: () => number;
};

export function UpdateProvider({ children, now = Date.now }: Props) {
  const [state, dispatch] = useReducer(updateReducer, initialUpdateState);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [autoCheck, setAutoCheckState] = useState(true);
  const [autoCheckError, setAutoCheckError] = useState<AppError | null>(null);
  const [seen, setSeen] = useState<string | null>(null);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);

  const stateRef = useRef(state);
  stateRef.current = state;
  // Menahan klik ganda sebelum render berikutnya menandai tombol sibuk.
  const running = useRef(false);
  const started = useRef(false);
  const nowRef = useRef(now);
  nowRef.current = now;

  const currentVersion = info?.currentVersion ?? null;
  // Catatan dibaca ulang saat bahasa berganti (versi .en.md kalau ada), dan
  // notes ada di dependensi useMemo di bawah, jadi nilai konteks ikut berganti.
  const lang = useLang();
  const notes = notesFor(currentVersion, lang);

  useEffect(() => {
    if (started.current || !isTauri()) return;
    started.current = true;
    void (async () => {
      let loaded: unknown;
      try {
        loaded = await updateInfo();
      } catch {
        return;
      }
      if (!isValidInfo(loaded)) return;
      setInfo(loaded);

      const [auto, last, seenValue] = await Promise.all([
        readSetting(AUTO_CHECK_KEY),
        readSetting(LAST_CHECK_KEY),
        readSetting(WHATS_NEW_KEY),
      ]);
      setAutoCheckState(auto !== "off");

      // Kalau catatan yang sudah dilihat tidak terbaca, dialog tidak dipaksakan.
      if (seenValue !== undefined) {
        setSeen(seenValue);
        if (shouldShowWhatsNew(seenValue, loaded.currentVersion, notesFor(loaded.currentVersion) !== null)) {
          setWhatsNewOpen(true);
        }
      }

      if (!loaded.configured || auto === "off" || last === undefined) return;
      if (!checkIsDue(last, nowRef.current())) return;
      if (running.current) return;
      running.current = true;
      dispatch({ type: "checkStart" });
      try {
        const result = await updateCheck();
        dispatch({ type: "checkDone", result });
        await api.setSetting(LAST_CHECK_KEY, new Date(nowRef.current()).toISOString()).catch(() => {});
      } catch {
        // Cek otomatis diam saat gagal: tidak ada titik, tidak ada pesan.
        dispatch({ type: "silentFail" });
      } finally {
        running.current = false;
      }
    })();
  }, []);

  const check = useCallback(async () => {
    if (!isTauri() || running.current || isBusy(stateRef.current)) return;
    running.current = true;
    dispatch({ type: "checkStart" });
    try {
      dispatch({ type: "checkDone", result: await updateCheck() });
    } catch (err) {
      dispatch({ type: "failed", error: toAppError(err), during: "check" });
    } finally {
      running.current = false;
    }
  }, []);

  const download = useCallback(async () => {
    const s = stateRef.current;
    const version =
      s.status === "available" ? s.version : s.status === "error" && s.retry === "download" ? s.version : null;
    if (!isTauri() || running.current || !version) return;
    running.current = true;
    dispatch({ type: "downloadStart", version });
    try {
      const done = await updateDownload((p) => dispatch({ type: "progress", downloaded: p.downloaded, total: p.total }));
      dispatch({ type: "downloadDone", version: done?.version || version });
    } catch (err) {
      dispatch({ type: "failed", error: toAppError(err), during: "download" });
    } finally {
      running.current = false;
    }
  }, []);

  const install = useCallback(async () => {
    const s = stateRef.current;
    const canInstall = s.status === "ready" || (s.status === "error" && s.retry === "install");
    if (!isTauri() || running.current || !canInstall) return;
    running.current = true;
    dispatch({ type: "installStart" });
    try {
      // Biasanya tidak kembali: Mira ditutup lalu dibuka lagi oleh installer.
      await updateInstall();
    } catch (err) {
      dispatch({ type: "failed", error: toAppError(err), during: "install" });
    } finally {
      running.current = false;
    }
  }, []);

  const setAutoCheck = useCallback(
    async (on: boolean) => {
      if (!isTauri()) return;
      const before = autoCheck;
      setAutoCheckState(on);
      setAutoCheckError(null);
      try {
        await api.setSetting(AUTO_CHECK_KEY, on ? "on" : "off");
      } catch (err) {
        setAutoCheckState(before);
        setAutoCheckError(toAppError(err));
      }
    },
    [autoCheck],
  );

  const showWhatsNew = useCallback(() => {
    if (notes) setWhatsNewOpen(true);
  }, [notes]);

  const closeWhatsNew = useCallback(() => {
    setWhatsNewOpen(false);
    if (!currentVersion || !shouldShowWhatsNew(seen, currentVersion, true)) return;
    setSeen(currentVersion);
    // Kalau gagal tersimpan, dialog muncul lagi saat Mira dibuka berikutnya. Tidak perlu pesan.
    void api.setSetting(WHATS_NEW_KEY, currentVersion).catch(() => {});
  }, [currentVersion, seen]);

  const value = useMemo<UpdateContextValue>(
    () => ({
      currentVersion,
      configured: info?.configured ?? false,
      state,
      hasUpdate: hasUpdate(state),
      check,
      download,
      install,
      autoCheck,
      setAutoCheck,
      autoCheckError,
      whatsNew: { version: currentVersion, notes, open: whatsNewOpen, show: showWhatsNew, close: closeWhatsNew },
    }),
    [
      currentVersion,
      info,
      state,
      check,
      download,
      install,
      autoCheck,
      setAutoCheck,
      autoCheckError,
      notes,
      whatsNewOpen,
      showWhatsNew,
      closeWhatsNew,
    ],
  );

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

// Instal baru (layar onboarding): catat versi ini sebagai sudah dilihat, supaya
// pengguna baru tidak disambut dialog "Yang baru".
export function MarkWhatsNewSeen() {
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !isTauri()) return;
    started.current = true;
    void (async () => {
      try {
        const loaded: unknown = await updateInfo();
        if (!isValidInfo(loaded)) return;
        const seenValue = await api.getSetting(WHATS_NEW_KEY);
        if (!seenValue) await api.setSetting(WHATS_NEW_KEY, loaded.currentVersion);
      } catch {
        // Paling buruk dialog tampil sekali setelah onboarding. Tidak perlu pesan.
      }
    })();
  }, []);
  return null;
}
