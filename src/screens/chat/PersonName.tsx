import type { Person } from "../../api/chat";
import { NameWithLabels } from "../../components/NameWithLabels";
import { useLabelsOf } from "./PeopleLabels";

// Nama orang di layar chat (daftar anggota grup, pemilih orang, penulis pesan), dengan
// label profilnya dari PeopleLabelsProvider. `plain` untuk tempat sempit seperti chip
// orang terpilih: nama saja.
export function PersonName({ person, me, plain }: { person: Person; me?: boolean; plain?: boolean }) {
  const labels = useLabelsOf(person.publicKey);
  return <NameWithLabels name={person.name} labels={plain ? [] : labels} suffix={me ? " (Anda)" : undefined} />;
}
