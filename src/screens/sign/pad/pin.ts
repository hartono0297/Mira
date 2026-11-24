// Aturan PIN tanda tangan, sama dengan inti Rust (signing/pin.rs): 6 sampai 12 angka.

import { SIGN_PAD_TEXT as T } from "../../../i18n/sign-pad";

export const PIN_MIN = 6;
export const PIN_MAX = 12;

// Pesan error dalam bahasa aktif, atau null kalau PIN sah.
export function validatePin(pin: string, emptyMessage: string = T.pin.empty): string | null {
  if (pin.length === 0) return emptyMessage;
  if (!/^[0-9]+$/.test(pin)) return T.pin.digitsOnly;
  if (pin.length < PIN_MIN || pin.length > PIN_MAX) return T.pin.length(PIN_MIN, PIN_MAX);
  return null;
}

// Perkiraan lama kunci dari pesan pin_locked ("... sekitar 5 menit ...").
// Pesan Inggris (peta kode error di api) dicocokkan juga ("5 minutes").
// Kalau tidak ada angka menit di pesan, dianggap 1 menit (kunci terpendek).
export function lockMinutesFromMessage(message: string): number {
  const m = /(\d+)\s*(?:menit|min)/i.exec(message);
  const n = m ? Number(m[1]) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}
