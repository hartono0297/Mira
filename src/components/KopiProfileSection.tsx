import { IconCoffee, IconSquareCheck } from "@tabler/icons-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { subscribeFeature, toAppError, type AppError } from "../api";
import { formatDateTime, relativeTime } from "../api/format";
import { kopiApi, kopiTargetKey, type KopiEntry, type KopiPerson, type KopiProfile, type KopiTarget } from "../api/kopi";
import { KOPI_TEXT as T } from "../i18n/kopi";
import { useLang } from "../i18n/core";
import { ErrorAlert } from "./ErrorAlert";
import { KopiGiveDialog } from "./KopiGiveDialog";
import { kopiTierName, kopiTierRank, kopiToday } from "./kopiText";
import { KOPI_POLL_MS, useKopi } from "./useKopi";
import "./kopi.css";

// Riwayat yang tampil sebelum tombol "Tampilkan semua".
const HISTORY_PREVIEW = 5;

type Props = {
  person: KopiPerson;
};

type Load =
  | { status: "loading" }
  | { status: "error"; error: AppError }
  | { status: "ready"; profile: KopiProfile; stale: AppError | null };

// Bagian Kopi di profil orang: jumlah dari rekan dan dari kerja, tingkatan dan
// jarak ke tingkatan berikutnya, tombol Beri kopi, dan riwayat. Tidak tampil
// kalau fitur mati (superadmin melihat satu baris keterangan).
export function KopiProfileSection({ person }: Props) {
  const { overview, reload: reloadOverview } = useKopi();
  const enabled = overview?.enabled ?? false;
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const seq = useRef(0);
  const alive = useRef(true);
  const pk = person.publicKey;

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const profile = await kopiApi.profile(pk);
      if (alive.current && mine === seq.current) setLoad({ status: "ready", profile, stale: null });
    } catch (err) {
      if (!alive.current || mine !== seq.current) return;
      const error = toAppError(err);
      setLoad((prev) => (prev.status === "ready" ? { ...prev, stale: error } : { status: "error", error }));
    }
  }, [pk]);

  useEffect(() => {
    alive.current = true;
    if (!enabled) return;
    setLoad({ status: "loading" });
    void reload();
    const stopKopi = subscribeFeature("kopi", () => void reload());
    const stopBoard = subscribeFeature("board", () => void reload());
    const timer = window.setInterval(() => void reload(), KOPI_POLL_MS);
    return () => {
      alive.current = false;
      stopKopi();
      stopBoard();
      window.clearInterval(timer);
    };
  }, [enabled, reload]);

  if (!overview) return null;
  if (!overview.enabled) {
    return overview.isSuperadmin ? <p className="kopi-off hint">{T.profile.featureOff}</p> : null;
  }

  return (
    <section className="kopi-prof" aria-labelledby={`kopi-prof-${pk}`}>
      <h3 className="kopi-prof-title" id={`kopi-prof-${pk}`}>
        <IconCoffee size={18} aria-hidden="true" />
        {T.profile.title}
      </h3>
      <div aria-live="polite" className="kopi-prof-live">
        {load.status === "loading" && (
          <p className="hint" role="status">
            {T.profile.loading}
          </p>
        )}
        {load.status === "error" && (
          <ErrorAlert title={T.profile.loadFail}>
            <p>{load.error.message}</p>
            <button type="button" className="btn btn-ghost btn-sm kopi-retry" onClick={() => void reload()}>
              {T.profile.retry}
            </button>
          </ErrorAlert>
        )}
        {load.status === "ready" && load.stale && <p className="hint">{T.profile.stale(load.stale.message)}</p>}
      </div>
      {load.status === "ready" && (
        <ProfileBody
          profile={load.profile}
          person={person}
          onGiven={() => void reload()}
          onChanged={() => {
            void reload();
            void reloadOverview();
          }}
        />
      )}
    </section>
  );
}

