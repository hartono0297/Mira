// Gambar sticker atau emote (v0.5.1). Byte gambar datang dari inti Rust sebagai URL data:
// yang sudah diperiksa (PNG, WebP, GIF; tidak pernah SVG), jadi CSP tetap 'self'.
// Disimpan di cache per hash supaya daftar pesan tidak meminta gambar yang sama berulang.
import { useEffect, useState } from "react";
import { chatApi } from "../../api/chat";
import "./sticker-image.css";

export type StickerSize = "large" | "thumb" | "inline";

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

export function loadStickerImage(hash: string): Promise<string> {
  const hit = cache.get(hash);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(hash);
  if (!p) {
    p = chatApi
      .stickerImage(hash)
      .then((url) => {
        cache.set(hash, url);
        return url;
      })
      .finally(() => pending.delete(hash));
    pending.set(hash, p);
  }
  return p;
}

// Untuk tes.
export function clearStickerImageCache() {
  cache.clear();
  pending.clear();
}

type Props = {
  hash: string;
  // Teks pengganti, misalnya ":kopi:". Dipakai sebagai alt dan saat gambar belum ada.
  alt: string;
  size: StickerSize;
  // false: gambar belum ada di laptop ini. Teks pengganti tampil tanpa meminta gambar.
  ready?: boolean;
  className?: string;
};

export function StickerImage({ hash, alt, size, ready = true, className }: Props) {
  const [url, setUrl] = useState<string | null>(() => cache.get(hash) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    setUrl(cache.get(hash) ?? null);
    if (!ready || cache.has(hash)) return;
    loadStickerImage(hash)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [hash, ready]);

  const cls = `sticker-img sticker-img-${size}${className ? ` ${className}` : ""}`;
  if (!url || failed) {
    // alt kosong = hiasan (nama sudah tertulis di sampingnya): disembunyikan dari pembaca layar.
    if (!alt) return <span className={`${cls} sticker-img-missing`} aria-hidden="true" />;
    // Teks pengganti terlihat untuk ukuran besar dan sebaris; kotak kecil di kisi sudah punya
    // nama di sampingnya.
    return (
      <span className={`${cls} sticker-img-missing`} role="img" aria-label={alt}>
        {size === "thumb" ? null : <span aria-hidden="true">{alt}</span>}
      </span>
    );
  }
  return <img className={cls} src={url} alt={alt} draggable={false} />;
}
