import type { ConversationSummary } from "../../api/chat";

// Kontrak antara ChatScreen (daftar) dan panel percakapan. Diisi subagent UI percakapan.
export type ConversationProps = {
  summary: ConversationSummary;
  me: string;
  // Data percakapan berubah (kirim, hapus, arsip): ChatScreen memuat ulang ringkasan.
  onChanged: () => void;
  // Percakapan tidak tersedia lagi (channel dihapus): ChatScreen kembali ke #umum.
  onGone: () => void;
};

export function Conversation({ summary }: ConversationProps) {
  return (
    <section className="chat-conv" aria-label={summary.name}>
      <h2>{summary.name}</h2>
    </section>
  );
}
