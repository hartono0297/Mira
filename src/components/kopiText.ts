// Pembantu kecil fitur Kopi yang dipakai beberapa layar (profil, chat, board,
// papan Organisasi).
import type { KopiTier } from "../api/kopi";
import { KOPI_TEXT } from "../i18n/kopi";

const RANK: Record<KopiTier, number> = { anak_baru: 0, andalan: 1, senior: 2, legenda: 3 };

// Nama tingkatan dalam bahasa aktif.
export function kopiTierName(tier: KopiTier): string {
  return KOPI_TEXT.tier[tier] ?? tier;
}

// Urutan tingkatan, 0 sampai 3. Dipakai untuk jumlah garis di ikon.
export function kopiTierRank(tier: KopiTier): number {
  return RANK[tier] ?? 0;
}

// Tanggal lokal hari ini YYYY-MM-DD, untuk target profil.
export function kopiToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Jumlah karakter seperti chars() di Rust (titik kode, bukan unit UTF-16).
export function kopiReasonLength(reason: string): number {
  return [...reason.trim()].length;
}
