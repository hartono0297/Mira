// @vitest-environment node
import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import type { RequestDetail, SignerView, Unlocked } from "../../api/signing";
import type { PageGeometry } from "../../components/pdf/types";
import {
  BOX_MIN_WIDTH_PT,
  describeSpot,
  fingerprintOf,
  movePlacement,
  placementWidthPt,
  quickPlacement,
  resizePlacement,
  runSignFlow,
  type SignFlowApi,
} from "./signFlow";

// PNG 2x1 piksel RGBA yang sah (sama dengan stamp.test.ts).
const PNG_2X1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwnwEIGGAMAEHvBP2qjq7jAAAAAElFTkSuQmCC"),
  (c) => c.charCodeAt(0),
);

const DOC_TAG = "mira-doc:uji0123456789abcdef";
const ME_KEY = "a1b2c3d4e5f60718" + "0".repeat(48);
const OTHER_KEY = "ffee0011223344aa" + "1".repeat(48);

async function makePdf(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]);
  return doc.save();
}

function signer(over: Partial<SignerView>): SignerView {
  return {
    position: 1,
    publicKey: ME_KEY,
    displayName: "Penanda Uji",
    kind: "member",
    status: "waiting",
    signedAt: null,
    hashAfter: null,
    isMe: true,
    canSignNow: true,
    ...over,
  };
}

function detail(over: Partial<RequestDetail> = {}): RequestDetail {
  return {
    id: "req-uji",
    title: "Kontrak uji",
    mode: "sequential",
    status: "in_progress",
    myState: "your_turn",
    signedCount: 1,
    signerCount: 2,
    createdAt: "2026-11-20T02:00:00Z",
    updatedAt: "2026-11-21T02:00:00Z",
    completedAt: null,
    integrity: "intact",
    exportWarnings: 0,
    requestedBy: { publicKey: OTHER_KEY, displayName: "Pengirim Uji" },
    originalHash: "ab".repeat(32),
    currentHash: "cd".repeat(32),
    signers: [
      signer({ position: 2 }),
      signer({
        position: 1,
        publicKey: OTHER_KEY,
        displayName: "Rekan Uji",
        kind: "guest",
        status: "signed",
        signedAt: "2026-11-21T02:00:00Z",
        isMe: false,
        canSignNow: false,
      }),
    ],
    events: [],
    exports: [],
    isLastPending: false,
    docTag: DOC_TAG,
    sealValid: null,
    ...over,
  };
}

function fakeApi(unlockImpl?: () => Promise<Unlocked>) {
  const png = PNG_2X1.slice();
  const unlock = vi.fn(
    unlockImpl ??
      (async (): Promise<Unlocked> => ({ token: "token-uji", png, signedAt: "2026-11-22T08:04:00Z", width: 2, height: 1 })),
  );
  const complete = vi.fn(async (_id: string, _token: string, _base: string, _bytes: Uint8Array) => detail({ status: "completed" }));
  const api: SignFlowApi = { unlock, complete };
  return { api, unlock, complete, png };
}

const placement = { pageIndex: 1, x: 380, y: 60, width: 160, height: 80 };

function latin1(bytes: Uint8Array) {
  return new TextDecoder("latin1").decode(bytes);
}

describe("fingerprintOf", () => {
  it("sama dengan format sidik jari inti Rust", () => {
    expect(fingerprintOf(ME_KEY)).toBe("A1B2 C3D4 E5F6 0718");
  });
});

