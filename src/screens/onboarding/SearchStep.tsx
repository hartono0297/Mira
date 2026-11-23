import { IconLoader2 } from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import { toAppError, type AppError } from "../../api";
import { joinApi, type FoundOffice, type JoinDevice } from "../../api/join";
import { DeviceFacts } from "./DeviceFacts";
import { StepHeading } from "./StepHeading";

// Lama pencarian dan jeda antarputaran (kontrak 8.1: mendengarkan 15 detik).
export const SEARCH_MS = 15_000;
export const ROUND_GAP_MS = 1_500;

// Cara pencarian berakhir tanpa kantor yang bisa dipilih.
export type SearchEnd =
  // 15 detik habis. ok = paling sedikit satu putaran berhasil dijalankan.
  | { kind: "timeout"; orgSeen: boolean; ok: boolean; error: AppError | null }
  // mDNS mati atau gagal: pencarian otomatis tidak bisa jalan.
  | { kind: "mdns"; orgSeen: boolean; error: string | null }
  // Pengguna menekan Batal.
  | { kind: "cancelled" }
  // Kantor ditemukan, tapi pengguna memilih cara lain.
  | { kind: "other" };

type Props = {
  device: JoinDevice | null;
  deviceError: boolean;
  onFound: (offices: FoundOffice[]) => void;
  onEnd: (end: SearchEnd) => void;
};

// (a) Mencari kantor. joinApi.search() dipanggil berulang, tidak pernah
// tumpang tindih, sampai ada kantor atau 15 detik habis.
export function SearchStep({ device, deviceError, onFound, onEnd }: Props) {
  const handlers = useRef({ onFound, onEnd });
  handlers.current = { onFound, onEnd };
  const stopRef = useRef<() => void>(() => {});

  useEffect(() => {
    let done = false;
    let inflight = false;
    let timeUp = false;
    let orgSeen = false;
    let ok = false;
    let lastError: AppError | null = null;
    let gap: number | undefined;

    function finish(next: () => void) {
      if (done) return;
      done = true;
      window.clearTimeout(gap);
      window.clearTimeout(limit);
      next();
    }

    const limit = window.setTimeout(() => {
      timeUp = true;
      if (!inflight) finish(() => handlers.current.onEnd({ kind: "timeout", orgSeen, ok, error: lastError }));
    }, SEARCH_MS);

    async function round() {
      inflight = true;
      try {
        const result = await joinApi.search();
        if (done) return;
        if (result && typeof result === "object") {
          ok = true;
          lastError = null;
          orgSeen = orgSeen || result.orgSeen === true;
          const offices = Array.isArray(result.offices) ? result.offices : [];
          if (offices.length > 0) {
            finish(() => handlers.current.onFound(offices));
            return;
          }
          if (result.mdnsOk === false) {
            finish(() => handlers.current.onEnd({ kind: "mdns", orgSeen, error: result.mdnsError ?? null }));
            return;
          }
        }
      } catch (err) {
        if (done) return;
        lastError = toAppError(err);
      } finally {
        inflight = false;
      }
      if (timeUp) {
        finish(() => handlers.current.onEnd({ kind: "timeout", orgSeen, ok, error: lastError }));
      } else {
        gap = window.setTimeout(() => void round(), ROUND_GAP_MS);
      }
    }

    stopRef.current = () => finish(() => handlers.current.onEnd({ kind: "cancelled" }));
    void round();
    return () => {
      done = true;
      window.clearTimeout(gap);
      window.clearTimeout(limit);
    };
  }, []);

  return (
    <div className="onb-form">
      <StepHeading>Mencari kantor di jaringan...</StepHeading>
      <p className="onb-lead">Mira mencari organisasi Mira di Wi-Fi atau LAN yang sedang dipakai laptop ini.</p>

      <div className="onb-search" role="status">
        <IconLoader2 size={28} className="onb-spin" aria-hidden="true" />
        <div>
          <strong>Mencari</strong>
          <p className="hint">Pencarian berhenti sendiri setelah 15 detik.</p>
        </div>
      </div>

      <DeviceFacts device={device} error={deviceError} />

      <div className="onb-actions">
        <button type="button" className="btn btn-ghost" onClick={() => stopRef.current()}>
          Batal
        </button>
      </div>
    </div>
  );
}
