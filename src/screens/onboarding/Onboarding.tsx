import { useEffect, useRef, useState } from "react";
import type { AppState, IdentityInfo, OrgInfo } from "../../api";
import { joinApi, type FoundOffice, type JoinDevice, type OutgoingJoinRequest } from "../../api/join";
import { FirewallGuide } from "../../components/FirewallGuide";
import { Logo } from "../../components/Logo";
import { firewallName } from "../../platform";
import { JoinStep } from "./JoinStep";
import { NewOfficeStep } from "./NewOfficeStep";
import { NotFoundStep } from "./NotFoundStep";
import { OfficeStep } from "./OfficeStep";
import { SearchStep, type SearchEnd } from "./SearchStep";
import { StepHeading } from "./StepHeading";
import { RejectedStep, WaitingStep } from "./WaitingStep";
import "./onboarding.css";

type Props = {
  state: AppState;
  onIdentity: (identity: IdentityInfo) => void;
  onOrganization: (org: OrgInfo) => void;
  onReload: () => void;
};

// Alur v0.3 (mockup usulan-v0.3 bagian 1): firewall, (a) cari, (b) kantor
// ditemukan, (c) menunggu persetujuan. Cadangan: (d) cara lain, (e) kantor baru.
type View =
  | { kind: "resume" }
  // invite: dibuka dari kode undangan; lanjutnya kembali ke sana, bukan mencari.
  | { kind: "firewall"; invite: SearchEnd | null }
  | { kind: "search"; round: number }
  | { kind: "offices"; offices: FoundOffice[]; round: number }
  | { kind: "waiting"; request: OutgoingJoinRequest }
  | { kind: "rejected"; request: OutgoingJoinRequest }
  | { kind: "other"; end: SearchEnd }
  | { kind: "invite"; end: SearchEnd }
  | { kind: "new-office"; end: SearchEnd };

function stepLabel(view: View): string | null {
  switch (view.kind) {
    case "firewall":
      return "Langkah 1 dari 3";
    case "search":
    case "offices":
      return "Langkah 2 dari 3";
    case "waiting":
      return "Langkah 3 dari 3";
    default:
      return null;
  }
}

function isRequest(value: unknown): value is OutgoingJoinRequest {
  return typeof value === "object" && value !== null && typeof (value as OutgoingJoinRequest).requestId === "string";
}