describe("runSignFlow", () => {
  it("menstempel lalu mengirim dengan token, hash dasar, dan byte bertanda kode dokumen", async () => {
    const bytes = await makePdf();
    const { api, unlock, complete, png } = fakeApi();
    const result = await runSignFlow({ pin: "135790", detail: detail(), bytes, placement, me: { displayName: "Penanda Uji" }, api, timeZone: "Asia/Jakarta" });

    expect(unlock).toHaveBeenCalledWith("135790");
    expect(complete).toHaveBeenCalledTimes(1);
    const [id, token, base, sent] = complete.mock.calls[0];
    expect(id).toBe("req-uji");
    expect(token).toBe("token-uji");
    expect(base).toBe("cd".repeat(32));
    expect(latin1(sent)).toContain(DOC_TAG);
    // Bukan penanda tangan terakhir: jumlah halaman tetap.
    const out = await PDFDocument.load(sent);
    expect(out.getPageCount()).toBe(2);
    expect(result.status).toBe("completed");
    // Gambar tanda tangan dikosongkan setelah dipakai.
    expect(png.every((b) => b === 0)).toBe(true);
  });

  it("penanda tangan terakhir menambah halaman catatan", async () => {
    const bytes = await makePdf();
    const { api, complete } = fakeApi();
    await runSignFlow({
      pin: "135790",
      detail: detail({ isLastPending: true }),
      bytes,
      placement,
      me: { displayName: "Penanda Uji" },
      api,
      timeZone: "Asia/Jakarta",
    });
    const sent = complete.mock.calls[0][3];
    const out = await PDFDocument.load(sent);
    expect(out.getPageCount()).toBe(3);
    expect(latin1(sent)).toContain(DOC_TAG);
  });

  it("PIN salah dari unlock diteruskan apa adanya dan tidak ada yang dikirim", async () => {
    const wrong = { code: "pin_wrong", message: "PIN salah. Sisa 4 percobaan." };
    const { api, complete } = fakeApi(() => Promise.reject(wrong));
    await expect(
      runSignFlow({ pin: "111111", detail: detail(), bytes: await makePdf(), placement, me: { displayName: "Penanda Uji" }, api }),
    ).rejects.toBe(wrong);
    expect(complete).not.toHaveBeenCalled();
  });

  it("error pdf-lib diubah jadi AppError berbahasa Indonesia", async () => {
    const { api, complete } = fakeApi(async () => ({
      token: "t",
      png: Uint8Array.from([1, 2, 3]),
      signedAt: "2026-11-22T08:04:00Z",
      width: 2,
      height: 1,
    }));
    const err = await runSignFlow({
      pin: "135790",
      detail: detail(),
      bytes: await makePdf(),
      placement,
      me: { displayName: "Penanda Uji" },
      api,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "stamp_failed" });
    expect((err as { message: string }).message).toMatch(/^Tanda tangan belum bisa ditempel ke PDF\. /);
    expect(complete).not.toHaveBeenCalled();
  });

  it("halaman di luar dokumen ditolak sebelum dikirim", async () => {
    const { api, complete } = fakeApi();
    const err = await runSignFlow({
      pin: "135790",
      detail: detail(),
      bytes: await makePdf(1),
      placement,
      me: { displayName: "Penanda Uji" },
      api,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "stamp_failed" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("error dari complete (mis. versi bentrok) diteruskan sebagai AppError", async () => {
    const { api, complete } = fakeApi();
    const conflict = { code: "version_conflict", message: "Dokumen sudah berubah." };
    complete.mockRejectedValueOnce(conflict);
    await expect(
      runSignFlow({ pin: "135790", detail: detail(), bytes: await makePdf(), placement, me: { displayName: "Penanda Uji" }, api }),
    ).rejects.toBe(conflict);
  });
});

describe("penempatan kotak", () => {
  const A4: PageGeometry = { index: 0, view: [0, 0, 595, 842], width: 595, height: 842, rotation: 0 };
  const TURNED: PageGeometry = { index: 1, view: [0, 0, 595, 842], width: 595, height: 842, rotation: 90 };

  it("bawaan kanan bawah, 160 pt, jarak tepi 36 pt", () => {
    const r = quickPlacement(A4, 2, "right");
    expect(r).toEqual({ pageIndex: 0, x: 399, y: 36, width: 160, height: 80 });
    expect(describeSpot(r, A4)).toBe("kanan bawah");
  });

  it("halaman berotasi 90: lebar tampak tetap 160 pt, persegi PDF terbalik", () => {
    const r = quickPlacement(TURNED, 2, "left");
    expect(r.width).toBeCloseTo(80);
    expect(r.height).toBeCloseTo(160);
    expect(placementWidthPt(r, TURNED)).toBeCloseTo(160);
    expect(describeSpot(r, TURNED)).toBe("kiri bawah");
  });

  it("ubah ukuran menjaga titik tengah dan batas minimum", () => {
    const r = quickPlacement(A4, 2, "center");
    const big = resizePlacement(r, A4, 2, 40);
    expect(big.width).toBeCloseTo(200);
    expect(big.x + big.width / 2).toBeCloseTo(r.x + r.width / 2);
    let small = r;
    for (let i = 0; i < 20; i++) small = resizePlacement(small, A4, 2, -20);
    expect(small.width).toBeCloseTo(BOX_MIN_WIDTH_PT);
  });

  it("pindah halaman menjaga posisi relatif", () => {
    const r = quickPlacement(A4, 2, "right");
    const moved = movePlacement(r, A4, { ...A4, index: 1 }, 2);
    expect(moved).toMatchObject({ pageIndex: 1, x: 399, width: 160 });
  });
});
