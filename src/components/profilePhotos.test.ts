// Penyimpan foto profil: peta owner -> hash, data URL per hash, muat ulang saat event "profile".
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);

type Store = typeof import("./profilePhotos");

// Status penyimpan ada di tingkat modul, jadi setiap tes memakai salinan modul baru.
async function freshStore(): Promise<Store> {
  vi.resetModules();
  return import("./profilePhotos");
}

let photos: { owner: string; hash: string }[] = [];

function dataCalls(hash?: string) {
  return invoke.mock.calls.filter(
    ([cmd, args]) => cmd === "profile_photo_data" && (hash === undefined || args?.hash === hash),
  );
}

function emitFeature(topic: string) {
  for (const [event, handler] of listen.mock.calls) {
    if (event === "mira://feature") (handler as (e: { payload: unknown }) => void)({ payload: { topic } });
  }
}

// Impor pertama mengubah semua modul (lambat di mesin yang sibuk); setelah itu
// salinan baru per tes cepat. Tanpa pemanasan ini tes pertama bisa habis waktu.
beforeAll(async () => {
  await import("./profilePhotos");
}, 60_000);

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  photos = [];
  invoke.mockReset();
  listen.mockReset();
  listen.mockResolvedValue(() => {});
  invoke.mockImplementation(async (cmd: string, args?: { hash?: string }) => {
    if (cmd === "profile_photos") return photos;
    if (cmd === "profile_photo_data") return `b64-${args?.hash?.slice(0, 1)}`;
    throw new Error(`perintah tak terduga ${cmd}`);
  });
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("usePhotoUrl", () => {
  it("tanpa kunci atau tanpa foto: null", async () => {
    photos = [{ owner: A, hash: H1 }];
    const { usePhotoUrl } = await freshStore();
    const none = renderHook(() => usePhotoUrl(null));
    const other = renderHook(() => usePhotoUrl(B));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("profile_photos", undefined));
    await act(async () => {});
    expect(none.result.current).toBeNull();
    expect(other.result.current).toBeNull();
    expect(dataCalls()).toHaveLength(0);
  });

  it("memuat peta sekali dan data URL sekali per hash walau banyak avatar tampil", async () => {
    // B dan C memakai foto yang sama (hash sama): data cukup diminta sekali.
    photos = [
      { owner: A, hash: H1 },
      { owner: B, hash: H2 },
      { owner: C, hash: H2 },
    ];
    const { usePhotoUrl } = await freshStore();
    const hooks = [A, A, B, C, C].map((key) => renderHook(() => usePhotoUrl(key)));

    await waitFor(() => expect(hooks[0].result.current).toBe("data:image/jpeg;base64,b64-1"));
    await waitFor(() => expect(hooks[4].result.current).toBe("data:image/jpeg;base64,b64-2"));
    expect(hooks[1].result.current).toBe("data:image/jpeg;base64,b64-1");
    expect(hooks[2].result.current).toBe("data:image/jpeg;base64,b64-2");

    expect(invoke.mock.calls.filter(([cmd]) => cmd === "profile_photos")).toHaveLength(1);
    expect(dataCalls(H1)).toHaveLength(1);
    expect(dataCalls(H2)).toHaveLength(1);
    expect(listen.mock.calls.filter(([event]) => event === "mira://feature")).toHaveLength(1);
  });

  it("memuat ulang peta saat event profile datang, topik lain diabaikan", async () => {
    photos = [{ owner: A, hash: H1 }];
    const { usePhotoUrl } = await freshStore();
    const hook = renderHook(() => usePhotoUrl(A));
    await waitFor(() => expect(hook.result.current).toBe("data:image/jpeg;base64,b64-1"));

    photos = [{ owner: A, hash: H2 }];
    act(() => emitFeature("chat"));
    await act(async () => {});
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "profile_photos")).toHaveLength(1);

    act(() => emitFeature("profile"));
    await waitFor(() => expect(hook.result.current).toBe("data:image/jpeg;base64,b64-2"));
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "profile_photos")).toHaveLength(2);
    expect(dataCalls(H1)).toHaveLength(1);
    expect(dataCalls(H2)).toHaveLength(1);

    // Foto dihapus: kembali ke null.
    photos = [];
    act(() => emitFeature("profile"));
    await waitFor(() => expect(hook.result.current).toBeNull());
  });

  it("refreshProfilePhotos memuat ulang tanpa meminta ulang data hash yang sudah ada", async () => {
    photos = [{ owner: A, hash: H1 }];
    const { usePhotoUrl, refreshProfilePhotos } = await freshStore();
    const a = renderHook(() => usePhotoUrl(A));
    const b = renderHook(() => usePhotoUrl(B));
    await waitFor(() => expect(a.result.current).not.toBeNull());

    photos = [
      { owner: A, hash: H1 },
      { owner: B, hash: H2 },
    ];
    await act(() => refreshProfilePhotos());
    await waitFor(() => expect(b.result.current).toBe("data:image/jpeg;base64,b64-2"));
    expect(a.result.current).toBe("data:image/jpeg;base64,b64-1");
    expect(dataCalls(H1)).toHaveLength(1);
  });

  it("data gagal dimuat: tetap null dan tidak meminta ulang sampai peta dimuat ulang", async () => {
    photos = [{ owner: A, hash: H1 }];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "profile_photos") return photos;
      throw { code: "not_found", message: "Foto tidak ditemukan." };
    });
    const { usePhotoUrl, refreshProfilePhotos } = await freshStore();
    const first = renderHook(() => usePhotoUrl(A));
    await waitFor(() => expect(dataCalls(H1)).toHaveLength(1));
    await act(async () => {});
    renderHook(() => usePhotoUrl(A));
    await act(async () => {});
    expect(first.result.current).toBeNull();
    expect(dataCalls(H1)).toHaveLength(1);

    await act(() => refreshProfilePhotos());
    await waitFor(() => expect(dataCalls(H1)).toHaveLength(2));
  });

  it("di luar Tauri: null, tanpa panggilan dan tanpa error", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const { usePhotoUrl, refreshProfilePhotos } = await freshStore();
    const hook = renderHook(() => usePhotoUrl(A));
    await act(() => refreshProfilePhotos());
    expect(hook.result.current).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });
});
