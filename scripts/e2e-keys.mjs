// Kunci laptop uji di Windows Credential Manager (device-key-<pk>.id.mira.desktop).
//
// Setiap instance uji membuat kunci laptop sendiri. Skrip e2e hanya boleh menghapus kunci
// laptop ujinya sendiri: bukan semua kunci baru yang muncul selama uji berjalan, karena itu
// juga menghapus kunci uji lain yang berjalan bersamaan, atau kunci Mira sungguhan yang
// dibuat di tengah uji. Kunci milik skrip dikenali dari mira.db di folder data instance uji
// (tabel identity) dan dari kunci publik yang dicatat skrip sendiri.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const TARGET = /device-key-[0-9a-f]{64}\.id\.mira\.desktop/g;

export const keyTarget = (publicKey) => `device-key-${publicKey.toLowerCase()}.id.mira.desktop`;

// Kunci publik dari nama target kredensial, atau null.
export function keyOfTarget(target) {
  const m = /^device-key-([0-9a-f]{64})\.id\.mira\.desktop$/.exec(target);
  return m ? m[1] : null;
}

// Semua target kredensial Mira yang ada sekarang.
export function miraCredentials() {
  try {
    const out = execFileSync("cmdkey", ["/list"], { encoding: "utf8" });
    return new Set(out.match(TARGET) ?? []);
  } catch {
    return new Set();
  }
}

let sqlite;
async function openDb(file) {
  if (!sqlite) {
    // node:sqlite masih eksperimental di Node 22: peringatannya tidak berguna di log uji.
    const emit = process.emitWarning;
    process.emitWarning = (w, ...rest) => {
      if (String(w?.message ?? w).includes("SQLite")) return;
      emit.call(process, w, ...rest);
    };
    try {
      sqlite = await import("node:sqlite");
    } finally {
      process.emitWarning = emit;
    }
  }
  return new sqlite.DatabaseSync(file, { readOnly: true });
}

// Kunci publik laptop di folder data `dir` (identity di mira.db), atau null kalau belum ada.
// Panggil setelah instance berhenti.
export async function identityKeyOf(dir) {
  const file = join(dir, "mira.db");
  if (!existsSync(file)) return null;
  try {
    const db = await openDb(file);
    try {
      const row = db.prepare("SELECT public_key FROM identity WHERE id = 1").get();
      return typeof row?.public_key === "string" ? row.public_key.toLowerCase() : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

// Menghapus kunci uji milik skrip ini: target yang belum ada sebelum uji (`before`) dan kunci
// publiknya ada di `keys` (kunci publik atau target) atau di mira.db salah satu `dirs`.
// Kunci baru lain dibiarkan dan disebut di log. Mengembalikan jumlah yang dihapus dan dibiarkan.
export async function deleteOwnKeys({ before, dirs = [], keys = [], log = console.log }) {
  const own = new Set();
  for (const k of keys) {
    const key = keyOfTarget(k) ?? (typeof k === "string" ? k.toLowerCase() : null);
    if (key) own.add(key);
  }
  for (const dir of dirs) {
    const key = await identityKeyOf(dir);
    if (key) own.add(key);
  }
  let deleted = 0;
  let kept = 0;
  for (const target of miraCredentials()) {
    if (before.has(target)) continue;
    if (!own.has(keyOfTarget(target))) {
      kept += 1;
      log(`Kredensial baru bukan milik uji ini, dibiarkan: ${target}`);
      continue;
    }
    try {
      execFileSync("cmdkey", [`/delete:${target}`], { stdio: "ignore" });
      deleted += 1;
    } catch {
      log(`Kunci uji tidak bisa dihapus: ${target}`);
    }
  }
  return { deleted, kept };
}
