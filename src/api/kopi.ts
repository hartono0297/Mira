// Kontrak frontend fitur Kopi (docs/plans/kopi.md, "Kontrak frontend").
// Command ada di src-tauri/src/kopi/commands.rs; bentuk JSON camelCase.
import { invoke } from "@tauri-apps/api/core";
import { isTauri, NO_TAURI_ERROR, toAppError } from ".";
import { localizeError } from "../i18n/errors";

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw NO_TAURI_ERROR;
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw localizeError(toAppError(err));
  }
}

export type KopiTier = "anak_baru" | "andalan" | "senior" | "legenda";

export type KopiTarget =
  | { kind: "message"; id: string }
  | { kind: "task"; project: string; task: string }
  | { kind: "profile"; day: string };

export type KopiPerson = { publicKey: string; name: string };

// Ringkasan per orang, untuk ikon kecil di samping nama.
export type KopiBadge = {
  publicKey: string;
  peer: number; // Kopi dari rekan (yang tidak disembunyikan)
  work: number; // Kopi dari kerja
  score: number; // peer * 3 + work
  tier: KopiTier;
};

export type KopiOverview = {
  enabled: boolean; // fitur Kopi untuk seluruh kantor
  boardEnabled: boolean; // papan bulanan di Organisasi
  isSuperadmin: boolean;
  canGive: boolean; // anggota (bukan Tamu) dan fitur menyala
  me: string;
  givenToday: number; // pemberian saya hari ini (hari lokal)
  dailyLimit: number; // 3
  reasonMax: number; // 120
  // Kunci target yang sudah saya beri: "message:<id>", "task:<proyek>:<task>",
  // "profile:<kunci penerima>:<YYYY-MM-DD>".
  givenTargets: string[];
  badges: KopiBadge[];
  tiers: { tier: KopiTier; minScore: number }[]; // urut naik
  peerWeight: number; // 3
  workWeight: number; // 1
};

export type KopiWorkWhy = "assigned" | "on_time";

export type KopiEntry =
  | {
      kind: "peer";
      id: string; // id record pemberian
      from: KopiPerson;
      target: KopiTarget;
      reason: string;
      at: string; // RFC 3339
      hidden: boolean; // hanya dikirim ke superadmin; orang lain tidak melihat entri tersembunyi
    }
  | {
      kind: "work";
      id: string; // "<proyek>:<task>"
      projectId: string;
      taskId: string;
      title: string | null; // null kalau proyek tidak terbaca di laptop ini
      projectName: string | null;
      why: KopiWorkWhy;
      at: string; // waktu selesai
    };

export type KopiProfile = {
  person: KopiPerson;
  peer: number;
  work: number;
  score: number;
  tier: KopiTier;
  next: { tier: KopiTier; minScore: number } | null;
  history: KopiEntry[]; // terbaru dulu, paling banyak 100
};

export type KopiBoardRow = {
  person: KopiPerson;
  peer: number;
  work: number;
  score: number;
  tier: KopiTier;
};

export type KopiBoard = {
  month: string; // "YYYY-MM"
  enabled: boolean; // fitur dan papan menyala
  rows: KopiBoardRow[]; // skor bulan itu, terbesar dulu, paling banyak 10, skor > 0
};

export type KopiGiveInput = {
  to: string;
  target: KopiTarget;
  reason: string;
};

// Offset zona waktu laptop dalam menit timur UTC (WIB = 420). Dipakai Rust
// untuk menulis `at` dan menentukan "hari ini".
export function localOffsetMinutes(now: Date = new Date()): number {
  return -now.getTimezoneOffset();
}

export const kopiApi = {
  overview: () => call<KopiOverview>("kopi_overview", { offsetMinutes: localOffsetMinutes() }),
  profile: (publicKey: string) => call<KopiProfile>("kopi_profile", { publicKey }),
  give: (input: KopiGiveInput) => call<void>("kopi_give", { input, offsetMinutes: localOffsetMinutes() }),
  hide: (recordId: string, hidden: boolean) => call<void>("kopi_hide", { recordId, hidden }),
  setSettings: (enabled: boolean, board: boolean) => call<void>("kopi_set_settings", { enabled, board }),
  board: (month: string) => call<KopiBoard>("kopi_board", { month, offsetMinutes: localOffsetMinutes() }),
};

// Kunci target, sama dengan Target::key di Rust.
export function kopiTargetKey(to: string, target: KopiTarget): string {
  switch (target.kind) {
    case "message":
      return `message:${target.id}`;
    case "task":
      return `task:${target.project}:${target.task}`;
    case "profile":
      return `profile:${to}:${target.day}`;
  }
}
