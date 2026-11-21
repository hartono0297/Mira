// Token warna per peran. Layar hanya memakai var(--peran), tidak pernah kode
// warna langsung. Tema baru (Kertas, Panel) cukup ditambah sebagai objek baru.

export const TOKEN_ROLES = [
  "bg", // latar utama
  "side", // sidebar
  "side-text",
  "side-sec",
  "text", // teks utama
  "text-sec", // teks pendukung
  "border", // garis pemisah
  "border-strong", // garis kolom isian dan tombol sekunder (lolos 3:1)
  "hover", // latar baris menu saat disorot kursor
  "card", // kartu dan kolom isian
  "col", // kolom board
  "accent", // tombol aksi, pilihan aktif
  "on-accent", // teks di atas tombol aksi
  "accent-soft", // sorotan aksi, menu aktif
  "accent-text", // teks di atas sorotan aksi
  "state", // teks status "menunggu Anda"
  "online",
  "focus", // cincin fokus keyboard
  "danger", // teks dan ikon error
  "danger-soft", // latar kotak error
  "danger-border",
] as const;

export type TokenRole = (typeof TOKEN_ROLES)[number];
export type TokenSet = Record<TokenRole, string>;
export type ThemeName = "bata";
export type ResolvedTheme = "light" | "dark";

export type ThemeDef = {
  id: ThemeName;
  label: string;
  description: string;
  light: TokenSet;
  dark: TokenSet;
};

// Nilai dari design/tema-c.html (.c-light dan .c-dark). Peran danger dan
// hover tidak ada di tema-c; dipilih sendiri dan dicek kontrasnya (AA).
const bata: ThemeDef = {
  id: "bata",
  label: "Bata",
  description: "hangat dan lapang",
  light: {
    bg: "#FFFFFF",
    side: "#FFF4EE",
    "side-text": "#2A1F1A",
    "side-sec": "#6E5F57",
    text: "#2A1F1A",
    "text-sec": "#6E5F57",
    border: "#F0DDD2",
    "border-strong": "#A88A7C",
    hover: "#F7E6DC",
    card: "#FFF9F6",
    col: "#FFF4EE",
    accent: "#B4472A",
    "on-accent": "#FFFFFF",
    "accent-soft": "#FBE3D8",
    "accent-text": "#A8401F",
    state: "#A8401F",
    online: "#3B7A4F",
    focus: "#B4472A",
    danger: "#A3221B",
    "danger-soft": "#FDEDEB",
    "danger-border": "#D9827A",
  },
  dark: {
    bg: "#1E1714",
    side: "#261D19",
    "side-text": "#F5EAE4",
    "side-sec": "#C2B0A6",
    text: "#F5EAE4",
    "text-sec": "#C2B0A6",
    border: "#3E302A",
    "border-strong": "#8F766A",
    hover: "#33271F",
    card: "#2A201C",
    col: "#261D19",
    accent: "#F08A64",
    "on-accent": "#2A1F1A",
    "accent-soft": "#4A2A1E",
    "accent-text": "#FFB59A",
    state: "#FF9E7A",
    online: "#6CC48A",
    focus: "#F08A64",
    danger: "#FF9A8F",
    "danger-soft": "#3A1F1B",
    "danger-border": "#A8574E",
  },
};

export const themes: Record<ThemeName, ThemeDef> = { bata };

export const DEFAULT_THEME: ThemeName = "bata";

export function parseThemeName(value: unknown): ThemeName {
  return typeof value === "string" && value in themes ? (value as ThemeName) : DEFAULT_THEME;
}

// Tema yang direncanakan (design/arah-tampilan.html arah A dan B). Belum
// bisa dipilih; hanya contoh warna untuk daftar "Nanti" di Pengaturan.
export const plannedThemes = [
  { id: "kertas", label: "Kertas", description: "tenang, seperti dokumen", swatches: ["#1F6B52", "#F1EDE4", "#23211C"] },
  { id: "panel", label: "Panel", description: "padat, untuk kerja cepat", swatches: ["#D9A23A", "#1C2321", "#FFFFFF"] },
] as const;

function block(selector: string, tokens: TokenSet): string {
  const body = TOKEN_ROLES.map((role) => `--${role}:${tokens[role]};`).join("");
  return `${selector}{${body}}`;
}

export function themeCss(theme: ThemeDef): string {
  return block(':root[data-theme="light"]', theme.light) + block(':root[data-theme="dark"]', theme.dark);
}
