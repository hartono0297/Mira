import { IconLoader2 } from "@tabler/icons-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import {
  chatApi,
  type ConversationEvent,
  type ConversationSummary,
  type ConversationView,
  type MessageView,
  type Person,
} from "../../api/chat";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorAlert } from "../../components/ErrorAlert";
import { ConversationActionsContext, type ConversationActions, type ConvRequest } from "./ChatActions";
import { Composer, type MentionRequest } from "./Composer";
import { ConversationHeader } from "./ConversationHeader";
import { useGroupView } from "./GroupMembers";
import { messageDomId } from "./MessageItem";
import { buildTimeline, mergeEvents, MessageList } from "./MessageList";
import { conversationTarget, conversationTitle, mergeMessages, messagePreview } from "./text";
import { useChatLive } from "./useChatLive";
import "./conversation.css";

// Kontrak antara ChatScreen (daftar) dan panel percakapan.
export type ConversationProps = {
  summary: ConversationSummary;
  me: string;
  // Data percakapan berubah (kirim, hapus, arsip): ChatScreen memuat ulang ringkasan.
  onChanged: () => void;
  // Percakapan tidak tersedia lagi (channel dihapus): ChatScreen kembali ke #umum.
  onGone: () => void;
  // Permintaan dari menu sidebar (Ganti nama, Tambah orang) untuk percakapan ini.
  request?: ConvRequest | null;
  onRequestDone?: () => void;
};

// Jarak dari bawah (px) yang masih dianggap "di bawah": pesan baru ikut menggulir.
const NEAR_BOTTOM_PX = 80;
const FLASH_MS = 2000;

// Satu panel per percakapan: ganti percakapan berarti semua keadaan (draf
// balasan, pesan lama yang dimuat, posisi gulir) mulai dari awal.
export function Conversation(props: ConversationProps) {
  return <ConversationPanel key={props.summary.id} {...props} />;
}

function lastFromOthers(messages: MessageView[]): MessageView | null {
  for (let i = messages.length - 1; i >= 0; i--) if (!messages[i].mine) return messages[i];
  return null;
}

