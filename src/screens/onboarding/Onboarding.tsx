import { useEffect, useRef, useState } from "react";
import { api, type AppState, type IdentityInfo, type OrgInfo } from "../../api";
import { joinApi, type FoundOffice, type JoinDevice, type OutgoingJoinRequest } from "../../api/join";
import { FirewallGuide } from "../../components/FirewallGuide";
import { Logo } from "../../components/Logo";
import { firewallName } from "../../platform";
import { JoinStep } from "./JoinStep";
import { NameStep } from "./NameStep";
import { NewOfficeStep } from "./NewOfficeStep";
import { NotFoundStep } from "./NotFoundStep";
import { OfficeStep } from "./OfficeStep";
import { SearchStep, type SearchEnd } from "./SearchStep";
import { StepHeading } from "./StepHeading";
import { CHECKING_FIREWALL, FIREWALL_LEAD, STEP } from "./texts";
import { RejectedStep, WaitingStep } from "./WaitingStep";
import "./onboarding.css";

type Props = {
  state: AppState;
  onIdentity: (identity: IdentityInfo) => void;
  onOrganization: (org: OrgInfo) => void;
  onReload: () => void;
};

// Alur v0.4 (docs/plans/v04-onboarding.md): (1) nama, firewall kalau aturan
// Mira belum ada, (2) cari dan pilih kantor, (3) menunggu persetujuan.
// Cadangan: (d) cara lain, (e) kantor baru di bagian "Untuk admin IT".
type View =
  | { kind: "resume" }
  // back: kembali ke formulir kantor setelah nama diubah, bukan mencari ulang.
  | { kind: "name"; back: View | null }
  | { kind: "checking" }
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
    case "name":
      return STEP.name;
    case "firewall":
      return view.invite ? null : STEP.find;
    case "checking":
    case "search":
    case "offices":
      return STEP.find;
    case "waiting":
      return STEP.wait;
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
  // tombol "kantor baru" di bagian "Untuk admin IT" diganti penjelasan.
  const [officeSeen, setOfficeSeen] = useState(false);
  // Nama yang disimpan di langkah 1. state.identity baru berganti setelah
  // induknya memproses onIdentity, jadi layar ini memegang salinannya sendiri.
  const [savedName, setSavedName] = useState<string | null>(null);
  // Kunci per putaran, supaya "Cari lagi" memasang layar baru dan judulnya mendapat fokus.
  const rounds = useRef(0);
  // Mira dibuka dengan --siapkan-kantor. Disimpan sebagai janji, supaya langkah
  // nama tidak perlu menunggu jawabannya sebelum tampil.
  const setupMode = useRef<Promise<boolean>>(Promise.resolve(false));

  const identity: IdentityInfo = savedName === null ? state.identity : { ...state.identity, displayName: savedName };
  const displayName = identity.displayName?.trim() ? identity.displayName : null;

  useEffect(() => {
    let alive = true;
    setupMode.current = joinApi
      .setupMode()
      .then((on) => on === true)
      .catch(() => false);
    joinApi
      .outgoing()
      .then((request) => {
        if (!alive) return;
        if (isRequest(request)) {
          setView({ kind: request.status === "rejected" ? "rejected" : "waiting", request });
        } else {
          setView({ kind: "name", back: null });
        }
      })
      .catch(() => {
        // Permintaan lama tidak terbaca: mulai dari awal. Kirim permintaan baru menggantikannya.
        if (alive) setView({ kind: "name", back: null });
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

  // Setelah langkah nama: kantor baru (mode --siapkan-kantor), atau firewall
  // kalau aturan Mira belum ada, atau langsung mencari.
  async function afterName() {
    if (await setupMode.current) {
      setView({ kind: "new-office", end: { kind: "other" } });
      return;
    }
    setView({ kind: "checking" });
    let ready = true;
    try {
      const status = await api.getFirewallStatus();
      if (status && typeof status === "object") ready = status.rule === "allowed" || !status.supported;
    } catch {
      // Status tidak terbaca: jangan menahan orangnya di sini. Panduan firewall
      // tetap ada di Pengaturan, bagian Jaringan.
    }
    if (ready) search();
    else setView({ kind: "firewall", invite: null });
  }

  function nameDone(saved: IdentityInfo, back: View | null) {
    if (saved.displayName !== identity.displayName) {
      setSavedName(saved.displayName);
      onIdentity(saved);
    }
    if (back) setView(back);
    else void afterName();
  }

  function showOffices(offices: FoundOffice[]) {
    setOfficeSeen(true);
    rounds.current += 1;
    const next: View = { kind: "offices", offices, round: rounds.current };
    // Formulir kantor tidak menanyakan nama lagi. Kalau nama belum ada (misalnya
    // setelah permintaan lama dibatalkan), tanyakan dulu.
    setView(displayName ? next : { kind: "name", back: next });
  }

  function searchEnded(end: SearchEnd) {
    if ((end.kind === "timeout" || end.kind === "mdns") && end.orgSeen) setOfficeSeen(true);
    setView({ kind: "other", end });
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
          {view.kind === "name" && <NameStep identity={identity} onDone={(saved) => nameDone(saved, view.back)} />}
          {view.kind === "checking" && (
            <p className="hint" role="status">
              {CHECKING_FIREWALL(firewallName())}
            </p>
          )}
          {view.kind === "firewall" && (
            <FirewallStep
              lead={
                view.invite
                  ? `Kode undangan diperiksa oleh laptop rekan lewat jaringan kantor. Pastikan ${firewallName()} mengizinkan Mira.`
                  : FIREWALL_LEAD(firewallName())
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
              displayName={displayName ?? ""}
              onEditName={() => setView({ kind: "name", back: view })}
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
              officeSeen={officeSeen}
              onOffices={showOffices}
              onInvite={() => setView({ kind: "invite", end: view.end })}
              onSearchAgain={search}
              onNewOffice={() => setView({ kind: "new-office", end: view.end })}
            />
          )}
          {view.kind === "invite" && (
            <JoinStep
              identity={identity}
              onIdentity={onIdentity}
              onBack={() => setView({ kind: "other", end: view.end })}
              onFirewall={() => setView({ kind: "firewall", invite: view.end })}
              onJoined={onOrganization}
              onReload={onReload}
            />
          )}
          {view.kind === "new-office" && !officeSeen && (
            <NewOfficeStep
              identity={identity}
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
