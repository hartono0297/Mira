import { ErrorAlert } from "../../components/ErrorAlert";
import { locale } from "../../i18n/core";
import { SETTINGS_TEXT } from "../../i18n/settings";
import { Markdown } from "../../updates/Markdown";
import { useUpdates } from "../../updates/UpdateContext";
import { isBusy, type UpdateState } from "../../updates/updateState";
import "../../updates/updates.css";

const T = SETTINGS_TEXT.about;

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale(), { dateStyle: "long" });
}

// Kalimat status di wilayah live. Kosong saat belum ada yang perlu diberitahukan.
function Status({ state, configured }: { state: UpdateState; configured: boolean }) {
  switch (state.status) {
    case "idle":
      return configured ? null : <p className="update-calm">{T.notConfigured}</p>;
    case "checking":
      return <p>{T.checking}</p>;
    case "upToDate":
      return <p>{T.upToDate}</p>;
    case "available": {
      const date = formatDate(state.date);
      return (
        <p>
          <strong>{T.available(state.version)}</strong>
          {date && <span className="update-date"> {T.released(date)}</span>}
        </p>
      );
    }
    case "downloading":
      return <p>{T.downloading}{state.percent !== null && ` ${state.percent}%`}</p>;
    case "ready":
      return <p>{T.ready}</p>;
    case "installing":
      return <p>{T.installing}</p>;
    case "error":
      if (state.kind === "offline") return <p className="update-calm">{T.offline}</p>;
      if (state.kind === "notConfigured") return <p className="update-calm">{T.notConfigured}</p>;
      return (
        <ErrorAlert title={T.failedTitle[state.retry]}>
          <p>{state.message}</p>
          {state.retry === "check" && <p>{T.retryHint}</p>}
        </ErrorAlert>
      );
  }
}

// Satu tombol aksi utama yang berganti label sesuai langkah. Tombol yang sama
// dipakai dari awal unduhan sampai pemasangan, jadi fokus keyboard tidak hilang.
function primaryAction(state: UpdateState): { label: string; busy: boolean; run: "download" | "install" } | null {
  switch (state.status) {
    case "available":
      return { label: T.actions.updateNow, busy: false, run: "download" };
    case "downloading":
      return { label: T.actions.downloading, busy: true, run: "download" };
    case "ready":
      return { label: T.actions.restart, busy: false, run: "install" };
    case "installing":
      return { label: T.actions.installing, busy: true, run: "install" };
    case "error":
      if (state.retry === "download") return { label: T.actions.downloadAgain, busy: false, run: "download" };
      if (state.retry === "install") return { label: T.actions.installAgain, busy: false, run: "install" };
      return null;
    default:
      return null;
  }
}

export function AboutSection() {
  const { currentVersion, configured, state, check, download, install, autoCheck, setAutoCheck, autoCheckError, whatsNew } =
    useUpdates();
  const busy = isBusy(state);
  const action = primaryAction(state);

  return (
    <section className="set-section about" aria-labelledby="about-title">
      <h2 id="about-title" className="set-title">
        {SETTINGS_TEXT.parts.about}
      </h2>

      <div className="about-head">
        <div>
          <p className="about-version">{currentVersion ? `Mira ${currentVersion}` : "Mira"}</p>
          <p className="hint">{currentVersion ? T.versionInstalled : T.versionUnknown}</p>
        </div>
        <div className="about-buttons">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!currentVersion || !configured}
            aria-disabled={busy || undefined}
            aria-busy={state.status === "checking" || undefined}
            onClick={() => {
              if (!busy) void check();
            }}
          >
            {T.check}
          </button>
          {whatsNew.notes && (
            <button type="button" className="btn btn-ghost" onClick={whatsNew.show}>
              {T.seeWhatsNew}
            </button>
          )}
        </div>
      </div>

      <div aria-live="polite" className="set-live update-status">
        {currentVersion && <Status state={state} configured={configured} />}
      </div>

      {state.status === "downloading" && (
        <progress
          className="update-progress"
          max={100}
          value={state.percent ?? undefined}
          aria-label={T.progressLabel}
        />
      )}

      {state.status === "available" && state.notes && (
        <div className="update-notes">
          <Markdown source={state.notes} />
        </div>
      )}

      {action && (
        <div>
          <button
            type="button"
            className="btn"
            aria-disabled={action.busy || undefined}
            aria-busy={action.busy || undefined}
            onClick={() => {
              if (action.busy) return;
              void (action.run === "download" ? download() : install());
            }}
          >
            {action.label}
          </button>
        </div>
      )}

      <div className="about-auto">
        <label className="check-row">
          <input type="checkbox" checked={autoCheck} onChange={(e) => void setAutoCheck(e.target.checked)} />
          {T.autoCheck}
        </label>
        <p className="hint">{T.autoHint}</p>
        <div aria-live="polite">
          {autoCheckError && (
            <p className="field-error">{T.autoError(autoCheckError.message)}</p>
          )}
        </div>
      </div>

      <p className="hint">{T.dataSafe}</p>
    </section>
  );
}
