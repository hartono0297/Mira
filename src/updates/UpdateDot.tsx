import { useUpdates } from "./UpdateContext";
import "./updates.css";

// Titik di menu Pengaturan selama ada versi baru yang belum dipasang.
export function UpdateDot() {
  const { hasUpdate } = useUpdates();
  if (!hasUpdate) return null;
  return (
    <>
      <span className="update-dot" aria-hidden="true" />
      <span className="sr-only">, ada pembaruan</span>
    </>
  );
}
