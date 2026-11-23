// Inti Rust tiruan untuk tes pembaruan: pengaturan tersimpan di objek biasa,
// perintah pembaruan bisa diganti per tes.
import type { Mock } from "vitest";

type Handler = (args: Record<string, unknown> | undefined) => unknown;

export type UpdateBackendOptions = {
  version?: string;
  configured?: boolean;
  settings?: Record<string, string>;
  commands?: Record<string, Handler>;
};

// Pengaturan "cek terakhir baru saja" supaya cek otomatis tidak ikut berjalan.
export const recentCheck = () => ({ "update.last_check": new Date().toISOString() });

export function updateBackend(invoke: Mock, opts: UpdateBackendOptions = {}) {
  const settings: Record<string, string> = { ...(opts.settings ?? {}) };
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (opts.commands && cmd in opts.commands) return opts.commands[cmd](args);
    switch (cmd) {
      case "update_info":
        return { currentVersion: opts.version ?? "0.3.0", configured: opts.configured ?? true };
      case "get_setting":
        return settings[String(args?.key)] ?? null;
      case "set_setting":
        settings[String(args?.key)] = String(args?.value);
        return null;
      default:
        return null;
    }
  });
  return settings;
}

export function rejectWith(code: string, message: string): Handler {
  return () => Promise.reject({ code, message });
}

// Janji yang diselesaikan dari dalam tes.
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
