import type { Person } from "../../api/chat";
import { NameWithLabels } from "../../components/NameWithLabels";
import { CHAT_TEXT } from "../../i18n/chat";
import { useLabelsOf } from "./PeopleLabels";

// "all": semua label, chip boleh turun baris (kepala pesan pribadi, daftar anggota,
// penulis pesan). "compact": paling banyak tiga label dan "+N" yang bisa difokus.
// "none": nama saja, untuk tempat sempit seperti chip orang terpilih.
export type LabelsMode = "all" | "compact" | "none";

type Props = {
  person: Person;
  me?: boolean;
  labelsMode?: LabelsMode;
  // Nama lama untuk labelsMode="none".
  plain?: boolean;
};

// Nama orang di layar chat dengan label profilnya dari PeopleLabelsProvider. Label orang
// itu sendiri (me) ikut tampil, sesudah "(Anda)".
export function PersonName({ person, me, labelsMode, plain }: Props) {
  const labels = useLabelsOf(person.publicKey);
  const mode: LabelsMode = labelsMode ?? (plain ? "none" : "compact");
  const all = mode === "all";
  return (
    <NameWithLabels
      name={person.name}
      labels={mode === "none" ? [] : labels}
      all={all}
      wrap={all}
      moreFocusable={mode === "compact"}
      suffix={me ? CHAT_TEXT.youSuffix : undefined}
    />
  );
}
