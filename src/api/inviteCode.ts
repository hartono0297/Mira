// Pemeriksaan cepat kode undangan di tampilan (docs/plans/tahap-1.md 1.3).
// Inti Rust tetap yang memutuskan; ini hanya supaya salah ketik terlihat
// sebelum Mira mencari laptop rekan.
import { API_TEXT } from "../i18n/api";

export const INVITE_CODE_LENGTH = 20;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// Huruf besar, buang spasi dan tanda "-", baca I dan L sebagai 1, O sebagai 0.
// Karakter lain dibiarkan supaya bisa dilaporkan.
export function cleanInviteInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s\-‐-―]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

export function formatInviteCode(clean: string): string {
  const groups: string[] = [];
  for (let i = 0; i < clean.length; i += 4) groups.push(clean.slice(i, i + 4));
  return groups.join("-");
}

export type InviteCheck = { ok: true; code: string } | { ok: false; error: string };

export function checkInviteCode(raw: string): InviteCheck {
  const clean = cleanInviteInput(raw);
  if (clean.length === 0) return { ok: false, error: API_TEXT.inviteCode.empty };
  const bad = [...clean].find((ch) => !ALPHABET.includes(ch));
  if (bad !== undefined) {
    return { ok: false, error: API_TEXT.inviteCode.badChar(bad) };
  }
  if (clean.length !== INVITE_CODE_LENGTH) {
    return { ok: false, error: API_TEXT.inviteCode.wrongLength(INVITE_CODE_LENGTH, clean.length) };
  }
  return { ok: true, code: formatInviteCode(clean) };
}
