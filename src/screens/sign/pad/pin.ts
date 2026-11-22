// Aturan PIN tanda tangan, sama dengan inti Rust (signing/pin.rs): 6 sampai 12 angka.

export const PIN_MIN = 6;
export const PIN_MAX = 12;

// Pesan error bahasa Indonesia, atau null kalau PIN sah.
export function validatePin(pin: string, emptyMessage = "Masukkan PIN Anda."): string | null {
  if (pin.length === 0) return emptyMessage;
  if (!/^[0-9]+$/.test(pin)) return "PIN hanya boleh berisi angka 0 sampai 9.";
  if (pin.length < PIN_MIN || pin.length > PIN_MAX) return `PIN harus ${PIN_MIN} sampai ${PIN_MAX} angka.`;
  return null;
}

// Perkiraan lama kunci dari pesan pin_locked ("... sekitar 5 menit ...").
// Kalau tidak ada angka menit di pesan, dianggap 1 menit (kunci terpendek).
export function lockMinutesFromMessage(message: string): number {
  const m = /(\d+)\s*menit/i.exec(message);
  const n = m ? Number(m[1]) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}
