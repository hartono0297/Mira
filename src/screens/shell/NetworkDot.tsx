import { IconBan, IconPlugConnected, IconPlugConnectedX, IconSearch, IconUsers, type Icon } from "@tabler/icons-react";
import type { NetState } from "../../api";
import { NET_STATE_TEXT } from "../../api/messages";
import { SHELL_TEXT } from "../../i18n/shell";
import { useNetwork, validStatus } from "./NetworkContext";

export type NetTone = "ok" | "bad" | "plain";

export const STATE_ICON: Record<NetState, { icon: Icon; tone: NetTone }> = {
  starting: { icon: IconSearch, tone: "plain" },
  no_org: { icon: IconUsers, tone: "plain" },
  alone: { icon: IconUsers, tone: "plain" },
  lan: { icon: IconPlugConnected, tone: "ok" },
  vpn: { icon: IconPlugConnected, tone: "ok" },
  offline: { icon: IconPlugConnectedX, tone: "bad" },
  removed: { icon: IconBan, tone: "bad" },
};

// Status jaringan di sidebar ringkas: satu ikon berwarna (hijau tersambung,
// merah ada masalah, abu memeriksa). Bentuk ikonnya ikut berbeda, sama dengan
// panel lebar, jadi statusnya tidak dibedakan oleh warna saja. Klik membuka
// Organisasi, sama dengan tautan di panel lebar.
export function NetworkDot({ onOpenOrg }: { onOpenOrg: () => void }) {
  const { data, error, loading } = useNetwork();
  const status = validStatus(data);
  const T = SHELL_TEXT.net;

  let view: { icon: Icon; tone: NetTone; text: string };
  if (status) {
    const base = NET_STATE_TEXT[status.state];
    view = { ...STATE_ICON[status.state], text: error ? `${base}. ${T.stale}` : base };
  } else if (loading) {
    view = { icon: IconSearch, tone: "plain", text: T.checking };
  } else {
    view = { icon: IconPlugConnectedX, tone: "bad", text: T.unreadable };
  }
  const { icon: StateIcon, tone, text } = view;
  const label = T.dotLabel(text);

  return (
    <section className="side-net-dot" aria-label={T.region}>
      <button type="button" className={`side-dot side-dot-${tone}`} aria-label={label} data-tip={label} onClick={onOpenOrg}>
        <StateIcon size={20} aria-hidden="true" />
      </button>
      <p role="status" aria-live="polite" className="sr-only">
        {text}
      </p>
    </section>
  );
}
