import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api, toAppError, type AppError } from "../../api";
import { REMINDER_DAY_BEFORE, REMINDER_DUE_DAY } from "../../api/board";
import { ErrorAlert } from "../../components/ErrorAlert";
import { BOARD_DETAIL } from "../../i18n/board-detail";
import { systemName } from "../../platform";
import "./task.css";

type Key = typeof REMINDER_DAY_BEFORE | typeof REMINDER_DUE_DAY;

const OPTIONS: Key[] = [REMINDER_DAY_BEFORE, REMINDER_DUE_DAY];

// Dibaca saat render supaya mengikuti bahasa aktif.
function optionLabel(key: Key): string {
  return key === REMINDER_DAY_BEFORE ? BOARD_DETAIL.reminder.dayBefore : BOARD_DETAIL.reminder.dueDay;
}

// Nilai bawaan "on": hanya "off" yang mematikan.
const isOn = (value: string | null) => value !== "off";

// Pengaturan pengingat tenggat untuk laptop ini. Disimpan begitu dicentang.
export function ReminderSettings() {
  const [values, setValues] = useState<Record<Key, boolean> | null>(null);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [saveError, setSaveError] = useState<{ key: Key; error: AppError } | null>(null);
  const [saved, setSaved] = useState<{ key: Key; on: boolean } | null>(null);
  const alive = useRef(true);
  const savedValues = useRef<Record<Key, boolean> | null>(null);
  const seq = useRef<Record<Key, number>>({ [REMINDER_DAY_BEFORE]: 0, [REMINDER_DUE_DAY]: 0 });
  const ids = useId();

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [dayBefore, dueDay] = await Promise.all([
        api.getSetting(REMINDER_DAY_BEFORE),
        api.getSetting(REMINDER_DUE_DAY),
      ]);
      if (!alive.current) return;
      const next = { [REMINDER_DAY_BEFORE]: isOn(dayBefore), [REMINDER_DUE_DAY]: isOn(dueDay) };
      savedValues.current = { ...next };
      setValues(next);
    } catch (err) {
      if (alive.current) setLoadError(toAppError(err));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  async function toggle(key: Key, on: boolean) {
    const mine = ++seq.current[key];
    setValues((v) => (v ? { ...v, [key]: on } : v));
    setSaveError(null);
    setSaved(null);
    try {
      await api.setSetting(key, on ? "on" : "off");
      // Jawaban untuk klik yang sudah disusul klik lain diabaikan.
      if (!alive.current || mine !== seq.current[key]) return;
      if (savedValues.current) savedValues.current[key] = on;
      setSaved({ key, on });
    } catch (err) {
      if (!alive.current || mine !== seq.current[key]) return;
      // Kembali ke nilai terakhir yang benar-benar tersimpan.
      const last = savedValues.current?.[key];
      if (last !== undefined) setValues((v) => (v ? { ...v, [key]: last } : v));
      setSaveError({ key, error: toAppError(err) });
    }
  }

  const T = BOARD_DETAIL.reminder;
  return (
    <section className="rem" aria-labelledby={`${ids}-title`}>
      <h3 id={`${ids}-title`} className="rem-title">
        {T.title}
      </h3>
      <p className="rem-note">{T.note(systemName())}</p>
      {!values && !loadError && (
        <p className="hint" role="status">
          {T.loading}
        </p>
      )}
      {loadError && (
        <div role="alert">
          <ErrorAlert title={T.loadErrorTitle}>
            <p>{loadError.message}</p>
            <button type="button" className="btn btn-ghost btn-sm rem-retry" onClick={() => void load()}>
              {T.retry}
            </button>
          </ErrorAlert>
        </div>
      )}
      {values && (
        <fieldset className="rem-set">
          <legend className="sr-only">{T.legend}</legend>
          {OPTIONS.map((key) => (
            <label key={key} className="rem-opt">
              <input
                type="checkbox"
                checked={values[key]}
                onChange={(e) => void toggle(key, e.target.checked)}
              />
              <span>{optionLabel(key)}</span>
            </label>
          ))}
        </fieldset>
      )}
      <div aria-live="polite">
        {saved && <p className="rem-saved">{T.saved(optionLabel(saved.key), saved.on)}</p>}
        {saveError && (
          <ErrorAlert title={T.saveErrorTitle(optionLabel(saveError.key))}>
            <p>{saveError.error.message}</p>
            <p>{T.reverted}</p>
          </ErrorAlert>
        )}
      </div>
    </section>
  );
}
