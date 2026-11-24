import { useEffect, useRef, useState } from "react";
import { api, type AppState, type IdentityInfo, type OrgInfo } from "../../api";
import {
  joinApi,
  type FoundOffice,
  type JoinDevice,
  type JoinSearch,
  type LocalAd,
  type OutgoingJoinRequest,
} from "../../api/join";
import { FirewallGuide } from "../../components/FirewallGuide";
import { LanguagePicker } from "../../components/LanguagePicker";
import { Logo } from "../../components/Logo";
import { firewallName } from "../../platform";
import { asLocalAd } from "./adProfile";
import { JoinStep } from "./JoinStep";
import { NameStep } from "./NameStep";
import { NewOfficeStep } from "./NewOfficeStep";
import { NotFoundStep } from "./NotFoundStep";
import { anySeen, LegacyOffices, legacyOnly, mergeSeen, NO_SEEN, SecondOfficeGuard, type SeenOffices } from "./OfficeGuard";
import { OfficeStep, type OfficeDraft } from "./OfficeStep";
import { SearchStep, SETUP_SEARCH_MS, type SearchEnd } from "./SearchStep";
import { StepHeading } from "./StepHeading";
import { ADMIN_IT, CHECKING_FIREWALL, FIREWALL_INVITE_LEAD, FIREWALL_LEAD, ONB, STEP } from "./texts";
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
  // setup: Mira dibuka dengan --siapkan-kantor; lanjutnya ke kantor baru.
  | { kind: "firewall"; invite: SearchEnd | null; setup?: boolean }
  // setup: pencarian singkat mode --siapkan-kantor sebelum kantor baru.
  | { kind: "search"; round: number; setup?: boolean }
  // --siapkan-kantor menemukan kantor lain: peringatan sebelum kantor baru.
  | { kind: "setup-guard" }
  // draft: isian formulir kantor sebelum orangnya kembali mengubah nama.
  | { kind: "offices"; offices: FoundOffice[]; round: number; draft?: OfficeDraft }
  | { kind: "waiting"; request: OutgoingJoinRequest }
  | { kind: "rejected"; request: OutgoingJoinRequest }
  | { kind: "other"; end: SearchEnd }
  | { kind: "invite"; end: SearchEnd }
  // confirmed: orangnya sudah melewati peringatan kantor kedua.
  | { kind: "new-office"; end: SearchEnd; confirmed?: boolean };

