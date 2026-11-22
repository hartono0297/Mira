import type { ConversationSummary, MessageView } from "../../api/chat";
import { MessageItem } from "./MessageItem";
import type { ListItem } from "./text";

type Props = {
  items: ListItem[];
  me: string;
  kind: ConversationSummary["kind"];
  flashId: string | null;
  loadedIds: Set<string>;
  onReply: (message: MessageView) => void;
  onDelete: (message: MessageView) => void;
  onJump: (messageId: string) => void;
  onReload: () => void;
};

// Daftar pesan dengan pemisah hari. Pengguliran diatur Conversation.
export function MessageList({ items, me, kind, flashId, loadedIds, onReply, onDelete, onJump, onReload }: Props) {
  return (
    <ol className="conv-list">
      {items.map((item) =>
        item.kind === "day" ? (
          <li key={`day-${item.key}`} className="conv-day">
            <h3 className="conv-day-label">{item.label}</h3>
          </li>
        ) : (
          <MessageItem
            key={item.message.id}
            message={item.message}
            grouped={item.grouped}
            me={me}
            kind={kind}
            flash={flashId === item.message.id}
            replyLoaded={!!item.message.replyTo && loadedIds.has(item.message.replyTo.id)}
            onReply={onReply}
            onDelete={onDelete}
            onJump={onJump}
            onReload={onReload}
          />
        ),
      )}
    </ol>
  );
}