export function Onboarding({ state, onIdentity, onOrganization, onReload }: Props) {
  const [view, setView] = useState<View>({ kind: "resume" });
  const [device, setDevice] = useState<JoinDevice | null>(null);
  const [deviceError, setDeviceError] = useState(false);
  // Pernah ada kantor atau pengumuman organisasi di sesi ini. Setelah itu,
  // pilihan "kantor baru" tidak pernah ditampilkan lagi.
  const [officeSeen, setOfficeSeen] = useState(false);
  // Kunci per putaran, supaya "Cari lagi" memasang layar baru dan judulnya mendapat fokus.
  const rounds = useRef(0);

  useEffect(() => {
    let alive = true;
    joinApi
      .outgoing()
      .then((request) => {
        if (!alive) return;
        if (isRequest(request)) {
          setView({ kind: request.status === "rejected" ? "rejected" : "waiting", request });
        } else {
          setView({ kind: "firewall", invite: null });
        }
      })
      .catch(() => {
        // Permintaan lama tidak terbaca: mulai dari awal. Kirim permintaan baru menggantikannya.
        if (alive) setView({ kind: "firewall", invite: null });
      });
    joinApi
      .device()
      .then((d) => {
        if (!alive) return;
        if (d && typeof d === "object") setDevice(d);
        else setDeviceError(true);
      })
      .catch(() => {
        if (alive) setDeviceError(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  function search() {
    rounds.current += 1;
    setView({ kind: "search", round: rounds.current });
  }

  function showOffices(offices: FoundOffice[]) {
    setOfficeSeen(true);
    rounds.current += 1;
    setView({ kind: "offices", offices, round: rounds.current });
  }

  function searchEnded(end: SearchEnd) {
    if ((end.kind === "timeout" || end.kind === "mdns") && end.orgSeen) setOfficeSeen(true);
    setView({ kind: "other", end });
  }

  // Kantor baru hanya setelah pencarian yang benar-benar berjalan selesai tanpa
  // kantor dan tanpa pengumuman organisasi, dan belum pernah ada kantor di sesi ini.
  function newOfficeAllowed(end: SearchEnd): boolean {
    if (officeSeen) return false;
    if (end.kind === "timeout") return end.ok && !end.orgSeen;
    if (end.kind === "mdns") return !end.orgSeen;
    return false;
  }

  const label = stepLabel(view);

  return (
    <div className="onb">
      <div className="onb-col">
        <div className="onb-brand">
          <Logo size={32} />
          <span>Mira</span>
        </div>
        <main className="onb-card">
          {label && <p className="onb-step">{label}</p>}
          {view.kind === "resume" && (
            <p className="hint" role="status">
              Memeriksa permintaan bergabung yang tersimpan...
            </p>
          )}
          {view.kind === "firewall" && (
            <FirewallStep
              lead={
                view.invite
                  ? `Kode undangan diperiksa oleh laptop rekan lewat jaringan kantor. Pastikan ${firewallName()} mengizinkan Mira.`
                  : `Mira mencari kantor Anda lewat jaringan, dan laptop rekan perlu bisa menyambung ke laptop ini. Untuk itu, ${firewallName()} perlu mengizinkan Mira.`
              }
              continueLabel={view.invite ? "Kembali ke kode undangan" : "Cari kantor"}
              onContinue={() => (view.invite ? setView({ kind: "invite", end: view.invite }) : search())}
            />
          )}
          {view.kind === "search" && (
            <SearchStep
              key={view.round}
              device={device}
              deviceError={deviceError}
              onFound={showOffices}
              onEnd={searchEnded}
            />
          )}
          {view.kind === "offices" && (
            <OfficeStep
              key={view.round}
              offices={view.offices}
              identity={state.identity}
              onIdentity={onIdentity}
              onSent={(request) => setView({ kind: "waiting", request })}
              onOther={() => setView({ kind: "other", end: { kind: "other" } })}
            />
          )}
          {view.kind === "waiting" && (
            <WaitingStep
              key={view.request.requestId}
              request={view.request}
              device={device}
              onApproved={onOrganization}
              onRejected={(request) => setView({ kind: "rejected", request })}
              onGone={search}
            />
          )}
          {view.kind === "rejected" && (
            <RejectedStep
              request={view.request}
              onResent={(request) => setView({ kind: "waiting", request })}
              onSearch={search}
            />
          )}
          {view.kind === "other" && (
            <NotFoundStep
              end={view.end}
              showNewOffice={newOfficeAllowed(view.end)}
              onOffices={showOffices}
              onInvite={() => setView({ kind: "invite", end: view.end })}
              onSearchAgain={search}
              onNewOffice={() => setView({ kind: "new-office", end: view.end })}
            />
          )}
          {view.kind === "invite" && (
            <JoinStep
              identity={state.identity}
              onIdentity={onIdentity}
              onBack={() => setView({ kind: "other", end: view.end })}
              onFirewall={() => setView({ kind: "firewall", invite: view.end })}
              onJoined={onOrganization}
              onReload={onReload}
            />
          )}
          {view.kind === "new-office" && newOfficeAllowed(view.end) && (
            <NewOfficeStep
              identity={state.identity}
              onIdentity={onIdentity}
              onOrganization={onOrganization}
              onBack={() => setView({ kind: "other", end: view.end })}
              onReload={onReload}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function FirewallStep({
  lead,
  continueLabel,
  onContinue,
}: {
  lead: string;
  continueLabel: string;
  onContinue: () => void;
}) {
  return (
    <div className="onb-form">
      <StepHeading>Izinkan Mira di jaringan kantor</StepHeading>
      <p className="onb-lead">{lead}</p>
      <FirewallGuide
        footer={(status) => {
          const ready = status !== null && (status.rule === "allowed" || !status.supported);
          return (
            <div className="onb-actions">
              <button type="button" className={ready ? "btn" : "btn btn-ghost"} onClick={onContinue}>
                {ready ? continueLabel : "Lewati, atur nanti"}
              </button>
            </div>
          );
        }}
      />
    </div>
  );
}
