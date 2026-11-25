import { IconSpeakerphone } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { ConversationSummary } from "../../api/chat";
import { CHAT_DIVISION } from "../../i18n/chat-division";
import { isDivisionChat } from "./divisionOrder";
import { useConversationSettings } from "./useConversationSettings";
import "./division.css";

// Mode pengumuman di channel departemen atau chat divisi: orang yang bukan pengelola mendapat satu
// kalimat tenang di tempat kolom pesan. Selama pengaturan belum termuat, kolom pesan tetap tampil.
export function AnnounceGate({ summary, children }: { summary: ConversationSummary; children: ReactNode }) {
  const { settings } = useConversationSettings(summary);
  if (!settings || !settings.announce || settings.canWrite || summary.former) return <>{children}</>;
  const division = settings.divisionId !== null || isDivisionChat(summary);
  return (
    <div className="conv-composer conv-composer-blocked">
      <p className="conv-blocked">
        <IconSpeakerphone size={16} aria-hidden="true" />
        {division ? CHAT_DIVISION.gate.division : CHAT_DIVISION.gate.team}
      </p>
    </div>
  );
}
