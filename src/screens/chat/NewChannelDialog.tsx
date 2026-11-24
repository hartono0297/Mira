import { useId, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { chatApi, type ConversationSummary } from "../../api/chat";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { CHAT_DIALOGS } from "../../i18n/chat-dialogs";
import { MAX_CHANNEL_NAME, normalizeChannelName } from "./ListFormat";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (summary: ConversationSummary) => void;
};

function serverTitle(error: AppError): string {
  if (error.code === "forbidden") return CHAT_DIALOGS.newChannel.forbidden;
  return CHAT_DIALOGS.newChannel.failed;
}

// Channel umum baru (v0.3: hanya superadmin, hanya bagian Umum). Channel departemen dan proyek
// dibuat otomatis oleh Mira. Nama dirapikan dengan aturan yang sama dengan inti Rust.
export function NewChannelDialog({ open, onOpenChange, onCreated }: Props) {
  const T = CHAT_DIALOGS.newChannel;
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [server, setServer] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const previewId = useId();
  const errId = useId();
  const lockId = useId();

  const normalized = normalizeChannelName(name);

  function reset() {
    setName("");
    setNameError(null);
    setServer(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setServer(null);
    if (!normalized) {
      setNameError(
        name.trim() ? T.nameNoChars : T.nameEmpty,
      );
      nameRef.current?.focus();
      return;
    }
    setNameError(null);
    setBusy(true);
    try {
      const summary = await chatApi.createChannel(normalized, { kind: "org", id: null });
      reset();
      onCreated(summary);
    } catch (err) {
      const error = toAppError(err);
      if (error.code === "invalid_input" && /nama|name/i.test(error.message)) {
        setNameError(error.message);
        nameRef.current?.focus();
      } else {
        setServer(error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) reset();
        onOpenChange(next);
      }}
      title={T.title}
      description={T.description}
    >
      <form className="chat-form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={nameId}>{T.nameLabel}</label>
          <input
            ref={nameRef}
            id={nameId}
            autoComplete="off"
            spellCheck={false}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={`${previewId} ${errId} ${lockId}`}
            readOnly={busy}
          />
          <p id={previewId} className="hint">
            {normalized ? (
              <>
                {T.previewAs}
                <strong className="chat-preview">#{normalized}</strong>
              </>
            ) : (
              T.rules(MAX_CHANNEL_NAME)
            )}
          </p>
          <div id={errId} aria-live="polite">
            {nameError && <FieldError text={nameError} />}
          </div>
        </div>
        <p id={lockId} className="hint">
          {T.lockHint}
        </p>
        <div aria-live="polite">
          {server && (
            <ErrorAlert title={serverTitle(server)}>
              <p>{server.message}</p>
            </ErrorAlert>
          )}
        </div>
        <div className="dlg-actions">
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost" disabled={busy}>
              {CHAT_DIALOGS.common.cancel}
            </button>
          </DialogClose>
          <button type="submit" className="btn" disabled={busy} aria-busy={busy || undefined}>
            {busy ? T.creating : T.create}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
