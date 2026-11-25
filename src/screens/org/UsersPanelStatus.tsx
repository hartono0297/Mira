// 0.5.1: status nonaktif dan dialog Nonaktifkan, Aktifkan lagi, Keluarkan permanen.
// Dipakai tab Pengguna (superadmin dan admin departemen). Boleh tidaknya setiap
// aksi dihitung inti Rust per laptop yang melihat (canSuspend, canReinstate,
// canRemove); layar hanya mengikuti tanda itu.
import { IconUserPause } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { formatDate } from "../../api/format";
import { actionErrorTitle } from "../../api/messages";
import { orgApi, type SuspendGate, type UserView } from "../../api/org";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { ORG_TEXT, USERS_TEXT as T } from "../../i18n/org";
import type { OrgPage } from "./context";
import { orgMessage } from "./PeoplePanel";

// Yang dibutuhkan dialog dan penanda status.
export type StatusTarget = Pick<UserView, "publicKey" | "displayName"> &
  Partial<Pick<UserView, "status" | "suspendedAt" | "suspendedByName" | "canSuspend" | "canReinstate" | "canRemove">>;

export function ErrorBox({ error, title }: { error: AppError; title: string }) {
  return (
    <ErrorAlert title={actionErrorTitle(error, title)}>
      <p>{orgMessage(error.message)}</p>
      {error.code === "last_superadmin" && <p>{ORG_TEXT.lastSuperadminHint}</p>}
    </ErrorAlert>
  );
}

export function DialogError({ error, title }: { error: AppError | null; title: string }) {
  return <div aria-live="polite">{error && <ErrorBox error={error} title={title} />}</div>;
}

export function suspendedSince(u: StatusTarget): string {
  return T.suspended.since(u.suspendedAt ? formatDate(u.suspendedAt) : "", u.suspendedByName ?? null);
}

// Penanda "Nonaktif": ikon dan teks, bukan warna saja, lalu kapan dan oleh siapa.
export function SuspendedStatus({ u }: { u: StatusTarget }) {
  return (
    <span className="users-susp">
      <span className="users-chip">
        <IconUserPause size={14} aria-hidden="true" />
        {T.suspended.chip}
      </span>
      <span className="users-susp-since">{suspendedSince(u)}</span>
    </span>
  );
}

type GateState = { kind: "loading" } | { kind: "ready"; gate: SuspendGate } | { kind: "error" };

