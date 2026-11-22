import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestDetail, SignerView, SignOverview } from "../../api/signing";
import type { PageGeometry } from "../../components/pdf/types";

const PAGES: PageGeometry[] = [
  { index: 0, view: [0, 0, 595, 842], width: 595, height: 842, rotation: 0 },
  { index: 1, view: [0, 0, 595, 842], width: 595, height: 842, rotation: 0 },
];

const api = vi.hoisted(() => ({
  overview: vi.fn(),
  getRequest: vi.fn(),
  readFile: vi.fn(),
  saveSignature: vi.fn(),
  unlock: vi.fn(),
  complete: vi.fn(),
  cancel: vi.fn(),
  exportFile: vi.fn(),
}));

const flow = vi.hoisted(() => ({ runSignFlow: vi.fn() }));

vi.mock("../../api/signing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/signing")>()),
  signingApi: api,
}));

vi.mock("./signFlow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./signFlow")>()),
  runSignFlow: flow.runSignFlow,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));

// pdf.js tidak jalan di jsdom: penampil tiruan memanggil onLoaded dan
// menggambar lapisan halaman yang sedang tampil pada skala 1.
vi.mock("../../components/pdf/PdfViewer", async () => {
  const { useEffect } = await import("react");
  return {
    PdfViewer: (props: {
      page?: number;
      onLoaded?: (i: { pageCount: number; pages: PageGeometry[] }) => void;
      renderOverlay?: (info: unknown) => unknown;
    }) => {
      useEffect(() => {
        props.onLoaded?.({ pageCount: PAGES.length, pages: PAGES });
      }, []);
      const geo = PAGES[(props.page ?? 1) - 1];
      const info = { ...geo, scale: 1, cssWidth: geo.width, cssHeight: geo.height };
      return (
        <div data-testid="viewer" data-page={props.page}>
          {props.renderOverlay?.(info) as never}
        </div>
      );
    },
  };
});

import { SignDocumentView } from "./SignDocumentView";

const ME = "a1b2c3d4e5f60718" + "0".repeat(48);
const OTHER = "ffee0011223344aa" + "1".repeat(48);

function signer(over: Partial<SignerView>): SignerView {
  return {
    position: 1,
    publicKey: ME,
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
    signedCount: 0,
    signerCount: 2,
    createdAt: "2026-11-20T02:00:00Z",
    updatedAt: "2026-11-21T02:00:00Z",
    completedAt: null,
    integrity: "intact",
    exportWarnings: 0,
    requestedBy: { publicKey: OTHER, displayName: "Pengirim Uji" },
    originalHash: "ab".repeat(32),
    currentHash: "cd".repeat(32),
    signers: [
      signer({ position: 1 }),
      signer({ position: 2, publicKey: OTHER, displayName: "Rekan Uji", kind: "guest", isMe: false, canSignNow: false }),
    ],
    events: [
      {
        kind: "created",
        actorKey: OTHER,
        actorName: "Pengirim Uji",
        at: "2026-11-20T02:00:00Z",
        hashBefore: null,
        hashAfter: "ab".repeat(32),
        detail: "Berurutan, 2 penanda tangan",
        valid: true,
      },
    ],
    exports: [],
    isLastPending: false,
    docTag: "mira-doc:uji",
    sealValid: null,
    ...over,
  };
}

function overview(over: Partial<SignOverview> = {}): SignOverview {
  return {
    saved: { width: 400, height: 200, createdAt: "2026-11-01T00:00:00Z", failedAttempts: 0, lockedUntil: null, attemptsLeft: 5 },
    requests: [],
    canRequest: true,
    me: { publicKey: ME, displayName: "Penanda Uji", kind: "member" },
    ...over,
  };
}

function setup(d: RequestDetail = detail(), o: SignOverview = overview()) {
  api.getRequest.mockResolvedValue(d);
  api.overview.mockResolvedValue(o);
  api.readFile.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
  const onBack = vi.fn();
  const onChanged = vi.fn();
  const user = userEvent.setup();
  render(<SignDocumentView requestId="req-uji" onBack={onBack} onChanged={onChanged} />);
  return { user, onBack, onChanged };
}

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  flow.runSignFlow.mockReset();
});

