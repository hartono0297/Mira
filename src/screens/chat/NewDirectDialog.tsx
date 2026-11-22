import { useId, useState } from "react";
import { toAppError, type AppError } from "../../api";
import { chatApi, type ConversationSummary, type Person } from "../../api/chat";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { initials } from "../../components/initials";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  people: Person[];
  onOpened: (summary: ConversationSummary) => void;
};

// Pesan baru: cari rekan lalu pilih. Chat pribadi yang sudah ada dibuka lagi, bukan dibuat dobel.
export function NewDirectDialog({ open, onOpenChange, people, onOpened }: Props) {
  const [query, setQuery] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const searchId = useId();
  const countId = useId();

  const q = query.trim().toLowerCase();
  const shown = [...people]
    .sort((a, b) => a.name.localeCompare(b.name, "id"))
    .filter((p) => !q || p.name.toLowerCase().includes(q));

  function reset() {
    setQuery("");
    setError(null);
  }

  async function pick(person: Person) {
    if (busyKey) return;
    setBusyKey(person.publicKey);
    setError(null);
    try {
      const summary = await chatApi.openDm(person.publicKey);
      reset();
      onOpened(summary);
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busyKey) return;
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Pesan baru"
      description="Pilih rekan untuk chat pribadi. Hanya Anda berdua yang bisa membacanya."
    >
      {people.length === 0 ? (
        <p className="chat-note">
          Belum ada rekan lain di kantor ini. Undang rekan dari menu Organisasi, lalu chat pribadi bisa dimulai.
        </p>
      ) : (
        <>
          <div className="field">
            <label htmlFor={searchId}>Cari rekan</label>
            <input
              id={searchId}
              type="search"
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-describedby={countId}
            />
            <p id={countId} className="sr-only" aria-live="polite">
              {shown.length} rekan
            </p>
          </div>
          {shown.length > 0 ? (
            <ul className="chat-people" aria-label="Rekan">
              {shown.map((p) => (
                <li key={p.publicKey}>
                  <button
                    type="button"
                    className="chat-person"
                    onClick={() => void pick(p)}
                    disabled={busyKey !== null}
                    aria-busy={busyKey === p.publicKey || undefined}
                  >
                    <span className="chat-av" aria-hidden="true">
                      {initials(p.name)}
                    </span>
                    <span className="chat-person-name">{p.name}</span>
                    {busyKey === p.publicKey && <span className="chat-person-busy">Membuka...</span>}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="chat-note">Tidak ada rekan bernama "{query.trim()}".</p>
          )}
        </>
      )}
      <div aria-live="polite">
        {error && (
          <ErrorAlert title="Chat pribadi belum terbuka">
            <p>{error.message}</p>
          </ErrorAlert>
        )}
      </div>
      <div className="dlg-actions">
        <DialogClose asChild>
          <button type="button" className="btn btn-ghost" disabled={busyKey !== null}>
            Batal
          </button>
        </DialogClose>
      </div>
    </Dialog>
  );
}
