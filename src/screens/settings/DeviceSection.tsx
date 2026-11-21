import { ROLE_LABELS, type AppState, type OrgInfo } from "../../api";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("id-ID", { dateStyle: "long", timeStyle: "short" });
}

export function DeviceSection({ state }: { state: AppState & { organization: OrgInfo } }) {
  const { identity, organization, dataDir } = state;
  return (
    <section className="set-section" aria-labelledby="device-title">
      <h2 id="device-title" className="set-title">
        Laptop ini
      </h2>
      <p className="hint">Data di bawah hanya untuk dilihat di versi ini.</p>
      <dl className="facts">
        <div>
          <dt>Nama tampilan</dt>
          <dd>{identity.displayName}</dd>
        </div>
        <div>
          <dt>Sidik jari kunci</dt>
          <dd>
            <span className="mono selectable">{identity.fingerprint}</span>
            <span className="fact-note">
              Penanda kunci unik laptop ini. Kunci rahasianya tersimpan di penyimpanan kredensial Windows.
            </span>
          </dd>
        </div>
        <div>
          <dt>Kunci dibuat</dt>
          <dd>{formatDate(identity.createdAt)}</dd>
        </div>
        <div>
          <dt>Folder data</dt>
          <dd className="mono selectable path">{dataDir}</dd>
        </div>
        <div>
          <dt>Organisasi</dt>
          <dd>{organization.name}</dd>
        </div>
        <div>
          <dt>Peran Anda</dt>
          <dd>{ROLE_LABELS[organization.role]}</dd>
        </div>
      </dl>
    </section>
  );
}
