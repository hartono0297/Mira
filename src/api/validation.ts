// Validasi cepat di tampilan. Aturan yang sama dicek ulang di Rust.

function length(value: string): number {
  return [...value].length;
}

export function validateDisplayName(raw: string): string | null {
  const name = raw.trim();
  if (length(name) === 0) return "Isi nama tampilan dulu.";
  if (length(name) > 50) return "Nama tampilan paling banyak 50 karakter.";
  return null;
}

export function validateOrgName(raw: string): string | null {
  const name = raw.trim();
  if (length(name) === 0) return "Isi nama organisasi dulu.";
  if (length(name) < 2) return "Nama organisasi minimal 2 karakter.";
  if (length(name) > 80) return "Nama organisasi paling banyak 80 karakter.";
  return null;
}

export function validateTeamName(raw: string): string | null {
  const name = raw.trim();
  if (length(name) === 0) return "Isi nama tim dulu.";
  if (length(name) < 2) return "Nama tim minimal 2 karakter.";
  if (length(name) > 60) return "Nama tim paling banyak 60 karakter.";
  return null;
}

// Nama departemen saat menyiapkan kantor baru. Inti Rust menerima 2 sampai 60
// karakter (validate_team_name); di sini paling banyak 50.
export function validateDepartmentName(raw: string): string | null {
  const name = raw.trim();
  if (length(name) === 0) return "Isi nama departemen dulu.";
  if (length(name) < 2) return "Nama departemen minimal 2 karakter.";
  if (length(name) > 50) return "Nama departemen paling banyak 50 karakter.";
  return null;
}
