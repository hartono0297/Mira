import { IconCheck, IconChecks, IconClock, IconClockShare, type Icon } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { toAppError, type AppError } from "../../api";
import {
  chatApi,
  DELIVERY_LABELS,
  type ConversationSummary,
  type DeliveryState,
  type MessageStatus,
  type ReceiptView,
} from "../../api/chat";
import { deliveryLine } from "./text";

const ICONS: Record<DeliveryState, Icon> = {
  pending: IconClock,
  deposited: IconClockShare,
  delivered: IconCheck,
  read: IconChecks,
};

export function StateIcon({ state, size = 14 }: { state: DeliveryState; size?: number }) {
  const Glyph = ICONS[state];
  return <Glyph size={size} aria-hidden="true" />;
}

type Props = {
  messageId: string;
  status: MessageStatus;
  kind: ConversationSummary["kind"];
};

// Status pesan sendiri. Tombolnya membuka daftar per orang dari chat_message_receipts.
// Ikon dan teks selalu tampil bersama, warna tidak membawa arti sendiri.
export function DeliveryStatus({ messageId, status, kind }: Props) {
  const line = deliveryLine(status, kind);
  const [open, setOpen] = useState(false);
  const [receipts, setReceipts] = useState<ReceiptView[] | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popId = useId();
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const list = await chatApi.messageReceipts(messageId);
      if (alive.current) setReceipts(list);
    } catch (err) {
      if (alive.current) setError(toAppError(err));
    } finally {
      if (alive.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    popRef.current?.focus();
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!line) return null;

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    void load();
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    }
  }

  return (
    <div
      className="conv-status-wrap"
      ref={wrapRef}
      onKeyDown={onKey}
      onBlur={(e) => {
        if (open && !wrapRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="conv-status"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-haspopup="dialog"
        aria-label={`Status: ${line.text}. Lihat rincian per orang`}
        onClick={toggle}
      >
        <StateIcon state={line.icon} />
        <span>{line.text}</span>
      </button>
      {open && (
        <div ref={popRef} id={popId} className="conv-pop" role="dialog" aria-label="Status pesan per orang" tabIndex={-1}>
          <p className="conv-pop-title">Status pesan</p>
          {loading && !receipts && <p className="conv-pop-note">Memuat status...</p>}
          {error && (
            <div className="conv-pop-note" role="alert">
              <p>Status belum bisa dimuat. {error.message}</p>
              <button type="button" className="link-btn" onClick={() => void load()}>
                Coba lagi
              </button>
            </div>
          )}
          {receipts && receipts.length === 0 && <p className="conv-pop-note">Belum ada penerima.</p>}
          {receipts && receipts.length > 0 && (
            <ul className="conv-receipts">
              {receipts.map((r) => (
                <li key={r.person.publicKey}>
                  <span className="conv-receipt-name">{r.person.name}</span>
                  <span className="conv-receipt-state">
                    <StateIcon state={r.state} />
                    {DELIVERY_LABELS[r.state]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
