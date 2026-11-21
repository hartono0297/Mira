import { ErrorAlert } from "../../components/ErrorAlert";
import type { ThemeMode } from "../../theme/mode";
import { useTheme } from "../../theme/ThemeProvider";
import { plannedThemes, themes, type TokenSet } from "../../theme/tokens";

const MODE_LABELS: Record<ThemeMode, string> = {
  light: "Terang",
  dark: "Gelap",
  system: "Ikuti Windows",
};

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
        Tampilan
      </h2>

      <div>
        <fieldset className="modes-fieldset">
          <legend className="set-label">Mode</legend>
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
                  {MODE_LABELS[m]}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div aria-live="polite" className="set-live">
          {saving && <p className="hint">Menyimpan pilihan mode...</p>}
          {error && (
            <ErrorAlert title="Mode belum tersimpan">
              <p>
                {error.error.message} Pilihan dikembalikan ke {MODE_LABELS[error.kept]}. Coba pilih lagi.
              </p>
            </ErrorAlert>
          )}
          {!error && loadError && (
            <ErrorAlert title="Pilihan mode tersimpan belum bisa dibaca">
              <p>
                {loadError.message} Untuk sementara Mira memakai pilihan terakhir yang diingat jendela ini. Memilih mode
                lagi akan mencoba menyimpannya.
              </p>
            </ErrorAlert>
          )}
        </div>
      </div>

      <h3 className="set-label">Tema warna</h3>
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
          <span className="tag">Dipakai</span>
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
            <span className="tag tag-soon">Nanti</span>
          </li>
        ))}
      </ul>
      <p className="hint">Pengaturan ini hanya berlaku di laptop ini dan tidak dikirim ke rekan.</p>
    </section>
  );
}
