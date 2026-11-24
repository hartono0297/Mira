// Penyimpan foto profil untuk semua avatar (docs/plans/foto-profil.md 3.2).
//
// Satu peta owner -> hash untuk seluruh aplikasi, dimuat saat avatar pertama
// tampil dan dimuat ulang saat event "profile" datang atau setelah foto sendiri
// diganti. Isi foto (data URL) dimuat malas per hash dan disimpan, jadi seratus
// avatar dengan foto yang sama hanya meminta datanya sekali.
import { useEffect, useSyncExternalStore } from "react";
import { isTauri, subscribeFeature } from "../api";
import { PROFILE_TOPIC, profilePhotoData, profilePhotos } from "../api/profile";

let owners: ReadonlyMap<string, string> = new Map();
const urls = new Map<string, string>();
const loading = new Set<string>();
// Hash yang gagal dimuat tidak dicoba lagi sampai peta dimuat ulang, supaya
// avatar yang dirender ulang tidak mengulang permintaan yang sama terus.
const failed = new Set<string>();
const listeners = new Set<() => void>();
let started = false;
let mapSeq = 0;

function emit() {
  for (const listener of listeners) listener();
}

function start() {
  if (started || !isTauri()) return;
  started = true;
  subscribeFeature(PROFILE_TOPIC, () => void refreshProfilePhotos());
  void refreshProfilePhotos();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
  };
}

// Memuat ulang peta foto. Di luar aplikasi desktop tidak melakukan apa pun.
// Gagal memuat: peta terakhir tetap dipakai, avatar tetap tampil (inisial atau foto lama).
export async function refreshProfilePhotos(): Promise<void> {
  if (!isTauri()) return;
  const mine = ++mapSeq;
  let entries;
  try {
    entries = await profilePhotos();
  } catch {
    return;
  }
  if (mine !== mapSeq) return;
  // Mock tes lama mengembalikan null untuk perintah yang tidak dikenalnya.
  const list = Array.isArray(entries) ? entries : [];
  const next = new Map(list.map((e) => [e.owner, e.hash]));
  const live = new Set(next.values());
  // Foto yang sudah tidak dipakai siapa pun dilepas dari memori.
  for (const hash of urls.keys()) if (!live.has(hash)) urls.delete(hash);
  const retry = [...failed].filter((hash) => live.has(hash));
  failed.clear();
  owners = next;
  emit();
  // Foto yang tadi gagal dan masih dipakai dicoba lagi sekali.
  for (const hash of retry) loadData(hash);
}

function loadData(hash: string) {
  if (urls.has(hash) || loading.has(hash) || failed.has(hash)) return;
  loading.add(hash);
  profilePhotoData(hash)
    .then((b64) => {
      urls.set(hash, `data:image/jpeg;base64,${b64}`);
    })
    .catch(() => {
      failed.add(hash);
    })
    .finally(() => {
      loading.delete(hash);
      emit();
    });
}

// Hash foto seseorang menurut peta, atau null kalau tidak berfoto atau tanpa
// kunci. Untuk keputusan "punya foto atau tidak": tidak bergantung pada data
// foto yang mungkin belum atau gagal dimuat.
export function usePhotoHash(publicKey: string | null | undefined): string | null {
  return useSyncExternalStore(subscribe, () => (publicKey ? (owners.get(publicKey) ?? null) : null));
}

// Data URL foto seseorang, atau null kalau belum ada, belum termuat, atau tanpa kunci.
export function usePhotoUrl(publicKey: string | null | undefined): string | null {
  const hash = usePhotoHash(publicKey);
  const url = useSyncExternalStore(subscribe, () => (hash ? (urls.get(hash) ?? null) : null));
  useEffect(() => {
    if (hash) loadData(hash);
  }, [hash]);
  return url;
}
