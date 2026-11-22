import { IconAlertTriangle } from "@tabler/icons-react";
import { useCallback, useMemo, useState } from "react";
import { api, toAppError, type AppError, type AppState, type Directory, type OrgInfo } from "../../api";
import { actionErrorTitle } from "../../api/messages";
import { useLive } from "../../api/useLive";
import { ErrorAlert } from "../../components/ErrorAlert";
import { makeCtx, type Act } from "./context";
import { InvitesPanel } from "./InvitesPanel";
import { MembersPanel } from "./MembersPanel";
import { TeamsPanel } from "./TeamsPanel";
import "../settings/settings.css";
import "./org.css";

type Part = "teams" | "members" | "invites";

const PARTS: { id: Part; label: string }[] = [
  { id: "teams", label: "Tim" },
  { id: "members", label: "Anggota" },
  { id: "invites", label: "Kode undangan" },
];

type Feedback = { kind: "ok"; text: string } | { kind: "error"; title: string; error: AppError } | null;

export const DIRECTORY_POLL_MS = 15000;

function validDirectory(data: Directory | null): Directory | null {
  return data && typeof data === "object" && Array.isArray(data.members) && Array.isArray(data.teams) ? data : null;
}

function errorHint(error: AppError): string | null {
  if (error.code === "last_superadmin") return "Jadikan anggota lain superadmin dulu, baru lepaskan peran ini.";
  if (error.code === "not_found") return "Daftar di layar ini sudah dimuat ulang. Periksa lagi sebelum mencoba.";
  return null;
}

type Props = { state: AppState & { organization: OrgInfo }; onRefresh: () => void };

export function OrgScreen({ state, onRefresh }: Props) {
  const live = useLive(api.getDirectory, "mira://directory", DIRECTORY_POLL_MS);
  const dir = validDirectory(live.data);
  const [part, setPart] = useState<Part>("teams");
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const { reload } = live;

  const act: Act = useCallback(
    async (key, run, ok, failTitle) => {
      setPending(key);
      setFeedback(null);
      try {
        await run();
        setFeedback({ kind: "ok", text: ok });
        await reload();
        onRefresh();
        return true;
      } catch (err) {
        const error = toAppError(err);
        setFeedback({ kind: "error", title: actionErrorTitle(error, failTitle), error });
        if (error.code === "not_found" || error.code === "forbidden") void reload();
        return false;
      } finally {
        setPending(null);
      }
    },
    [reload, onRefresh],
  );

  const notify = useCallback((text: string) => setFeedback({ kind: "ok", text }), []);
  const ctx = useMemo(
    () => (dir ? makeCtx(dir, act, pending, reload, notify) : null),
    [dir, act, pending, reload, notify],
  );
  const current = PARTS.find((p) => p.id === part) ?? PARTS[0];

  return (
    <main className="settings" aria-labelledby="page-title">
      <header className="page-head">
        <h1 id="page-title" className="page-title">
          Organisasi
        </h1>
        <span className="page-sub">{dir?.org.name ?? state.organization.name}</span>
      </header>

      {live.loading && !dir && (
        <p className="org-pad hint" role="status">
          Memuat data organisasi...
        </p>
      )}
      {!live.loading && !dir && (
        <div className="org-pad org-narrow" role="alert">
          <ErrorAlert title="Data organisasi belum terbaca">
            <p>{live.error?.message ?? "Inti Mira tidak mengirim data organisasi."}</p>
            <button type="button" className="btn btn-ghost onb-inline-btn" onClick={() => void reload()}>
              Coba baca lagi
            </button>
          </ErrorAlert>
        </div>
      )}

      {dir && ctx && (
        <>
          {dir.me.isSuperadmin && dir.superadminCount < 2 && (
            <div className="org-pad org-narrow">
              <div className="notice">
                <IconAlertTriangle size={18} aria-hidden="true" />
                <div>
                  <strong>Organisasi ini baru punya satu superadmin</strong>
                  <p>
                    Kalau laptop superadmin rusak, hilang, atau orangnya keluar, tidak ada yang bisa membuat tim,
                    menunjuk admin, atau mengeluarkan anggota. Jadikan satu anggota lain superadmin.
                  </p>
                  {part !== "members" && (
                    <button type="button" className="btn btn-ghost onb-inline-btn org-notice-btn" onClick={() => setPart("members")}>
                      Pilih anggota di bagian Anggota
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="settings-layout">
            <nav aria-label="Bagian organisasi">
              <ul className="settings-nav">
                {PARTS.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="settings-link"
                      aria-current={part === p.id ? "true" : undefined}
                      onClick={() => {
                        setPart(p.id);
                        setFeedback(null);
                      }}
                    >
                      {p.label}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="org-body">
              <div aria-live="polite" className="org-live">
                {live.error && (
                  <p className="hint">
                    Data terbaru belum bisa dibaca ({live.error.message}). Yang tampil adalah data terakhir.
                  </p>
                )}
                {feedback?.kind === "ok" && <p className="org-ok">{feedback.text}</p>}
                {feedback?.kind === "error" && (
                  <ErrorAlert title={feedback.title}>
                    <p>{feedback.error.message}</p>
                    {errorHint(feedback.error) && <p>{errorHint(feedback.error)}</p>}
                  </ErrorAlert>
                )}
              </div>
              {current.id === "teams" && <TeamsPanel ctx={ctx} />}
              {current.id === "members" && <MembersPanel ctx={ctx} />}
              {current.id === "invites" && <InvitesPanel ctx={ctx} />}
            </div>
          </div>
        </>
      )}
    </main>
  );
}
