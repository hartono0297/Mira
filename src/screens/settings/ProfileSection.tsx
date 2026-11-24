import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeFeature, toAppError, type AppError, type AppState, type OrgInfo } from "../../api";
import { orgApi, subscribeOrg } from "../../api/org";
import {
  PROFILE_TOPIC,
  profileAdminRemovePhoto,
  profileClearPhoto,
  profileMyPhoto,
  profilePhotos,
  type MyPhoto,
} from "../../api/profile";
import { Avatar } from "../../components/Avatar";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { refreshProfilePhotos } from "../../components/profilePhotos";
import { useChangePhoto } from "../../components/profile/useChangePhoto";
import { PROFILE_TEXT } from "../../i18n/profile";
import { SETTINGS_TEXT } from "../../i18n/settings";

type State = AppState & { organization: OrgInfo };

// Fokus boleh dipindahkan hanya kalau sedang hilang (tombolnya baru saja
// lenyap) atau masih di dialog konfirmasi yang sedang menutup, supaya muat
// ulang dari laptop lain tidak merebut fokus pengguna.
function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected || active.closest('[role="dialog"]') !== null;
}

// Pengaturan > Profil: foto sendiri, dan untuk superadmin daftar foto anggota lain.
export function ProfileSection({ state }: { state: State }) {
  const T = PROFILE_TEXT.section;
  const me = state.identity.publicKey;
  const name = state.identity.displayName ?? "";
  const isSuperadmin = state.organization.role === "superadmin";

  const [mine, setMine] = useState<MyPhoto | null>(null);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [status, setStatus] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<AppError | null>(null);
  const changeRef = useRef<HTMLButtonElement | null>(null);
  // Setelah foto sendiri dihapus tombol Hapus foto hilang; fokus pindah ke Ganti foto.
  const focusChangeNext = useRef(false);

  const load = useCallback(async () => {
    try {
      setMine(await profileMyPhoto());
      setLoadError(null);
    } catch (err) {
      setLoadError(toAppError(err));
    }
  }, []);

  useEffect(() => {
    void load();
    return subscribeFeature(PROFILE_TOPIC, () => void load());
  }, [load]);

  const change = useChangePhoto(() => {
    setStatus(T.saved);
    void load();
  });

  async function remove() {
    if (removing) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await profileClearPhoto();
      await refreshProfilePhotos();
      focusChangeNext.current = true;
      setConfirming(false);
      setStatus(T.removed);
      await load();
    } catch (err) {
      setRemoveError(toAppError(err));
    } finally {
      setRemoving(false);
    }
  }

  const hasPhoto = Boolean(mine?.hash);

  useEffect(() => {
    if (!focusChangeNext.current || hasPhoto) return;
    focusChangeNext.current = false;
    if (focusLost()) changeRef.current?.focus();
  }, [mine, hasPhoto]);

  return (
    <section className="set-section" aria-labelledby="profile-title">
      <h2 id="profile-title" className="set-title">
        {SETTINGS_TEXT.parts.profile}
      </h2>

      <div className="profile-me">
        <Avatar name={name} publicKey={me} size="lg" />
        <div className="profile-me-text">
          <p className="profile-me-name">{name}</p>
          {mine && !hasPhoto && !mine.removedByAdmin && <p className="hint">{T.noPhoto}</p>}
          <div className="profile-actions">
            {/* aria-disabled, bukan disabled: tombol yang dinonaktifkan saat
                berfokus membuang fokusnya, lalu dialog pemotong mencatat body
                sebagai pembuka dan fokus tidak bisa kembali ke sini. */}
            <button
              ref={changeRef}
              type="button"
              className="btn btn-sm"
              onClick={() => {
                if (change.busy) return;
                setStatus("");
                change.start();
              }}
              aria-disabled={change.busy || undefined}
              aria-busy={change.busy || undefined}
            >
              {T.change}
            </button>
            {hasPhoto && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setStatus("");
                  setRemoveError(null);
                  setConfirming(true);
                }}
              >
                {T.remove}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="set-live" aria-live="polite">
        {!mine && !loadError && <p className="hint">{T.loading}</p>}
        {status && <p className="ok-line">{status}</p>}
        {change.error && <ErrorAlert title={T.changeFailed}>{change.error.message}</ErrorAlert>}
      </div>

      {loadError && (
        <ErrorAlert title={T.loadErrorTitle}>
          <p>{loadError.message}</p>
          <button type="button" className="btn btn-ghost btn-sm profile-retry" onClick={() => void load()}>
            {T.retry}
          </button>
        </ErrorAlert>
      )}

      {mine?.removedByAdmin && (
        <div className="notice" role="note">
          <div>
            <strong>{T.removedTitle}</strong>
            <p>{T.removedBody}</p>
          </div>
        </div>
      )}

      <p className="hint">{T.visibleTo}</p>
      <p className="hint">{T.processing}</p>

      {isSuperadmin && <MemberPhotos me={me} />}

      {change.element}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={PROFILE_TEXT.confirmRemove.title}
        confirmLabel={T.remove}
        busyLabel={PROFILE_TEXT.confirmRemove.busy}
        busy={removing}
        onConfirm={() => void remove()}
        error={removeError && <ErrorAlert title={PROFILE_TEXT.confirmRemove.failed}>{removeError.message}</ErrorAlert>}
      >
        {PROFILE_TEXT.confirmRemove.body}
      </ConfirmDialog>
    </section>
  );
}

