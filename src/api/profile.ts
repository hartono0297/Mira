// Foto profil (docs/plans/foto-profil.md 3.1). Bentuk data mengikuti profile/commands.rs.
import { invoke } from "@tauri-apps/api/core";
import { localizeError } from "../i18n/errors";
import { isTauri, NO_TAURI_ERROR, toAppError } from ".";

export type PhotoEntry = { owner: string; hash: string };
export type MyPhoto = { hash: string | null; removedByAdmin: boolean };
// Kotak potong dalam piksel gambar sumber (bukan piksel pratinjau).
export type Crop = { x: number; y: number; size: number };
export type PickedPhoto = {
  token: string;
  preview: string; // base64 JPEG
  width: number;
  height: number;
  previewWidth: number;
  previewHeight: number;
};

export const PROFILE_TOPIC = "profile";

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw NO_TAURI_ERROR;
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw localizeError(toAppError(err));
  }
}

// Foto efektif yang sudah ada di laptop ini, satu per pemilik.
export function profilePhotos(): Promise<PhotoEntry[]> {
  return call<PhotoEntry[]>("profile_photos");
}

// Isi foto sebagai base64 JPEG.
export function profilePhotoData(hash: string): Promise<string> {
  return call<string>("profile_photo_data", { hash });
}

export function profileMyPhoto(): Promise<MyPhoto> {
  return call<MyPhoto>("profile_my_photo");
}

// Membuka dialog file di Rust. null kalau dibatalkan.
export function profilePickPhoto(): Promise<PickedPhoto | null> {
  return call<PickedPhoto | null>("profile_pick_photo");
}

export function profileSetPhoto(token: string, crop: Crop): Promise<PhotoEntry> {
  return call<PhotoEntry>("profile_set_photo", { token, crop });
}

export async function profileClearPhoto(): Promise<void> {
  await call<null>("profile_clear_photo");
}

export async function profileAdminRemovePhoto(owner: string): Promise<void> {
  await call<null>("profile_admin_remove_photo", { owner });
}
