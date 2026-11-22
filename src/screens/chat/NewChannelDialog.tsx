import { useId, useRef, useState, type FormEvent } from "react";
import { toAppError, type AppError } from "../../api";
import { chatApi, type ChatOverview, type ConversationSummary, type NewChannelScope } from "../../api/chat";
import { Dialog, DialogClose } from "../../components/Dialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { FieldError } from "../../components/FieldError";
import { MAX_CHANNEL_NAME, normalizeChannelName, scopeLabel } from "./ListFormat";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Hanya superadmin yang boleh membuat channel "Seluruh kantor".
  canCreateOrgChannel: boolean;
  teams: ChatOverview["teams"];
  projects: ChatOverview["projects"];
  onCreated: (summary: ConversationSummary) => void;
};

const ORG = "org";

export const NO_SCOPE_NOTE =
  "Channel baru dibuat untuk tim atau proyek, dan Anda belum masuk tim atau proyek mana pun. Channel seluruh kantor dibuat oleh superadmin.";

function parseScope(value: string): NewChannelScope {
  const [kind, id] = value.split(":");
  if ((kind === "team" || kind === "project") && id) return { kind, id };
  return { kind: "org", id: null };
}

function serverTitle(error: AppError): string {
  if (error.code === "forbidden") return "Anda tidak punya izin membuat channel di sini";
  return "Channel belum dibuat";
}

// Channel baru: nama dan cakupan (seluruh kantor untuk superadmin, salah satu tim saya, atau
// salah satu proyek saya). Nama dirapikan dengan aturan yang sama dengan inti Rust.
export function NewChannelDialog({ open, onOpenChange, canCreateOrgChannel, teams, projects, onCreated }: Props) {
  const allowed = [
    ...(canCreateOrgChannel ? [ORG] : []),
    ...teams.map((t) => `team:${t.id}`),
    ...projects.map((p) => `project:${p.id}`),
  ];
  const firstScope = allowed[0] ?? "";
  const [name, setName] = useState("");
  const [picked, setScope] = useState(firstScope);
  // Pilihan yang sudah tidak ada (keluar dari tim) kembali ke cakupan pertama yang boleh.
  const scope = allowed.includes(picked) ? picked : firstScope;
  const [nameError, setNameError] = useState<string | null>(null);
  const [server, setServer] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const previewId = useId();
  const errId = useId();
  const scopeId = useId();
  const scopeHintId = useId();

  const normalized = normalizeChannelName(name);

  function reset() {
    setName("");
    setScope(firstScope);
    setNameError(null);
    setServer(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !scope) return;
    setServer(null);
    if (!normalized) {
      setNameError(
        name.trim()
          ? "Nama ini tidak menyisakan huruf atau angka. Pakai huruf a sampai z atau angka."
          : "Tulis nama channel dulu.",
      );
      nameRef.current?.focus();
      return;
    }
    setNameError(null);
    setBusy(true);
    try {
      const summary = await chatApi.createChannel(normalized, parseScope(scope));
      reset();
      onCreated(summary);
    } catch (err) {
      const error = toAppError(err);
      if (error.code === "invalid_input" && /nama/i.test(error.message)) {
        setNameError(error.message);
        nameRef.current?.focus();
      } else {
        setServer(error);
      }
    } finally {
      setBusy(false);
    }
  }

  const scopeHint =
    scope === ORG
      ? "Semua anggota kantor bisa membaca dan menulis. Tamu tidak."
      : scope.startsWith("team:")
        ? "Hanya anggota tim ini."
        : "Anggota proyek ini, termasuk Tamu yang diundang ke proyek.";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Channel baru"
      description="Channel adalah ruang obrolan bersama. Pilih siapa saja yang ikut di dalamnya."
    >
      {!scope ? (
        <>
          <p className="chat-note">{NO_SCOPE_NOTE}</p>
          <div className="dlg-actions">
            <DialogClose asChild>
              <button type="button" className="btn btn-ghost">
                Tutup
              </button>
            </DialogClose>
          </div>
        </>
      ) : (
        <form className="chat-form" onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor={nameId}>Nama channel</label>
            <input
              ref={nameRef}
              id={nameId}
              autoComplete="off"
              spellCheck={false}
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={`${previewId} ${errId}`}
              readOnly={busy}
            />
            <p id={previewId} className="hint">
              {normalized ? (
                <>
                  Tampil sebagai <strong className="chat-preview">#{normalized}</strong>
                </>
              ) : (
                `Huruf kecil, angka, dan tanda hubung. Spasi jadi tanda hubung. Paling banyak ${MAX_CHANNEL_NAME} karakter.`
              )}
            </p>
            <div id={errId} aria-live="polite">
              {nameError && <FieldError text={nameError} />}
            </div>
          </div>
          <div className="field">
            <label htmlFor={scopeId}>Untuk siapa</label>
            <select
              id={scopeId}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              aria-describedby={scopeHintId}
              disabled={busy}
            >
              {canCreateOrgChannel && <option value={ORG}>Seluruh kantor</option>}
              {teams.length > 0 && (
                <optgroup label="Tim saya">
                  {teams.map((t) => (
                    <option key={t.id} value={`team:${t.id}`}>
                      {scopeLabel("team", t.name)}
                    </option>
                  ))}
                </optgroup>
              )}
              {projects.length > 0 && (
                <optgroup label="Proyek saya">
                  {projects.map((p) => (
                    <option key={p.id} value={`project:${p.id}`}>
                      {scopeLabel("project", p.name)}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <p id={scopeHintId} className="hint">
              {scopeHint}
            </p>
          </div>
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
                Batal
              </button>
            </DialogClose>
            <button type="submit" className="btn" disabled={busy} aria-busy={busy || undefined}>
              {busy ? "Membuat channel..." : "Buat channel"}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
