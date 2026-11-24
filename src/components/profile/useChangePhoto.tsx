import { useCallback, useRef, useState, type ReactNode } from "react";
import { toAppError, type AppError } from "../../api";
import { profilePickPhoto, type PickedPhoto } from "../../api/profile";
import { refreshProfilePhotos } from "../profilePhotos";
import { PhotoCropDialog } from "./PhotoCropDialog";

// Alur ganti foto untuk Pengaturan dan Shell (docs/plans/foto-profil.md 3.4):
// start() membuka dialog file Rust; batal tidak melakukan apa pun, error
// (format, ukuran) dikembalikan lewat `error` untuk ditampilkan pemanggil
// dengan ErrorAlert. Kalau foto dipilih, `element` berisi dialog pemotong.
// Setelah tersimpan peta foto dimuat ulang, lalu onDone dipanggil.
export function useChangePhoto(onDone?: () => void): {
  start: () => void;
  busy: boolean;
  error: AppError | null;
  element: ReactNode;
} {
  const [picked, setPicked] = useState<PickedPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  // Mencegah dua dialog file sekaligus kalau tombol diklik dua kali cepat.
  const picking = useRef(false);
  const done = useRef(onDone);
  done.current = onDone;

  const start = useCallback(() => {
    if (picking.current) return;
    picking.current = true;
    setBusy(true);
    setError(null);
    profilePickPhoto()
      .then((photo) => {
        if (photo) setPicked(photo);
      })
      .catch((err: unknown) => setError(toAppError(err)))
      .finally(() => {
        picking.current = false;
        setBusy(false);
      });
  }, []);

  const element = picked ? (
    <PhotoCropDialog
      key={picked.token}
      picked={picked}
      onCancel={() => setPicked(null)}
      onSaved={() => {
        setPicked(null);
        // Foto sudah tersimpan di Rust; gagal memuat ulang peta tidak membatalkannya.
        void refreshProfilePhotos()
          .catch(() => {})
          .then(() => done.current?.());
      }}
    />
  ) : null;

  return { start, busy, error, element };
}
