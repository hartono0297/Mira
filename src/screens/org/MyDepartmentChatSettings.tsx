import { IconAlertCircle } from "@tabler/icons-react";
import { useId, useState, type FormEvent } from "react";
import { divisionApi, type ChatSettingsView } from "../../api/division";
import { formatDateTime } from "../../api/format";
import { DIVISION_TEXT } from "../../i18n/org-division";
import { charCount, PINNED_MAX, validPinned, type DeptCtx } from "./myDepartmentShared";

type Props = {
  dept: DeptCtx;
  // Nama percakapan untuk pesan hasil ("# desain", "Mobile").
  name: string;
  divisionId: string | null;
  settings: ChatSettingsView;
  canEdit: boolean;
};

// Catatan disematkan dan mode pengumuman untuk channel departemen atau chat divisi.
// Komponen ini diberi key dari setAt, jadi isian kembali ke nilai tersimpan setelah disimpan.
export function ChatSettingsForm({ dept, name, divisionId, settings, canEdit }: Props) {
  const T = DIVISION_TEXT.chat;
  const { page, ov } = dept;
  const uid = useId();
  const [pinned, setPinned] = useState(settings.pinned);
  const [announce, setAnnounce] = useState(settings.announce);
  const announceText = divisionId === null ? T.announceDept : T.announceDivision;
  const key = `md:chat:${divisionId ?? "dept"}`;
  const saving = page.pending === key;
  const count = charCount(pinned);
  const tooLong = count > PINNED_MAX;
  const badChars = !validPinned(pinned);
  const error = tooLong ? T.tooLong(PINNED_MAX) : badChars ? T.badChars : null;
  const changed = pinned.trim() !== settings.pinned || announce !== settings.announce;
  const last =
    settings.setAt && settings.setByName ? T.lastSet(settings.setByName, formatDateTime(settings.setAt)) : null;

  if (!canEdit) {
    return (
      <div className="md-chat-read">
        <p className="md-k">{T.pinnedLabel}</p>
        {settings.pinned ? (
          <p className="md-pinned" dir="auto">
            {settings.pinned}
          </p>
        ) : (
          <p className="hint">{T.noPinned}</p>
        )}
        <p className="md-k">{T.announceLabel}</p>
        <p>{settings.announce ? announceText : T.announceOff}</p>
        {last && <p className="hint">{last}</p>}
      </div>
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (error || !changed || dept.busy || !dept.canWrite) return;
    void page.act(
      key,
      () => divisionApi.setChatSettings(ov.teamId, divisionId, pinned.trim(), announce),
      T.saved(name),
      T.saveFail,
    );
  }

  const off = !dept.canWrite;
  return (
    <form className="md-chat" onSubmit={submit} noValidate>
      <fieldset className="md-fields" disabled={off}>
        <div className="md-field">
          <label htmlFor={`${uid}-pinned`}>{T.pinnedLabel}</label>
          <textarea
            id={`${uid}-pinned`}
            className="md-input md-textarea"
            value={pinned}
            rows={3}
            dir="auto"
            aria-invalid={error ? true : undefined}
            aria-describedby={`${uid}-hint ${uid}-count${error ? ` ${uid}-err` : ""}`}
            onChange={(e) => setPinned(e.target.value)}
          />
          <div className="md-field-foot">
            <span id={`${uid}-hint`} className="hint">
              {T.pinnedHint}
            </span>
            <span id={`${uid}-count`} className={tooLong ? "md-count md-count-over" : "md-count"}>
              {T.counter(count, PINNED_MAX)}
            </span>
          </div>
          {error && (
            <p id={`${uid}-err`} className="field-error">
              <IconAlertCircle size={16} aria-hidden="true" />
              {error}
            </p>
          )}
        </div>
        <div className="md-switch">
          <input
            id={`${uid}-announce`}
            type="checkbox"
            role="switch"
            checked={announce}
            aria-describedby={`${uid}-announce-desc`}
            onChange={(e) => setAnnounce(e.target.checked)}
          />
          <div>
            <label htmlFor={`${uid}-announce`}>{T.announceLabel}</label>
            <p id={`${uid}-announce-desc`} className="hint">
              {announceText}
            </p>
          </div>
        </div>
      </fieldset>
      <div className="md-chat-actions">
        <button
          type="submit"
          className="btn btn-ghost"
          disabled={off || dept.busy || !changed || !!error}
          aria-busy={saving || undefined}
        >
          {saving ? T.saving : T.save}
        </button>
        {last && <span className="hint">{last}</span>}
      </div>
    </form>
  );
}
