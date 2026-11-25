// Avatar orang: foto profil kalau ada, inisial kalau tidak (docs/plans/foto-profil.md 3.3).
import { useId, useState, type MouseEventHandler } from "react";
import "./avatar.css";
import { initials } from "./initials";
import { usePhotoUrl } from "./profilePhotos";

export type AvatarProps = {
  name: string;
  publicKey?: string | null;
  // 24, 32, 72 px. Diabaikan kalau className diberikan: kelas lama yang menentukan ukuran.
  size?: "sm" | "md" | "lg";
  className?: string;
  // Bawaan true: nama orang sudah tertulis di dekat avatar.
  decorative?: boolean;
  online?: boolean;
  onlineLabel?: string;
  title?: string;
  onContextMenu?: MouseEventHandler<HTMLElement>;
};

export function Avatar({
  name,
  publicKey,
  size = "md",
  className,
  decorative = true,
  online = false,
  onlineLabel,
  title,
  onContextMenu,
}: AvatarProps) {
  const url = usePhotoUrl(publicKey);
  // Simpan URL yang gagal, bukan boolean: foto baru untuk orang yang sama dicoba lagi.
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const labelId = useId();
  const photo = url && url !== brokenUrl ? url : null;
  const status = online && onlineLabel ? onlineLabel : null;

  // Avatar dekoratif disembunyikan seluruhnya, kecuali kalau membawa status
  // online: statusnya tetap dibacakan, gambar dan inisialnya yang disembunyikan.
  const hideRoot = decorative && !status;
  const hideInner = decorative && !!status;

  return (
    <span
      className={className ?? `avatar avatar-${size}`}
      data-avatar-key={publicKey || undefined}
      data-avatar-online={online ? "" : undefined}
      aria-hidden={hideRoot ? "true" : undefined}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : name}
      aria-describedby={!decorative && status ? labelId : undefined}
      title={title}
      onContextMenu={onContextMenu}
    >
      {photo ? (
        <img
          className="avatar-img"
          src={photo}
          alt=""
          draggable={false}
          aria-hidden={hideInner ? "true" : undefined}
          onError={() => setBrokenUrl(photo)}
        />
      ) : hideInner ? (
        <span aria-hidden="true">{initials(name)}</span>
      ) : (
        initials(name)
      )}
      {online && <span className="avatar-dot" aria-hidden="true" />}
      {status && (
        <span id={labelId} className="sr-only">
          {status}
        </span>
      )}
    </span>
  );
}
