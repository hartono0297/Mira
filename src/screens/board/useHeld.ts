import { useState } from "react";

// Isian yang sedang difokus tidak boleh berubah di bawah kursor saat data
// dari server dimuat ulang. Nilai server ditahan sejak isian difokus sampai
// ditinggalkan; setelah itu isian kembali ikut nilai server terbaru.
// Ketikan pengguna (draf) disimpan terpisah oleh pemanggil dan selalu menang.
export function useHeld(server: string) {
  const [held, setHeld] = useState<string | null>(null);
  return {
    value: held ?? server,
    hold: () => setHeld((h) => h ?? server),
    release: () => setHeld(null),
    // Setelah disimpan atau dibatalkan, isian yang masih difokus menahan nilai
    // akhirnya, bukan nilai saat difokus. Isian yang tidak difokus tidak berubah.
    settle: (value: string) => setHeld((h) => (h === null ? null : value)),
  };
}
