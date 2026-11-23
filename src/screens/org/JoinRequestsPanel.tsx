import { IconCheck, IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import { formatDateTime, relativeTime } from "../../api/format";
import { orgApi, type JoinRequestView } from "../../api/org";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { initials } from "../../components/initials";
import type { OrgPage } from "./context";
import { useOrgLive } from "./useOrgLive";
import "./requests.css";

const NOT_RECORDED = "Tidak tercatat";

function systemText(r: JoinRequestView): string {
  const parts = [r.os.trim(), r.appVersion.trim() ? `Mira ${r.appVersion.trim()}` : ""].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : NOT_RECORDED;
}

// Penolakan beruntun untuk satu alamat IP (kontrak 8.6). Daftarnya diambil saat
// dialog dibuka, supaya muat ulang di tengah jalan tidak mengubah yang ditolak.
type Bulk = {
  ip: string;
  items: JoinRequestView[];
  // Urutan permintaan yang sedang ditolak (mulai 0), null kalau belum berjalan.
  current: number | null;
  error: { title: string; error: AppError; note: string } | null;
};

export function JoinRequestsPanel({ page }: { page: OrgPage }) {
  const live = useOrgLive(() => orgApi.joinRequests(), { version: page.version });
  const requests = useMemo(() => (Array.isArray(live.data) ? live.data : null), [live.data]);
  const [rejecting, setRejecting] = useState<JoinRequestView | null>(null);
  const [bulk, setBulk] = useState<Bulk | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const perIp = useMemo(() => {
    const map = new Map<string, JoinRequestView[]>();
    for (const r of requests ?? []) {
      if (!r.ip) continue;
      map.set(r.ip, [...(map.get(r.ip) ?? []), r]);
    }
    return map;
  }, [requests]);

  const running = bulk?.current != null;
  const busy = page.pending !== null || running;
  const scoped = !page.overview.isSuperadmin;

  async function rejectOne(r: JoinRequestView) {
    await page.act(
      `reject:${r.id}`,
      () => orgApi.rejectJoin(r.id),
      `Permintaan ${r.displayName} ditolak. Kalau keliru, ${r.displayName} bisa mengirim permintaan baru.`,
      "Permintaan belum ditolak",
    );
    if (alive.current) setRejecting(null);
  }

  async function rejectAll(target: Bulk) {
    const { ip, items } = target;
    let done = 0;
    let skipped = 0;
    for (let i = 0; i < items.length; i++) {
      if (!alive.current) return;
      setBulk({ ...target, current: i, error: null });
      try {
        await orgApi.rejectJoin(items[i].id);
        done++;
      } catch (err) {
        const error = toAppError(err);
        if (error.code === "join_already_decided") {
          skipped++;
          continue;
        }
        if (!alive.current) return;
        const parts = [`Sudah ditolak sebelum berhenti: ${done} dari ${items.length}.`];
        if (skipped > 0) parts.push(`${skipped} sudah diputuskan orang lain lebih dulu.`);
        parts.push(`Yang tersisa di bawah ini bisa ditolak lagi.`);
        setBulk({
          ip,
          items: items.slice(i),
          current: null,
          error: { title: `Gagal menolak permintaan ${items[i].displayName}`, error, note: parts.join(" ") },
        });
        page.refresh();
        return;
      }
    }
    if (!alive.current) return;
    setBulk(null);
    page.refresh();
    const skippedText = skipped > 0 ? ` ${skipped} lainnya sudah diputuskan orang lain lebih dulu.` : "";
    page.notify(
      done > 0
        ? `${done} permintaan dari ${ip} ditolak.${skippedText}`
        : `Semua permintaan dari ${ip} sudah diputuskan orang lain lebih dulu.`,
    );
  }

  const intro = (
    <div>
      <h2 id="requests-title" className="set-title">
        Permintaan bergabung
      </h2>
      <p className="hint">
        Laptop baru di jaringan kantor yang memilih organisasi ini muncul di sini.
        {scoped && " Anda hanya melihat permintaan ke departemen Anda."}
      </p>
    </div>
  );

  if (!requests) {
    return (
      <section className="set-section" aria-labelledby="requests-title">
        {intro}
        {live.loading ? (
          <p className="hint" role="status">
            Memuat permintaan bergabung...
          </p>
        ) : (
          <div role="alert">
            <ErrorAlert title="Permintaan bergabung belum terbaca">
              <p>{live.error?.message ?? "Inti Mira tidak mengirim daftar permintaan."}</p>
              <button type="button" className="btn btn-ghost req-retry" onClick={() => void live.reload()}>
                Coba lagi
              </button>
            </ErrorAlert>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="set-section" aria-labelledby="requests-title">
      {intro}
      {live.error && (
        <p className="hint">Daftar terbaru belum bisa dibaca ({live.error.message}). Yang tampil adalah data terakhir.</p>
      )}

      {requests.length === 0 ? (
        <div className="org-empty">
          <p>
            <strong>Tidak ada permintaan yang menunggu.</strong>
          </p>
          <p className="req-empty-text">
            Permintaan muncul di sini saat laptop baru di jaringan kantor memilih organisasi ini
            {scoped ? " dan departemen Anda" : ""}. Orang yang tidak bisa menemukan kantor tetap bisa bergabung dengan
            kode dari tab Undangan.
          </p>
        </div>
      ) : (
        <ul className="req-list">
          {requests.map((r) => {
            const sameIp = r.ip ? (perIp.get(r.ip) ?? []) : [];
            const approving = page.pending === `approve:${r.id}`;
            return (
              <li key={r.id} className="req">
                <div className="req-head">
                  <div className="req-who">
                    <span className="req-av" aria-hidden="true">
                      {initials(r.displayName)}
                    </span>
                    <div className="req-who-text">
                      <h3 className="req-name">
                        {r.displayName}
                      </h3>
                      <p className="hint">
                        Minta bergabung{" "}
                        <time dateTime={r.requestedAt} title={formatDateTime(r.requestedAt)}>
                          {relativeTime(r.requestedAt)}
                        </time>
                      </p>
                    </div>
                  </div>
                  <div className="req-actions">
                    <button
                      type="button"
                      className="btn btn-ghost req-reject"
                      disabled={busy}
                      aria-label={`Tolak permintaan ${r.displayName}`}
                      onClick={() => setRejecting(r)}
                    >
                      <IconX size={16} aria-hidden="true" />
                      Tolak
                    </button>
                    <button
                      type="button"
                      className="btn req-approve"
                      disabled={busy}
                      aria-busy={approving || undefined}
                      aria-label={approving ? undefined : `Setujui permintaan ${r.displayName}`}
                      onClick={() =>
                        void page.act(
                          `approve:${r.id}`,
                          () => orgApi.approveJoin(r.id),
                          `${r.displayName} disetujui dan masuk departemen ${r.teamName}.`,
                          "Permintaan belum disetujui",
                        )
                      }
                    >
                      <IconCheck size={16} aria-hidden="true" />
                      {approving ? "Menyetujui..." : "Setujui"}
                    </button>
                  </div>
                </div>

                <dl className="req-facts">
                  <div>
                    <dt>Departemen</dt>
                    <dd>{r.teamName}</dd>
                  </div>
                  <div>
                    <dt>Laptop</dt>
                    <dd className={r.laptop.trim() ? "mono" : undefined}>{r.laptop.trim() || NOT_RECORDED}</dd>
                  </div>
                  <div>
                    <dt>Alamat IP</dt>
                    <dd className={r.ip ? "mono" : undefined}>{r.ip ?? NOT_RECORDED}</dd>
                  </div>
                  <div>
                    <dt>Sistem</dt>
                    <dd>{systemText(r)}</dd>
                  </div>
                </dl>

                <div className="req-match">
                  <div className="req-code-box">
                    <span className="req-code-label">Kode cocok</span>
                    <span className="req-code mono">{r.code}</span>
                  </div>
                  <p className="req-match-text">
                    Cocokkan dengan layar di laptop {r.displayName} sebelum menyetujui, lewat telepon atau datang ke
                    mejanya.
                  </p>
                </div>

                {(r.seenByName || sameIp.length >= 2) && (
                  <div className="req-foot">
                    {r.seenByName && <p className="hint">Diterima lewat laptop {r.seenByName}</p>}
                    {r.ip && sameIp.length >= 2 && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm req-reject-all"
                        disabled={busy}
                        onClick={() => setBulk({ ip: r.ip as string, items: sameIp, current: null, error: null })}
                      >
                        Tolak semua dari {r.ip} ({sameIp.length})
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={rejecting !== null}
        onOpenChange={(open) => {
          if (!open) setRejecting(null);
        }}
        title={rejecting ? `Tolak permintaan ${rejecting.displayName}?` : "Tolak permintaan"}
        confirmLabel={rejecting ? `Tolak ${rejecting.displayName}` : "Tolak"}
        busyLabel="Menolak..."
        busy={rejecting !== null && page.pending === `reject:${rejecting.id}`}
        onConfirm={() => {
          if (rejecting) void rejectOne(rejecting);
        }}
      >
        {rejecting && (
          <p>
            Permintaan yang ditolak tidak bisa disetujui lagi. Kalau ternyata keliru, {rejecting.displayName} bisa
            mengirim permintaan baru dari laptopnya, dengan kode cocok yang baru.
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={bulk !== null}
        onOpenChange={(open) => {
          if (!open) setBulk(null);
        }}
        title={bulk ? `Tolak ${bulk.items.length} permintaan dari ${bulk.ip}?` : "Tolak semua permintaan"}
        confirmLabel={bulk ? `Tolak ${bulk.items.length} permintaan` : "Tolak"}
        busyLabel={bulk?.current != null ? `Menolak ${bulk.current + 1} dari ${bulk.items.length}...` : "Menolak..."}
        busy={running}
        onConfirm={() => {
          if (bulk && !running) void rejectAll(bulk);
        }}
        error={
          bulk?.error && (
            <ErrorAlert title={bulk.error.title}>
              <p>{bulk.error.error.message}</p>
              <p>{bulk.error.note}</p>
            </ErrorAlert>
          )
        }
      >
        {bulk && (
          <>
            <p>Permintaan berikut dikirim dari alamat yang sama:</p>
            <ul className="req-dlg-list">
              {bulk.items.map((r) => (
                <li key={r.id}>
                  {r.displayName} <span className="hint">({r.teamName})</span>
                </li>
              ))}
            </ul>
            <p>
              Pakai ini kalau ada yang membanjiri kantor dengan permintaan palsu. Permintaan yang ditolak tidak bisa
              disetujui lagi; orang yang memang berhak bisa mengirim permintaan baru.
            </p>
          </>
        )}
      </ConfirmDialog>
    </section>
  );
}
