import { IconChevronDown, IconDoorExit, IconLoader2 } from "@tabler/icons-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { chatApi, type GroupMemberView, type GroupView } from "../../api/chat";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { initials } from "../../components/initials";
import { GROUP_PICK_MAX, groupNameError, InlineError, normalizeGroupName, GROUP_NAME_MAX } from "./NewGroupDialog";
import { PeoplePicker, usePeopleDirectory } from "./PeoplePicker";
import { PersonName } from "./PersonName";

export type GroupState = {
  group: GroupView | null;
  loading: boolean;
  error: AppError | null;
  reload: () => Promise<void>;
};

// Data grup (anggota, kandidat, hak). conv null: bukan grup, tidak memuat apa pun.
// refreshKey berubah saat ringkasan berubah (jumlah anggota, nama), lalu dimuat ulang.
export function useGroupView(conv: string | null, refreshKey: string): GroupState {
  const [group, setGroup] = useState<GroupView | null>(null);
  const [loading, setLoading] = useState(conv !== null);
  const [error, setError] = useState<AppError | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const n = ++seq.current;
    if (!conv) {
      setGroup(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await chatApi.group(conv);
      if (n === seq.current) setGroup(next);
    } catch (err) {
      if (n === seq.current) setError(toAppError(err));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [conv]);

  useEffect(() => {
    void reload();
    return () => {
      // Jawaban yang datang sesudah ganti percakapan atau unmount diabaikan.
      seq.current++;
    };
  }, [reload, refreshKey]);

  return { group, loading, error, reload };
}

type MembersProps = {
  memberCount: number;
  title: string;
  state: GroupState;
  onChanged: () => void;
  onGone: () => void;
};

// Tombol "Grup · N anggota" dan daftar anggota yang terbuka di bawahnya.
export function GroupMembers({ memberCount, title, state, onChanged, onGone }: MembersProps) {
  const [open, setOpen] = useState(false);
  const [toRemove, setToRemove] = useState<GroupMemberView | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<AppError | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();
  const departments = usePeopleDirectory(open);
  const alive = useRef(true);
  const dialogOpen = toRemove !== null || leaving;
  const dialogOpenRef = useRef(dialogOpen);
  dialogOpenRef.current = dialogOpen;
  const { group, loading, error, reload } = state;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    void reload();
    function onDown(e: MouseEvent) {
      if (dialogOpenRef.current) return;
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // reload sengaja tidak jadi dependensi: dimuat ulang sekali setiap panel dibuka.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close(focusButton: boolean) {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }

  async function removeMember() {
    if (!toRemove || !group) return;
    setBusy(true);
    setActionError(null);
    try {
      await chatApi.groupRemove(group.conv, toRemove.person.publicKey);
      if (!alive.current) return;
      setToRemove(null);
      void reload();
      onChanged();
    } catch (err) {
      if (alive.current) setActionError(toAppError(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function leave() {
    if (!group) return;
    setBusy(true);
    setActionError(null);
    try {
      await chatApi.groupLeave(group.conv);
      if (!alive.current) return;
      setLeaving(false);
      setOpen(false);
      onChanged();
      onGone();
    } catch (err) {
      if (alive.current) setActionError(toAppError(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const members = group?.members ?? [];
  const count = group ? members.length : memberCount;
  const iAmOwner = members.some((m) => m.me && m.owner);
  const removeName = toRemove?.person.name ?? "";

  let content;
  if (!group && loading) {
    content = (
      <p className="conv-group-state" role="status">
        <IconLoader2 size={16} className="conv-spin" aria-hidden="true" />
        Memuat anggota...
      </p>
    );
  } else if (!group) {
    content = (
      <ErrorAlert title="Daftar anggota belum bisa dimuat">
        <p>{error?.message}</p>
        <button
          type="button"
          className="btn btn-ghost btn-sm conv-retry"
          onClick={() => void reload()}
          disabled={loading}
          aria-busy={loading || undefined}
        >
          {loading ? "Memuat ulang..." : "Coba lagi"}
        </button>
      </ErrorAlert>
    );
  } else if (members.length === 0) {
    content = <p className="conv-group-state">Belum ada anggota yang tercatat di grup ini.</p>;
  } else {
    content = (
      <ul className="conv-members">
        {members.map((m) => {
          const department = departments.get(m.person.publicKey);
          return (
            <li key={m.person.publicKey} className="conv-member">
              <span className="pick-av" aria-hidden="true">
                {initials(m.person.name)}
              </span>
              <span className="pick-who">
                <span className="pick-name">
                  <PersonName person={m.person} me={m.me} />
                </span>
                {department && <span className="pick-dept-line">{department}</span>}
              </span>
              {m.owner && <span className="chip chip-on">Pemilik grup</span>}
              {m.canRemove && (
                <button
                  type="button"
                  className="conv-member-remove"
                  aria-label={`Keluarkan ${m.person.name} dari grup`}
                  onClick={() => {
                    setActionError(null);
                    setToRemove(m);
                  }}
                >
                  Keluarkan
                </button>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="conv-group-wrap">
      <button
        ref={buttonRef}
        type="button"
        className="conv-members-btn"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        Grup · {memberCount} anggota
        <IconChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="conv-group-pop"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close(true);
            }
          }}
        >
          <p id={titleId} className="conv-pop-title">
            Anggota grup ({count})
          </p>
          {group && error && (
            <p className="conv-group-stale" role="status">
              Daftar terbaru belum bisa dimuat. Yang tampil adalah daftar terakhir.
            </p>
          )}
          {content}
          {group?.canLeave && !group.former && (
            <>
              <hr className="conv-group-sep" />
              <button
                type="button"
                className="conv-leave"
                onClick={() => {
                  setActionError(null);
                  setLeaving(true);
                }}
              >
                <IconDoorExit size={16} aria-hidden="true" />
                Keluar dari grup
              </button>
            </>
          )}
        </div>
      )}
      <ConfirmDialog
        open={toRemove !== null}
        onOpenChange={(next) => {
          if (!next) setToRemove(null);
        }}
        title={`Keluarkan ${removeName} dari grup?`}
        confirmLabel="Keluarkan"
        busyLabel="Mengeluarkan..."
        busy={busy}
        onConfirm={() => void removeMember()}
        error={
          actionError && (
            <ErrorAlert title={`${removeName} belum dikeluarkan`}>
              <p>{actionError.message}</p>
            </ErrorAlert>
          )
        }
      >
        <p>
          {removeName} tidak menerima pesan baru lagi; pesan lama tetap di laptopnya.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title={`Keluar dari grup ${title}?`}
        confirmLabel="Keluar dari grup"
        busyLabel="Keluar..."
        busy={busy}
        onConfirm={() => void leave()}
        error={
          actionError && (
            <ErrorAlert title="Anda belum keluar dari grup">
              <p>{actionError.message}</p>
            </ErrorAlert>
          )
        }
      >
        <p>
          Pesan baru di grup ini tidak dikirim lagi ke laptop Anda; pesan lama tetap tersimpan di sini. Untuk masuk lagi,
          anggota grup perlu menambahkan Anda.
        </p>
        {iAmOwner && members.length > 1 && (
          <p>Peran pemilik grup pindah ke anggota yang paling lama di grup.</p>
        )}
      </ConfirmDialog>
    </div>
  );
}

type AddProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: GroupView;
  onAdded: () => void;
};

// "Tambah orang": pemilih yang sama dengan Grup baru, atas kandidat dari inti Rust.
export function AddPeopleDialog({ open, onOpenChange, group, onAdded }: AddProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const departments = usePeopleDirectory(open);

  const pickError =
    selected.length === 0
      ? "Pilih minimal satu orang."
      : selected.length > GROUP_PICK_MAX
        ? `Paling banyak ${GROUP_PICK_MAX} orang sekaligus.`
        : null;

  function reset() {
    setSelected([]);
    setTried(false);
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setTried(true);
    if (pickError) return;
    setBusy(true);
    setError(null);
    try {
      await chatApi.groupAdd(group.conv, selected);
      reset();
      onAdded();
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(false);
    }
  }

  const count = selected.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) reset();
        onOpenChange(next);
      }}
      title={`Tambah orang ke ${group.name}`}
    >
      <form className="group-form" onSubmit={(e) => void submit(e)} noValidate>
        <PeoplePicker
          people={group.candidates}
          departments={departments}
          selected={selected}
          onChange={setSelected}
          disabled={busy}
          emptyText="Semua rekan yang bisa dimasukkan sudah ada di grup ini. Tamu tidak bisa dimasukkan ke grup."
          hint={
            count === 0
              ? "Orang yang ditambahkan bisa membaca pesan lama di grup ini."
              : `${count} orang dipilih. Orang yang ditambahkan bisa membaca pesan lama di grup ini.`
          }
        />
        <div aria-live="polite">
          {tried && pickError && group.candidates.length > 0 && <InlineError text={pickError} />}
          {error && (
            <ErrorAlert title="Orang belum ditambahkan">
              <p>{error.message}</p>
            </ErrorAlert>
          )}
        </div>
        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={busy}>
              Batal
            </button>
          </DialogClose>
          {group.candidates.length > 0 && (
            <button
              type="submit"
              className="btn"
              aria-disabled={!!pickError || undefined}
              aria-busy={busy || undefined}
              disabled={busy}
            >
              {busy ? "Menambahkan..." : "Tambah ke grup"}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

type RenameProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conv: string;
  name: string;
  onRenamed: () => void;
};

export function RenameGroupDialog({ open, onOpenChange, conv, name, onRenamed }: RenameProps) {
  const [value, setValue] = useState(name);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const ids = useId();

  // Setiap kali dibuka, kolom diisi nama sekarang.
  useEffect(() => {
    if (open) {
      setValue(name);
      setTried(false);
      setError(null);
    }
  }, [open, name]);

  const nameError = groupNameError(value);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setTried(true);
    if (nameError) return;
    const next = normalizeGroupName(value);
    if (next === name) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await chatApi.groupRename(conv, next);
      onRenamed();
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title="Ganti nama grup"
      description="Nama baru terlihat oleh semua anggota grup."
    >
      <form className="group-form" onSubmit={(e) => void submit(e)} noValidate>
        <div className="field">
          <label htmlFor={`${ids}-name`}>Nama grup</label>
          <input
            id={`${ids}-name`}
            type="text"
            autoComplete="off"
            maxLength={GROUP_NAME_MAX}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={tried && !!nameError}
            aria-describedby={tried && nameError ? `${ids}-error` : undefined}
            disabled={busy}
          />
          {tried && nameError && <InlineError id={`${ids}-error`} text={nameError} />}
        </div>
        <div aria-live="polite">
          {error && (
            <ErrorAlert title="Nama grup belum diganti">
              <p>{error.message}</p>
            </ErrorAlert>
          )}
        </div>
        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={busy}>
              Batal
            </button>
          </DialogClose>
          <button type="submit" className="btn" disabled={busy} aria-busy={busy || undefined}>
            {busy ? "Menyimpan..." : "Simpan nama"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