function ConversationPanel({ summary, me, onChanged, onGone, request = null, onRequestDone }: ConversationProps) {
  const title = conversationTitle(summary);
  const load = useCallback(() => chatApi.messages(summary.id), [summary.id]);
  const live = useChatLive<ConversationView>(load, summary.id);
  const view = live.data;

  const [older, setOlder] = useState<MessageView[]>([]);
  const [olderEvents, setOlderEvents] = useState<ConversationEvent[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<AppError | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [replyTo, setReplyTo] = useState<MessageView | null>(null);
  const [toDelete, setToDelete] = useState<MessageView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<AppError | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  // Salin gagal: tampil juga di layar, bukan hanya untuk pembaca layar.
  const [copyError, setCopyError] = useState<string | null>(null);
  const [mentionRequest, setMentionRequest] = useState<MentionRequest | null>(null);

  // Data grup dipegang di sini: kepala percakapan (anggota, dialog) dan menu orang di pesan
  // (Keluarkan dari grup) memakai data yang sama.
  const groupState = useGroupView(
    summary.kind === "group" ? summary.id : null,
    `${summary.memberCount}|${summary.name}|${summary.former}`,
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const scrolledOnce = useRef(false);
  const lastId = useRef<string | null>(null);
  const restoreFromBottom = useRef<number | null>(null);
  const markedFor = useRef<string | null>(null);
  const baseline = useRef<string | null | undefined>(undefined);
  const alive = useRef(true);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const messages = useMemo(() => (view ? mergeMessages(older, view.messages) : []), [older, view]);
  const events = useMemo(() => (view ? mergeEvents(olderEvents, view.events ?? []) : []), [olderEvents, view]);
  const items = useMemo(() => buildTimeline(messages, events), [messages, events]);
  const loadedIds = useMemo(() => new Set(messages.map((m) => m.id)), [messages]);
  const hasMore = olderHasMore ?? view?.hasMore ?? false;
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const announcedFor = useRef<string | null | undefined>(undefined);
  const seenEvents = useRef<Set<string> | null>(null);

  // Pembaca layar: hanya pesan baru dari orang lain yang dibacakan. Riwayat saat
  // dibuka dan pesan lama yang dimuat di atas tidak ikut dibacakan.
  useEffect(() => {
    if (!view) return;
    const id = lastMessage?.id ?? null;
    if (announcedFor.current === undefined) {
      announcedFor.current = id;
      return;
    }
    if (id === announcedFor.current) return;
    announcedFor.current = id;
    if (lastMessage && !lastMessage.mine && !lastMessage.deleted) {
      setAnnounce(`Pesan baru dari ${lastMessage.author.name}: ${messagePreview(lastMessage, 160)}`);
    }
  }, [view, lastMessage]);

  // Kejadian grup baru (orang ditambahkan, keluar, ganti nama) dibacakan sekali. Kejadian
  // yang sudah ada saat dibuka dan yang ikut termuat bersama pesan lama tidak dibacakan.
  useEffect(() => {
    if (!view) return;
    const latest = view.events ?? [];
    if (seenEvents.current === null) {
      seenEvents.current = new Set(latest.map((e) => e.id));
      return;
    }
    const fresh = latest.filter((e) => !seenEvents.current!.has(e.id));
    fresh.forEach((e) => seenEvents.current!.add(e.id));
    if (fresh.length > 0) setAnnounce(fresh[fresh.length - 1].text);
  }, [view]);

  // Gulir: ke bawah saat pertama dibuka, ikut pesan atau kejadian baru kalau pengguna
  // di dekat bawah atau pesan itu kiriman sendiri, dan tetap di tempat saat pesan lama
  // ditambahkan di atas.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const last = items[items.length - 1];
    if (!el || !last || last.kind === "day") return;
    const key = last.kind === "message" ? last.message.id : `ev-${last.event.id}`;
    const mine = last.kind === "message" && last.message.mine;
    if (restoreFromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - restoreFromBottom.current;
      restoreFromBottom.current = null;
    } else if (!scrolledOnce.current) {
      el.scrollTop = el.scrollHeight;
      scrolledOnce.current = true;
    } else if (key !== lastId.current && (nearBottom.current || mine)) {
      el.scrollTop = el.scrollHeight;
    }
    lastId.current = key;
  }, [items]);

  // Tandai dibaca: saat dibuka dengan pesan belum dibaca, atau saat pesan baru
  // dari orang lain datang. Satu panggilan per pesan terakhir dari orang lain.
  useEffect(() => {
    if (!view) return;
    const lastOther = lastFromOthers(view.messages)?.id ?? null;
    if (baseline.current === undefined) baseline.current = summary.unread > 0 ? null : lastOther;
    if (!lastOther || markedFor.current === lastOther) return;
    if (summary.unread <= 0 && lastOther === baseline.current) return;
    markedFor.current = lastOther;
    chatApi
      .markRead(summary.id)
      .then(() => {
        if (alive.current) onChangedRef.current();
      })
      .catch(() => {
        // Dicoba lagi saat data berikutnya datang (event atau polling).
        if (markedFor.current === lastOther) markedFor.current = null;
      });
  }, [view, summary.id, summary.unread]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }

  async function loadOlder() {
    if (loadingOlder || messages.length === 0) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await chatApi.messages(summary.id, messages[0].id);
      if (!alive.current) return;
      const el = scrollRef.current;
      restoreFromBottom.current = el ? el.scrollHeight - el.scrollTop : null;
      setOlder((prev) => mergeMessages(page.messages, prev));
      setOlderEvents((prev) => mergeEvents(page.events ?? [], prev));
      setOlderHasMore(page.hasMore);
    } catch (err) {
      if (alive.current) setOlderError(toAppError(err));
    } finally {
      if (alive.current) setLoadingOlder(false);
    }
  }

  async function retry() {
    setRetrying(true);
    await live.reload();
    if (alive.current) setRetrying(false);
  }

  const reloadLive = live.reload;
  const reload = useCallback(() => void reloadLive(), [reloadLive]);

  function onSent(sent: MessageView) {
    setReplyTo(null);
    nearBottom.current = true;
    if (view && !view.messages.some((m) => m.id === sent.id)) {
      live.setData({ ...view, messages: [...view.messages, sent] });
    }
    void live.reload();
    onChanged();
  }

  const onReply = useCallback((m: MessageView) => {
    setReplyTo(m);
    inputRef.current?.focus();
  }, []);

  const onDelete = useCallback((m: MessageView) => {
    setDeleteError(null);
    setToDelete(m);
  }, []);

  // Teks sama berturut-turut (salin dua kali) tetap dibacakan ulang: isinya dibuat berbeda.
  const onAnnounce = useCallback((text: string, error?: boolean) => {
    if (error) {
      setCopyError(text);
      return;
    }
    setCopyError(null);
    setAnnounce((prev) => (prev === text ? `${text}\u00a0` : text));
  }, []);

  const onJump = useCallback((id: string) => {
    const el = document.getElementById(messageDomId(id));
    if (!el) return;
    el.scrollIntoView?.({ block: "center" });
    el.focus({ preventScroll: true });
    setFlashId(id);
  }, []);

  useEffect(() => {
    if (!flashId) return;
    const t = window.setTimeout(() => setFlashId(null), FLASH_MS);
    return () => window.clearTimeout(t);
  }, [flashId]);

  async function confirmDelete() {
    if (!toDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await chatApi.deleteMessage(summary.id, toDelete.id);
      if (!alive.current) return;
      if (replyTo?.id === toDelete.id) setReplyTo(null);
      setToDelete(null);
      void live.reload();
      onChanged();
    } catch (err) {
      if (alive.current) setDeleteError(toAppError(err));
    } finally {
      if (alive.current) setDeleting(false);
    }
  }

  let body;
  if (!view && live.loading) {
    body = (
      <p className="conv-state" role="status">
        <IconLoader2 size={18} className="conv-spin" aria-hidden="true" />
        Memuat pesan...
      </p>
    );
  } else if (!view) {
    body = (
      <div className="conv-state-error">
        <ErrorAlert title="Pesan belum bisa dimuat">
          <p>{live.error?.message}</p>
          <button
            type="button"
            className="btn btn-ghost btn-sm conv-retry"
            onClick={() => void retry()}
            disabled={retrying}
            aria-busy={retrying || undefined}
          >
            {retrying ? "Memuat ulang..." : "Coba lagi"}
          </button>
        </ErrorAlert>
      </div>
    );
  } else if (messages.length === 0 && events.length === 0) {
    body = (
      <p className="conv-state">
        {summary.canPost
          ? `Belum ada pesan di ${conversationTarget(summary)}. Tulis pesan pertama di kolom bawah.`
          : `Belum ada pesan di ${conversationTarget(summary)}.`}
      </p>
    );
  } else {
    body = (
      <>
        {hasMore && (
          <div className="conv-older">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void loadOlder()}
              disabled={loadingOlder}
              aria-busy={loadingOlder || undefined}
            >
              {loadingOlder ? "Memuat..." : "Muat pesan sebelumnya"}
            </button>
            <div aria-live="polite">
              {olderError && (
                <ErrorAlert title="Pesan sebelumnya belum bisa dimuat">
                  <p>{olderError.message}</p>
                </ErrorAlert>
              )}
            </div>
          </div>
        )}
        <MessageList
          items={items}
          me={me}
          kind={summary.kind}
          flashId={flashId}
          loadedIds={loadedIds}
          canReply={summary.canPost}
          onReply={onReply}
          onDelete={onDelete}
          onJump={onJump}
          onReload={reload}
          onAnnounce={onAnnounce}
        />
        {messages.length === 0 && (
          <p className="conv-state conv-state-after">
            {summary.canPost ? "Belum ada pesan. Tulis pesan pertama di kolom bawah." : "Belum ada pesan."}
          </p>
        )}
      </>
    );
  }

  const group = groupState.group;
  const reloadGroup = groupState.reload;
  const memberKeys = useMemo(() => new Set((view?.members ?? []).map((p) => p.publicKey)), [view]);
  const canPost = summary.canPost;
  const actions = useMemo<ConversationActions>(
    () => ({
      conv: summary.id,
      // Sebut dari menu pesan atau menu orang: Composer menyisipkan @Nama di posisi kursor.
      mention: canPost
        ? (person: Person) => setMentionRequest((prev) => ({ person, n: (prev?.n ?? 0) + 1 }))
        : null,
      isMember: (pk) => memberKeys.has(pk),
      canRemove: (pk) => !!group?.members.some((m) => m.person.publicKey === pk && m.canRemove),
      removeFromGroup: async (person) => {
        await chatApi.groupRemove(summary.id, person.publicKey);
        void reloadGroup();
        onChangedRef.current();
      },
    }),
    [summary.id, canPost, memberKeys, group, reloadGroup],
  );

  return (
    <ConversationActionsContext.Provider value={actions}>
    <section className="chat-conv conv" aria-label={title}>
      <ConversationHeader
        summary={summary}
        groupState={groupState}
        request={request?.conv === summary.id ? request : null}
        onRequestDone={onRequestDone}
        onChanged={onChanged}
        onGone={onGone}
      />
      <div aria-live="polite" className="conv-live">
        {view && live.error && (
          <ErrorAlert title="Pesan terbaru belum bisa dimuat">
            <p>{live.error.message}</p>
            <button type="button" className="link-btn" onClick={() => void retry()} disabled={retrying}>
              {retrying ? "Memuat ulang..." : "Coba lagi"}
            </button>
          </ErrorAlert>
        )}
        {copyError && (
          <div className="conv-copy-error">
            <ErrorAlert title={copyError}>
              <button type="button" className="link-btn" onClick={() => setCopyError(null)}>
                Tutup
              </button>
            </ErrorAlert>
          </div>
        )}
      </div>
      <div className="conv-scroll" ref={scrollRef} onScroll={onScroll} role="region" aria-label={`Pesan di ${title}`}>
        {body}
      </div>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <Composer
        summary={summary}
        me={me}
        members={view?.members ?? []}
        replyTo={replyTo}
        onCancelReply={() => {
          setReplyTo(null);
          inputRef.current?.focus();
        }}
        onSent={onSent}
        inputRef={inputRef}
        mentionRequest={mentionRequest}
      />
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(next) => {
          if (!next) setToDelete(null);
        }}
        title="Hapus pesan ini?"
        confirmLabel="Hapus pesan"
        busyLabel="Menghapus..."
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        error={
          deleteError && (
            <ErrorAlert title="Pesan belum terhapus">
              <p>{deleteError.message}</p>
            </ErrorAlert>
          )
        }
      >
        <p>
          Pesan ini dihapus untuk semua orang di {title} dan tidak bisa dikembalikan. Di percakapan hanya tersisa tanda
          "Pesan dihapus".
        </p>
      </ConfirmDialog>
    </section>
    </ConversationActionsContext.Provider>
  );
}
