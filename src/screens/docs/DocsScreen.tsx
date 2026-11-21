import { IconFileText } from "@tabler/icons-react";
import { NotYetScreen } from "../../components/NotYetScreen";

export function DocsScreen() {
  return (
    <NotYetScreen
      title="Dokumen"
      icon={IconFileText}
      heading="Dokumen belum ada di versi ini"
      body="Nanti Anda bisa menyimpan dan membagikan file ke tim, mengedit file Word dan Excel, lalu meminta tanda tangan PDF dari rekan."
      stage="Direncanakan di Tahap 4 (dokumen) dan Tahap 5 (tanda tangan PDF)."
    />
  );
}
