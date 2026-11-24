import { IconPlugConnectedX, IconRefresh } from "@tabler/icons-react";
import { useId } from "react";
import type { NetState, PeerView } from "../../api";
import { relativeTime } from "../../api/format";
import { NET_STATE_TEXT, OFFLINE_HINT } from "../../api/messages";
import { SHELL_TEXT } from "../../i18n/shell";
import { useNetwork, validStatus } from "./NetworkContext";
import { NetworkDot, STATE_ICON } from "./NetworkDot";

export function sortPeers(peers: PeerView[]): PeerView[] {
  const byName = (a: PeerView, b: PeerView) => a.displayName.localeCompare(b.displayName, "id");
  return [...peers.filter((p) => p.online).sort(byName), ...peers.filter((p) => !p.online).sort(byName)];
}

function routeHint(peer: PeerView): string | null {
  if (peer.route === "vpn") return SHELL_TEXT.net.viaVpn;
  if (peer.route === "local") return SHELL_TEXT.net.local;
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

// compact: sidebar ringkas, panel diganti satu ikon status (NetworkDot).
export function NetworkPanel({ onOpenOrg, compact = false }: { onOpenOrg: () => void; compact?: boolean }) {
  if (compact) return <NetworkDot onOpenOrg={onOpenOrg} />;
  return <NetworkList onOpenOrg={onOpenOrg} />;
}

function NetworkList({ onOpenOrg }: { onOpenOrg: () => void }) {
  const { data, error, loading, reload } = useNetwork();
  const status = validStatus(data);
  const listTitle = useId();
  const T = SHELL_TEXT.net;

  return (
    <section className="side-net" aria-label={T.region}>
      <div role="status" aria-live="polite" className="side-net-status">
        {loading && !status && <p className="net-loading">{T.checking}</p>}
        {!loading && !status && (
          <div className="net-state net-bad">
            <IconPlugConnectedX size={18} aria-hidden="true" />
            <div>
              <p className="net-state-text">{T.unreadable}</p>
              {error && <p className="net-state-hint">{error.message}</p>}
            </div>
          </div>
        )}
        {status && status.state !== "no_org" && <NetStateLine state={status.state} compact />}
        {status && error && <p className="net-state-hint">{T.stale}</p>}
      </div>
      {!loading && (!status || error) && (
        <button type="button" className="side-retry" onClick={() => void reload()}>
          <IconRefresh size={14} aria-hidden="true" />
          {T.retry}
        </button>
      )}

      {status && status.state !== "no_org" && (
        <>
          <h2 id={listTitle} className="side-lbl">
            {T.onNetwork}
          </h2>
          {status.peers.length === 0 ? (
            <p className="side-empty">
              {T.emptyBefore}{" "}
              <button type="button" className="link-btn" onClick={onOpenOrg}>
                {SHELL_TEXT.nav.org}
              </button>
              {T.emptyAfter}
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
                        <span className="sr-only">{peer.online ? T.online : T.offline}</span>
                      </span>
                      {hint && <span className="peer-sub">{hint}</span>}
                      {!peer.online && (
                        <span className="peer-sub">
                          {peer.lastSeenAt ? T.lastSeen(relativeTime(peer.lastSeenAt)) : T.neverSeen}
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
