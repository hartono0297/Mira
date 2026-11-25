// Panel "Anggota proyek" (design/usulan-v0.3.html bagian 5): siapa yang melihat
// board, chat, dan dokumen proyek ini. Pengelola menambah dan mengeluarkan
// anggota; anggota boleh keluar sendiri. Inti Rust tetap memeriksa izinnya.
import { IconLock, IconLogout, IconUserPlus } from "@tabler/icons-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import {
  orgApi,
  subscribeOrg,
  type PersonView,
  type ProjectMembersView,
  type ProjectMemberView,
  type ProjectRole,
} from "../../api/org";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { Avatar } from "../../components/Avatar";
import { BOARD_DETAIL } from "../../i18n/board-detail";
import { NO_DEPARTMENT } from "./format";
import { PeoplePicker } from "./PeoplePicker";
import "./members.css";

export type ProjectMembers = {
  view: ProjectMembersView | null;
  error: AppError | null;
  // Hanya true sebelum data pertama datang.
  loading: boolean;
  reload: () => Promise<void>;
};

// Anggota satu proyek, dimuat ulang saat data organisasi berubah (mira://directory).
// Kalau muat ulang gagal, data terakhir tetap dipakai.
export function useProjectMembers(projectId: string): ProjectMembers {
  const [view, setView] = useState<ProjectMembersView | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await orgApi.projectMembers(projectId);
      if (mine !== seq.current) return;
      setView(next && Array.isArray(next.members) ? next : null);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(toAppError(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
    const stop = subscribeOrg(() => void reload());
    return () => {
      seq.current++;
      stop();
    };
  }, [reload]);

  return { view, error, loading, reload };
}

const GROUPS: ProjectRole[] = ["manager", "member", "guest"];

// Dibaca saat render supaya mengikuti bahasa aktif.
function groupTitle(role: ProjectRole): string {
  const T = BOARD_DETAIL.members;
  return role === "manager" ? T.groupManager : role === "member" ? T.groupMember : T.groupGuest;
}

function memberSub(m: ProjectMemberView): string {
  const T = BOARD_DETAIL.members;
  if (m.role === "guest") return m.byInvite ? T.guestByInvite : T.guestAdded;
  const dept = m.departmentName ?? NO_DEPARTMENT;
  return m.isCreator ? T.creator(dept) : dept;
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  // Kunci publik saya (BoardView.me).
  me: string;
  members: ProjectMembers;
  // Saya baru saja keluar dari proyek ini lewat panel.
  onLeft: () => void;
};

type Pending = { kind: "remove"; member: ProjectMemberView } | { kind: "leave" };

