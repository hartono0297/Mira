import { IconPin } from "@tabler/icons-react";
import { useId, useState } from "react";
import type { ConversationSummary } from "../../api/chat";
import { CHAT_DIVISION } from "../../i18n/chat-division";
import { ChatSettingsDialog } from "./ChatSettingsDialog";
import { settingsChanged, useConversationSettings } from "./useConversationSettings";
import "./division.css";

// Catatan yang lebih panjang dari ini diringkas jadi tiga baris dengan tombol Tampilkan semua.
const LONG_CHARS = 180;
const LONG_LINES = 3;

export function isLongNote(text: string): boolean {
  return [...text].length > LONG_CHARS || text.split("\n").length > LONG_LINES;
}

// Banner catatan disematkan di atas channel departemen dan chat divisi. Teks tampil apa adanya
// (node teks React, baris baru dipertahankan lewat CSS), tidak pernah sebagai HTML.
export function PinnedNote({ summary }: { summary: ConversationSummary }) {
  const T = CHAT_DIVISION.pinned;
  const { settings } = useConversationSettings(summary);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState("");
  const ids = useId();

  if (!settings) return null;
  const note = settings.pinned;
  // Pengelola diberi tahu bahwa anggota lain sedang tidak bisa menulis. Yang lain sudah membaca
  // penjelasannya di tempat kolom pesan.
  const announceChip = settings.announce && settings.canWrite;
  if (!note && !settings.canEdit && !announceChip) return null;
  const long = !!note && isLongNote(note);
  const clamped = long && !expanded;

  return (
    <aside className={note ? "pin-note" : "pin-note pin-note-empty"} aria-label={T.label}>
      <IconPin size={16} className="pin-note-icon" aria-hidden="true" />
      <div className="pin-note-body">
        {note && (
          <p id={`${ids}-text`} className={clamped ? "pin-note-text pin-note-clamp" : "pin-note-text"}>
            {note}
          </p>
        )}
        {(long || announceChip) && (
          <div className="pin-note-meta">
            {long && (
              <button
                type="button"
                className="link-btn pin-note-toggle"
                aria-expanded={expanded}
                aria-controls={`${ids}-text`}
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? T.less : T.more}
              </button>
            )}
            {announceChip && <span className="chip chip-on">{T.announceOn}</span>}
          </div>
        )}
      </div>
      {settings.canEdit && (
        <button
          type="button"
          className="btn btn-ghost btn-sm pin-note-edit"
          aria-label={note ? T.editLabel : undefined}
          onClick={() => {
            setStatus("");
            setEditing(true);
          }}
        >
          {note ? T.edit : T.add}
        </button>
      )}
      <p className="sr-only" aria-live="polite">
        {status}
      </p>
      {settings.canEdit && (
        <ChatSettingsDialog
          open={editing}
          onOpenChange={setEditing}
          settings={settings}
          onSaved={() => {
            setStatus(T.saved);
            settingsChanged(summary.id);
          }}
        />
      )}
    </aside>
  );
}
