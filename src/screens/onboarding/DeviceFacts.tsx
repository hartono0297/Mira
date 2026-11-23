import type { JoinDevice } from "../../api/join";

// Nama laptop dan alamatnya, yang nanti juga dilihat penyetuju.
export function DeviceFacts({ device, error }: { device: JoinDevice | null; error: boolean }) {
  if (error) {
    return <p className="hint">Nama dan alamat laptop ini belum terbaca. Pencarian tetap berjalan.</p>;
  }
  if (!device) return <p className="hint">Membaca nama laptop ini...</p>;
  const addresses = Array.isArray(device.addresses) ? device.addresses : [];
  return (
    <dl className="onb-kv">
      <dt>Laptop ini</dt>
      <dd className="mono">{device.laptop}</dd>
      <dt>Alamat</dt>
      {addresses.length > 0 ? (
        <dd className="mono">{addresses.join(", ")}</dd>
      ) : (
        <dd>Belum tersambung ke jaringan</dd>
      )}
    </dl>
  );
}
