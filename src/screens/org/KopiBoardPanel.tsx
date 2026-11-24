import { IconChevronLeft, IconChevronRight, IconCoffee, IconInfoCircle } from "@tabler/icons-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { subscribeFeature, toAppError, type AppError } from "../../api";
import { kopiApi, type KopiBoard, type KopiBoardRow, type KopiOverview, type KopiTier } from "../../api/kopi";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { reloadKopi } from "../../components/useKopi";
import { locale, useLang } from "../../i18n/core";
import { KOPI_BOARD_TEXT as T } from "../../i18n/kopi-board";
import type { OrgPage } from "./context";
import "./kopi-board.css";

// Kopi kerja dihitung paling banyak 3 per orang per hari (WORK_DAILY_LIMIT di
// src-tauri/src/kopi/types.rs). Overview tidak mengirim angka ini.
const WORK_DAILY_LIMIT = 3;
// Papan berisi paling banyak 10 orang (docs/plans/kopi.md bagian 1).
const BOARD_MAX = 10;
// Cadangan kalau event fitur tidak datang, sama dengan useKopi.
const POLL_MS = 60000;

type Data = { overview: KopiOverview; board: KopiBoard };

export function monthOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  return monthOf(new Date(y, m - 1 + delta, 1));
}

function monthLabel(month: string, lang: Parameters<typeof locale>[0]): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(locale(lang), { month: "long", year: "numeric" }).format(new Date(y, m - 1, 1));
}

function tierName(tier: KopiTier): string {
  return T.tiers[tier] ?? tier;
}

function valid(overview: unknown, board: unknown): boolean {
  const o = overview as KopiOverview | null;
  const b = board as KopiBoard | null;
  return (
    !!o &&
    typeof o === "object" &&
    typeof o.enabled === "boolean" &&
    Array.isArray(o.tiers) &&
    !!b &&
    typeof b === "object" &&
    typeof b.month === "string" &&
    Array.isArray(b.rows)
  );
}

// Overview dan papan satu bulan. Muat ulang saat fitur kopi atau board
// berubah (Kopi kerja dihitung dari board), setelah aksi di halaman, dan
// setiap menit. Data terakhir tetap tampil kalau muat ulang gagal.
function useKopiBoard(month: string, version: number) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(true);
  const monthRef = useRef(month);
  monthRef.current = month;
  const seq = useRef(0);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const [overview, board] = await Promise.all([kopiApi.overview(), kopiApi.board(monthRef.current)]);
      if (!valid(overview, board)) throw { code: "bad_data", message: T.badData };
      if (!alive.current || mine !== seq.current) return;
      setData({ overview, board });
      setError(null);
    } catch (err) {
      if (!alive.current || mine !== seq.current) return;
      setError(toAppError(err));
    } finally {
      if (alive.current && mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, month, version]);

  useEffect(() => {
    alive.current = true;
    const stopKopi = subscribeFeature("kopi", () => void reload());
    const stopBoard = subscribeFeature("board", () => void reload());
    const timer = window.setInterval(() => void reload(), POLL_MS);
    return () => {
      alive.current = false;
      stopKopi();
      stopBoard();
      window.clearInterval(timer);
    };
  }, [reload]);

  return { data, error, loading, reload };
}

export function KopiBoardPanel({ page }: { page: OrgPage }) {
  const lang = useLang();
  const thisMonth = monthOf(new Date());
  const [month, setMonth] = useState(thisMonth);
  const live = useKopiBoard(month, page.version);
  const data = live.data;
  const overview = data?.overview ?? null;

  return (
    <section className="set-section kb" aria-labelledby="kopi-title">
      <div className="org-head">
        <div>
          <h2 id="kopi-title" className="set-title kb-title">
            <IconCoffee size={22} aria-hidden="true" />
            {T.title}
          </h2>
          <p className="hint kb-intro">{T.intro}</p>
        </div>
      </div>

      {live.loading && !data && (
        <p className="hint" role="status">
          {T.loading}
        </p>
      )}

      {!live.loading && !data && (
        <div role="alert">
          <ErrorAlert title={T.loadErrorTitle}>
            <p>{live.error?.message ?? T.loadErrorEmpty}</p>
            <button type="button" className="btn btn-ghost org-retry" onClick={() => void live.reload()}>
              {T.retry}
            </button>
          </ErrorAlert>
        </div>
      )}

      {data && overview && (
        <>
          {live.error && !live.loading && data.board.month === month && <p className="hint">{T.stale(live.error.message)}</p>}

          {overview.isSuperadmin && <KopiSettings overview={overview} page={page} reload={live.reload} />}

          {!overview.enabled ? (
            <div className="notice kb-notice">
              <IconInfoCircle size={18} aria-hidden="true" />
              <div>
                <strong>{T.featureOffTitle}</strong>
                <p>{overview.isSuperadmin ? T.featureOffAdmin : T.featureOffBody}</p>
              </div>
            </div>
          ) : (
            <div className="kb-grid">
              {overview.boardEnabled ? (
                <BoardSection
                  month={month}
                  thisMonth={thisMonth}
                  lang={lang}
                  data={data}
                  loading={live.loading}
                  error={live.error}
                  onMonth={setMonth}
                  onRetry={() => void live.reload()}
                />
              ) : (
                <div className="notice kb-notice">
                  <IconInfoCircle size={18} aria-hidden="true" />
                  <div>
                    <strong>{T.boardOffTitle}</strong>
                    <p>{overview.isSuperadmin ? T.boardOffAdmin : T.boardOffBody}</p>
                  </div>
                </div>
              )}
              <HowSection overview={overview} />
            </div>
          )}
        </>
      )}
    </section>
  );
}

