import { useCallback, useEffect, useState } from "react";
import { api, toAppError, type AppError, type AppState, type OrgInfo } from "./api";
import { Onboarding } from "./screens/onboarding/Onboarding";
import { Shell } from "./screens/shell/Shell";
import { ErrorScreen, LoadingScreen } from "./screens/StatusScreens";

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

  useEffect(() => {
    void load();
  }, [load]);

  const update = useCallback((fn: (s: AppState) => AppState) => {
    setPhase((p) => (p.kind === "ready" ? { kind: "ready", state: fn(p.state) } : p));
  }, []);

  if (phase.kind === "loading") return <LoadingScreen />;
  if (phase.kind === "error") return <ErrorScreen error={phase.error} onRetry={load} />;

  const { state } = phase;
  if (state.identity.displayName === null || !hasOrganization(state)) {
    return (
      <Onboarding
        state={state}
        onIdentity={(identity) => update((s) => ({ ...s, identity }))}
        onOrganization={(organization) => update((s) => ({ ...s, organization }))}
        onReload={load}
      />
    );
  }
  return <Shell state={state} />;
}