describe("SignDocumentView", () => {
  it("menampilkan keadaan memuat lalu dokumen", async () => {
    setup();
    expect(screen.getByRole("status")).toHaveTextContent("Memuat dokumen...");
    expect(await screen.findByRole("heading", { level: 1, name: "Kontrak uji" })).toBeInTheDocument();
    expect(api.readFile).toHaveBeenCalledWith("req-uji", "cd".repeat(32));
    expect(await screen.findByTestId("viewer")).toBeInTheDocument();
  });

  it("error memuat: Coba lagi memanggil ulang, Kembali ke daftar memanggil onBack", async () => {
    api.getRequest.mockRejectedValueOnce({ code: "not_found", message: "Permintaan tidak ditemukan." });
    api.getRequest.mockResolvedValueOnce(detail());
    api.overview.mockResolvedValue(overview());
    api.readFile.mockResolvedValue(new Uint8Array([1]));
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(<SignDocumentView requestId="req-uji" onBack={onBack} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Dokumen belum bisa dibuka");
    expect(alert).toHaveTextContent("Permintaan tidak ditemukan.");
    await user.click(within(alert).getByRole("button", { name: "Kembali ke daftar" }));
    expect(onBack).toHaveBeenCalled();
    await user.click(within(alert).getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Kontrak uji" })).toBeInTheDocument();
    expect(api.getRequest).toHaveBeenCalledTimes(2);
  });

  it("banner bahaya kalau isi file berubah", async () => {
    setup(detail({ integrity: "changed" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Isi file ini berubah setelah ditandatangani");
    expect(alert).toHaveTextContent("Jangan kirim atau cetak file ini.");
    expect(screen.queryByRole("button", { name: "Tempatkan tanda tangan" })).not.toBeInTheDocument();
    expect(screen.getByText(/menandatangani dinonaktifkan karena file dokumen bermasalah/)).toBeInTheDocument();
  });

  it("banner bahaya kalau catatan penguncian tidak sah", async () => {
    setup(detail({ status: "completed", sealValid: false }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Catatan penguncian tidak sah");
    expect(screen.queryByText("Terkunci")).not.toBeInTheDocument();
  });

  it("dokumen selesai dan sah ditandai Terkunci dengan 16 karakter awal hash", async () => {
    const hash = "0123456789abcdef".repeat(4);
    setup(
      detail({
        status: "completed",
        sealValid: true,
        currentHash: hash,
        signedCount: 2,
        signers: [
          signer({ status: "signed", signedAt: "2026-11-21T02:00:00Z", canSignNow: false }),
          signer({ position: 2, publicKey: OTHER, displayName: "Rekan Uji", isMe: false, canSignNow: false, status: "signed", signedAt: "2026-11-22T02:00:00Z" }),
        ],
      }),
    );
    expect(await screen.findByText("Terkunci")).toBeInTheDocument();
    expect(screen.getByText(/Perubahan sekecil apa pun akan terdeteksi/)).toBeInTheDocument();
    const short = screen.getByTitle(hash);
    expect(short).toHaveTextContent(/^0123456789abcdef$/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("tombol tempatkan hanya muncul kalau giliran saya", async () => {
    setup(
      detail({
        signers: [
          signer({ position: 1, publicKey: OTHER, displayName: "Rekan Uji", isMe: false, canSignNow: false }),
          signer({ position: 2, canSignNow: false }),
        ],
      }),
    );
    expect(await screen.findByText(/Belum giliran Anda\. Menunggu Rekan Uji/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tempatkan tanda tangan" })).not.toBeInTheDocument();
  });

  it("belum punya tanda tangan tersimpan: ajakan membuatnya", async () => {
    const { user } = setup(detail(), overview({ saved: null }));
    const btn = await screen.findByRole("button", { name: "Buat tanda tangan" });
    expect(screen.queryByRole("button", { name: "Tempatkan tanda tangan" })).not.toBeInTheDocument();
    await user.click(btn);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("menempatkan kotak di kanan bawah, posisi cepat mengubah posisi", async () => {
    const { user } = setup();
    const place = await screen.findByRole("button", { name: "Tempatkan tanda tangan" });
    await waitFor(() => expect(place).toBeEnabled());
    await user.click(place);

    const box = await screen.findByRole("group", { name: "Kotak tanda tangan Penanda Uji" });
    // 160 pt lebar, rasio 2:1 dari gambar 400x200, 36 pt dari tepi kanan dan bawah.
    expect(box).toHaveStyle({ left: "399px", top: "726px", width: "160px", height: "80px" });
    expect(box).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Kiri bawah" }));
    expect(box).toHaveStyle({ left: "36px", top: "726px" });
    await user.click(screen.getByRole("button", { name: "Tengah bawah" }));
    expect(box).toHaveStyle({ left: "217.5px" });

    await user.click(screen.getByRole("button", { name: "Besarkan kotak" }));
    expect(box).toHaveStyle({ width: "180px", height: "90px" });

    await waitFor(() => expect(screen.getByText(/^Halaman 1, tengah bawah\. Kiri 208 pt, bawah 31 pt, lebar 180 pt\.$/)).toBeInTheDocument());
  });

  it("PIN benar: alur dijalankan, konfirmasi tampil, onChanged dipanggil", async () => {
    const after = detail({ currentHash: "ef".repeat(32), signedCount: 1 });
    flow.runSignFlow.mockResolvedValue(after);
    const { user, onChanged } = setup();
    const place = await screen.findByRole("button", { name: "Tempatkan tanda tangan" });
    await waitFor(() => expect(place).toBeEnabled());
    await user.click(place);
    await user.click(screen.getByRole("button", { name: "Selesai dan tanda tangani" }));
    await user.type(await screen.findByLabelText("PIN tanda tangan"), "135790{Enter}");

    await waitFor(() => expect(flow.runSignFlow).toHaveBeenCalled());
    const arg = flow.runSignFlow.mock.calls[0][0];
    expect(arg.pin).toBe("135790");
    expect(arg.placement).toMatchObject({ pageIndex: 0, x: 399, width: 160, height: 80 });
    expect(await screen.findByText("Tanda tangan tersimpan")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
    await waitFor(() => expect(api.readFile).toHaveBeenCalledWith("req-uji", "ef".repeat(32)));
  });

  it("batalkan permintaan hanya untuk pengirim", async () => {
    setup();
    await screen.findByRole("heading", { level: 1, name: "Kontrak uji" });
    expect(screen.queryByRole("button", { name: "Batalkan permintaan" })).not.toBeInTheDocument();
  });

  it("pengirim bisa membatalkan lewat konfirmasi", async () => {
    api.cancel.mockResolvedValue(detail({ status: "cancelled", requestedBy: { publicKey: ME, displayName: "Penanda Uji" } }));
    const { user, onChanged } = setup(detail({ requestedBy: { publicKey: ME, displayName: "Penanda Uji" } }));
    await user.click(await screen.findByRole("button", { name: "Batalkan permintaan" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Batalkan permintaan" }));
    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith("req-uji"));
    expect(await screen.findByText("Dibatalkan")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it("menyimpan salinan menampilkan path dan status salinan lama", async () => {
    api.exportFile.mockResolvedValue({ path: "C:\\Unduhan\\Kontrak uji (ditandatangani).pdf" });
    const { user } = setup(
      detail({ exports: [{ path: "C:\\Unduhan\\lama.pdf", exportedAt: "2026-11-21T03:00:00Z", state: "changed" }] }),
    );
    expect(await screen.findByText("Berubah")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Simpan salinan PDF" }));
    expect(await screen.findByText("C:\\Unduhan\\Kontrak uji (ditandatangani).pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tampilkan di folder" })).toBeInTheDocument();
  });
});
