// Validasi cepat di tampilan. Aturan yang sama dicek ulang di Rust.
import { API_TEXT } from "../i18n/api";

function length(value: string): number {
  return [...value].length;
}

export function validateDisplayName(raw: string): string | null {
  const name = raw.trim();
  const t = API_TEXT.validation;
  if (length(name) === 0) return t.displayNameEmpty;
  if (length(name) > 50) return t.displayNameMax(50);
  return null;
}

export function validateOrgName(raw: string): string | null {
  const name = raw.trim();
  const t = API_TEXT.validation;
  if (length(name) === 0) return t.orgNameEmpty;
  if (length(name) < 2) return t.orgNameMin(2);
  if (length(name) > 80) return t.orgNameMax(80);
  return null;
}

export function validateTeamName(raw: string): string | null {
  const name = raw.trim();
  const t = API_TEXT.validation;
  if (length(name) === 0) return t.teamNameEmpty;
  if (length(name) < 2) return t.teamNameMin(2);
  if (length(name) > 60) return t.teamNameMax(60);
  return null;
}

// Nama departemen saat menyiapkan kantor baru. Inti Rust menerima 2 sampai 60
// karakter (validate_team_name); di sini paling banyak 50.
export function validateDepartmentName(raw: string): string | null {
  const name = raw.trim();
  const t = API_TEXT.validation;
  if (length(name) === 0) return t.teamNameEmpty;
  if (length(name) < 2) return t.teamNameMin(2);
  if (length(name) > 50) return t.teamNameMax(50);
  return null;
}
