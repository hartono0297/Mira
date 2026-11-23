import { useCallback, useMemo, useRef, useState } from "react";
import { toAppError, type AppError } from "../../api";
import { chatApi, type ChatOverview, type ConversationSummary, type Person } from "../../api/chat";
import { ErrorAlert } from "../../components/ErrorAlert";
import { ChatActionsContext, type ChatActions, type ConvRequest } from "./ChatActions";
import { Conversation } from "./Conversation";
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

  // Pilihan yang sudah tidak ada (channel dihapus, akses dicabut) kembali ke #umum.
  const list = overview?.conversations ?? [];
  const current = list.find((c) => c.id === selected) ?? defaultConversation(list);

  const changed = useCallback(() => void reload(), [reload]);
  const gone = useCallback(() => {
    setSelected(null);
    void reload();
  }, [reload]);

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
        } catch (err) {
          setDmError(toAppError(err));
        }
      },
      showProfile: (person) => setProfile(person),
    }),
    [overview?.me, dmKeys],
  );

  if (!overview) {
    return (
      <main className="chat" aria-labelledby="page-title">
        <div className="chat-list">
          <div className="chat-list-head">
            <h1 id="page-title" className="page-title">
              Chat
            </h1>
          </div>
        </div>
        <div className="chat-main">
          {live.loading ? (
            <p className="chat-pad hint" role="status">
              Memuat chat...
            </p>
          ) : (
            <div className="chat-pad chat-narrow" role="alert">
              <ErrorAlert title="Daftar chat belum terbaca">
                <p>{live.error?.message ?? "Inti Mira tidak mengirim daftar chat."}</p>
                <p>Pesan tersimpan di laptop ini, tidak ada yang hilang. Tunggu sebentar lalu coba lagi.</p>
                <button type="button" className="btn btn-ghost btn-sm chat-retry" onClick={() => void reload()}>
                  Coba lagi
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
        onRetry={changed}
        onNewChannel={() => setOpen("channel")}
        onNewGroup={() => setOpen("group")}
        onNewDirect={() => setOpen("direct")}
        onNotify={() => setOpen("notify")}
      />

      <div className="chat-main">
        {current ? (
          <Conversation
            key={current.id}
            summary={current}
            me={overview.me}
            onChanged={changed}
            onGone={gone}
            request={request}
            onRequestDone={requestDone}
          />
        ) : (
          <EmptyChat guest={overview.isGuest} />
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
      <div aria-live="polite" className="chat-dm-error">
        {dmError && (
          <ErrorAlert title="Pesan pribadi belum bisa dibuka">
            <p>{dmError.message}</p>
          </ErrorAlert>
        )}
      </div>
    </main>
    </ChatActionsContext.Provider>
  );
}

function EmptyChat({ guest }: { guest: boolean }) {
  return (
    <div className="chat-empty">
      <h2 className="chat-empty-title">Belum ada percakapan</h2>
      {guest ? (
        <p>
          Sebagai Tamu, Anda hanya bisa chat di proyek yang Anda diundang ke dalamnya. Chat proyek itu muncul di
          bagian Proyek begitu laptop Anda tersambung dengan laptop rekan di kantor. Kalau belum muncul juga, minta
          admin proyek memeriksa undangan Anda.
        </p>
      ) : (
        <p>
          Channel #umum, channel departemen, dan chat proyek Anda muncul di sini begitu data kantor tersalin dari
          laptop rekan. Sementara itu Anda bisa membuat grup atau mengirim pesan pribadi dari daftar di kiri.
        </p>
      )}
    </div>
  );
}
