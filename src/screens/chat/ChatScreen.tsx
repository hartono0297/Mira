import { useCallback, useState } from "react";
import { chatApi, type ChatOverview, type ConversationSummary } from "../../api/chat";
import { ErrorAlert } from "../../components/ErrorAlert";
import { Conversation } from "./Conversation";
import { ConversationList } from "./ConversationList";
import { defaultConversation, withConversation } from "./ListFormat";
import { NewChannelDialog } from "./NewChannelDialog";
import { NewDirectDialog } from "./NewDirectDialog";
import { NewGroupDialog } from "./NewGroupDialog";
import { NotifySettings } from "./NotifySettings";
import { PeopleLabelsProvider } from "./PeopleLabels";
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
    void reload();
  }

  const closeTo = (next: boolean) => {
    if (!next) setOpen(null);
  };

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
    <main className="chat" aria-labelledby="page-title">
      <ConversationList
        overview={overview}
        currentId={current?.id ?? null}
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
          <Conversation key={current.id} summary={current} me={overview.me} onChanged={changed} onGone={gone} />
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
    </main>
  );
}

function EmptyChat({ guest }: { guest: boolean }) {
  return (
    <div className="chat-empty">
      <h2 className="chat-empty-title">Belum ada percakapan</h2>
      {guest ? (
        <p>
          Sebagai Tamu, Anda hanya bisa chat di channel proyek yang Anda diundang ke dalamnya. Channel itu muncul di
          bagian Proyek begitu laptop Anda tersambung dengan laptop rekan di kantor. Kalau belum muncul juga, minta
          admin proyek memeriksa undangan Anda.
        </p>
      ) : (
        <p>
          Channel #umum, channel departemen, dan channel proyek Anda muncul di sini begitu data kantor tersalin dari
          laptop rekan. Sementara itu Anda bisa membuat grup atau mengirim pesan pribadi dari daftar di kiri.
        </p>
      )}
    </div>
  );
}
