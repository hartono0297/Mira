import { ErrorAlert } from "../../components/ErrorAlert";
import { Markdown } from "../../updates/Markdown";
import { useUpdates } from "../../updates/UpdateContext";
import { isBusy, type RetryTarget, type UpdateState } from "../../updates/updateState";
import "../../updates/updates.css";

const OFFLINE_TEXT = "Tidak bisa menghubungi GitHub. Coba lagi saat laptop tersambung ke internet.";
const NOT_CONFIGURED_TEXT =
  "Versi Mira ini belum disiapkan untuk pembaruan dari dalam aplikasi. Pasang versi baru dengan installer seperti biasa.";

const FAILED_TITLE: Record<RetryTarget, string> = {
  check: "Pengecekan pembaruan gagal",
  download: "Unduhan pembaruan gagal",
  install: "Pembaruan belum terpasang",
};

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("id-ID", { dateStyle: "long" });
}

// Kalimat status di wilayah live. Kosong saat belum ada yang perlu diberitahukan.
function Status({ state, configured }: { state: UpdateState; configured: boolean }) {
  switch (state.status) {
    case "idle":
      return configured ? null : <p className="update-calm">{NOT_CONFIGURED_TEXT}</p>;
    case "checking":
      return <p>Sedang mengecek pembaruan...</p>;
    case "upToDate":
      return <p>Mira sudah versi terbaru.</p>;
    case "available": {
      const date = formatDate(state.date);
      return (
        <p>
          <strong>Versi baru tersedia: Mira {state.version}.</strong>
          {date && <span className="update-date"> Dirilis {date}.</span>}
        </p>
      );
    }
    case "downloading":
      return <p>Mengunduh pembaruan...{state.percent !== null && ` ${state.percent}%`}</p>;
    case "ready":
      return <p>Pembaruan siap dipasang. Mira akan tertutup sebentar lalu terbuka lagi.</p>;
    case "installing":
      return <p>Memasang pembaruan...</p>;
    case "error":
      if (state.kind === "offline") return <p className="update-calm">{OFFLINE_TEXT}</p>;
      if (state.kind === "notConfigured") return <p className="update-calm">{NOT_CONFIGURED_TEXT}</p>;
      return (
        <ErrorAlert title={FAILED_TITLE[state.retry]}>
          <p>{state.message}</p>
          {state.retry === "check" && <p>Coba lagi dengan tombol Cek pembaruan.</p>}
        </ErrorAlert>
      );
  }
}

// Satu tombol aksi utama yang berganti label sesuai langkah. Tombol yang sama
// dipakai dari awal unduhan sampai pemasangan, jadi fokus keyboard tidak hilang.
function primaryAction(state: UpdateState): { label: string; busy: boolean; run: "download" | "install" } | null {
  switch (state.status) {
    case "available":
      return { label: "Perbarui sekarang", busy: false, run: "download" };
    case "downloading":
      return { label: "Mengunduh...", busy: true, run: "download" };
    case "ready":
      return { label: "Mulai ulang Mira", busy: false, run: "install" };
    case "installing":
      return { label: "Memasang...", busy: true, run: "install" };
    case "error":
      if (state.retry === "download") return { label: "Unduh lagi", busy: false, run: "download" };
      if (state.retry === "install") return { label: "Pasang lagi", busy: false, run: "install" };
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
        Tentang dan pembaruan
      </h2>

      <div className="about-head">
        <div>
          <p className="about-version">{currentVersion ? `Mira ${currentVersion}` : "Mira"}</p>
          <p className="hint">{currentVersion ? "Versi yang terpasang di laptop ini." : "Versi belum terbaca."}</p>
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
            Cek pembaruan
          </button>
          {whatsNew.notes && (
            <button type="button" className="btn btn-ghost" onClick={whatsNew.show}>
              Lihat yang baru
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
          aria-label="Kemajuan unduhan pembaruan"
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
          Cek pembaruan otomatis saat Mira dibuka
        </label>
        <p className="hint">
          Butuh internet, dan Mira hanya menghubungi GitHub. Pengecekan otomatis berjalan paling sering sekali sehari.
        </p>
        <div aria-live="polite">
          {autoCheckError && (
            <p className="field-error">Pilihan belum tersimpan: {autoCheckError.message}</p>
          )}
        </div>
      </div>

      <p className="hint">Pembaruan hanya mengganti program Mira. Data dan kunci laptop ini tidak tersentuh.</p>
    </section>
  );
}
