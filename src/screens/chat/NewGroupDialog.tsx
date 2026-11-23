import { IconAlertCircle } from "@tabler/icons-react";
import { useId, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { chatApi, type ConversationSummary, type Person } from "../../api/chat";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { PeoplePicker, usePeopleDirectory } from "./PeoplePicker";
import "./conversation.css";

export const GROUP_NAME_MAX = 50;
// Batas inti Rust: paling banyak 99 orang per op grup.
export const GROUP_PICK_MAX = 99;

// Nama grup seperti yang disimpan inti Rust: trim dan spasi berulang jadi satu.
export function normalizeGroupName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// Pesan untuk kolom nama grup, atau null kalau nama boleh dipakai.
export function groupNameError(value: string): string | null {
  const name = normalizeGroupName(value);
  if (!name) return "Isi nama grup.";
  if ([...name].length > GROUP_NAME_MAX) return `Nama grup paling panjang ${GROUP_NAME_MAX} karakter.`;
  return null;
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Rekan yang bisa dimasukkan: anggota aktif bukan Tamu, tanpa saya (ChatOverview.people).
  people: Person[];
  onCreated: (summary: ConversationSummary) => void;
};

export function NewGroupDialog({ open, onOpenChange, people, onCreated }: Props) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const departments = usePeopleDirectory(open);
  const ids = useId();

  const nameError = groupNameError(name);
  const pickError =
    selected.length === 0
      ? "Pilih minimal satu orang."
      : selected.length > GROUP_PICK_MAX
        ? `Paling banyak ${GROUP_PICK_MAX} orang sekaligus.`
        : null;
  const ready = !nameError && !pickError;

  function reset() {
    setName("");
    setSelected([]);
    setTried(false);
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setTried(true);
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const summary = await chatApi.createGroup(normalizeGroupName(name), selected);
      reset();
      onCreated(summary);
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
      title="Grup baru"
      description="Grup untuk percakapan dengan beberapa rekan dari departemen mana pun. Hanya anggota grup yang menerima pesannya."
    >
      <form className="group-form" onSubmit={(e) => void submit(e)} noValidate>
        <div className="field">
          <label htmlFor={`${ids}-name`}>Nama grup</label>
          <input
            id={`${ids}-name`}
            type="text"
            autoComplete="off"
            maxLength={GROUP_NAME_MAX}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={tried && !!nameError}
            aria-describedby={tried && nameError ? `${ids}-name-error` : undefined}
            disabled={busy}
          />
          {tried && nameError && <InlineError id={`${ids}-name-error`} text={nameError} />}
        </div>

        <PeoplePicker
          people={people}
          departments={departments}
          selected={selected}
          onChange={setSelected}
          disabled={busy}
          emptyText="Belum ada rekan lain yang bisa dimasukkan ke grup. Tamu tidak bisa dimasukkan ke grup."
          hint={
            count === 0
              ? "Belum ada yang dipilih. Tamu tidak bisa dimasukkan ke grup."
              : `${count} orang dipilih, ditambah Anda. Tamu tidak bisa dimasukkan ke grup.`
          }
        />
        <div aria-live="polite">{tried && pickError && people.length > 0 && <InlineError text={pickError} />}</div>

        <div aria-live="polite">
          {error && (
            <ErrorAlert title="Grup belum dibuat">
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
          <button
            type="submit"
            className="btn"
            aria-disabled={!ready || undefined}
            aria-busy={busy || undefined}
            disabled={busy}
          >
            {busy ? "Membuat grup..." : "Buat grup"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// Seperti FieldError, dengan id untuk aria-describedby.
export function InlineError({ id, text }: { id?: string; text: string }) {
  return (
    <p id={id} className="field-error">
      <IconAlertCircle size={16} aria-hidden="true" />
      {text}
    </p>
  );
}
