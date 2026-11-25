import { IconAlertCircle } from "@tabler/icons-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { divisionApi, type ChatSettingsView } from "../../api/division";
import { formatDateTime } from "../../api/format";
import { DIVISION_TEXT } from "../../i18n/org-division";
import { normalizePinned, PINNED_MAX, PINNED_MAX_LINES, pinnedLength, pinnedProblem } from "../chat/pinnedRules";
import type { DeptCtx } from "./myDepartmentShared";

type Props = {
  dept: DeptCtx;
  // Nama percakapan untuk pesan hasil ("# desain", "Mobile").
  name: string;
  divisionId: string | null;
  settings: ChatSettingsView;
  canEdit: boolean;
};

// Catatan disematkan dan mode pengumuman untuk channel departemen atau chat divisi.
export function ChatSettingsForm({ dept, name, divisionId, settings, canEdit }: Props) {
  const T = DIVISION_TEXT.chat;
  const { page, ov } = dept;
  const uid = useId();
  const [pinned, setPinned] = useState(settings.pinned);
  const [announce, setAnnounce] = useState(settings.announce);
  // Setelah disimpan (di sini atau di laptop lain), isian kembali ke nilai tersimpan.
  // Formulir tidak dipasang ulang, jadi fokus tetap di tempatnya.
  useEffect(() => {
    setPinned(settings.pinned);
    setAnnounce(settings.announce);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.setAt]);
  const announceText = divisionId === null ? T.announceDept : T.announceDivision;
  const key = `md:chat:${divisionId ?? "dept"}`;
  const saving = page.pending === key;
  const count = pinnedLength(pinned);
  const problem = pinnedProblem(pinned);
  const error = problem === "chars" ? T.tooLong(PINNED_MAX) : problem === "lines" ? T.tooManyLines(PINNED_MAX_LINES) : null;
  const changed = normalizePinned(pinned) !== settings.pinned || announce !== settings.announce;
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
      () => divisionApi.setChatSettings(ov.teamId, divisionId, normalizePinned(pinned), announce),
      T.saved(name),
      T.saveFail,
    );
  }

  const off = !dept.canWrite;
  const gateId = `${uid}-gate`;
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
              {T.pinnedHint(PINNED_MAX, PINNED_MAX_LINES)}
            </span>
            <span id={`${uid}-count`} className={problem === "chars" ? "md-count md-count-over" : "md-count"}>
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
        <div className="md-check">
          <input
            id={`${uid}-announce`}
            type="checkbox"
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
          aria-describedby={dept.gateHint ? gateId : undefined}
        >
          {saving ? T.saving : T.save}
        </button>
        {dept.gateHint ? (
          <span id={gateId} className="hint">
            {dept.gateHint}
          </span>
        ) : (
          last && <span className="hint">{last}</span>
        )}
      </div>
    </form>
  );
}
