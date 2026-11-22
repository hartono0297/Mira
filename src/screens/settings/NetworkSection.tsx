import { IconTrash } from "@tabler/icons-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { api, toAppError, type AppError, type ManualAddress, type NetworkStatus } from "../../api";
import { relativeTime } from "../../api/format";
import { CopyButton } from "../../components/CopyButton";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { FirewallGuide } from "../../components/FirewallGuide";
import { NetStateLine } from "../shell/NetworkPanel";
import { useNetwork, validStatus } from "../shell/NetworkContext";

// QR dari Rust dipasang sebagai gambar, bukan HTML, jadi isinya tidak bisa menjalankan apa pun.
export function qrDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function NetworkSection() {
  const { data, error, loading, reload } = useNetwork();
  const status = validStatus(data);

  return (
    <section className="set-section" aria-labelledby="network-title">
      <h2 id="network-title" className="set-title">
        Jaringan
      </h2>

      <div role="status" aria-live="polite">
        {loading && !status && <p className="hint">Membaca status jaringan...</p>}
        {status && <NetStateLine state={status.state} />}
      </div>
      {!loading && !status && (
        <ErrorAlert title="Status jaringan belum terbaca">
          <p>{error?.message ?? "Inti Mira tidak mengirim status jaringan."}</p>
          <button type="button" className="btn btn-ghost onb-inline-btn" onClick={() => void reload()}>
            Coba baca lagi
          </button>
        </ErrorAlert>
      )}
      {status && error && (
        <p className="hint">Status terbaru belum bisa dibaca ({error.message}). Yang tampil adalah status terakhir.</p>
      )}

      {status && (
        <>
          <ThisLaptop status={status} />
          <ManualAddresses status={status} onChanged={reload} />
          <Discovery status={status} />
        </>
      )}

      <h3 className="set-sub">Windows Firewall</h3>
      <FirewallGuide />
    </section>
  );
}

