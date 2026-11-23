import type { Person } from "../../api/chat";

// Nama orang di layar chat (daftar anggota grup, pemilih orang, penulis pesan).
//
// Tempat tukar label: agen B v0.3 mengekspor komponen `NameWithLabels` (nama plus label
// aktif dari orgApi.people()). Saat komponen itu siap, ganti isi fungsi ini saja dengan
// komponen itu; semua tempat di layar chat sudah memanggil PersonName. File ini sengaja
// tidak mengimpor apa pun dari src/screens/organization/ sampai penggantian itu.
export function PersonName({ person, me }: { person: Person; me?: boolean }) {
  return <>{me ? `${person.name} (Anda)` : person.name}</>;
}
