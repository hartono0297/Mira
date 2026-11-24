import { ROLE_LABELS, type AppState, type OrgInfo } from "../../api";
import { locale } from "../../i18n/core";
import { SETTINGS_TEXT } from "../../i18n/settings";
import { keyStoreName } from "../../platform";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale(), { dateStyle: "long", timeStyle: "short" });
}

export function DeviceSection({ state }: { state: AppState & { organization: OrgInfo } }) {
  const { identity, organization, dataDir } = state;
  const T = SETTINGS_TEXT.device;
  return (
    <section className="set-section" aria-labelledby="device-title">
      <h2 id="device-title" className="set-title">
        {SETTINGS_TEXT.parts.device}
      </h2>
      <p className="hint">{T.viewOnly}</p>
      <dl className="facts">
        <div>
          <dt>{T.displayName}</dt>
          <dd>{identity.displayName}</dd>
        </div>
        <div>
          <dt>{T.fingerprint}</dt>
          <dd>
            <span className="mono selectable">{identity.fingerprint}</span>
            <span className="fact-note">{T.fingerprintNote(keyStoreName())}</span>
          </dd>
        </div>
        <div>
          <dt>{T.keyCreated}</dt>
          <dd>{formatDate(identity.createdAt)}</dd>
        </div>
        <div>
          <dt>{T.dataFolder}</dt>
          <dd className="mono selectable path">{dataDir}</dd>
        </div>
        <div>
          <dt>{T.organization}</dt>
          <dd>{organization.name}</dd>
        </div>
        <div>
          <dt>{T.yourRole}</dt>
          <dd>{ROLE_LABELS[organization.role]}</dd>
        </div>
      </dl>
    </section>
  );
}