// Gerbang versi dibaca setiap kali dialog dibuka: laptop bisa diperbarui kapan saja.
function useSuspendGate(enabled: boolean): GateState {
  const [state, setState] = useState<GateState>({ kind: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    orgApi
      .suspendGate()
      .then((gate) => {
        if (!alive) return;
        setState(gate && Array.isArray(gate.outdated) ? { kind: "ready", gate } : { kind: "error" });
      })
      .catch(() => {
        if (alive) setState({ kind: "error" });
      });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return state;
}

function blockedText(gate: SuspendGate): string {
  if (gate.outdated.length === 0) return T.takeOut.gateBlockedUnknown;
  const who = gate.outdated.map(
    (o) => `${o.name} (${o.appVersion ? T.takeOut.version(o.appVersion) : T.takeOut.versionUnknown})`,
  );
  return T.takeOut.gateBlocked(joinList(who, T.takeOut.and));
}

// "A", "A dan B", "A, B, dan C" (atau "and" dalam bahasa Inggris).
function joinList(items: string[], and: string): string {
  if (items.length <= 2) return items.join(` ${and} `);
  return `${items.slice(0, -1).join(", ")}, ${and} ${items[items.length - 1]}`;
}

export type StatusDone = "suspended" | "reinstated" | "removed";

type DialogProps = {
  user: StatusTarget;
  page: OrgPage;
  onClose: () => void;
  onDone: (user: StatusTarget, result: StatusDone) => void;
};

type Choice = "suspend" | "remove";

// Mengeluarkan orang aktif: Nonaktifkan (bisa dibatalkan) atau Keluarkan
// permanen. Pilihan yang tidak boleh untuk laptop ini tidak ditampilkan.
export function TakeOutDialog({
  user,
  page,
  onClose,
  onDone,
  allowSuspend,
  allowRemove,
}: DialogProps & { allowSuspend: boolean; allowRemove: boolean }) {
  const gate = useSuspendGate(allowSuspend);
  const groupName = useId();
  const noteId = useId();
  const [picked, setPicked] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const name = user.displayName;
  const both = allowSuspend && allowRemove;

  // Kalau gerbang tidak terbaca, Nonaktifkan tetap boleh dicoba: inti Rust memeriksa lagi.
  const suspendOpen = allowSuspend && (gate.kind === "error" || (gate.kind === "ready" && gate.gate.allowed));
  const gateNote = !allowSuspend
    ? null
    : gate.kind === "loading"
      ? T.takeOut.gateLoading
      : gate.kind === "error"
        ? T.takeOut.gateError
        : gate.gate.allowed
          ? null
          : blockedText(gate.gate);
  // Selama Nonaktifkan belum bisa dipilih (gerbang dimuat atau terhalang), fokus
  // awal di Batal, bukan di pilihan Keluarkan permanen yang tidak bisa dibatalkan.
  const suspendWaiting = allowSuspend && (gate.kind === "loading" || (gate.kind === "ready" && !gate.gate.allowed));
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Bawaan: pilihan yang bisa dibatalkan. Keluar permanen harus dipilih sendiri.
  const fallback: Choice | null = suspendOpen ? "suspend" : !allowSuspend && allowRemove ? "remove" : null;
  const choice: Choice | null = picked === "suspend" && !suspendOpen ? fallback : (picked ?? fallback);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!choice || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (choice === "suspend") await orgApi.suspendMember(user.publicKey);
      else await orgApi.removeMember(user.publicKey);
      page.notify(choice === "suspend" ? T.takeOut.doneSuspend(name) : T.removeForGood.done(name));
      page.refresh();
      onDone(user, choice === "suspend" ? "suspended" : "removed");
    } catch (err) {
      setError(toAppError(err));
      setBusy(false);
    }
  }

  const title = both ? T.takeOut.titleBoth(name) : allowSuspend ? T.takeOut.titleSuspend(name) : T.removeForGood.title(name);
  const submitLabel = busy
    ? choice === "suspend"
      ? T.takeOut.suspending
      : T.removeForGood.busy
    : choice === "suspend" || (!both && allowSuspend)
      ? T.takeOut.submitSuspend(name)
      : choice === "remove"
        ? T.removeForGood.confirm(name)
        : T.takeOut.choose;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={title}
      onOpenAutoFocus={(e) => {
        if (!suspendWaiting) return;
        e.preventDefault();
        cancelRef.current?.focus();
      }}
    >
      <form className="dlg-form" onSubmit={(e) => void submit(e)}>
        {both ? (
          <fieldset className="role-set">
            <legend className="users-legend">{T.takeOut.legend}</legend>
            <label className={suspendOpen ? "role-opt" : "role-opt role-opt-off"}>
              <input
                type="radio"
                name={groupName}
                value="suspend"
                checked={choice === "suspend"}
                disabled={!suspendOpen || busy}
                aria-describedby={gateNote ? noteId : undefined}
                onChange={() => setPicked("suspend")}
              />
              <span>
                <span className="role-title">{T.takeOut.suspend}</span>
                <span className="role-desc">{T.takeOut.suspendDesc(name)}</span>
                {gateNote && (
                  <span id={noteId} className="role-note">
                    {gateNote}
                  </span>
                )}
              </span>
            </label>
            <label className="role-opt">
              <input
                type="radio"
                name={groupName}
                value="remove"
                checked={choice === "remove"}
                disabled={busy}
                onChange={() => setPicked("remove")}
              />
              <span>
                <span className="role-title">{T.takeOut.remove}</span>
                <span className="role-desc">{T.removeForGood.effect(name)}</span>
                <span className="role-desc">{T.removeForGood.data(name)}</span>
              </span>
            </label>
          </fieldset>
        ) : allowSuspend ? (
          <div className="dlg-desc">
            <p>{T.takeOut.suspendDesc(name)}</p>
            {gateNote && <p className="users-gate">{gateNote}</p>}
          </div>
        ) : (
          <div className="dlg-desc">
            <p>{T.removeForGood.effect(name)}</p>
            <p>{T.removeForGood.data(name)}</p>
          </div>
        )}
        <DialogError
          error={error}
          title={choice === "remove" ? T.removeForGood.failTitle(name) : T.takeOut.failSuspend(name)}
        />
        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={busy} ref={cancelRef}>
              {T.cancel}
            </button>
          </DialogClose>
          <button
            type="submit"
            className={choice === "remove" ? "btn btn-danger" : "btn"}
            disabled={busy || !choice}
            aria-busy={busy || undefined}
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ReinstateDialog({ user, page, onClose, onDone }: DialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const name = user.displayName;

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await orgApi.reinstateMember(user.publicKey);
      page.notify(T.reinstate.done(name));
      page.refresh();
      onDone(user, "reinstated");
    } catch (err) {
      setError(toAppError(err));
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={T.reinstate.title(name)}
      confirmLabel={T.reinstate.confirm(name)}
      busyLabel={T.reinstate.busy}
      busy={busy}
      danger={false}
      onConfirm={() => void confirm()}
      error={error && <ErrorBox error={error} title={T.reinstate.failTitle(name)} />}
    >
      <p>{T.reinstate.body(name)}</p>
      <p>{T.reinstate.gone(name)}</p>
    </ConfirmDialog>
  );
}

// Orang yang sedang nonaktif dikeluarkan permanen (superadmin).
export function RemoveForGoodDialog({ user, page, onClose, onDone }: DialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const name = user.displayName;

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await orgApi.removeMember(user.publicKey);
      page.notify(T.removeForGood.done(name));
      page.refresh();
      onDone(user, "removed");
    } catch (err) {
      setError(toAppError(err));
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={T.removeForGood.title(name)}
      confirmLabel={T.removeForGood.confirm(name)}
      busyLabel={T.removeForGood.busy}
      busy={busy}
      onConfirm={() => void confirm()}
      error={error && <ErrorBox error={error} title={T.removeForGood.failTitle(name)} />}
    >
      <p>{T.removeForGood.effect(name)}</p>
      <p>{T.removeForGood.data(name)}</p>
    </ConfirmDialog>
  );
}
