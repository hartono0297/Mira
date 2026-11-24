import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from "react";
import { toAppError, type AppError } from "../../api";
import { chatApi, type ChatOverview, type ConversationSummary, type Person } from "../../api/chat";
import { ErrorAlert } from "../../components/ErrorAlert";
import { CHAT } from "../../i18n/chat";
import { ChatActionsContext, type ChatActions, type ConvRequest } from "./ChatActions";
import { Conversation, type FocusRequest } from "./Conversation";
import { ConversationList } from "./ConversationList";
import { defaultConversation, withConversation } from "./ListFormat";
import { NewChannelDialog } from "./NewChannelDialog";
import { NewDirectDialog } from "./NewDirectDialog";
import { NewGroupDialog } from "./NewGroupDialog";
import { NotifySettings } from "./NotifySettings";
import { PeopleLabelsProvider } from "./PeopleLabels";
import { ProfileDialog } from "./ProfileDialog";
import { useChatLive } from "./useChatLive";
import "./chat.css";

type Open = "channel" | "group" | "direct" | "notify" | null;

export function ChatScreen() {
  return (
    <PeopleLabelsProvider>
      <ChatScreenInner />
    </PeopleLabelsProvider>
  );
}

function ChatScreenInner() {
  const live = useChatLive<ChatOverview>(chatApi.overview, "overview");
  const overview = live.data;
  const { reload, setData } = live;
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const [reveal, setReveal] = useState<string | null>(null);
  const revealed = useCallback(() => setReveal(null), []);
  const [profile, setProfile] = useState<Person | null>(null);
  const [dmError, setDmError] = useState<AppError | null>(null);
  const [request, setRequest] = useState<ConvRequest | null>(null);
  const requestDone = useCallback(() => setRequest(null), []);
  const requestCount = useRef(0);
  // Ganti nama atau Tambah orang dari menu sidebar: buka percakapannya, lalu kepala percakapan
  // membuka dialognya begitu data grup siap.
  const requestFor = useCallback((conv: string, action: ConvRequest["action"]) => {
    setSelected(conv);
    setRequest({ conv, action, n: ++requestCount.current });
  }, []);

  // Pilihan yang sudah tidak ada (channel dihapus, akses dicabut) kembali ke #umum.
  const list = overview?.conversations ?? [];
  const current = list.find((c) => c.id === selected) ?? defaultConversation(list);

  // Aksi yang membuang panel percakapan (Kirim pesan pribadi, Hapus channel, Keluar dari grup)
  // juga membuang elemen yang sedang terfokus. Panel berikutnya memindahkan fokus sekali ke
  // kolom pesan atau judulnya. Ganti percakapan biasa dan muat ulang data tidak memakai ini.
  const [focusReq, setFocusReq] = useState<FocusRequest | null>(null);
  const focusCount = useRef(0);
  const focusDone = useCallback(() => setFocusReq(null), []);
  const requestFocus = useCallback((conv: string | null, target: FocusRequest["target"]) => {
    setFocusReq({ conv, target, n: ++focusCount.current });
  }, []);

  const changed = useCallback(() => void reload(), [reload]);
  const gone = useCallback(() => {
    setSelected(null);
    requestFocus(null, "title");
    void reload();
  }, [reload, requestFocus]);
  // Channel dihapus atau keluar dari grup lewat menu sidebar. Daftar sudah dimuat ulang oleh menu;
  // kalau percakapan itu sedang dibuka, kembali ke percakapan bawaan.
  const currentId = current?.id ?? null;
  const removed = useCallback(
    (conv: string) => {
      if (conv !== currentId) return;
      setSelected(null);
      requestFocus(null, "title");
    },
    [currentId, requestFocus],
  );

  // Tidak ada percakapan lagi untuk menerima fokus: judul keadaan kosong yang menerimanya.
  const emptyTitleRef = useRef<HTMLHeadingElement>(null);
  const noConversation = overview !== null && !current;
  useEffect(() => {
    if (!focusReq || !noConversation) return;
    emptyTitleRef.current?.focus();
    setFocusReq(null);
  }, [focusReq, noConversation]);

  function adopt(summary: ConversationSummary) {
    setOpen(null);
    if (overview) setData(withConversation(overview, summary));
    setSelected(summary.id);
    setReveal(summary.id);
    void reload();
  }

  const closeTo = (next: boolean) => {
    if (!next) setOpen(null);
  };

  const adoptRef = useRef(adopt);
  adoptRef.current = adopt;
  const dmKeys = useMemo(
    () => new Set(overview?.canDirectMessage ? overview.people.map((p) => p.publicKey) : []),
    [overview],
  );
  const actions = useMemo<ChatActions>(
    () => ({
      me: overview?.me ?? "",
      canMessage: (pk) => dmKeys.has(pk),
      openDm: async (person) => {
        setDmError(null);
        try {
          const summary = await chatApi.openDm(person.publicKey);
          setProfile(null);
          adoptRef.current(summary);
          requestFocus(summary.id, "composer");
        } catch (err) {
          setDmError(toAppError(err));
        }
      },
      showProfile: (person) => setProfile(person),
    }),
    [overview?.me, dmKeys, requestFocus],
  );

  if (!overview) {
    return (
      <main className="chat" aria-labelledby="page-title">
        <div className="chat-list">
          <div className="chat-list-head">
            <h1 id="page-title" className="page-title">
              {CHAT.title}
            </h1>
          </div>
        </div>
        <div className="chat-main">
          {live.loading ? (
            <p className="chat-pad hint" role="status">
              {CHAT.screen.loading}
            </p>
          ) : (
            <div className="chat-pad chat-narrow" role="alert">
              <ErrorAlert title={CHAT.screen.errorTitle}>
                <p>{live.error?.message ?? CHAT.screen.errorNoList}</p>
                <p>{CHAT.screen.errorSafe}</p>
                <button type="button" className="btn btn-ghost btn-sm chat-retry" onClick={() => void reload()}>
                  {CHAT.retry}
                </button>
              </ErrorAlert>
            </div>
          )}
        </div>
      </main>
    );
  }

  return (
    <ChatActionsContext.Provider value={actions}>
    <main className="chat" aria-labelledby="page-title">
      <ConversationList
        overview={overview}
        currentId={current?.id ?? null}
        revealId={reveal}
        onRevealed={revealed}
        staleError={live.error}
        onSelect={setSelected}
        onRequest={requestFor}
        onChanged={changed}
        onRemoved={removed}
        onRetry={changed}
        onNewChannel={() => setOpen("channel")}
        onNewGroup={() => setOpen("group")}
        onNewDirect={() => setOpen("direct")}
        onNotify={() => setOpen("notify")}
      />

      <div className="chat-main">
        {/* Di dalam kolom kanan, bukan anak langsung grid .chat: wilayah ini tidak boleh
            menambah baris grid. Kosong saat tidak ada error, jadi tingginya nol. */}
        <div aria-live="polite" className="chat-dm-error">
          {dmError && (
            <ErrorAlert title={CHAT.screen.dmError}>
              <p>{dmError.message}</p>
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  // Tombol ini ikut hilang: fokus pindah ke judul percakapan yang terbuka.
                  setDmError(null);
                  requestFocus(current?.id ?? null, "title");
                }}
              >
                {CHAT.close}
              </button>
            </ErrorAlert>
          )}
        </div>
        {current ? (
          <Conversation
            key={current.id}
            summary={current}
            me={overview.me}
            onChanged={changed}
            onGone={gone}
            request={request}
            onRequestDone={requestDone}
            focus={focusReq}
            onFocusDone={focusDone}
          />
        ) : (
          <EmptyChat guest={overview.isGuest} titleRef={emptyTitleRef} />
        )}
      </div>

      {overview.canCreateOrgChannel && (
        <NewChannelDialog open={open === "channel"} onOpenChange={closeTo} onCreated={adopt} />
      )}
      {overview.canCreateGroup && (
        <NewGroupDialog
          open={open === "group"}
          onOpenChange={closeTo}
          people={overview.people}
          onCreated={adopt}
        />
      )}
      {overview.canDirectMessage && (
        <NewDirectDialog open={open === "direct"} onOpenChange={closeTo} people={overview.people} onOpened={adopt} />
      )}
      <NotifySettings
        open={open === "notify"}
        onOpenChange={closeTo}
        mode={overview.notify}
        onSaved={(notify) => setData({ ...overview, notify })}
      />
      <ProfileDialog person={profile} onOpenChange={(next) => !next && setProfile(null)} />
    </main>
    </ChatActionsContext.Provider>
  );
}

function EmptyChat({ guest, titleRef }: { guest: boolean; titleRef: Ref<HTMLHeadingElement> }) {
  return (
    <div className="chat-empty">
      <h2 className="chat-empty-title" ref={titleRef} tabIndex={-1}>
        {CHAT.screen.emptyTitle}
      </h2>
      {guest ? <p>{CHAT.screen.emptyGuest}</p> : <p>{CHAT.screen.emptyMember}</p>}
    </div>
  );
}
