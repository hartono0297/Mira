import { useState } from "react";
import { toAppError, type AppError } from "../../api";
import type { DeptOverview } from "../../api/division";
import type { OrgPage } from "./context";

// Yang dibagi ke setiap bagian tab Departemen saya.
export type DeptCtx = {
  page: OrgPage;
  ov: DeptOverview;
  // Ada aksi yang sedang berjalan di halaman: semua tombol aksi menunggu.
  busy: boolean;
  // Op divisi dan pengaturan chat boleh ditulis: gerbang versi terbuka dan
  // departemen tidak diarsipkan. Rust tetap memeriksa ulang.
  canWrite: boolean;
  // Penjelasan di dekat tombol yang nonaktif karena gerbang versi tertutup; null kalau terbuka.
  gateHint: string | null;
  onOpenChat?: (conv: string) => void;
};

// Panjang dihitung per karakter seperti `chars().count()` di Rust, bukan per unit UTF-16.
export function charCount(text: string): number {
  return [...text].length;
}

// Aturan nama divisi sama dengan nama departemen (`is_canonical_team_name`).
export function validDivisionName(name: string): boolean {
  const n = charCount(name.trim());
  return n >= 2 && n <= 60 && ![...name].some(isControl);
}

function isControl(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return c < 0x20 || c === 0x7f;
}

// Aksi dari dialog konfirmasi: dialog tetap terbuka dengan label sibuk selama berjalan,
// dan error tampil di dalamnya, seperti dialog Arsipkan di tab Departemen.
export function useConfirmAction(page: OrgPage) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  async function run(task: () => Promise<unknown>, ok: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await task();
      page.notify(ok);
      page.refresh();
      return true;
    } catch (err) {
      const appErr = toAppError(err);
      setError(appErr);
      if (appErr.code === "not_found" || appErr.code === "forbidden") page.refresh();
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, run, clear: () => setError(null) };
}
