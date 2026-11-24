import { IconTrash } from "@tabler/icons-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { api, toAppError, type AppError, type ManualAddress, type NetworkStatus } from "../../api";
import { relativeTime } from "../../api/format";
import { CopyButton } from "../../components/CopyButton";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { FirewallGuide } from "../../components/FirewallGuide";
import { SETTINGS_TEXT } from "../../i18n/settings";
import { firewallName } from "../../platform";
import { NetStateLine } from "../shell/NetworkPanel";
import { useNetwork, validStatus } from "../shell/NetworkContext";

const T = SETTINGS_TEXT.network;

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
        {SETTINGS_TEXT.parts.network}
      </h2>

      <div role="status" aria-live="polite">
        {loading && !status && <p className="hint">{T.reading}</p>}
        {status && <NetStateLine state={status.state} />}
      </div>
      {!loading && !status && (
        <ErrorAlert title={T.unreadableTitle}>
          <p>{error?.message ?? T.noStatus}</p>
          <button type="button" className="btn btn-ghost onb-inline-btn" onClick={() => void reload()}>
            {T.retry}
          </button>
        </ErrorAlert>
      )}
      {status && error && (
        <p className="hint">{T.stale(error.message)}</p>
      )}

      {status && (
        <>
          <ThisLaptop status={status} />
          <ManualAddresses status={status} onChanged={reload} />
          <Discovery status={status} />
        </>
      )}

      <h3 className="set-sub">{firewallName()}</h3>
      <FirewallGuide />
    </section>
  );
}

function ThisLaptop({ status }: { status: NetworkStatus }) {
  return (
    <>
      <h3 className="set-sub">{T.thisLaptop.heading}</h3>
      {status.localAddresses.length === 0 ? (
        <p className="hint">{T.thisLaptop.noAddress}</p>
      ) : (
        <>
          <ul className="addr-list">
            {status.localAddresses.map((a) => (
              <li key={a} className="mono selectable">
                {a}
              </li>
            ))}
          </ul>
          <p className="hint">{T.thisLaptop.addressHint}</p>
        </>
      )}

      {status.shareLink && (
        <div className="share">
          {status.qrSvg && (
            <img className="share-qr" src={qrDataUrl(status.qrSvg)} alt={T.thisLaptop.qrAlt} width={148} height={148} />
          )}
          <div className="share-text">
            <p className="fw-label">{T.thisLaptop.linkLabel}</p>
            <p className="hint">{T.thisLaptop.linkHint}</p>
            <div className="copy-block">
              <code>{status.shareLink}</code>
              <CopyButton text={status.shareLink} label={T.thisLaptop.copyLink} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Rust mengosongkan lastError saat percobaan berhasil, tapi publicKey tetap
// tersimpan saat percobaan berikutnya gagal. Jadi error dicek lebih dulu.
function attemptText(m: ManualAddress, status: NetworkStatus): string {
  const peer = m.publicKey ? status.peers.find((p) => p.publicKey === m.publicKey) : undefined;
  const A = T.attempt;
  const who = peer ? peer.displayName : A.colleagueLaptop;
  if (m.lastError) {
    return m.lastTriedAt ? A.failedAt(relativeTime(m.lastTriedAt), m.lastError) : A.failed(m.lastError);
  }
  if (m.publicKey) {
    return m.lastTriedAt ? A.connected(who, relativeTime(m.lastTriedAt)) : A.ownedBy(who);
  }
  if (m.lastTriedAt) return A.triedAt(relativeTime(m.lastTriedAt));
  return A.never;
}

// Pesan disimpan sebagai jenis + data, lalu dijadikan kalimat saat render,
// supaya ikut bahasa aktif kalau bahasa diganti saat pesan masih tampil.
type FieldProblem = { kind: "empty" } | { kind: "invalid"; message: string };
type Failure = { kind: "add" | "remove"; error: AppError };
type Done = { kind: "added" | "removed"; address: string };

function ManualAddresses({ status, onChanged }: { status: NetworkStatus; onChanged: () => Promise<void> }) {
  const M = T.manual;
  const [value, setValue] = useState("");
  const [fieldProblem, setFieldProblem] = useState<FieldProblem | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
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
      setFieldProblem({ kind: "empty" });
      inputRef.current?.focus();
      return;
    }
    setFieldProblem(null);
    setAdding(true);
    try {
      const added = await api.addManualAddress(address);
      setValue("");
      setDone({ kind: "added", address: added?.address ?? address });
      await onChanged();
    } catch (err) {
      const error = toAppError(err);
      if (error.code === "invalid_address") {
        setFieldProblem({ kind: "invalid", message: error.message });
        inputRef.current?.focus();
      } else {
        setFailure({ kind: "add", error });
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
      setDone({ kind: "removed", address });
      await onChanged();
    } catch (err) {
      setFailure({ kind: "remove", error: toAppError(err) });
    } finally {
      setRemoving(null);
    }
  }

  const fieldError = fieldProblem ? (fieldProblem.kind === "empty" ? M.fillFirst : fieldProblem.message) : null;

  return (
    <>
      <h3 className="set-sub">{M.heading}</h3>
      <p className="hint">{M.intro}</p>
      {manual.length === 0 ? (
        <p className="hint">{M.empty}</p>
      ) : (
        <ul className="manual-list">
          {manual.map((m) => (
            <li key={m.address}>
              <div className="manual-text">
                <span className="mono selectable">{m.address}</span>
                <span className={m.lastError ? "manual-sub manual-bad" : "manual-sub"}>
                  {attemptText(m, status)}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void remove(m.address)}
                disabled={removing !== null}
                aria-busy={removing === m.address || undefined}
                aria-label={M.removeLabel(m.address)}
              >
                <IconTrash size={16} aria-hidden="true" />
                {removing === m.address ? M.removing : M.remove}
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="manual-form" onSubmit={add} noValidate>
        <div className="field">
          <label htmlFor={inputId}>{M.addLabel}</label>
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
              {adding ? M.adding : M.addButton}
            </button>
          </div>
          <p id={hintId} className="hint">
            {M.example}
          </p>
          <div id={errId} aria-live="polite">
            {fieldError && <FieldError text={fieldError} />}
          </div>
        </div>
      </form>
      <div aria-live="polite" className="set-live">
        {done && <p className="hint">{done.kind === "added" ? M.added(done.address) : M.removed(done.address)}</p>}
        {failure && (
          <ErrorAlert title={failure.kind === "add" ? M.addFailedTitle : M.removeFailedTitle}>
            <p>{failure.error.message}</p>
          </ErrorAlert>
        )}
      </div>
    </>
  );
}

function Discovery({ status }: { status: NetworkStatus }) {
  const mdns = status.mdns ?? { ok: false, error: null };
  const D = T.discovery;
  return (
    <>
      <h3 className="set-sub">{D.heading}</h3>
      <dl className="facts">
        <div>
          <dt>{D.mdns}</dt>
          <dd>
            {mdns.ok ? D.on : D.off}
            {!mdns.ok && (
              <span className="fact-note">
                {mdns.error ? `${mdns.error} ` : ""}
                {D.mdnsNote}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>{D.udpPort}</dt>
          <dd>{status.listenPort ?? D.notListening}</dd>
        </div>
      </dl>
    </>
  );
}
