import { IconLayoutKanban } from "@tabler/icons-react";
import { NotYetScreen } from "../../components/NotYetScreen";

export function BoardScreen() {
  return (
    <NotYetScreen
      title="Board"
      icon={IconLayoutKanban}
      heading="Board belum ada di versi ini"
      body="Nanti setiap proyek punya board task dengan kolom seperti To do, Dikerjakan, dan Selesai. Task bisa dibuat langsung dari pesan chat."
      stage="Direncanakan di Tahap 3."
    />
  );
}
