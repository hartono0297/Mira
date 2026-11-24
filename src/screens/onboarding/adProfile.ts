// Data akun domain (Active Directory) di layar onboarding: pembanding domain,
// penguraian DN untuk lokasi OU, dan alasan data AD tidak ikut permintaan.
// Inti Rust tetap penentu akhir (join_send_request dengan useAd).
import type { AdDeptSuggestion, FoundOffice, LocalAd } from "../../api/join";

function normDomain(s: string): string {
  return s.trim().toLowerCase().replace(/\.$/, "");
}

// Dua domain sama tanpa beda huruf besar dan titik di akhir.
export function sameDomain(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = normDomain(a);
  return x !== "" && x === normDomain(b);
}

// Domain yang boleh diisi admin IT: huruf, angka, dan tanda strip per bagian,
// paling sedikit dua bagian (sama dengan normalize_domain di Rust).
const LABEL = /^[a-z0-9-]{1,63}$/;

export function normalizeAdDomain(input: string): string | null {
  const d = normDomain(input);
  if (d === "" || d.length > 253) return null;
  const labels = d.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  return d;
}

// Pecah teks di karakter pemisah yang tidak di-escape. Escape tetap utuh.
function splitUnescaped(s: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      cur += c + s[i + 1];
      i++;
    } else if (c === sep) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}

const HEX2 = /^[0-9a-fA-F]{2}$/;

// Nilai RDN tanpa escape (RFC 4514): \, \+ \\ dan \2C. Byte hex berurutan
// dibaca sebagai UTF-8, misalnya \C3\A9 menjadi é.
function unescapeValue(v: string): string {
  let out = "";
  let bytes: number[] = [];
  const flush = () => {
    if (bytes.length) {
      out += new TextDecoder().decode(new Uint8Array(bytes));
      bytes = [];
    }
  };
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === "\\" && i + 1 < v.length) {
      const hex = v.slice(i + 1, i + 3);
      if (HEX2.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
      flush();
      out += v[i + 1];
      i++;
      continue;
    }
    flush();
    out += c;
  }
  flush();
  return out.trim();
}

// OU dari DN, paling dalam dulu (urutan DN). DN yang tidak terbaca: daftar kosong.
export function dnOus(dn: string | null | undefined): string[] {
  if (!dn) return [];
  const ous: string[] = [];
  for (const rdn of splitUnescaped(dn, ",")) {
    for (const ava of splitUnescaped(rdn, "+")) {
      const eq = ava.indexOf("=");
      if (eq <= 0) continue;
      if (ava.slice(0, eq).trim().toUpperCase() !== "OU") continue;
      const value = unescapeValue(ava.slice(eq + 1));
      if (value) ous.push(value);
    }
  }
  return ous;
}

// Lokasi di AD untuk dibaca orang: dari yang paling luar ke paling dalam.
export function ouPath(dn: string | null | undefined): string | null {
  const ous = dnOus(dn);
  return ous.length ? [...ous].reverse().join(" › ") : null;
}

export type AdSkipReason = "noDomain" | "otherDomain" | "outdated" | "noUser";

// none: tidak ada profil AD atau belum ada kantor terpilih (tidak ada teks AD).
// use: data AD ikut permintaan. skip: ada profil, tapi tidak ikut, dengan alasannya.
export type AdUse = { kind: "none" } | { kind: "use" } | { kind: "skip"; reason: AdSkipReason };

export function adUse(ad: LocalAd | null, office: FoundOffice | null): AdUse {
  if (!ad || !office) return { kind: "none" };
  if (!office.adDomain) return { kind: "skip", reason: "noDomain" };
  if (!sameDomain(office.adDomain, ad.domain)) return { kind: "skip", reason: "otherDomain" };
  if (office.acceptsAd !== true) return { kind: "skip", reason: "outdated" };
  if (!ad.user?.trim()) return { kind: "skip", reason: "noUser" };
  return { kind: "use" };
}

// Profil dari inti Rust dianggap ada hanya kalau domainnya terisi.
export function asLocalAd(value: unknown): LocalAd | null {
  if (typeof value !== "object" || value === null) return null;
  const ad = value as LocalAd;
  return typeof ad.domain === "string" && ad.domain.trim() !== "" ? ad : null;
}

export function asSuggestion(value: unknown): AdDeptSuggestion | null {
  if (typeof value !== "object" || value === null) return null;
  return typeof (value as AdDeptSuggestion).inMira === "boolean" ? (value as AdDeptSuggestion) : null;
}