type BoardProps = {
  month: string;
  thisMonth: string;
  lang: Parameters<typeof locale>[0];
  data: Data;
  loading: boolean;
  error: AppError | null;
  onMonth: (month: string) => void;
  onRetry: () => void;
};

function BoardSection({ month, thisMonth, lang, data, loading, error, onMonth, onRetry }: BoardProps) {
  const label = monthLabel(month, lang);
  const isNow = month === thisMonth;
  const ready = data.board.month === month;
  // Urutan dari inti sudah skor terbesar dulu; diurutkan lagi (stabil) supaya
  // tampilan tetap benar kalau inti lama mengirim urutan lain.
  const rows: KopiBoardRow[] = ready
    ? [...data.board.rows].sort((a, b) => b.score - a.score).slice(0, BOARD_MAX)
    : [];

  return (
    <section className="kb-board" aria-labelledby="kopi-board-title">
      <div className="kb-board-head">
        <div>
          <h3 id="kopi-board-title" className="kb-h3">
            {isNow ? T.boardTitleNow : T.boardTitle(label)}
          </h3>
          <p className="hint">{T.boardHint}</p>
        </div>
        <nav className="kb-months" aria-label={T.monthNav}>
          <button
            type="button"
            className="btn btn-ghost kb-month-btn"
            aria-label={T.prevMonth}
            title={T.prevMonth}
            onClick={() => onMonth(shiftMonth(month, -1))}
          >
            <IconChevronLeft size={18} aria-hidden="true" />
          </button>
          <span className="kb-month" aria-live="polite">
            {label}
          </span>
          <button
            type="button"
            className="btn btn-ghost kb-month-btn"
            aria-label={T.nextMonth}
            title={T.nextMonth}
            disabled={isNow}
            onClick={() => onMonth(shiftMonth(month, 1))}
          >
            <IconChevronRight size={18} aria-hidden="true" />
          </button>
        </nav>
      </div>

      {!ready && loading && (
        <p className="hint" role="status">
          {T.monthLoading(label)}
        </p>
      )}

      {!ready && !loading && (
        <div role="alert">
          <ErrorAlert title={T.monthErrorTitle(label)}>
            <p>{error?.message ?? T.loadErrorEmpty}</p>
            <button type="button" className="btn btn-ghost org-retry" onClick={onRetry}>
              {T.retry}
            </button>
          </ErrorAlert>
        </div>
      )}

      {ready && rows.length === 0 && (
        <div className="org-empty">
          <p>{isNow ? T.emptyNow : T.emptyPast(label)}</p>
        </div>
      )}

      {ready && rows.length > 0 && (
        <ol className="kb-list" aria-label={T.listLabel(label)}>
          {rows.map((r, i) => (
            <li key={r.person.publicKey} className="kb-row">
              <span className="kb-rank" aria-hidden="true">
                {i + 1}
              </span>
              <div className="kb-who">
                <span className="kb-name" data-testid="kb-name">
                  {r.person.name}
                  {r.person.publicKey === data.overview.me && <span className="kb-you">{T.you}</span>}
                </span>
                <span className="kb-tier">{tierName(r.tier)}</span>
              </div>
              <dl className="kb-stats">
                <div>
                  <dt>{T.peer}</dt>
                  <dd>{r.peer}</dd>
                </div>
                <div>
                  <dt>{T.work}</dt>
                  <dd>{r.work}</dd>
                </div>
                <div className="kb-score">
                  <dt>{T.score}</dt>
                  <dd>{r.score}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function HowSection({ overview }: { overview: KopiOverview }) {
  const tiers = [...overview.tiers].sort((a, b) => a.minScore - b.minScore);
  return (
    <section className="kb-how" aria-labelledby="kopi-how-title">
      <h3 id="kopi-how-title" className="kb-h3">
        {T.howTitle}
      </h3>
      <ul className="kb-rules">
        <li>{T.howPeer(overview.peerWeight)}</li>
        <li>{T.howWork(overview.workWeight)}</li>
        <li>{T.howLimit(overview.dailyLimit, WORK_DAILY_LIMIT)}</li>
        <li>{T.howGuest}</li>
      </ul>
      <table className="kb-tiers" aria-labelledby="kopi-tiers-title" aria-describedby="kopi-tiers-hint">
        <caption>
          <span id="kopi-tiers-title" className="kb-h4">
            {T.tiersTitle}
          </span>
          <span id="kopi-tiers-hint" className="hint kb-tiers-hint">
            {T.tiersHint}
          </span>
        </caption>
        <thead>
          <tr>
            <th scope="col">{T.tierCol}</th>
            <th scope="col">{T.minCol}</th>
          </tr>
        </thead>
        <tbody>
          {tiers.map((t) => (
            <tr key={t.tier}>
              <td>{tierName(t.tier)}</td>
              <td>{t.minScore}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

type Which = "enabled" | "board";

function KopiSettings({
  overview,
  page,
  reload,
}: {
  overview: KopiOverview;
  page: OrgPage;
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<Which | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [confirm, setConfirm] = useState(false);

  const save = async (which: Which, enabled: boolean, board: boolean, done: string) => {
    setBusy(which);
    setError(null);
    try {
      await kopiApi.setSettings(enabled, board);
      // Ikon Kopi di samping nama (cache bersama useKopi) ikut berubah sekarang.
      void reloadKopi();
      // Sakelar baru berubah setelah data terbaru terbaca, supaya tidak berkedip.
      await reload();
      setConfirm(false);
      page.notify(done);
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(null);
    }
  };

  const onFeature = () => {
    if (overview.enabled) {
      setError(null);
      setConfirm(true);
    } else {
      void save("enabled", true, overview.boardEnabled, T.featureOnDone);
    }
  };

  const onBoard = () => {
    const next = !overview.boardEnabled;
    void save("board", overview.enabled, next, next ? T.boardOnDone : T.boardOffDone);
  };

  return (
    <section className="kb-settings" aria-labelledby="kopi-settings-title" aria-busy={busy !== null || undefined}>
      <h3 id="kopi-settings-title" className="kb-h3">
        {T.settingsTitle}
      </h3>
      <p className="hint">{T.settingsHint}</p>
      <div className="kb-switches">
        <Switch
          label={T.featureSwitch}
          hint={T.featureSwitchHint}
          checked={overview.enabled}
          disabled={busy !== null}
          saving={busy === "enabled" && !confirm}
          onChange={onFeature}
        />
        <Switch
          label={T.boardSwitch}
          hint={overview.enabled ? T.boardSwitchHint : `${T.boardSwitchHint} ${T.boardSwitchNeedsFeature}`}
          checked={overview.boardEnabled}
          disabled={busy !== null}
          saving={busy === "board"}
          onChange={onBoard}
        />
      </div>
      <div aria-live="polite">
        {error && !confirm && (
          <ErrorAlert title={T.saveFail}>
            <p>{error.message}</p>
          </ErrorAlert>
        )}
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={(open) => {
          if (!open) {
            setConfirm(false);
            setError(null);
          }
        }}
        title={T.confirmTitle}
        confirmLabel={T.confirmBtn}
        busyLabel={T.confirmBusy}
        busy={busy === "enabled"}
        onConfirm={() => void save("enabled", false, overview.boardEnabled, T.featureOffDone)}
        error={
          error && confirm ? (
            <ErrorAlert title={T.saveFail}>
              <p>{error.message}</p>
            </ErrorAlert>
          ) : null
        }
      >
        <p>{T.confirmBody}</p>
        <p>{T.confirmKeep}</p>
      </ConfirmDialog>
    </section>
  );
}

type SwitchProps = {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  saving: boolean;
  onChange: () => void;
};

// Sakelar: kotak centang dengan role switch, jadi Spasi dan pembaca layar
// bekerja seperti biasa. Keadaannya juga ditulis (Nyala/Mati), bukan warna saja.
function Switch({ label, hint, checked, disabled, saving, onChange }: SwitchProps) {
  const id = useId();
  return (
    <label className="kb-switch">
      <span className="kb-switch-text">
        <span className="kb-switch-label" id={`${id}-l`}>
          {label}
        </span>
        <span className="hint" id={`${id}-h`}>
          {hint}
        </span>
      </span>
      <span className="kb-switch-ctl">
        <span className="kb-switch-state" aria-hidden="true">
          {saving ? T.saving : checked ? T.on : T.off}
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-labelledby={`${id}-l`}
          aria-describedby={`${id}-h`}
          checked={checked}
          disabled={disabled}
          aria-busy={saving || undefined}
          onChange={onChange}
        />
      </span>
    </label>
  );
}
