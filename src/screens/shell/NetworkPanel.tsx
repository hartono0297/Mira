import {
  IconBan,
  IconPlugConnected,
  IconPlugConnectedX,
  IconRefresh,
  IconSearch,
  IconUsers,
  type Icon,
} from "@tabler/icons-react";
import { useId } from "react";
import type { NetState, PeerView } from "../../api";
import { relativeTime } from "../../api/format";
import { NET_STATE_TEXT, OFFLINE_HINT } from "../../api/messages";
import { useNetwork, validStatus } from "./NetworkContext";

const STATE_ICON: Record<NetState, { icon: Icon; tone: "ok" | "bad" | "plain" }> = {
  starting: { icon: IconSearch, tone: "plain" },
  no_org: { icon: IconUsers, tone: "plain" },
  alone: { icon: IconUsers, tone: "plain" },
  lan: { icon: IconPlugConnected, tone: "ok" },
  vpn: { icon: IconPlugConnected, tone: "ok" },
  offline: { icon: IconPlugConnectedX, tone: "bad" },
  removed: { icon: IconBan, tone: "bad" },
};

export function sortPeers(peers: PeerView[]): PeerView[] {
  const byName = (a: PeerView, b: PeerView) => a.displayName.localeCompare(b.displayName, "id");
  return [...peers.filter((p) => p.online).sort(byName), ...peers.filter((p) => !p.online).sort(byName)];
}

function routeHint(peer: PeerView): string | null {
  if (peer.route === "vpn") return "lewat VPN";
  if (peer.route === "local") return "di komputer ini";
  return null;
}

// Status koneksi (F-NET-05). Dipakai di sidebar dan di Pengaturan > Jaringan.
export function NetStateLine({ state, compact = false }: { state: NetState; compact?: boolean }) {
  const { icon: StateIcon, tone } = STATE_ICON[state];
  return (
    <div className={`net-state net-${tone}${compact ? " net-compact" : ""}`}>
      <StateIcon size={18} aria-hidden="true" />
      <div>
        <p className="net-state-text">{NET_STATE_TEXT[state]}</p>
        {state === "offline" && <p className="net-state-hint">{OFFLINE_HINT}</p>}
      </div>
    </div>
  );
}

export function NetworkPanel({ onOpenOrg }: { onOpenOrg: () => void }) {
  const { data, error, loading, reload } = useNetwork();
  const status = validStatus(data);
  const listTitle = useId();

  return (
    <section className="side-net" aria-label="Jaringan kantor">
      <div role="status" aria-live="polite" className="side-net-status">
        {loading && !status && <p className="net-loading">Memeriksa jaringan...</p>}
        {!loading && !status && (
          <div className="net-state net-bad">
            <IconPlugConnectedX size={18} aria-hidden="true" />
            <div>
              <p className="net-state-text">Status jaringan belum terbaca</p>
              {error && <p className="net-state-hint">{error.message}</p>}
            </div>
          </div>
        )}
        {status && status.state !== "no_org" && <NetStateLine state={status.state} compact />}
        {status && error && <p className="net-state-hint">Belum bisa diperbarui. Yang tampil adalah status terakhir.</p>}
      </div>
      {!loading && (!status || error) && (
        <button type="button" className="side-retry" onClick={() => void reload()}>
          <IconRefresh size={14} aria-hidden="true" />
          Coba baca lagi
        </button>
      )}

      {status && status.state !== "no_org" && (
        <>
          <h2 id={listTitle} className="side-lbl">
            Di jaringan
          </h2>
          {status.peers.length === 0 ? (
            <p className="side-empty">
              Belum ada rekan di organisasi. Undang lewat menu{" "}
              <button type="button" className="link-btn" onClick={onOpenOrg}>
                Organisasi
              </button>
              .
            </p>
          ) : (
            <ul className="peer-list" aria-labelledby={listTitle}>
              {sortPeers(status.peers).map((peer) => {
                const hint = peer.online ? routeHint(peer) : null;
                return (
                  <li key={peer.publicKey} className={peer.online ? "peer peer-on" : "peer peer-off"}>
                    <span className="peer-dot" aria-hidden="true" />
                    <span className="peer-text">
                      <span className="peer-name">
                        {peer.displayName}
                        <span className="sr-only">{peer.online ? ", online" : ", offline"}</span>
                      </span>
                      {hint && <span className="peer-sub">{hint}</span>}
                      {!peer.online && (
                        <span className="peer-sub">
                          {peer.lastSeenAt ? `Terakhir terlihat ${relativeTime(peer.lastSeenAt)}` : "Belum pernah terlihat"}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
