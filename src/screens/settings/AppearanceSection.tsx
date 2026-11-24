import { ErrorAlert } from "../../components/ErrorAlert";
import { SETTINGS_TEXT } from "../../i18n/settings";
import { systemName } from "../../platform";
import type { ThemeMode } from "../../theme/mode";
import { useTheme } from "../../theme/ThemeProvider";
import { plannedThemes, themes, type TokenSet } from "../../theme/tokens";

const T = SETTINGS_TEXT.appearance;

// Dibaca saat render, supaya ikut bahasa aktif.
function modeLabel(mode: ThemeMode): string {
  return mode === "system" ? T.modes.system(systemName()) : T.modes[mode];
}

const MODES: ThemeMode[] = ["light", "dark", "system"];

// Gambar mini jendela: sidebar + isi, diambil dari token tema yang sedang dipakai.
function Thumb({ mode, light, dark }: { mode: ThemeMode; light: TokenSet; dark: TokenSet }) {
  const parts =
    mode === "light"
      ? [light.side, light.bg]
      : mode === "dark"
        ? [dark.side, dark.bg]
        : [light.side, light.bg, dark.side, dark.bg];
  return (
    <span className={`thumb${mode === "system" ? " thumb-split" : ""}`} aria-hidden="true">
      {parts.map((color, i) => (
        <b key={i} style={{ background: color }} />
      ))}
    </span>
  );
}

export function AppearanceSection() {
  const { mode, setMode, themeName, loadError, saving, saveError: error } = useTheme();
  const theme = themes[themeName];

  function choose(next: ThemeMode) {
    if (next !== mode) void setMode(next);
  }

  return (
    <section className="set-section" aria-labelledby="appearance-title">
      <h2 id="appearance-title" className="set-title">
        {SETTINGS_TEXT.parts.appearance}
      </h2>

      <div>
        <fieldset className="modes-fieldset">
          <legend className="set-label">{T.modeLegend}</legend>
          <div className="modes">
            {MODES.map((m) => (
              <label key={m} className="mode">
                <Thumb mode={m} light={theme.light} dark={theme.dark} />
                <span className="mode-row">
                  <input
                    type="radio"
                    name="theme-mode"
                    value={m}
                    checked={mode === m}
                    onChange={() => choose(m)}
                  />
                  {modeLabel(m)}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div aria-live="polite" className="set-live">
          {saving && <p className="hint">{T.saving}</p>}
          {error && (
            <ErrorAlert title={T.saveErrorTitle}>
              <p>{T.saveErrorBody(error.error.message, modeLabel(error.kept))}</p>
            </ErrorAlert>
          )}
          {!error && loadError && (
            <ErrorAlert title={T.loadErrorTitle}>
              <p>{T.loadErrorBody(loadError.message)}</p>
            </ErrorAlert>
          )}
        </div>
      </div>

      <h3 className="set-label">{T.themeHeading}</h3>
      <ul className="theme-list">
        <li className="theme-row">
          <span className="chips" aria-hidden="true">
            <i style={{ background: theme.light.accent }} />
            <i style={{ background: theme.light.side }} />
            <i style={{ background: theme.light.text }} />
          </span>
          <span>
            <b>{theme.label}</b>, {theme.description}
          </span>
          <span className="tag">{T.inUse}</span>
        </li>
        {plannedThemes.map((t) => (
          <li key={t.id} className="theme-row">
            <span className="chips" aria-hidden="true">
              {t.swatches.map((c) => (
                <i key={c} style={{ background: c }} />
              ))}
            </span>
            <span>
              <b>{t.label}</b>, {t.description}
            </span>
            <span className="tag tag-soon">{T.later}</span>
          </li>
        ))}
      </ul>
      <p className="hint">{T.localOnly}</p>
    </section>
  );
}