// onGiven memuat ulang profil saja (dialog sudah memuat ulang ringkasan);
// onChanged dipakai setelah menyembunyikan, yang mengubah keduanya.
function ProfileBody({
  profile,
  person,
  onGiven,
  onChanged,
}: {
  profile: KopiProfile;
  person: KopiPerson;
  onGiven: () => void;
  onChanged: () => void;
}) {
  const { overview } = useKopi();
  if (!overview) return null;
  return (
    <>
      <Summary profile={profile} tiers={overview.tiers} peerWeight={overview.peerWeight} workWeight={overview.workWeight} />
      <GiveButton person={person} onGiven={onGiven} />
      <History entries={profile.history} isSuperadmin={overview.isSuperadmin} onChanged={onChanged} />
    </>
  );
}

function Summary({
  profile,
  tiers,
  peerWeight,
  workWeight,
}: {
  profile: KopiProfile;
  tiers: { tier: KopiProfile["tier"]; minScore: number }[];
  peerWeight: number;
  workWeight: number;
}) {
  const tierName = kopiTierName(profile.tier);
  const base = [...tiers].reverse().find((t) => t.minScore <= profile.score)?.minScore ?? 0;
  const next = profile.next;
  let bar = null;
  let line: string;
  if (next) {
    const span = Math.max(1, next.minScore - base);
    const done = Math.min(span, Math.max(0, profile.score - base));
    const need = Math.max(0, next.minScore - profile.score);
    line = T.profile.progressText(profile.score, need, kopiTierName(next.tier));
    bar = (
      <div
        className="kopi-bar"
        role="progressbar"
        aria-label={T.profile.progressLabel(kopiTierName(next.tier))}
        aria-valuemin={base}
        aria-valuemax={next.minScore}
        aria-valuenow={Math.min(profile.score, next.minScore)}
        aria-valuetext={line}
      >
        <span style={{ width: `${(done / span) * 100}%` }} />
      </div>
    );
  } else {
    line = T.profile.top(profile.score);
  }
  return (
    <div className="kopi-sum">
      <div className="kopi-sum-tier">
        <span className="kopi-sum-label">{T.profile.tierLabel}</span>
        <span className={`kopi-sum-name kopi-r${kopiTierRank(profile.tier)}`}>{tierName}</span>
      </div>
      <dl className="kopi-counts">
        <div>
          <dt>{T.profile.fromPeers}</dt>
          <dd>{profile.peer}</dd>
        </div>
        <div>
          <dt>{T.profile.fromWork}</dt>
          <dd>{profile.work}</dd>
        </div>
      </dl>
      {bar}
      <p className="kopi-sum-line">
        {line}
      </p>
      <p className="hint">{T.profile.scoreHint(peerWeight, workWeight)}</p>
    </div>
  );
}

function GiveButton({ person, onGiven }: { person: KopiPerson; onGiven: () => void }) {
  const { overview } = useKopi();
  // Target ditetapkan saat tombol diklik, jadi dialog yang dibuka sebelum tengah
  // malam tidak memakai hari kemarin dari render lama. null: dialog tertutup.
  const [target, setTarget] = useState<KopiTarget | null>(null);
  const [sent, setSent] = useState("");
  const noteId = useId();
  if (!overview || !overview.canGive || person.publicKey === overview.me) return null;
  const todayKey = kopiTargetKey(person.publicKey, { kind: "profile", day: kopiToday() });
  let why: string | null = null;
  if (overview.givenTargets.includes(todayKey)) why = T.profile.givenToday;
  else if (overview.givenToday >= overview.dailyLimit) why = T.profile.noneLeft(overview.dailyLimit);
  return (
    <div className="kopi-give-row">
      <button
        type="button"
        className="btn btn-ghost btn-sm kopi-btn kopi-tap"
        aria-disabled={why ? true : undefined}
        aria-describedby={why ? noteId : undefined}
        onClick={() => {
          if (!why) setTarget({ kind: "profile", day: kopiToday() });
        }}
      >
        <IconCoffee size={16} aria-hidden="true" />
        {T.profile.giveBtn}
      </button>
      {why && (
        <p className="hint" id={noteId}>
          {why}
        </p>
      )}
      <p className="sr-only" role="status">
        {sent}
      </p>
      {target && (
        <KopiGiveDialog
          open
          onClose={() => setTarget(null)}
          to={person}
          target={target}
          onGiven={(name) => {
            setSent(T.give.sent(name));
            onGiven();
          }}
        />
      )}
    </div>
  );
}

