import { IconAlertTriangle } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, toAppError, type AppError, type AppState, type Directory, type OrgInfo } from "../../api";
import { actionErrorTitle } from "../../api/messages";
import { orgApi } from "../../api/org";
import { orgScreenApi } from "../../api/orgScreen";
import { ErrorAlert } from "../../components/ErrorAlert";
import { useLang } from "../../i18n/core";
import { KOPI_BOARD_TEXT } from "../../i18n/kopi-board";
import { ORG_TEXT } from "../../i18n/org";
import { makeCtx, type Act, type OrgPage } from "./context";
import { DepartmentsPanel } from "./DepartmentsPanel";
import { InvitesPanel } from "./InvitesPanel";
import { JoinRequestsPanel } from "./JoinRequestsPanel";
import { KopiBoardPanel } from "./KopiBoardPanel";
import { LabelsPanel } from "./LabelsPanel";
import { OtherOfficesNotice } from "./OtherOfficesNotice";
import { PeoplePanel } from "./PeoplePanel";
import { formatCount } from "./usePendingJoinCount";
import { useOrgLive } from "./useOrgLive";
import { UsersPanel } from "./UsersPanel";
import "../settings/settings.css";
import "./nav-count.css";
import "./org.css";

export type Part = "users" | "people" | "departments" | "requests" | "labels" | "invites" | "kopi";

type Feedback = { kind: "ok"; text: string } | { kind: "error"; title: string; error: AppError } | null;

function validDirectory(data: Directory | null): Directory | null {
  return data && typeof data === "object" && Array.isArray(data.members) && Array.isArray(data.teams) ? data : null;
}

function errorHint(error: AppError): string | null {
  if (error.code === "last_superadmin") return ORG_TEXT.lastSuperadminHint;
  if (error.code === "not_found") return ORG_TEXT.screen.notFoundHint;
  if (error.code === "forbidden") return ORG_TEXT.screen.forbiddenHint;
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
  const lang = useLang();
  const T = ORG_TEXT.screen;

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
    const tabs = ORG_TEXT.screen.tabs;
    if (overview.manageOrg) list.push({ id: "users", label: tabs.users });
    else list.push({ id: "people", label: tabs.people });
    if (overview.manageOrg) list.push({ id: "departments", label: tabs.departments });
    if (overview.isSuperadmin || overview.decideJoinTeamIds.length > 0) {
      list.push({ id: "requests", label: tabs.requests, count: overview.pendingJoinCount });
    }
    if (overview.manageOrg) list.push({ id: "labels", label: tabs.labels });
    if (canInvite || canRedeem) list.push({ id: "invites", label: tabs.invites });
    list.push({ id: "kopi", label: KOPI_BOARD_TEXT.tab });
    return list;
    // lang: label tab ikut bahasa aktif.
  }, [overview, canInvite, canRedeem, lang]);

  // Tab yang tadi dipilih bisa hilang kalau peran berubah: kembali ke tab pertama.
  const current = parts.find((p) => p.id === part) ?? parts[0];
  const orgName = dir?.org.name ?? state.organization.name;

  return (
    <main className="settings org" aria-labelledby="page-title">
      <header className="page-head">
        <h1 id="page-title" className="page-title">
          {T.title}
        </h1>
        <span className="page-sub">
          {orgName}
          {fingerprint && (
            <>
              <span aria-hidden="true">, </span>
              <span className="org-fp">
                {T.fingerprint} <span className="mono">{fingerprint}</span>
              </span>
            </>
          )}
        </span>
      </header>

      {overviewLive.loading && !overview && (
        <p className="org-pad hint" role="status">
          {T.loading}
        </p>
      )}
      {!overviewLive.loading && !overview && (
        <div className="org-pad org-narrow" role="alert">
          <ErrorAlert title={T.loadErrorTitle}>
            <p>{overviewLive.error?.message ?? T.loadErrorEmpty}</p>
            <button type="button" className="btn btn-ghost org-retry" onClick={() => void overviewLive.reload()}>
              {ORG_TEXT.retry}
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
                  <strong>{T.oneSuperadminTitle}</strong>
                  <p>{T.oneSuperadminBody}</p>
                  {current.id !== "users" && (
                    <button
                      type="button"
                      className="btn btn-ghost org-retry org-notice-btn"
                      onClick={() => {
                        setPart("users");
                        setFeedback(null);
                      }}
                    >
                      {T.openUsers}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          <OtherOfficesNotice superadmin={!!overview?.isSuperadmin} />

          <nav className="org-tabs-wrap" aria-label={T.tabsAria}>
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
                        <span className="sr-only">{T.waiting(p.count)}</span>
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
                <p className="hint">{ORG_TEXT.stale(overviewLive.error.message)}</p>
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
            {current.id === "kopi" && <KopiBoardPanel page={page} />}
            {current.id === "invites" &&
              (ctx ? (
                <InvitesPanel ctx={ctx} canRedeem={canRedeem} />
              ) : dirLive.loading ? (
                <p className="hint" role="status">
                  {T.invitesLoading}
                </p>
              ) : (
                <ErrorAlert title={T.invitesErrorTitle}>
                  <p>{dirLive.error?.message ?? T.invitesErrorEmpty}</p>
                  <button type="button" className="btn btn-ghost org-retry" onClick={() => void dirLive.reload()}>
                    {ORG_TEXT.retry}
                  </button>
                </ErrorAlert>
              ))}
          </div>
        </>
      )}
    </main>
  );
}