function ThisLaptop({ status }: { status: NetworkStatus }) {
  return (
    <>
      <h3 className="set-sub">Alamat laptop ini</h3>
      {status.localAddresses.length === 0 ? (
        <p className="hint">
          Laptop ini belum punya alamat jaringan yang bisa dibagikan. Sambungkan ke Wi-Fi atau kabel LAN kantor.
        </p>
      ) : (
        <>
          <ul className="addr-list">
            {status.localAddresses.map((a) => (
              <li key={a} className="mono selectable">
                {a}
              </li>
            ))}
          </ul>
          <p className="hint">
            Kalau laptop rekan tidak menemukan laptop ini otomatis, rekan bisa mengisi salah satu alamat ini.
            {status.listenPort !== null && ` Mira memakai port UDP ${status.listenPort}.`}
          </p>
        </>
      )}

      {status.shareLink && (
        <div className="share">
          {status.qrSvg && (
            <img className="share-qr" src={qrDataUrl(status.qrSvg)} alt="Kode QR berisi tautan laptop ini" width={148} height={148} />
          )}
          <div className="share-text">
            <p className="fw-label">Tautan laptop ini</p>
            <p className="hint">
              Kirim tautan ini ke rekan, atau minta rekan memindai kodenya. Tautan bisa ditempel di kolom alamat saat
              bergabung atau di bagian Alamat laptop rekan.
            </p>
            <div className="copy-block">
              <code>{status.shareLink}</code>
              <CopyButton text={status.shareLink} label="Salin tautan" />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function attemptText(m: ManualAddress, status: NetworkStatus): string {
  if (m.publicKey) {
    const peer = status.peers.find((p) => p.publicKey === m.publicKey);
    const who = peer ? peer.displayName : "laptop rekan";
    return m.lastTriedAt ? `Tersambung ke ${who}, ${relativeTime(m.lastTriedAt)}.` : `Terkait dengan ${who}.`;
  }
  if (m.lastError) {
    return m.lastTriedAt
      ? `Percobaan terakhir ${relativeTime(m.lastTriedAt)} gagal: ${m.lastError}`
      : `Percobaan terakhir gagal: ${m.lastError}`;
  }
  if (m.lastTriedAt) return `Dicoba ${relativeTime(m.lastTriedAt)}, belum ada jawaban.`;
  return "Belum dicoba. Mira mencoba alamat ini secara berkala.";
}

function ManualAddresses({ status, onChanged }: { status: NetworkStatus; onChanged: () => Promise<void> }) {
  const [value, setValue] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ title: string; error: AppError } | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();
  const errId = useId();
  const manual = Array.isArray(status.manualAddresses) ? status.manualAddresses : [];

  async function add(e: FormEvent) {
    e.preventDefault();
    if (adding) return;
    const address = value.trim();
    setDone(null);
    setFailure(null);
    if (!address) {
      setFieldError("Isi alamat laptop rekan dulu.");
      inputRef.current?.focus();
      return;
    }
    setFieldError(null);
    setAdding(true);
    try {
      const added = await api.addManualAddress(address);
      setValue("");
      setDone(`Alamat ${added?.address ?? address} ditambahkan. Mira akan mencoba menyambung ke sana.`);
      await onChanged();
    } catch (err) {
      const error = toAppError(err);
      if (error.code === "invalid_address") {
        setFieldError(error.message);
        inputRef.current?.focus();
      } else {
        setFailure({ title: "Alamat belum ditambahkan", error });
      }
    } finally {
      setAdding(false);
    }
  }

  async function remove(address: string) {
    setRemoving(address);
    setDone(null);
    setFailure(null);
    try {
      await api.removeManualAddress(address);
      setDone(`Alamat ${address} dihapus.`);
      await onChanged();
    } catch (err) {
      setFailure({ title: "Alamat belum dihapus", error: toAppError(err) });
    } finally {
      setRemoving(null);
    }
  }

  return (
    <>
      <h3 className="set-sub">Alamat laptop rekan</h3>
      <p className="hint">
        Untuk rekan yang tidak ditemukan otomatis, misalnya karena beda subnet atau tersambung lewat VPN.
      </p>
      {manual.length === 0 ? (
        <p className="hint">Belum ada alamat yang ditambahkan.</p>
      ) : (
        <ul className="manual-list">
          {manual.map((m) => (
            <li key={m.address}>
              <div className="manual-text">
                <span className="mono selectable">{m.address}</span>
                <span className={m.lastError && !m.publicKey ? "manual-sub manual-bad" : "manual-sub"}>
                  {attemptText(m, status)}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void remove(m.address)}
                disabled={removing !== null}
                aria-busy={removing === m.address || undefined}
                aria-label={`Hapus alamat ${m.address}`}
              >
                <IconTrash size={16} aria-hidden="true" />
                {removing === m.address ? "Menghapus..." : "Hapus"}
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="manual-form" onSubmit={add} noValidate>
        <div className="field">
          <label htmlFor={inputId}>Tambah alamat laptop rekan</label>
          <div className="manual-row">
            <input
              ref={inputRef}
              id={inputId}
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={`${hintId} ${errId}`}
              disabled={adding}
            />
            <button type="submit" className="btn" disabled={adding} aria-busy={adding || undefined}>
              {adding ? "Menambahkan..." : "Tambah alamat"}
            </button>
          </div>
          <p id={hintId} className="hint">
            Contoh: 192.168.1.20, 192.168.1.20:47800, atau tautan yang diawali mira:// dari rekan.
          </p>
          <div id={errId} aria-live="polite">
            {fieldError && <FieldError text={fieldError} />}
          </div>
        </div>
      </form>
      <div aria-live="polite" className="set-live">
        {done && <p className="hint">{done}</p>}
        {failure && (
          <ErrorAlert title={failure.title}>
            <p>{failure.error.message}</p>
          </ErrorAlert>
        )}
      </div>
    </>
  );
}

function Discovery({ status }: { status: NetworkStatus }) {
  const mdns = status.mdns ?? { ok: false, error: null };
  return (
    <>
      <h3 className="set-sub">Detail teknis</h3>
      <dl className="facts">
        <div>
          <dt>Penemuan otomatis (mDNS)</dt>
          <dd>
            {mdns.ok ? "Aktif" : "Tidak aktif"}
            {!mdns.ok && (
              <span className="fact-note">
                {mdns.error ? `${mdns.error} ` : ""}
                Laptop rekan tetap bisa tersambung lewat alamat yang diingat atau alamat yang ditambahkan di atas.
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Port UDP</dt>
          <dd>{status.listenPort ?? "Belum mendengarkan"}</dd>
        </div>
      </dl>
    </>
  );
}