function stepLabel(view: View): string | null {
  switch (view.kind) {
    case "name":
      return STEP.name;
    case "firewall":
      return view.invite || view.setup ? null : STEP.find;
    case "search":
      return view.setup ? null : STEP.find;
    case "checking":
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
  // Akun domain Windows laptop ini (onboarding-ad). null: tidak ada, belum
  // terbaca, atau gagal; alurnya sama persis dengan tanpa AD.
  const [ad, setAd] = useState<LocalAd | null>(null);
  // Domain AD tempat PC ini bergabung, walau yang login akun lokal.
  const [machineDomain, setMachineDomain] = useState<string | null>(null);
  // Kantor dan pengumuman organisasi yang pernah terlihat di sesi ini. Setelah
  // ada, kantor baru baru terbuka setelah peringatan dan konfirmasi. Salinan di
  // ref dibaca saat pencarian selesai, sebelum state sempat diperbarui.
  const [seen, setSeen] = useState<SeenOffices>(NO_SEEN);
  const seenNow = useRef<SeenOffices>(NO_SEEN);
  // Nama yang disimpan di langkah 1. state.identity baru berganti setelah
  // induknya memproses onIdentity, jadi layar ini memegang salinannya sendiri.
  const [savedName, setSavedName] = useState<string | null>(null);
  // Kunci per putaran, supaya "Cari lagi" memasang layar baru dan judulnya mendapat fokus.
  const rounds = useRef(0);
  // Mira dibuka dengan --siapkan-kantor. Disimpan sebagai janji, supaya langkah
  // nama tidak perlu menunggu jawabannya sebelum tampil.
  const setupMode = useRef<Promise<boolean>>(Promise.resolve(false));
  // afterName sedang berjalan: Lanjut yang ditekan dua kali tidak menjalankannya lagi.
  const advancing = useRef(false);

  const identity: IdentityInfo = savedName === null ? state.identity : { ...state.identity, displayName: savedName };
  const displayName = identity.displayName?.trim() ? identity.displayName : null;
  const officeSeen = anySeen(seen);
  const laptopDomain = ad?.domain ?? machineDomain;

  function addSeen(next: Parameters<typeof mergeSeen>[1]) {
    seenNow.current = mergeSeen(seenNow.current, next);
    setSeen(seenNow.current);
  }

  function noteRound(result: JoinSearch) {
    addSeen({
      legacy: Array.isArray(result.legacyOffices) ? result.legacyOffices : [],
      orgSeen: result.orgSeen === true,
    });
  }

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
    // Dibaca sekali tanpa menahan layar: pembacaan bisa sampai sekitar 4 detik.
    joinApi
      .adProfile()
      .then((profile) => {
        if (alive) setAd(asLocalAd(profile));
      })
      .catch(() => {});
    api
      .machineAdDomain()
      .then((domain) => {
        if (alive && typeof domain === "string" && domain.trim()) setMachineDomain(domain.trim());
      })
      .catch(() => {});
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

  // --siapkan-kantor: cari kantor sebentar dulu. Kantor baru langsung terbuka
  // hanya kalau tidak ada kantor Mira yang terlihat.
  function setupSearch() {
    rounds.current += 1;
    setView({ kind: "search", round: rounds.current, setup: true });
  }

  function setupEnded(offices: FoundOffice[]) {
    if (offices.length > 0) addSeen({ offices });
    if (anySeen(seenNow.current)) setView({ kind: "setup-guard" });
    else setView({ kind: "new-office", end: { kind: "other" }, confirmed: true });
  }

  // Setelah langkah nama: firewall kalau aturan Mira belum ada, lalu mencari,
  // atau kantor baru kalau Mira dibuka dengan --siapkan-kantor. Laptop admin IT
  // itu juga perlu firewall: rekan nanti menyambung ke sana untuk bergabung.
  async function afterName() {
    if (advancing.current) return;
    advancing.current = true;
    try {
      const setup = await setupMode.current;
      setView({ kind: "checking" });
      let ready = true;
      try {
        const status = await api.getFirewallStatus();
        if (status && typeof status === "object") ready = status.rule === "allowed" || !status.supported;
      } catch {
        // Status tidak terbaca: jangan menahan orangnya di sini. Panduan firewall
        // tetap ada di Pengaturan, bagian Jaringan.
      }
      if (!ready) setView({ kind: "firewall", invite: null, setup });
      else if (setup) setupSearch();
      else search();
    } finally {
      advancing.current = false;
    }
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
    addSeen({ offices });
    rounds.current += 1;
    const next: View = { kind: "offices", offices, round: rounds.current };
    // Formulir kantor tidak menanyakan nama lagi. Kalau nama belum ada (misalnya
    // setelah permintaan lama dibatalkan), tanyakan dulu.
    setView(displayName ? next : { kind: "name", back: next });
  }

  function searchEnded(end: SearchEnd) {
    if ((end.kind === "timeout" || end.kind === "mdns" || end.kind === "cancelled") && end.orgSeen) {
      addSeen({ orgSeen: true });
    }
    setView({ kind: "other", end });
  }

  // Kantor baru tidak tampil setelah ada kantor di sesi ini, kecuali orangnya
  // sudah melewati peringatan kantor kedua: layar cara lain menggantikannya.
  const shown: View =
    view.kind === "new-office" && officeSeen && !view.confirmed ? { kind: "other", end: view.end } : view;
  const label = stepLabel(shown);

  return (
    <div className="onb">
      <div className="onb-col">
        {/* Pemilih bahasa di setiap langkah, supaya orang baru bisa pindah ke
            bahasa Inggris sejak awal. Tidak mengambil fokus dari judul langkah. */}
        <div className="onb-top">
          <div className="onb-brand">
            <Logo size={32} />
            <span>Mira</span>
          </div>
          <LanguagePicker variant="compact" />
        </div>
        <main className="onb-card">
          {label && <p className="onb-step">{label}</p>}
          {view.kind === "resume" && (
            <p className="hint" role="status">
              {ONB.resume}
            </p>
          )}
          {view.kind === "name" && <NameStep identity={identity} ad={ad} onDone={(saved) => nameDone(saved, view.back)} />}
          {view.kind === "checking" && (
            <p className="hint" role="status">
              {CHECKING_FIREWALL(firewallName())}
            </p>
          )}
          {view.kind === "firewall" && (
            <FirewallStep
              lead={
                view.invite ? FIREWALL_INVITE_LEAD(firewallName()) : FIREWALL_LEAD(firewallName())
              }
              continueLabel={
                view.invite
                  ? ONB.firewall.backToInvite
                  : view.setup
                    ? ONB.firewall.setupContinue
                    : ONB.firewall.search
              }
              onContinue={() => {
                if (view.invite) setView({ kind: "invite", end: view.invite });
                else if (view.setup) setupSearch();
                else search();
              }}
            />
          )}
          {view.kind === "search" && !view.setup && (
            <SearchStep
              key={view.round}
              device={device}
              deviceError={deviceError}
              onFound={showOffices}
              onEnd={searchEnded}
              onRound={noteRound}
            />
          )}
          {view.kind === "search" && view.setup && (
            <SearchStep
              key={view.round}
              device={device}
              deviceError={deviceError}
              limitMs={SETUP_SEARCH_MS}
              lead={ONB.search.setupLead}
              onFound={setupEnded}
              onEnd={(end) => {
                if ((end.kind === "timeout" || end.kind === "mdns" || end.kind === "cancelled") && end.orgSeen) {
                  addSeen({ orgSeen: true });
                }
                setupEnded([]);
              }}
              onRound={noteRound}
            />
          )}
          {view.kind === "setup-guard" && (
            <div className="onb-form">
              <StepHeading>{ADMIN_IT.setupHeading}</StepHeading>
              <LegacyOffices legacy={legacyOnly(seen)} />
              <SecondOfficeGuard
                seen={seen}
                laptopDomain={laptopDomain}
                onJoin={showOffices}
                onConfirmed={() => setView({ kind: "new-office", end: { kind: "other" }, confirmed: true })}
              />
              <p className="hint onb-other">
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setView({ kind: "other", end: { kind: "other" } })}
                >
                  {ADMIN_IT.otherWay}
                </button>
              </p>
            </div>
          )}
          {view.kind === "offices" && (
            <OfficeStep
              key={view.round}
              offices={view.offices}
              displayName={displayName ?? ""}
              ad={ad}
              legacy={legacyOnly(seen)}
              draft={view.draft}
              onEditName={(draft) => setView({ kind: "name", back: { ...view, draft } })}
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
          {shown.kind === "other" && (
            <NotFoundStep
              end={shown.end}
              seen={seen}
              laptopDomain={laptopDomain}
              onOffices={showOffices}
              onInvite={() => setView({ kind: "invite", end: shown.end })}
              onSearchAgain={search}
              onNewOffice={() => setView({ kind: "new-office", end: shown.end, confirmed: true })}
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
          {view.kind === "new-office" && shown === view && (
            <NewOfficeStep
              identity={identity}
              adDomain={ad?.domain ?? null}
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
      <StepHeading>{ONB.firewall.heading}</StepHeading>
      <p className="onb-lead">{lead}</p>
      <FirewallGuide
        footer={(status) => {
          const ready = status !== null && (status.rule === "allowed" || !status.supported);
          return (
            <div className="onb-actions">
              <button type="button" className={ready ? "btn" : "btn btn-ghost"} onClick={onContinue}>
                {ready ? continueLabel : ONB.firewall.skip}
              </button>
            </div>
          );
        }}
      />
    </div>
  );
}
