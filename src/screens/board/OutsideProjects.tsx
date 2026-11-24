// Bagian "Proyek lain" di navigasi board, hanya untuk superadmin (keputusan D10):
// proyek terdaftar yang belum saya ikuti. Superadmin boleh menambahkan dirinya
// sendiri, dan langkah itu tercatat di log organisasi.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import { boardApi, subscribeBoard, type OutsideProject } from "../../api/board";
import { orgApi, subscribeOrg } from "../../api/org";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { teamLabel } from "./format";
import { TEKS_LAYAR } from "./teks";
import "./members.css";

type Props = {
  // Kunci publik saya. null selama data organisasi belum terbaca.
  myKey: string | null;
  // Saya baru saja bergabung: daftar proyek perlu dimuat ulang.
  onJoined: (projectId: string) => void;
};

// Nama proyek hanya ada kalau laptop ini masih menyimpan board-nya; log keanggotaan tidak memuatnya.
export function outsideLabel(p: OutsideProject): string {
  if (p.code && p.name) return `${p.code} ${p.name}`;
  if (p.name) return p.name;
  return p.teamName ? TEKS_LAYAR.luar.proyekDepartemen(teamLabel(p.teamName)) : TEKS_LAYAR.luar.tanpaDepartemen;
}

function outsideSub(p: OutsideProject): string {
  return TEKS_LAYAR.luar.sub(p.creatorName, p.memberCount);
}

export function OutsideProjects({ myKey, onJoined }: Props) {
  const [items, setItems] = useState<OutsideProject[] | null>(null);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [joining, setJoining] = useState<OutsideProject | null>(null);
  const [busy, setBusy] = useState(false);
  const [joinError, setJoinError] = useState<AppError | null>(null);
  const [message, setMessage] = useState("");
  const seq = useRef(0);
  const msgRef = useRef<HTMLParagraphElement>(null);
  // Tombol Gabung yang membuka konfirmasi hilang bersama barisnya; fokus pindah ke pesan.
  const [refocus, setRefocus] = useState(0);
  const ids = useId();

  useEffect(() => {
    if (!refocus) return;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body) msgRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refocus]);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await boardApi.outsideProjects();
      if (mine !== seq.current) return;
      setItems(Array.isArray(next) ? next : []);
      setLoadError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      setLoadError(toAppError(err));
    }
  }, []);

  useEffect(() => {
    void reload();
    const stopOrg = subscribeOrg(() => void reload());
    const stopBoard = subscribeBoard(() => void reload());
    return () => {
      seq.current++;
      stopOrg();
      stopBoard();
    };
  }, [reload]);

  async function join() {
    if (!joining || !myKey) return;
    setBusy(true);
    setJoinError(null);
    try {
      await orgApi.addProjectMember(joining.id, myKey);
      const label = outsideLabel(joining);
      setJoining(null);
      setMessage(
        joining.name ? TEKS_LAYAR.luar.sudahAnggota(label) : TEKS_LAYAR.luar.sudahAnggotaTunggu(label),
      );
      onJoined(joining.id);
      await reload();
      setRefocus((n) => n + 1);
    } catch (err) {
      setJoinError(toAppError(err));
    } finally {
      setBusy(false);
    }
  }

  const list = items ?? [];
  if (list.length === 0 && !message && !(loadError && items === null)) return null;

  return (
    <section className="op" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} className="bd-lbl">
        {TEKS_LAYAR.luar.judul}
      </h2>
      {list.length > 0 && (
        <p className="bd-nav-note">{TEKS_LAYAR.luar.catatan}</p>
      )}
      {loadError && items === null && (
        <p className="bd-nav-note">
          {TEKS_LAYAR.luar.belumTerbaca}{" "}
          <button type="button" className="link-btn" onClick={() => void reload()}>
            {TEKS_LAYAR.luar.cobaLagi}
          </button>
        </p>
      )}
      {list.length > 0 && (
        <ul className="op-list">
          {list.map((p) => {
            const titleId = `${ids}-${p.id}`;
            return (
              <li key={p.id} className="op-row">
                <span id={titleId} className="op-title">
                  {outsideLabel(p)}
                </span>
                <span className="op-sub">{outsideSub(p)}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={TEKS_LAYAR.luar.gabungLabel(outsideLabel(p))}
                  aria-describedby={titleId}
                  disabled={!myKey}
                  onClick={() => {
                    setJoinError(null);
                    setJoining(p);
                  }}
                >
                  {TEKS_LAYAR.luar.gabungTombol}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="bd-nav-note op-msg" role="status" ref={msgRef} tabIndex={-1}>
        {message}
      </p>

      <ConfirmDialog
        open={joining !== null}
        onOpenChange={(next) => {
          if (!next) setJoining(null);
        }}
        title={joining ? TEKS_LAYAR.luar.gabungJudul(outsideLabel(joining)) : TEKS_LAYAR.luar.gabungJudulCadangan}
        confirmLabel={TEKS_LAYAR.luar.gabung}
        busyLabel={TEKS_LAYAR.luar.bergabung}
        busy={busy}
        danger={false}
        onConfirm={() => void join()}
        error={
          joinError && (
            <ErrorAlert title={TEKS_LAYAR.luar.belumBergabung}>
              <p>{joinError.message}</p>
            </ErrorAlert>
          )
        }
      >
        <p>{TEKS_LAYAR.luar.gabungIsi}</p>
        {joining && !joining.name && (
          <p className="pm-confirm-p">{TEKS_LAYAR.luar.boardMenyusul}</p>
        )}
      </ConfirmDialog>
    </section>
  );
}
