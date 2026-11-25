// Pemberitahuan timer saya yang dijeda otomatis oleh inti Rust
// (docs/plans/timer-jeda.md bagian "Aturan jeda otomatis"). Diambil saat
// layar board dibuka dan setiap ada event board, lalu disimpan di
// timerNoticeStore; yang terbaru di atas. Galat diabaikan: board tetap bisa
// dipakai tanpa pemberitahuan ini.
import { IconPlayerPause, IconX } from "@tabler/icons-react";
import { useEffect, useRef, type FocusEvent } from "react";
import { boardApi, subscribeBoard } from "../../api/board";
import { TN } from "./teksWaktu";
import {
  dismissAllTimerNotices,
  dismissTimerNotice,
  noticeText,
  pushTimerNotices,
  useTimerNoticeAnnouncement,
  useTimerNotices,
} from "./timerNoticeStore";
import "./timer-notices.css";

export function TimerNotices() {
  const shown = useTimerNotices();
  const say = useTimerNoticeAnnouncement();
  const rootRef = useRef<HTMLDivElement>(null);
  // Elemen yang fokus sebelum fokus masuk ke pemberitahuan: tujuan fokus
  // setelah pemberitahuan terakhir ditutup.
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const take = () => {
      // Antrean di inti Rust sudah dikosongkan saat diambil, jadi hasilnya
      // tetap disimpan walau komponen sudah dilepas (store bersama).
      Promise.resolve()
        .then(() => boardApi.takeTimerNotices())
        .then(pushTimerNotices)
        .catch(() => {});
    };
    take();
    return subscribeBoard(take);
  }, []);

  function focusEntered(e: FocusEvent<HTMLDivElement>) {
    const from = e.relatedTarget;
    if (from instanceof HTMLElement && !rootRef.current?.contains(from)) returnTo.current = from;
  }

  // Tidak ada pemberitahuan lagi: kembali ke elemen sebelumnya kalau masih ada,
  // selain itu ke judul board atau Task saya di bawahnya.
  function focusAway() {
    const back = returnTo.current;
    returnTo.current = null;
    if (back?.isConnected) {
      back.focus();
      return;
    }
    rootRef.current?.parentElement?.querySelector<HTMLElement>("h2[tabindex='-1']")?.focus();
  }

  function dismiss(key: number, index: number) {
    if (shown.length === 1) {
      dismissTimerNotice(key);
      focusAway();
      return;
    }
    // Fokus pindah ke tombol tutup pemberitahuan berikutnya (atau sebelumnya).
    const buttons = rootRef.current?.querySelectorAll<HTMLButtonElement>(".tn-close");
    const target = buttons?.[index + 1] ?? buttons?.[index - 1] ?? null;
    dismissTimerNotice(key);
    target?.focus();
  }

  function dismissAll() {
    dismissAllTimerNotices();
    focusAway();
  }

  return (
    <div className="tn" ref={rootRef} onFocus={focusEntered}>
      {/* Hanya kalimat yang baru masuk yang dibacakan, bukan seluruh daftar. */}
      <span className="sr-only" role="status">
        {say}
      </span>
      {shown.length > 0 && (
        <div className="tn-wrap">
          <ul className="tn-list" aria-label={TN.region}>
            {shown.map(({ key, notice }, index) => (
              <li key={key} className="tn-item" data-reason={notice.reason}>
                <IconPlayerPause size={16} aria-hidden="true" className="tn-icon" />
                <p className="tn-text">{noticeText(notice)}</p>
                <button type="button" className="tn-close" aria-label={TN.dismiss} onClick={() => dismiss(key, index)}>
                  <IconX size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {shown.length > 1 && (
            <button type="button" className="btn btn-ghost btn-sm tn-all" onClick={dismissAll}>
              {TN.dismissAll}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