function History({
  entries,
  isSuperadmin,
  onChanged,
}: {
  entries: KopiEntry[];
  isSuperadmin: boolean;
  onChanged: () => void;
}) {
  useLang();
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = all ? entries : entries.slice(0, HISTORY_PREVIEW);

  async function toggle(id: string, hidden: boolean) {
    setBusy(id);
    setError(null);
    try {
      await kopiApi.hide(id, hidden);
      onChanged();
    } catch (err) {
      setError(toAppError(err).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="kopi-hist">
      <h4 className="kopi-hist-title">{T.profile.historyTitle}</h4>
      <div aria-live="polite">
        {error && (
          <ErrorAlert title={T.profile.hideFail}>
            <p>{error}</p>
          </ErrorAlert>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="hint">{T.profile.empty}</p>
      ) : (
        <ul className="kopi-hist-list">
          {shown.map((e) =>
            e.kind === "peer" ? (
              <li key={e.id} className={`kopi-entry${e.hidden ? " kopi-entry-hidden" : ""}`}>
                <IconCoffee size={16} className="kopi-entry-icon" aria-hidden="true" />
                <div className="kopi-entry-body">
                  <p className="kopi-entry-head">
                    <span>
                      <strong>{e.from.name}</strong>, {via(e.target)}
                    </span>
                    {e.hidden && <span className="chip kopi-hidden-chip">{T.profile.hiddenChip}</span>}
                  </p>
                  <p className="kopi-entry-reason">{e.reason}</p>
                  <Time at={e.at} />
                </div>
                {isSuperadmin && (
                  // aria-disabled, bukan disabled: tombol yang baru diklik tetap memegang fokus.
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm kopi-btn kopi-tap kopi-entry-act"
                    aria-label={
                      e.hidden
                        ? T.profile.unhideFor(e.from.name, relativeTime(e.at))
                        : T.profile.hideFor(e.from.name, relativeTime(e.at))
                    }
                    onClick={() => {
                      if (busy === null) void toggle(e.id, !e.hidden);
                    }}
                    aria-disabled={busy !== null || undefined}
                    aria-busy={busy === e.id || undefined}
                  >
                    {e.hidden ? T.profile.unhide : T.profile.hide}
                  </button>
                )}
              </li>
            ) : (
              <li key={e.id} className="kopi-entry">
                <IconSquareCheck size={16} className="kopi-entry-icon" aria-hidden="true" />
                <div className="kopi-entry-body">
                  <p className="kopi-entry-head">
                    <span className="sr-only">{T.profile.workLabel}: </span>
                    <strong>{e.title ?? T.profile.otherProject}</strong>
                  </p>
                  <p className="kopi-entry-reason">{e.why === "assigned" ? T.profile.whyAssigned : T.profile.whyOnTime}</p>
                  <Time at={e.at} />
                </div>
              </li>
            ),
          )}
        </ul>
      )}
      {entries.length > HISTORY_PREVIEW && (
        <button type="button" className="link-btn kopi-more kopi-tap" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? T.profile.showLess : T.profile.showAll(entries.length)}
        </button>
      )}
    </div>
  );
}

function via(target: KopiTarget): string {
  switch (target.kind) {
    case "message":
      return T.profile.viaMessage;
    case "task":
      return T.profile.viaTask;
    case "profile":
      return T.profile.viaProfile;
  }
}

function Time({ at }: { at: string }) {
  return (
    <time className="kopi-entry-time" dateTime={at} title={formatDateTime(at)}>
      {relativeTime(at)}
    </time>
  );
}
