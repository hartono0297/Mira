import { IconLoader2 } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import { joinApi, type FoundOffice, type JoinDevice } from "../../api/join";
import { DeviceFacts } from "./DeviceFacts";
import { StepHeading } from "./StepHeading";
import { SEARCH_GRACE } from "./texts";

// Lama pencarian dan jeda antarputaran (kontrak 8.1: mendengarkan 15 detik).
export const SEARCH_MS = 15_000;
export const ROUND_GAP_MS = 1_500;
// Setelah kantor pertama menjawab, pencarian berlanjut sebentar supaya kantor
// lain di jaringan yang sama sempat menjawab juga. Tanpa ini, satu kantor yang
// menjawab duluan langsung terpilih otomatis.
export const GRACE_MS = 3_000;

// Cara pencarian berakhir tanpa kantor yang bisa dipilih.
export type SearchEnd =
  // 15 detik habis. ok = paling sedikit satu putaran berhasil dijalankan.
  | { kind: "timeout"; orgSeen: boolean; ok: boolean; error: AppError | null }
  // mDNS mati atau gagal: pencarian otomatis tidak bisa jalan.
  | { kind: "mdns"; orgSeen: boolean; error: string | null }
  // Pengguna menekan Batal sebelum ada kantor yang menjawab.
  | { kind: "cancelled"; orgSeen: boolean }
  // Kantor ditemukan, tapi pengguna memilih cara lain.
  | { kind: "other" };

type Props = {
  device: JoinDevice | null;
  deviceError: boolean;
  onFound: (offices: FoundOffice[]) => void;
  onEnd: (end: SearchEnd) => void;
};

// (a) Mencari kantor. joinApi.search() dipanggil berulang, tidak pernah
// tumpang tindih, sampai GRACE_MS setelah kantor pertama ditemukan atau 15
// detik habis. Tiap putaran mengembalikan daftar lengkap dari Rust, jadi
// daftar tidak kosong yang terakhir yang dipakai.
export function SearchStep({ device, deviceError, onFound, onEnd }: Props) {
  const handlers = useRef({ onFound, onEnd });
  handlers.current = { onFound, onEnd };
  const stopRef = useRef<() => void>(() => {});
  const [grace, setGrace] = useState(false);

  useEffect(() => {
    let done = false;
    let inflight = false;
    let timeUp = false;
    let orgSeen = false;
    let ok = false;
    let lastError: AppError | null = null;
    let gap: number | undefined;
    let graceTimer: number | undefined;
    let graceOver = false;
    let found: FoundOffice[] = [];

    function finish(next: () => void) {
      if (done) return;
      done = true;
      window.clearTimeout(gap);
      window.clearTimeout(limit);
      window.clearTimeout(graceTimer);
      next();
    }

    // Akhir pencarian: kantor yang sudah ditemukan menang atas batas waktu.
    function settle() {
      if (found.length > 0) {
        const offices = found;
        finish(() => handlers.current.onFound(offices));
      } else {
        finish(() => handlers.current.onEnd({ kind: "timeout", orgSeen, ok, error: lastError }));
      }
    }

    const limit = window.setTimeout(() => {
      timeUp = true;
      if (!inflight) settle();
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
            if (found.length === 0) {
              setGrace(true);
              graceTimer = window.setTimeout(() => {
                graceOver = true;
                if (!inflight) settle();
              }, GRACE_MS);
            }
            // Putaran kosong sesudahnya tidak menghapus daftar ini.
            found = offices;
          } else if (found.length === 0 && result.mdnsOk === false) {
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
      if (timeUp || graceOver) {
        settle();
      } else {
        gap = window.setTimeout(() => void round(), ROUND_GAP_MS);
      }
    }

    // Batal saat masa tunggu: kantor yang sudah menjawab tetap dipakai.
    stopRef.current = () => {
      if (found.length > 0) settle();
      else finish(() => handlers.current.onEnd({ kind: "cancelled", orgSeen }));
    };
    void round();
    return () => {
      done = true;
      window.clearTimeout(gap);
      window.clearTimeout(limit);
      window.clearTimeout(graceTimer);
    };
  }, []);

  return (
    <div className="onb-form">
      <StepHeading>Mencari kantor di jaringan...</StepHeading>
      <p className="onb-lead">Mira mencari kantor yang memakai Mira di Wi-Fi atau LAN yang sedang dipakai laptop ini.</p>

      <div className="onb-search" role="status">
        <IconLoader2 size={28} className="onb-spin" aria-hidden="true" />
        {grace ? (
          <div>
            <strong>{SEARCH_GRACE.title}</strong>
            <p className="hint">{SEARCH_GRACE.hint}</p>
          </div>
        ) : (
          <div>
            <strong>Mencari</strong>
            <p className="hint">Pencarian berhenti sendiri setelah 15 detik.</p>
          </div>
        )}
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
