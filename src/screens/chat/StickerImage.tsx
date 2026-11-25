// Gambar sticker atau emote (v0.5.1). Byte gambar datang dari inti Rust sebagai URL data:
// yang sudah diperiksa (PNG, WebP, GIF; tidak pernah SVG), jadi CSP tetap 'self'.
// Disimpan di cache per hash supaya daftar pesan tidak meminta gambar yang sama berulang.
import { useEffect, useState } from "react";
import { chatApi } from "../../api/chat";
import "./sticker-image.css";

export type StickerSize = "large" | "thumb" | "inline";

// Cache LRU dengan batas ukuran: rekan yang mengirim banyak sticker berbeda tidak bisa membuat
// memori WebView terus bertambah. Map menyimpan urutan sisip; yang dipakai dipindah ke belakang.
export const STICKER_CACHE_MAX_CHARS = 24 * 1024 * 1024;
const cache = new Map<string, string>();
let cacheChars = 0;
const pending = new Map<string, Promise<string>>();

function cacheGet(hash: string): string | undefined {
  const hit = cache.get(hash);
  if (hit === undefined) return undefined;
  cache.delete(hash);
  cache.set(hash, hit);
  return hit;
}

function cachePut(hash: string, url: string) {
  const old = cache.get(hash);
  if (old !== undefined) {
    cache.delete(hash);
    cacheChars -= old.length;
  }
  cache.set(hash, url);
  cacheChars += url.length;
  for (const [key, value] of cache) {
    if (cacheChars <= STICKER_CACHE_MAX_CHARS || key === hash) break;
    cache.delete(key);
    cacheChars -= value.length;
  }
}

export function loadStickerImage(hash: string): Promise<string> {
  const hit = cacheGet(hash);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(hash);
  if (!p) {
    p = chatApi
      .stickerImage(hash)
      .then((url) => {
        cachePut(hash, url);
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
  cacheChars = 0;
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
  const [url, setUrl] = useState<string | null>(() => cacheGet(hash) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    const hit = cacheGet(hash) ?? null;
    setUrl(hit);
    if (!ready || hit) return;
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
