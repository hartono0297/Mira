import { IconAlertTriangle } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, toAppError, type AppError, type AppState, type Directory, type OrgInfo } from "../../api";
import { actionErrorTitle } from "../../api/messages";
import { orgApi } from "../../api/org";
import { orgScreenApi } from "../../api/orgScreen";
import { ErrorAlert } from "../../components/ErrorAlert";
import { makeCtx, type Act, type OrgPage } from "./context";
import { DepartmentsPanel } from "./DepartmentsPanel";
import { InvitesPanel } from "./InvitesPanel";
import { JoinRequestsPanel } from "./JoinRequestsPanel";
import { LabelsPanel } from "./LabelsPanel";
import { PeoplePanel } from "./PeoplePanel";
import { formatCount } from "./usePendingJoinCount";
import { useOrgLive } from "./useOrgLive";
import { UsersPanel } from "./UsersPanel";
import "../settings/settings.css";
import "./nav-count.css";
import "./org.css";

export type Part = "users" | "people" | "departments" | "requests" | "labels" | "invites";

type Feedback = { kind: "ok"; text: string } | { kind: "error"; title: string; error: AppError } | null;

function validDirectory(data: Directory | null): Directory | null {
  return data && typeof data === "object" && Array.isArray(data.members) && Array.isArray(data.teams) ? data : null;
}

function errorHint(error: AppError): string | null {
  if (error.code === "last_superadmin") return "Jadikan orang lain superadmin dulu, baru lepaskan peran ini.";
  if (error.code === "not_found") return "Data di layar ini sudah dimuat ulang. Periksa lagi sebelum mencoba.";
  if (error.code === "forbidden") return "Peran Anda mungkin baru berubah. Data di layar ini sudah dimuat ulang.";
  return null;
}

type Props = { state: AppState & { organization: OrgInfo }; onRefresh: () => void };

