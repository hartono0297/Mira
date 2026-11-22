import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api, toAppError, type AppError } from "../../api";
import { REMINDER_DAY_BEFORE, REMINDER_DUE_DAY } from "../../api/board";
import { ErrorAlert } from "../../components/ErrorAlert";
import "./task.css";

type Key = typeof REMINDER_DAY_BEFORE | typeof REMINDER_DUE_DAY;

const OPTIONS: { key: Key; label: string }[] = [
  { key: REMINDER_DAY_BEFORE, label: "Sehari sebelum tenggat" },
  { key: REMINDER_DUE_DAY, label: "Di hari tenggat" },
];

// Nilai bawaan "on": hanya "off" yang mematikan.
const isOn = (value: string | null) => value !== "off";

// Pengaturan pengingat tenggat untuk laptop ini. Disimpan begitu dicentang.
export function ReminderSettings() {
  const [values, setValues] = useState<Record<Key, boolean> | null>(null);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [saveError, setSaveError] = useState<{ label: string; error: AppError } | null>(null);
  const [saved, setSaved] = useState("");
  const alive = useRef(true);
  const ids = useId();

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [dayBefore, dueDay] = await Promise.all([
        api.getSetting(REMINDER_DAY_BEFORE),
        api.getSetting(REMINDER_DUE_DAY),
      ]);
      if (alive.current) setValues({ [REMINDER_DAY_BEFORE]: isOn(dayBefore), [REMINDER_DUE_DAY]: isOn(dueDay) });
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

  async function toggle(key: Key, label: string, on: boolean) {
    setValues((v) => (v ? { ...v, [key]: on } : v));
    setSaveError(null);
    setSaved("");
    try {
      await api.setSetting(key, on ? "on" : "off");
      if (alive.current) setSaved(`Pengingat "${label}" ${on ? "dinyalakan" : "dimatikan"}.`);
    } catch (err) {
      if (!alive.current) return;
      setValues((v) => (v ? { ...v, [key]: !on } : v));
      setSaveError({ label, error: toAppError(err) });
    }
  }

  return (
    <section className="rem" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} className="rem-title">
        Pengingat tenggat
      </h2>
      <p className="rem-note">
        Untuk task yang ditugaskan ke Anda dan belum selesai. Notifikasi muncul di Windows, hanya di laptop ini. Kalau
        laptop mati saat waktunya, pengingat muncul begitu laptop dinyalakan dan Mira berjalan lagi.
      </p>
      {!values && !loadError && (
        <p className="hint" role="status">
          Memuat pengaturan...
        </p>
      )}
      {loadError && (
        <div role="alert">
          <ErrorAlert title="Pengaturan pengingat belum terbaca">
            <p>{loadError.message}</p>
            <button type="button" className="btn btn-ghost btn-sm rem-retry" onClick={() => void load()}>
              Coba lagi
            </button>
          </ErrorAlert>
        </div>
      )}
      {values && (
        <fieldset className="rem-set">
          <legend className="sr-only">Kirim pengingat</legend>
          {OPTIONS.map((o) => (
            <label key={o.key} className="rem-opt">
              <input
                type="checkbox"
                checked={values[o.key]}
                onChange={(e) => void toggle(o.key, o.label, e.target.checked)}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </fieldset>
      )}
      <div aria-live="polite">
        {saved && <p className="rem-saved">{saved}</p>}
        {saveError && (
          <ErrorAlert title={`Pengingat "${saveError.label}" belum tersimpan`}>
            <p>{saveError.error.message}</p>
            <p>Centangnya sudah dikembalikan seperti semula. Coba ubah lagi.</p>
          </ErrorAlert>
        )}
      </div>
    </section>
  );
}
