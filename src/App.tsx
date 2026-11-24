import { useCallback, useEffect, useState } from "react";
import { api, toAppError, type AppError, type AppState, type OrgInfo } from "./api";
import { Onboarding } from "./screens/onboarding/Onboarding";
import { RemovedScreen } from "./screens/RemovedScreen";
import { Shell } from "./screens/shell/Shell";
import { ErrorScreen, LoadingScreen } from "./screens/StatusScreens";
import { SuspendedScreen } from "./screens/SuspendedScreen";
import { MarkWhatsNewSeen, UpdateProvider } from "./updates/UpdateContext";
import { WhatsNewDialog } from "./updates/WhatsNewDialog";

type Phase = { kind: "loading" } | { kind: "error"; error: AppError } | { kind: "ready"; state: AppState };

function hasOrganization(state: AppState): state is AppState & { organization: OrgInfo } {
  return state.organization !== null;
}

export default function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  const load = useCallback(async () => {
    setPhase({ kind: "loading" });
    try {
      const state = await api.getAppState();
      setPhase({ kind: "ready", state });
    } catch (err) {
      setPhase({ kind: "error", error: toAppError(err) });
    }
  }, []);

  // Muat ulang tanpa layar memuat, misalnya setelah peran berubah, akun
  // dinonaktifkan atau aktif lagi, atau laptop ini dikeluarkan. Kalau gagal,
  // layar yang sedang tampil dibiarkan.
  const refresh = useCallback(async () => {
    try {
      const state = await api.getAppState();
      if (state && typeof state === "object") setPhase({ kind: "ready", state });
    } catch {
      // Dicoba lagi pada event atau polling berikutnya.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = useCallback((fn: (s: AppState) => AppState) => {
    setPhase((p) => (p.kind === "ready" ? { kind: "ready", state: fn(p.state) } : p));
  }, []);

  const joined = useCallback(
    (organization: OrgInfo) => update((s) => ({ ...s, organization, membership: "active" })),
    [update],
  );

  if (phase.kind === "loading") return <LoadingScreen />;
  if (phase.kind === "error") return <ErrorScreen error={phase.error} onRetry={load} />;

  const { state } = phase;
  if (state.identity.displayName === null || !hasOrganization(state)) {
    return (
      <>
        <MarkWhatsNewSeen />
        <Onboarding
          state={state}
          onIdentity={(identity) => update((s) => ({ ...s, identity }))}
          onOrganization={joined}
          onReload={load}
        />
      </>
    );
  }
  if (state.membership === "removed") {
    // Setelah reset, AppState baru tanpa organisasi membawa ke onboarding.
    return <RemovedScreen state={state} onReset={(next) => setPhase({ kind: "ready", state: next })} />;
  }
  if (state.membership === "suspended") {
    return <SuspendedScreen state={state} onRefresh={refresh} />;
  }
  return (
    <UpdateProvider>
      <Shell state={state} onRefresh={refresh} />
      <WhatsNewDialog />
    </UpdateProvider>
  );
}
