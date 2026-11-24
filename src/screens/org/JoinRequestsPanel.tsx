import { IconCheck, IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import { formatDateTime, relativeTime } from "../../api/format";
import { actionErrorTitle } from "../../api/messages";
import { orgApi, type JoinRequestView } from "../../api/org";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { initials } from "../../components/initials";
import { REQUEST_TEXT } from "../../i18n/org-requests";
import type { OrgPage } from "./context";
import { JoinAdBlock, OutdatedNotice } from "./JoinRequestsPanelAd";
import { useOrgLive } from "./useOrgLive";
import "./requests.css";

// Teks kartu permintaan. Isinya ada di src/i18n/org-requests.id.ts dan mengikuti
// bahasa aktif setiap kali dibaca.
export const CARD_TEXT = REQUEST_TEXT.card;

// Isi bebas dari peminta: kosong atau hanya spasi dianggap tidak ada.
function filled(s: string | null | undefined): string | null {
  const t = s?.trim();
  return t ? t : null;
}

function isIpv4(s: string): boolean {
  const parts = s.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

// Delapan segmen 16 bit, atau null kalau bukan IPv6 yang sah.
function parseIpv6(s: string): number[] | null {
  if (!s.includes(":")) return null;
  let body = s;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const v4 = s.slice(lastColon + 1);
  if (v4.includes(".")) {
    if (!isIpv4(v4)) return null;
    const b = v4.split(".").map(Number);
    tail = [(b[0] << 8) | b[1], (b[2] << 8) | b[3]];
    body = s.slice(0, lastColon + 1);
    if (!body.endsWith("::")) body = body.slice(0, -1);
  }
  const halves = body.split("::");
  if (halves.length > 2) return null;
  const read = (h: string) => (h === "" ? [] : h.split(":"));
  const head = read(halves[0]);
  const rest = halves.length === 2 ? read(halves[1]) : [];
  if (![...head, ...rest].every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const nums = (g: string[]) => g.map((x) => parseInt(x, 16));
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1) return known === 8 ? [...nums(head), ...tail] : null;
  if (known > 7) return null;
  return [...nums(head), ...new Array<number>(8 - known).fill(0), ...nums(rest), ...tail];
}

// Kelompok alamat seperti `ip_group` di src-tauri/src/permissions/join_store.rs
// (kontrak 8.6): satu IPv4, atau satu IPv6 /64 ditulis "a:b:c:d::/64".
// IPv4 yang dibungkus IPv6 (::ffff:a.b.c.d) dihitung sebagai IPv4, seperti
// `to_canonical`. Alamat yang tidak terbaca dikelompokkan dengan tulisan yang persis sama.
export function ipGroup(raw: string): string {
  const ip = raw.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (isIpv4(ip)) return ip;
  const seg = parseIpv6(ip);
  if (!seg) return raw.trim();
  if (seg.slice(0, 5).every((x) => x === 0) && seg[5] === 0xffff) {
    return [seg[6] >> 8, seg[6] & 0xff, seg[7] >> 8, seg[7] & 0xff].join(".");
  }
  return `${seg
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(":")}::/64`;
}

// Penolakan beruntun untuk satu kelompok alamat (kontrak 8.6). Daftarnya diambil
// saat dialog dibuka, supaya muat ulang di tengah jalan tidak mengubah yang ditolak.
type Bulk = {
  group: string;
  // Kartu tempat tombolnya ditekan, untuk memindahkan fokus sesudahnya.
  openerId: string;
  items: JoinRequestView[];
  // Urutan permintaan yang sedang ditolak (mulai 0), null kalau belum berjalan.
  current: number | null;
  error: { title: string; error: AppError; note: string } | null;
};

export function JoinRequestsPanel({ page }: { page: OrgPage }) {
  const live = useOrgLive(() => orgApi.joinRequests(), { version: page.version });
  const requests = useMemo(() => (Array.isArray(live.data) ? live.data : null), [live.data]);
  const [rejecting, setRejecting] = useState<JoinRequestView | null>(null);
  const [rejectBusy, setRejectBusy] = useState(false);
  const [rejectError, setRejectError] = useState<{ title: string; error: AppError } | null>(null);
  const [bulk, setBulk] = useState<Bulk | null>(null);
  // Setelah kartu hilang karena disetujui atau ditolak, fokus pindah ke tombol
  // Setujui kartu berikutnya, atau ke judul tab kalau daftar sudah kosong.
  const [focusAfter, setFocusAfter] = useState<{ gone: string[]; next: string[] } | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const requestsRef = useRef<JoinRequestView[]>([]);
  requestsRef.current = requests ?? [];
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const perGroup = useMemo(() => {
    const map = new Map<string, JoinRequestView[]>();
    for (const r of requests ?? []) {
      if (!r.ip) continue;
      const g = ipGroup(r.ip);
      map.set(g, [...(map.get(g) ?? []), r]);
    }
    return map;
  }, [requests]);

  useEffect(() => {
    if (!focusAfter || !requests) return;
    if (requests.some((r) => focusAfter.gone.includes(r.id))) return;
    setFocusAfter(null);
    const nextId = focusAfter.next.find((id) => requests.some((r) => r.id === id));
    const target = nextId
      ? Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-approve]") ?? []).find(
          (b) => b.dataset.approve === nextId,
        )
      : undefined;
    (target ?? titleRef.current)?.focus();
  }, [focusAfter, requests]);

  // Kandidat fokus: kartu sesudah `fromId`, lalu kartu sebelumnya (terdekat dulu).
  function planFocus(fromId: string, gone: string[]) {
    const ids = requestsRef.current.map((r) => r.id);
    const at = Math.max(ids.indexOf(fromId), 0);
    const next = [...ids.slice(at + 1), ...ids.slice(0, at).reverse()].filter((id) => !gone.includes(id));
    setFocusAfter({ gone, next });
  }

  const running = bulk?.current != null;
  const busy = page.pending !== null || running || rejectBusy;
  const scoped = !page.overview.isSuperadmin;

  async function approve(r: JoinRequestView) {
    const ok = await page.act(
      `approve:${r.id}`,
      () => orgApi.approveJoin(r.id),
      REQUEST_TEXT.approved(r.displayName, r.teamName),
      REQUEST_TEXT.approveFailed,
    );
    if (ok && alive.current) planFocus(r.id, [r.id]);
  }

  // Dipanggil langsung (bukan lewat page.act) supaya error tampil di dialog
  // dan dialog tetap terbuka kalau gagal.
  async function rejectOne(r: JoinRequestView) {
    setRejectBusy(true);
    setRejectError(null);
    try {
      await orgApi.rejectJoin(r.id);
      if (!alive.current) return;
      planFocus(r.id, [r.id]);
      setRejecting(null);
      page.notify(REQUEST_TEXT.rejected(r.displayName));
      page.refresh();
    } catch (err) {
      if (!alive.current) return;
      const error = toAppError(err);
      setRejectError({ title: actionErrorTitle(error, REQUEST_TEXT.rejectFailed), error });
      if (error.code === "not_found" || error.code === "forbidden") page.refresh();
    } finally {
      if (alive.current) setRejectBusy(false);
    }
  }

  async function rejectAll(target: Bulk) {
    const { group, openerId, items } = target;
    let done = 0;
    let skipped = 0;
    for (let i = 0; i < items.length; i++) {
      if (!alive.current) return;
      setBulk({ ...target, current: i, error: null });
      try {
        await orgApi.rejectJoin(items[i].id);
        done++;
      } catch (err) {
        const error = toAppError(err);
        if (error.code === "join_already_decided") {
          skipped++;
          continue;
        }
        if (!alive.current) return;
        const parts = [REQUEST_TEXT.bulkStopped(done, items.length)];
        if (skipped > 0) parts.push(REQUEST_TEXT.bulkSkipped(skipped));
        parts.push(REQUEST_TEXT.bulkRetry);
        setBulk({
          group,
          openerId,
          items: items.slice(i),
          current: null,
          error: { title: REQUEST_TEXT.bulkFailedTitle(items[i].displayName), error, note: parts.join(" ") },
        });
        page.refresh();
        return;
      }
    }
    if (!alive.current) return;
    planFocus(
      openerId,
      items.map((r) => r.id),
    );
    setBulk(null);
    page.refresh();
    const skippedText = skipped > 0 ? REQUEST_TEXT.bulkSkippedTail(skipped) : "";
    page.notify(
      done > 0 ? REQUEST_TEXT.bulkDone(done, group, skippedText) : REQUEST_TEXT.bulkNoneLeft(group),
    );
  }

  const intro = (
    <div>
      <h2 id="requests-title" className="set-title" tabIndex={-1} ref={titleRef}>
        {REQUEST_TEXT.title}
      </h2>
      <p className="hint">
        {REQUEST_TEXT.intro}
        {scoped && REQUEST_TEXT.introScoped}
      </p>
    </div>
  );

  if (!requests) {
    return (
      <section className="set-section" aria-labelledby="requests-title">
        {intro}
        {live.loading ? (
          <p className="hint" role="status">
            {REQUEST_TEXT.loading}
          </p>
        ) : (
          <div role="alert">
            <ErrorAlert title={REQUEST_TEXT.loadErrorTitle}>
              <p>{live.error?.message ?? REQUEST_TEXT.loadErrorEmpty}</p>
              <button type="button" className="btn btn-ghost org-retry" onClick={() => void live.reload()}>
                {REQUEST_TEXT.retry}
              </button>
            </ErrorAlert>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="set-section" aria-labelledby="requests-title">
      {intro}
      {live.error && (
        <p className="hint">{REQUEST_TEXT.stale(live.error.message)}</p>
      )}

      {requests.length === 0 ? (
        <div className="org-empty">
          <p>
            <strong>{REQUEST_TEXT.emptyTitle}</strong>
          </p>
          <p className="req-empty-text">{REQUEST_TEXT.emptyBody(scoped)}</p>
        </div>
      ) : (
        <ul className="req-list" ref={listRef}>
          {requests.map((r) => {
            const group = r.ip ? ipGroup(r.ip) : null;
            const sameGroup = group ? (perGroup.get(group) ?? []) : [];
            const approving = page.pending === `approve:${r.id}`;
            const note = filled(r.note);
            const laptop = filled(r.laptop);
            const account = filled(r.account);
            return (
              <li key={r.id} className="req">
                <div className="req-head">
                  <div className="req-who">
                    <span className="req-av" aria-hidden="true">
                      {initials(r.displayName)}
                    </span>
                    <div className="req-who-text">
                      <h3 className="req-name">{r.displayName}</h3>
                      <p className="hint">
                        {REQUEST_TEXT.requested}{" "}
                        <time dateTime={r.requestedAt} title={formatDateTime(r.requestedAt)}>
                          {relativeTime(r.requestedAt)}
                        </time>
                      </p>
                    </div>
                  </div>
                  <div className="req-actions">
                    <button
                      type="button"
                      className="btn btn-ghost req-reject"
                      disabled={busy}
                      aria-label={REQUEST_TEXT.rejectAria(r.displayName)}
                      onClick={() => {
                        setRejectError(null);
                        setRejecting(r);
                      }}
                    >
                      <IconX size={16} aria-hidden="true" />
                      {REQUEST_TEXT.reject}
                    </button>
                    <button
                      type="button"
                      className="btn req-approve"
                      disabled={busy}
                      aria-busy={approving || undefined}
                      aria-label={approving ? undefined : REQUEST_TEXT.approveAria(r.displayName)}
                      data-approve={r.id}
                      onClick={() => void approve(r)}
                    >
                      <IconCheck size={16} aria-hidden="true" />
                      {approving ? REQUEST_TEXT.approving : REQUEST_TEXT.approve}
                    </button>
                  </div>
                </div>

                {r.requesterOutdated && <OutdatedNotice name={r.displayName} />}

                {note && (
                  <figure className="req-note">
                    <figcaption className="req-note-label">{CARD_TEXT.note}</figcaption>
                    <blockquote className="req-note-text" dir="auto">
                      {note}
                    </blockquote>
                  </figure>
                )}

                <dl className="req-facts">
                  <div>
                    <dt>{CARD_TEXT.department}</dt>
                    <dd>{r.teamName}</dd>
                  </div>
                  <div>
                    <dt>{CARD_TEXT.laptop}</dt>
                    <dd className={laptop ? "mono" : undefined}>{laptop ?? REQUEST_TEXT.notRecorded}</dd>
                  </div>
                  <div>
                    <dt>{CARD_TEXT.account}</dt>
                    <dd className={account ? "mono" : undefined}>
                      {r.account == null ? CARD_TEXT.accountNotSent : (account ?? REQUEST_TEXT.notRecorded)}
                    </dd>
                  </div>
                  <div>
                    <dt>{CARD_TEXT.ip}</dt>
                    <dd className={r.ip ? "mono" : undefined}>{r.ip ?? REQUEST_TEXT.notRecorded}</dd>
                  </div>
                  <div>
                    <dt>{CARD_TEXT.os}</dt>
                    <dd>{filled(r.os) ?? REQUEST_TEXT.notRecorded}</dd>
                  </div>
                  <div>
                    <dt>{CARD_TEXT.appVersion}</dt>
                    <dd>{filled(r.appVersion) ?? REQUEST_TEXT.notRecorded}</dd>
                  </div>
                </dl>

                {r.ad && <JoinAdBlock request={{ ...r, ad: r.ad }} />}

                <div className="req-match">
                  <div className="req-code-box">
                    <span className="req-code-label">{CARD_TEXT.codeLabel}</span>
                    <span className="req-code mono">{r.code}</span>
                  </div>
                  <p className="req-match-text">{CARD_TEXT.verifyHint}</p>
                </div>

                {(r.seenByName || sameGroup.length >= 2) && (
                  <div className="req-foot">
                    {r.seenByName && <p className="hint">{REQUEST_TEXT.seenBy(r.seenByName)}</p>}
                    {group && sameGroup.length >= 2 && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm req-reject-all"
                        disabled={busy}
                        onClick={() => setBulk({ group, openerId: r.id, items: sameGroup, current: null, error: null })}
                      >
                        {REQUEST_TEXT.rejectAllFrom(group, sameGroup.length)}
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={rejecting !== null}
        onOpenChange={(open) => {
          if (!open) setRejecting(null);
        }}
        title={rejecting ? REQUEST_TEXT.rejectOneTitle(rejecting.displayName) : REQUEST_TEXT.rejectOneTitleFallback}
        confirmLabel={rejecting ? REQUEST_TEXT.rejectOneConfirm(rejecting.displayName) : REQUEST_TEXT.reject}
        busyLabel={REQUEST_TEXT.rejecting}
        busy={rejectBusy}
        onConfirm={() => {
          if (rejecting && !rejectBusy) void rejectOne(rejecting);
        }}
        error={
          rejectError && (
            <ErrorAlert title={rejectError.title}>
              <p>{rejectError.error.message}</p>
            </ErrorAlert>
          )
        }
      >
        {rejecting && (
          <p>{REQUEST_TEXT.rejectOneBody(rejecting.displayName)}</p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={bulk !== null}
        onOpenChange={(open) => {
          if (!open) setBulk(null);
        }}
        title={bulk ? REQUEST_TEXT.bulkTitle(bulk.items.length, bulk.group) : REQUEST_TEXT.bulkTitleFallback}
        confirmLabel={bulk ? REQUEST_TEXT.bulkConfirm(bulk.items.length) : REQUEST_TEXT.reject}
        busyLabel={bulk?.current != null ? REQUEST_TEXT.bulkProgress(bulk.current + 1, bulk.items.length) : REQUEST_TEXT.rejecting}
        busy={running}
        onConfirm={() => {
          if (bulk && !running) void rejectAll(bulk);
        }}
        error={
          bulk?.error && (
            <ErrorAlert title={bulk.error.title}>
              <p>{bulk.error.error.message}</p>
              <p>{bulk.error.note}</p>
            </ErrorAlert>
          )
        }
      >
        {bulk && (
          <>
            <p>
              {bulk.group.endsWith("/64") ? REQUEST_TEXT.bulkIpv6 : REQUEST_TEXT.bulkSameIp}
            </p>
            <ul className="req-dlg-list">
              {bulk.items.map((r) => (
                <li key={r.id}>
                  {r.displayName}{" "}
                  <span className="hint">
                    ({r.teamName}
                    {r.ip && r.ip !== bulk.group && (
                      <>
                        , <span className="mono">{r.ip}</span>
                      </>
                    )}
                    )
                  </span>
                </li>
              ))}
            </ul>
            <p>{REQUEST_TEXT.bulkWhy}</p>
          </>
        )}
      </ConfirmDialog>
    </section>
  );
}