export function ProjectMembersPanel({ open, onOpenChange, projectId, me, members, onLeft }: Props) {
  const { view, error, loading, reload } = members;
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<AppError | null>(null);
  const [announce, setAnnounce] = useState({ text: "", n: 0 });
  const noticeRef = useRef<HTMLParagraphElement>(null);
  // Baris yang tombolnya membuka konfirmasi sudah hilang; fokus dipindah ke ringkasan.
  const [refocus, setRefocus] = useState(0);
  const ids = useId();
  const T = BOARD_DETAIL.members;

  useEffect(() => {
    if (!refocus) return;
    const timer = window.setTimeout(() => {
      // Fokus yang jatuh ke body atau ke wadah dialog (kunci fokus Radix) dianggap hilang.
      const active = document.activeElement;
      if (!active || active === document.body || active.getAttribute("role") === "dialog")
        noticeRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refocus]);

  function say(text: string) {
    setAnnounce((a) => ({ text, n: a.n + 1 }));
  }

  function nameOf(m: ProjectMemberView) {
    return m.publicKey === me ? T.me(m.displayName) : m.displayName;
  }

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setActionError(null);
    const key = pending.kind === "leave" ? me : pending.member.publicKey;
    try {
      await orgApi.removeProjectMember(projectId, key);
      if (pending.kind === "leave") {
        setPending(null);
        onOpenChange(false);
        onLeft();
        return;
      }
      await reload();
      say(T.removedSay(pending.member.displayName));
      setPending(null);
      setRefocus((n) => n + 1);
    } catch (err) {
      setActionError(toAppError(err));
    } finally {
      setBusy(false);
    }
  }

  function openConfirm(next: Pending) {
    setActionError(null);
    setPending(next);
  }

  function body() {
    if (!view && loading) {
      return (
        <p className="hint" role="status">
          {T.loading}
        </p>
      );
    }
    if (!view) {
      return (
        <div role="alert">
          <ErrorAlert title={T.loadErrorTitle}>
            <p>{error?.message ?? T.loadErrorEmpty}</p>
            <button type="button" className="btn btn-ghost btn-sm bd-retry" onClick={() => void reload()}>
              {T.retry}
            </button>
          </ErrorAlert>
        </div>
      );
    }
    if (!view.registered) {
      return <p className="pm-note">{T.notRegistered}</p>;
    }
    const count = view.members.length;
    return (
      <>
        <p className="notice pm-notice" ref={noticeRef} tabIndex={-1}>
          <IconLock size={18} aria-hidden="true" />
          <span>
            {count === 1 && view.members[0]?.publicKey === me ? T.onlyYou : T.onlyN(count)}
          </span>
        </p>
        {error && <p className="hint">{T.stale(error.message)}</p>}
        {GROUPS.map((role) => {
          const rows = view.members
            .filter((m) => m.role === role)
            .sort((a, b) =>
              a.publicKey === me ? -1 : b.publicKey === me ? 1 : a.displayName.localeCompare(b.displayName, "id"),
            );
          if (rows.length === 0) return null;
          const headId = `${ids}-${role}`;
          return (
            <section key={role} className="pm-group" aria-labelledby={headId}>
              <h3 id={headId} className="pm-group-title">
                {groupTitle(role)}
              </h3>
              <ul className="pm-list">
                {rows.map((m) => (
                  <li key={m.publicKey} className="pm-row">
                    <Avatar className="pm-av" name={m.displayName} publicKey={m.publicKey} />
                    <span className="pm-who">
                      <span className="pm-name">{nameOf(m)}</span>
                      <span className="pm-sub">{memberSub(m)}</span>
                    </span>
                    {view.canManage && m.publicKey !== me && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm pm-remove"
                        aria-label={T.removeLabel(m.displayName)}
                        onClick={() => openConfirm({ kind: "remove", member: m })}
                      >
                        {T.remove}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </>
    );
  }

  const removing = pending?.kind === "remove" ? pending.member : null;
  // Keluar membuat proyek kosong, atau tanpa pengelola (proyek tanpa departemen tidak punya
  // admin departemen sebagai pengelola cadangan).
  const managers = view?.members.filter((m) => m.role === "manager") ?? [];
  const leaveOrphans =
    !!view &&
    (view.members.length <= 1 ||
      (view.teamId === null && managers.length === 1 && managers[0].publicKey === me));

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={T.title}>
      <div className="pm-body">{body()}</div>
      <div className="sr-only" role="status" aria-live="polite">
        <span key={announce.n}>{announce.text}</span>
      </div>
      <div className="dlg-actions pm-actions">
        {view?.canLeave && (
          <button type="button" className="btn btn-ghost pm-leave" onClick={() => openConfirm({ kind: "leave" })}>
            <IconLogout size={16} aria-hidden="true" />
            {T.leave}
          </button>
        )}
        {view?.registered && view.canManage && (
          <button type="button" className="btn btn-ghost" onClick={() => setAdding(true)}>
            <IconUserPlus size={16} aria-hidden="true" />
            {T.add}
          </button>
        )}
        <DialogClose asChild>
          <button type="button" className="btn">
            {T.close}
          </button>
        </DialogClose>
      </div>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
        title={removing ? T.confirmRemoveTitle(removing.displayName) : T.confirmLeaveTitle}
        confirmLabel={removing ? T.remove : T.leave}
        busyLabel={removing ? T.removing : T.leaving}
        busy={busy}
        onConfirm={() => void confirm()}
        error={
          actionError && (
            <ErrorAlert title={removing ? T.removeFailed(removing.displayName) : T.leaveFailed}>
              <p>{actionError.message}</p>
            </ErrorAlert>
          )
        }
      >
        {removing ? (
          <>
            <p>
              {T.removeBody(removing.displayName)}
              {removing.byInvite ? ` ${T.removeInvite}` : ""}
            </p>
            <p className="pm-confirm-p">{T.addBack}</p>
          </>
        ) : (
          <>
            <p>{T.leaveBody}</p>
            {leaveOrphans ? (
              <p className="pm-confirm-p">
                {view && view.members.length <= 1 ? T.leaveLast : T.leaveOnlyManager}
              </p>
            ) : (
              <p className="pm-confirm-p">{T.comeBack}</p>
            )}
          </>
        )}
      </ConfirmDialog>

      {view?.canManage && (
        <AddMembersDialog
          open={adding}
          onOpenChange={setAdding}
          projectId={projectId}
          existing={view.members.map((m) => m.publicKey)}
          onAdded={async (names) => {
            await reload();
            if (names.length === 1) say(T.addedOneSay(names[0]));
            else if (names.length > 1) say(T.addedManySay(names.length));
          }}
        />
      )}
    </Dialog>
  );
}

type AddProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  existing: string[];
  onAdded: (names: string[]) => Promise<void>;
};

type PeopleState = { status: "loading" } | { status: "ready"; people: PersonView[] } | { status: "error"; error: AppError };
type Failure = { key: string; name: string; message: string };

// Pemilih orang untuk menambah anggota. Tamu boleh dipilih di sini (D7).
// Orang ditambahkan satu per satu; yang gagal tetap terpilih supaya bisa dicoba lagi.
function AddMembersDialog({ open, onOpenChange, projectId, existing, onAdded }: AddProps) {
  const [people, setPeople] = useState<PeopleState>({ status: "loading" });
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [failures, setFailures] = useState<Failure[]>([]);
  const seq = useRef(0);
  const T = BOARD_DETAIL.addMembers;

  const loadPeople = useCallback(() => {
    const mine = ++seq.current;
    setPeople({ status: "loading" });
    orgApi
      .people()
      .then((list) => {
        if (mine === seq.current) setPeople({ status: "ready", people: Array.isArray(list) ? list : [] });
      })
      .catch((err) => {
        if (mine === seq.current) setPeople({ status: "error", error: toAppError(err) });
      });
  }, []);

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setProblem(null);
    setFailures([]);
    loadPeople();
    return () => {
      seq.current++;
    };
  }, [open, loadPeople]);

  const candidates = people.status === "ready" ? people.people.filter((p) => !existing.includes(p.publicKey)) : [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (selected.length === 0) {
      setProblem(T.pickOne);
      return;
    }
    setProblem(null);
    setFailures([]);
    setBusy(true);
    const byKey = new Map(people.status === "ready" ? people.people.map((p) => [p.publicKey, p.displayName]) : []);
    const added: string[] = [];
    const failed: Failure[] = [];
    for (const key of selected) {
      const name = byKey.get(key) ?? T.someone;
      try {
        await orgApi.addProjectMember(projectId, key);
        added.push(name);
      } catch (err) {
        failed.push({ key, name, message: toAppError(err).message });
      }
    }
    await onAdded(added);
    setBusy(false);
    if (failed.length === 0) {
      onOpenChange(false);
      return;
    }
    setSelected(failed.map((f) => f.key));
    setFailures(failed);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={T.title}
    >
      <form className="pm-add" onSubmit={(e) => void submit(e)} noValidate>
        <p className="dlg-desc">{T.description}</p>
        {people.status === "loading" && (
          <p className="hint" role="status">
            {T.loading}
          </p>
        )}
        {people.status === "error" && (
          <div role="alert">
            <ErrorAlert title={T.loadErrorTitle}>
              <p>{people.error.message}</p>
              <button type="button" className="btn btn-ghost btn-sm bd-retry" onClick={loadPeople}>
                {T.retry}
              </button>
            </ErrorAlert>
          </div>
        )}
        {people.status === "ready" && (
          <PeoplePicker
            people={people.people}
            selected={selected}
            onChange={(keys) => {
              setSelected(keys);
              setProblem(null);
            }}
            exclude={existing}
            disabled={busy}
            label={T.pickerLabel}
            emptyText={T.empty}
          />
        )}
        <div aria-live="polite">
          {problem && <p className="field-error">{problem}</p>}
          {failures.length > 0 && (
            <ErrorAlert title={failures.length === 1 ? T.failedOne(failures[0].name) : T.failedMany(failures.length)}>
              <ul className="pm-fail">
                {failures.map((f) => (
                  <li key={f.key}>
                    {f.name}: {f.message}
                  </li>
                ))}
              </ul>
              <p>{T.keptSelected}</p>
            </ErrorAlert>
          )}
        </div>
        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={busy}>
              {T.cancel}
            </button>
          </DialogClose>
          <button
            type="submit"
            className="btn"
            disabled={busy || people.status !== "ready" || candidates.length === 0}
            aria-busy={busy || undefined}
          >
            {busy ? T.adding : T.submit}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
