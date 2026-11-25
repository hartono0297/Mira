import { IconAlertTriangle, IconMessage } from "@tabler/icons-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { divisionApi, type DeptOverview } from "../../api/division";
import { ErrorAlert } from "../../components/ErrorAlert";
import { useLang } from "../../i18n/core";
import { DIVISION_TEXT } from "../../i18n/org-division";
import type { OrgCtx, OrgPage } from "./context";
import { InvitesPanel } from "./InvitesPanel";
import { JoinRequestsPanel } from "./JoinRequestsPanel";
import { ChatSettingsForm } from "./MyDepartmentChatSettings";
import { MyDepartmentDivisions } from "./MyDepartmentDivisions";
import { MyDepartmentHistory } from "./MyDepartmentHistory";
import { MyDepartmentMembers } from "./MyDepartmentMembers";
import { MyDepartmentProjects } from "./MyDepartmentProjects";
import type { DeptCtx } from "./myDepartmentShared";
import { useOrgLive } from "./useOrgLive";
import "./my-department.css";

type Props = {
  page: OrgPage;
  // Direktori lama untuk bagian Kode undangan; null selama belum terbaca.
  ctx: OrgCtx | null;
  // Navigasi ke layar lain. Tanpa pemanggil, tombolnya tidak ditampilkan.
  onOpenChat?: (conv: string) => void;
  onOpenProject?: (projectId: string) => void;
};

function validOverview(data: unknown): DeptOverview | null {
  if (!data || typeof data !== "object") return null;
  const d = data as DeptOverview;
  return Array.isArray(d.members) && Array.isArray(d.divisions) && Array.isArray(d.choices) && d.gate ? d : null;
}

// Tab Departemen saya: departemen yang dikelola (atau tempat orang ini kepala divisi),
// divisinya, permintaan bergabung dan kode undangannya, proyek, channel, dan riwayat admin.
export function MyDepartmentPanel({ page, ctx, onOpenChat, onOpenProject }: Props) {
  const T = DIVISION_TEXT;
  const uid = useId();
  const lang = useLang();
  // null: departemen bawaan dari inti Rust (departemen sendiri atau yang pertama dikelola).
  const [teamId, setTeamId] = useState<string | null>(null);
  const teamRef = useRef(teamId);
  teamRef.current = teamId;
  const live = useOrgLive(() => divisionApi.deptOverview(teamRef.current), { version: page.version });
  const { reload } = live;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void reload();
  }, [teamId, reload]);

  const ov = validOverview(live.data);
  // Data departemen sebelumnya masih tampil sampai departemen pilihan terbaca.
  const switching = !!ov && teamId !== null && ov.teamId !== teamId;
  const dept: DeptCtx | null = useMemo(
    () =>
      ov
        ? {
            page,
            ov,
            busy: page.pending !== null,
            canWrite: ov.gate.open && !ov.archived,
            gateHint: ov.gate.open || ov.archived ? null : T.gate.disabled(ov.gate.since),
            onOpenChat,
          }
        : null,
    // lang: teks gateHint ikut berganti saat bahasa diganti.
    [ov, page, onOpenChat, lang],
  );

  if (!ov || !dept) {
    if (live.loading) {
      return (
        <p className="hint" role="status">
          {T.loading}
        </p>
      );
    }
    if (live.error) {
      return (
        <div role="alert">
          <ErrorAlert title={T.loadErrorTitle}>
            <p>{live.error.message}</p>
            <button type="button" className="btn btn-ghost org-retry" onClick={() => void reload()}>
              {T.retry}
            </button>
          </ErrorAlert>
        </div>
      );
    }
    return (
      <div className="org-empty">
        <p>{T.none}</p>
      </div>
    );
  }

  const blockers = ov.gate.blockers;
  const headOnly = !ov.canManageDept && ov.me.headOf.length > 0;

  return (
    <div className="md-panel">
      <div className="md-top">
        {ov.choices.length > 1 ? (
          <div className="md-picker">
            <label htmlFor={`${uid}-team`} className="md-label">
              {T.pickerLabel}
            </label>
            <select
              id={`${uid}-team`}
              className="md-input md-select"
              value={teamId ?? ov.teamId}
              onChange={(e) => setTeamId(e.target.value)}
            >
              {ov.choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <h2 className="md-team">{ov.teamName}</h2>
        )}
        {switching && (
          <p className="hint" role="status">
            {T.loading}
          </p>
        )}
      </div>

      {live.error && <p className="hint">{T.stale(live.error.message)}</p>}

      {!ov.gate.open && (
        <div className="notice" id="md-gate">
          <IconAlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>{T.gate.title(ov.gate.since)}</strong>
            {blockers.length > 0 ? (
              <>
                <p>{T.gate.body}</p>
                <ul className="md-blockers">
                  {blockers.map((b) => (
                    <li key={b.publicKey}>
                      {b.appVersion ? T.gate.blocker(b.name, b.appVersion) : T.gate.blockerUnreported(b.name)}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>{T.gate.bodyNoList}</p>
            )}
          </div>
        </div>
      )}

      {ov.archived && <p className="notice-plain">{T.archivedDept}</p>}
      {headOnly && <p className="hint md-intro">{T.headIntro}</p>}

      <MyDepartmentDivisions dept={dept} />
      <MyDepartmentMembers dept={dept} />

      {ov.canManageDept && (
        <div className="md-block">
          <JoinRequestsPanel page={page} teamId={ov.teamId} />
        </div>
      )}
      {ov.canManageDept && ctx && (
        <div className="md-block">
          <InvitesPanel ctx={ctx} canRedeem={false} teamId={ov.teamId} />
        </div>
      )}

      <MyDepartmentProjects projects={ov.projects} onOpenProject={onOpenProject} />

      <section className="set-section md-block" aria-labelledby="md-channel-title">
        <div className="org-head">
          <div>
            <h2 id="md-channel-title" className="set-title">
              {T.chat.deptTitle}
            </h2>
            <p className="hint">{T.chat.deptIntro(ov.channel.name)}</p>
          </div>
          {onOpenChat && (
            <button
              type="button"
              className="btn btn-ghost"
              aria-label={T.chat.openChannelAria(ov.channel.name)}
              onClick={() => onOpenChat(ov.channel.conv)}
            >
              <IconMessage size={16} aria-hidden="true" />
              {T.divisions.openChat}
            </button>
          )}
        </div>
        <ChatSettingsForm
          key={ov.teamId}
          dept={dept}
          name={T.chat.channelName(ov.channel.name)}
          divisionId={null}
          settings={ov.channel.settings}
          canEdit={ov.canManageDept && !ov.archived}
        />
      </section>

      {ov.canManageDept && <MyDepartmentHistory events={ov.adminHistory} />}
    </div>
  );
}
