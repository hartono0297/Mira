import { createContext, useContext, useEffect, type ReactNode } from "react";
import { api, type NetworkStatus } from "../../api";
import { useLive, type Live } from "../../api/useLive";

const NetworkCtx = createContext<Live<NetworkStatus> | null>(null);

export const NETWORK_POLL_MS = 5000;

// Satu sumber status jaringan untuk sidebar, Organisasi, dan Pengaturan.
// Memuat ulang saat event mira://network datang, dan polling tiap 5 detik.
export function NetworkProvider({ children, onRemoved }: { children: ReactNode; onRemoved: () => void }) {
  const live = useLive(api.getNetworkStatus, "mira://network", NETWORK_POLL_MS);
  const removed = live.data?.state === "removed";

  useEffect(() => {
    if (removed) onRemoved();
  }, [removed, onRemoved]);

  return <NetworkCtx.Provider value={live}>{children}</NetworkCtx.Provider>;
}

export function useNetwork(): Live<NetworkStatus> {
  const ctx = useContext(NetworkCtx);
  if (!ctx) throw new Error("useNetwork dipakai di luar NetworkProvider");
  return ctx;
}

// Data jaringan valid, atau null kalau inti Rust belum mengirim bentuk yang benar.
export function validStatus(data: NetworkStatus | null): NetworkStatus | null {
  return data && typeof data === "object" && typeof data.state === "string" && Array.isArray(data.peers) ? data : null;
}

// Untuk layar yang bisa tampil tanpa NetworkProvider (misalnya di tes).
export function useNetworkOptional(): Live<NetworkStatus> | null {
  return useContext(NetworkCtx);
}