type Row = { publicKey: string; displayName: string };

// Superadmin: orang lain yang punya foto, masing-masing dengan tombol hapus.
function MemberPhotos({ me }: { me: string }) {
  const T = PROFILE_TEXT.members;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  // target tetap terisi setelah dialog ditutup, supaya judul dan isinya tidak
  // kosong selama dialog menghilang.
  const [target, setTarget] = useState<Row | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState<AppError | null>(null);
  const [status, setStatus] = useState("");
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  // Urutan baris yang dihapus: setelah daftar dimuat ulang fokus pindah ke
  // tombol Hapus foto baris berikutnya (atau sebelumnya), atau ke judul.
  const focusIndexNext = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [people, photos] = await Promise.all([orgApi.people(), profilePhotos()]);
      const owners = new Set(photos.map((p) => p.owner));
      const next = people
        .filter((p) => p.publicKey !== me && owners.has(p.publicKey))
        .map((p) => ({ publicKey: p.publicKey, displayName: p.displayName }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName, "id"));
      setRows(next);
      setLoadError(null);
    } catch (err) {
      setLoadError(toAppError(err));
    }
  }, [me]);

  useEffect(() => {
    void load();
    const stopFeature = subscribeFeature(PROFILE_TOPIC, () => void load());
    const stopOrg = subscribeOrg(() => void load());
    return () => {
      stopFeature();
      stopOrg();
    };
  }, [load]);

  useEffect(() => {
    const index = focusIndexNext.current;
    if (index === null || !rows) return;
    focusIndexNext.current = null;
    if (!focusLost()) return;
    const row = rows[Math.min(index, rows.length - 1)];
    const next = row ? buttons.current.get(row.publicKey) : null;
    if (next) next.focus();
    else headingRef.current?.focus();
  }, [rows]);

  async function remove() {
    if (!target || busy) return;
    setBusy(true);
    setRemoveError(null);
    try {
      await profileAdminRemovePhoto(target.publicKey);
      await refreshProfilePhotos();
      setStatus(T.removed(target.displayName));
      const index = rows?.findIndex((r) => r.publicKey === target.publicKey) ?? -1;
      focusIndexNext.current = Math.max(index, 0);
      setConfirmOpen(false);
      await load();
    } catch (err) {
      setRemoveError(toAppError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="profile-members" aria-labelledby="member-photos-title">
      <h3 id="member-photos-title" className="set-sub" ref={headingRef} tabIndex={-1}>
        {T.heading}
      </h3>
      <p className="hint">{T.intro}</p>
      <div className="set-live" aria-live="polite">
        {!rows && !loadError && <p className="hint">{T.loading}</p>}
        {status && <p className="ok-line">{status}</p>}
      </div>
      {loadError && (
        <ErrorAlert title={T.loadErrorTitle}>
          <p>{loadError.message}</p>
          <button type="button" className="btn btn-ghost btn-sm profile-retry" onClick={() => void load()}>
            {PROFILE_TEXT.section.retry}
          </button>
        </ErrorAlert>
      )}
      {rows && rows.length === 0 && <p className="hint">{T.empty}</p>}
      {rows && rows.length > 0 && (
        <ul className="member-photo-list">
          {rows.map((row) => (
            <li key={row.publicKey}>
              <Avatar name={row.displayName} publicKey={row.publicKey} size="md" />
              <span className="member-photo-name">{row.displayName}</span>
              <button
                ref={(node) => {
                  if (node) buttons.current.set(row.publicKey, node);
                  else buttons.current.delete(row.publicKey);
                }}
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={T.removeLabel(row.displayName)}
                onClick={() => {
                  setStatus("");
                  setRemoveError(null);
                  setTarget(row);
                  setConfirmOpen(true);
                }}
              >
                {PROFILE_TEXT.section.remove}
              </button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={target ? T.confirmTitle(target.displayName) : ""}
        confirmLabel={PROFILE_TEXT.section.remove}
        busyLabel={PROFILE_TEXT.confirmRemove.busy}
        busy={busy}
        onConfirm={() => void remove()}
        error={removeError && <ErrorAlert title={PROFILE_TEXT.confirmRemove.failed}>{removeError.message}</ErrorAlert>}
      >
        {target && T.confirmBody(target.displayName)}
      </ConfirmDialog>
    </section>
  );
}
