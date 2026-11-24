import type { JoinDevice } from "../../api/join";
import { ONB } from "./texts";

// Nama laptop dan alamatnya, yang nanti juga dilihat penyetuju.
export function DeviceFacts({ device, error }: { device: JoinDevice | null; error: boolean }) {
  if (error) {
    return <p className="hint">{ONB.device.error}</p>;
  }
  if (!device) return <p className="hint">{ONB.device.reading}</p>;
  const addresses = Array.isArray(device.addresses) ? device.addresses : [];
  return (
    <dl className="onb-kv">
      <dt>{ONB.device.laptop}</dt>
      <dd className="mono">{device.laptop}</dd>
      <dt>{ONB.device.address}</dt>
      {addresses.length > 0 ? (
        <dd className="mono">{addresses.join(", ")}</dd>
      ) : (
        <dd>{ONB.device.offline}</dd>
      )}
    </dl>
  );
}
