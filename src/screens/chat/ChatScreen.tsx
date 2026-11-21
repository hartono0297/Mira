import { IconMessage } from "@tabler/icons-react";
import { NotYetScreen } from "../../components/NotYetScreen";

export function ChatScreen() {
  return (
    <NotYetScreen
      title="Chat"
      icon={IconMessage}
      heading="Chat belum ada di versi ini"
      body="Nanti Anda bisa mengirim pesan ke channel tim dan langsung ke rekan, lewat jaringan kantor tanpa internet. Pesan untuk rekan yang sedang offline dititipkan dan terkirim saat laptopnya tersambung."
      stage="Direncanakan di Tahap 2, setelah laptop-laptop di kantor bisa saling terhubung."
    />
  );
}