export function OrgScreen({ state, onRefresh }: Props) {
  const [version, setVersion] = useState(0);
  const overviewLive = useOrgLive(orgApi.overview, { version });
  const dirLive = useOrgLive(api.getDirectory, { version });
  const overview = overviewLive.data;
  const dir = validDirectory(dirLive.data);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [part, setPart] = useState<Part | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    let alive = true;
    orgScreenApi
      .fingerprint()
      .then((fp) => {
        if (alive && typeof fp === "string") setFingerprint(fp);
      })
      .catch(() => {
        // Sidik hanya pelengkap header; tanpa itu halaman tetap bisa dipakai.
      });
    return () => {
      alive = false;
    };
  }, []);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const act: Act = useCallback(
    async (key, run, ok, failTitle) => {
      setPending(key);
      setFeedback(null);
      try {
        await run();
        setFeedback({ kind: "ok", text: ok });
        refresh();
        onRefresh();
        return true;
      } catch (err) {
        const error = toAppError(err);
        setFeedback({ kind: "error", title: actionErrorTitle(error, failTitle), error });
        if (error.code === "not_found" || error.code === "forbidden") refresh();
        return false;
      } finally {
        setPending(null);
      }
    },
    [refresh, onRefresh],
  );

  const notify = useCallback((text: string) => setFeedback({ kind: "ok", text }), []);

  const page: OrgPage | null = useMemo(
    () =>
      overview
        ? {
            overview,
            act,
            pending,
            notify,
            version,
            refresh,
            isMe: (pk: string) => pk === overview.publicKey,
          }
        : null,
    [overview, act, pending, notify, version, refresh],
  );
  const ctx = useMemo(
    () => {
      if (!dir) return null;
      // Kode undangan yang dipakai bisa mengubah peran laptop ini: AppState ikut dimuat ulang.
      const reloadAll = async () => {
        refresh();
        onRefresh();
      };
      return makeCtx(dir, act, pending, reloadAll, notify);
    },
    [dir, act, pending, refresh, notify, onRefresh],
  );

  // Hanya orang tanpa departemen yang bukan Tamu yang bisa memakai kode undangan;
  // yang sudah di departemen ditolak Rust (`already_in_department`).
  const canRedeem = !!overview && overview.departmentId === null && !overview.isGuest;
  // Satu aplikasi untuk semua peran: anggota biasa tidak melihat tab yang hanya
  // berguna bagi pengelola. Membuat kode undangan: superadmin dan admin departemen.
  // decideJoinTeamIds hanya memuat departemen terbuka; manageTeamIds dari direktori
  // menutup sisanya (admin departemen yang diarsipkan masih bisa melihat kodenya).
  const canInvite =
    !!overview &&
    (overview.isSuperadmin || overview.decideJoinTeamIds.length > 0 || (dir?.can.manageTeamIds.length ?? 0) > 0);

  const parts = useMemo(() => {
    if (!overview) return [];
    const list: { id: Part; label: string; count?: number }[] = [];
    if (overview.manageOrg) list.push({ id: "users", label: "Pengguna" });
    else list.push({ id: "people", label: "Anggota" });
    if (overview.manageOrg) list.push({ id: "departments", label: "Departemen" });
    if (overview.isSuperadmin || overview.decideJoinTeamIds.length > 0) {
      list.push({ id: "requests", label: "Permintaan bergabung", count: overview.pendingJoinCount });
    }
    if (overview.manageOrg) list.push({ id: "labels", label: "Label" });
    if (canInvite || canRedeem) list.push({ id: "invites", label: "Undangan" });
    return list;
  }, [overview, canInvite, canRedeem]);

  // Tab yang tadi dipilih bisa hilang kalau peran berubah: kembali ke tab pertama.
  const current = parts.find((p) => p.id === part) ?? parts[0];
  const orgName = dir?.org.name ?? state.organization.name;

  return (
    <main className="settings org" aria-labelledby="page-title">
      <header className="page-head">
        <h1 id="page-title" className="page-title">
          Organisasi
        </h1>
        <span className="page-sub">
          {orgName}
          {fingerprint && (
            <>
              <span aria-hidden="true">, </span>
              <span className="org-fp">
                sidik <span className="mono">{fingerprint}</span>
              </span>
            </>
          )}
        </span>
      </header>

      {overviewLive.loading && !overview && (
        <p className="org-pad hint" role="status">
          Memuat data organisasi...
        </p>
      )}
      {!overviewLive.loading && !overview && (
        <div className="org-pad org-narrow" role="alert">
          <ErrorAlert title="Data organisasi belum terbaca">
            <p>{overviewLive.error?.message ?? "Inti Mira tidak mengirim data organisasi."}</p>
            <button type="button" className="btn btn-ghost org-retry" onClick={() => void overviewLive.reload()}>
              Coba lagi
            </button>
          </ErrorAlert>
        </div>
      )}

      {page && current && (
        <>
          {overview?.isSuperadmin && dir && dir.superadminCount < 2 && (
            <div className="org-pad org-narrow">
              <div className="notice">
                <IconAlertTriangle size={18} aria-hidden="true" />
                <div>
                  <strong>Organisasi ini baru punya satu superadmin</strong>
                  <p>
                    Kalau laptop superadmin rusak, hilang, atau orangnya keluar, tidak ada yang bisa membuat departemen,
                    menunjuk admin, atau mengeluarkan orang. Jadikan satu orang lain superadmin lewat Ubah peran.
                  </p>
                  {current.id !== "users" && (
                    <button
                      type="button"
                      className="btn btn-ghost org-retry org-notice-btn"
                      onClick={() => {
                        setPart("users");
                        setFeedback(null);
                      }}
                    >
                      Buka daftar Pengguna
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          <nav className="org-tabs-wrap" aria-label="Bagian organisasi">
            <ul className="org-tabs">
              {parts.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="org-tab"
                    aria-current={current.id === p.id ? "true" : undefined}
                    onClick={() => {
                      setPart(p.id);
                      setFeedback(null);
                    }}
                  >
                    {p.label}
                    {p.count !== undefined && p.count > 0 && (
                      <span className="nav-count">
                        <span aria-hidden="true">{formatCount(p.count)}</span>
                        <span className="sr-only">, {p.count} menunggu</span>
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div className={`org-main org-main-${current.id}`}>
            <div aria-live="polite" className="org-live">
              {overviewLive.error && (
                <p className="hint">
                  Data terbaru belum bisa dibaca ({overviewLive.error.message}). Yang tampil adalah data terakhir.
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
            {current.id === "users" && <UsersPanel page={page} />}
            {current.id === "people" && <PeoplePanel page={page} />}
            {current.id === "departments" && <DepartmentsPanel page={page} />}
            {current.id === "requests" && <JoinRequestsPanel page={page} />}
            {current.id === "labels" && <LabelsPanel page={page} />}
            {current.id === "invites" &&
              (ctx ? (
                <InvitesPanel ctx={ctx} canRedeem={canRedeem} />
              ) : dirLive.loading ? (
                <p className="hint" role="status">
                  Memuat kode undangan...
                </p>
              ) : (
                <ErrorAlert title="Kode undangan belum terbaca">
                  <p>{dirLive.error?.message ?? "Inti Mira tidak mengirim data undangan."}</p>
                  <button type="button" className="btn btn-ghost org-retry" onClick={() => void dirLive.reload()}>
                    Coba lagi
                  </button>
                </ErrorAlert>
              ))}
          </div>
        </>
      )}
    </main>
  );
}
