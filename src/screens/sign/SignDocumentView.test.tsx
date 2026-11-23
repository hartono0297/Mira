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
  downloadFile: vi.fn(),
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
      zoom?: number | "fit";
      onPageChange?: (n: number) => void;
      onZoomChange?: (z: number | "fit") => void;
      onLoaded?: (i: { pageCount: number; pages: PageGeometry[] }) => void;
      renderOverlay?: (info: unknown) => unknown;
    }) => {
      useEffect(() => {
        props.onLoaded?.({ pageCount: PAGES.length, pages: PAGES });
      }, []);
      const geo = PAGES[(props.page ?? 1) - 1];
      const info = { ...geo, scale: 1, cssWidth: geo.width, cssHeight: geo.height };
      return (
        <div data-testid="viewer" data-page={props.page} data-zoom={String(props.zoom)}>
          <button type="button" onClick={() => props.onPageChange?.(2)}>
            Ke halaman 2
          </button>
          <button type="button" onClick={() => props.onZoomChange?.(1.5)}>
            Zoom 150
          </button>
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
    fromPeer: true,
    requestedByName: "Pengirim Uji",
    fileAvailable: true,
    fileSize: 1024,
    pending: false,
    downloadSize: 0,
    downloading: false,
    scope: { teamId: null, projectId: null },
    rejected: [],
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
    saved: { width: 400, height: 200, createdAt: "2026-11-01T00:00:00Z", failedAttempts: 0, lockedUntil: null, attemptsLeft: 5, usableAfter: null },
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

  it("isi file berubah: banner, tidak bisa ditandatangani, salinan tidak bisa disimpan", async () => {
    setup(detail({ integrity: "changed" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Isi file tidak cocok dengan catatan Mira");
    expect(alert).toHaveTextContent("Jangan kirim atau cetak file ini.");
    expect(alert).toHaveTextContent("Minta salinan dari pengirim");
    expect(screen.queryByRole("button", { name: "Tempatkan tanda tangan" })).not.toBeInTheDocument();
    expect(screen.queryByText("Giliran Anda")).not.toBeInTheDocument();
    expect(screen.getByText("Tidak bisa ditandatangani")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Dokumen ini tidak bisa ditandatangani karena filenya berubah atau hilang. Minta pengirim membuat permintaan baru dengan file aslinya.",
      ),
    ).toBeInTheDocument();
    const copy = screen.getByRole("button", { name: "Simpan salinan PDF" });
    expect(copy).toHaveAttribute("aria-disabled", "true");
    expect(copy).toHaveAccessibleDescription(
      "Salinan tidak bisa disimpan karena isi file ini tidak cocok dengan catatan Mira.",
    );
    await userEvent.setup().click(copy);
    expect(api.exportFile).not.toHaveBeenCalled();
  });

  it("isi file berubah dan saya pengirimnya: tidak disuruh meminta salinan dari pengirim", async () => {
    setup(detail({ integrity: "changed", requestedBy: { publicKey: ME, displayName: "Penanda Uji" } }));
    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent("Minta salinan dari pengirim");
    expect(alert).toHaveTextContent("buat permintaan baru dengan file asli yang Anda simpan");
    expect(
      screen.getByText(
        "Dokumen ini tidak bisa ditandatangani karena filenya berubah atau hilang. Buat permintaan baru dengan file asli yang Anda simpan.",
      ),
    ).toBeInTheDocument();
  });

  it("banner bahaya kalau catatan penguncian tidak sah", async () => {
    setup(detail({ status: "completed", sealValid: false }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Catatan penguncian tidak sah");
    expect(screen.queryByText("Terkunci")).not.toBeInTheDocument();
    expect(screen.getByText("Selesai, kunci tidak sah")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Simpan salinan PDF" })).toHaveAttribute("aria-disabled", "true");
  });

  it("dokumen selesai dan sah ditandai Terkunci dengan sidik file 16 karakter", async () => {
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
    expect(
      screen.getByText(
        "Isi file dikunci. Perubahan sekecil apa pun terdeteksi di file Mira dan di salinan yang disimpan lewat Simpan salinan PDF. Salinan lain bisa dicek dengan Periksa file PDF.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Selesai, terkunci")).toBeInTheDocument();
    expect(screen.getByText("Sidik file akhir")).toBeInTheDocument();
    expect(screen.getByText("Sidik file asli")).toBeInTheDocument();
    const short = screen.getByTitle(hash);
    expect(short).toHaveTextContent(/^0123456789abcdef$/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Simpan salinan PDF" })).not.toHaveAttribute("aria-disabled");
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
    expect(
      screen.getByText("Satu salinan yang disimpan di luar Mira berubah. Rinciannya ada di bagian Salinan PDF."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Simpan salinan PDF" }));
    expect(await screen.findByText("C:\\Unduhan\\Kontrak uji (ditandatangani).pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tampilkan di folder" })).toBeInTheDocument();
  });

  async function startPlacing(user: ReturnType<typeof userEvent.setup>) {
    const place = await screen.findByRole("button", { name: "Tempatkan tanda tangan" });
    await waitFor(() => expect(place).not.toHaveAttribute("aria-disabled"));
    await user.click(place);
    return screen.findByRole("group", { name: "Kotak tanda tangan Penanda Uji" });
  }

  it("fokus ke judul saat memuat, lalu ke judul dokumen", async () => {
    setup();
    expect(screen.getByRole("heading", { level: 1, name: "Dokumen tanda tangan" })).toHaveFocus();
    const title = await screen.findByRole("heading", { level: 1, name: "Kontrak uji" });
    expect(title).toHaveFocus();
  });

  it("chip status, catatan pengiriman, dan petunjuk keyboard", async () => {
    const { user } = setup();
    expect(await screen.findByText("Berjalan, 0 dari 2 sudah tanda tangan")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Dokumen dikirim ke penanda tangan lain saat laptop mereka tersambung. Daftar ini berubah begitu mereka menandatangani.",
      ),
    ).toBeInTheDocument();
    await startPlacing(user);
    expect(
      screen.getByText(
        "Geser kotak dengan mouse atau tombol panah (tahan Shift untuk lebih jauh). Ubah ukuran dengan menarik sudut kanan bawah, tombol Kecilkan atau Besarkan, atau Alt dan panah.",
      ),
    ).toBeInTheDocument();
  });

  it("Kecilkan kotak di ukuran minimum: aria-disabled dan fokus tetap di tombol", async () => {
    const { user } = setup();
    const box = await startPlacing(user);
    const smaller = screen.getByRole("button", { name: "Kecilkan kotak" });
    for (let i = 0; i < 6; i++) await user.click(smaller);
    expect(box).toHaveStyle({ width: "60px" });
    expect(smaller).toHaveAttribute("aria-disabled", "true");
    expect(smaller).toHaveFocus();
    await user.click(smaller);
    expect(box).toHaveStyle({ width: "60px" });
  });

  it("Pindahkan ke halaman ini dan Lihat halaman N memindah fokus ke kotak", async () => {
    const { user } = setup();
    await startPlacing(user);
    await user.click(screen.getByRole("button", { name: "Ke halaman 2" }));
    expect(screen.getByTestId("viewer")).toHaveAttribute("data-page", "2");

    await user.click(screen.getByRole("button", { name: "Lihat halaman 1" }));
    expect(screen.getByTestId("viewer")).toHaveAttribute("data-page", "1");
    await waitFor(() => expect(screen.getByRole("group", { name: "Kotak tanda tangan Penanda Uji" })).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "Ke halaman 2" }));
    await user.click(screen.getByRole("button", { name: "Pindahkan ke halaman ini" }));
    expect(await screen.findByText(/Kotak ada di halaman 2/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("group", { name: "Kotak tanda tangan Penanda Uji" })).toHaveFocus());
  });

  it("Batal menempatkan mengembalikan fokus ke tombol Tempatkan tanda tangan", async () => {
    const { user } = setup();
    await startPlacing(user);
    await user.click(screen.getByRole("button", { name: "Batal menempatkan" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Tempatkan tanda tangan" })).toHaveFocus());
  });

  it("Simpan salinan PDF selama menyimpan: aria-disabled, fokus tetap, tidak dikirim dua kali", async () => {
    let finish: (v: { path: string }) => void = () => {};
    api.exportFile.mockReturnValue(new Promise((r) => (finish = r)));
    const { user } = setup();
    const btn = await screen.findByRole("button", { name: "Simpan salinan PDF" });
    await user.click(btn);
    const busy = screen.getByRole("button", { name: "Menyimpan salinan..." });
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(busy).toHaveFocus();
    await user.click(busy);
    expect(api.exportFile).toHaveBeenCalledTimes(1);
    finish({ path: "C:\\Unduhan\\a.pdf" });
    expect(await screen.findByText("C:\\Unduhan\\a.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Simpan salinan PDF" })).toHaveFocus();
  });

  it("setelah PIN benar: fokus ke konfirmasi, halaman stempel dan zoom tetap", async () => {
    const after = detail({ currentHash: "ef".repeat(32), signedCount: 1 });
    flow.runSignFlow.mockResolvedValue(after);
    const { user } = setup();
    await startPlacing(user);
    await user.click(screen.getByRole("button", { name: "Zoom 150" }));
    await user.click(screen.getByRole("button", { name: "Ke halaman 2" }));
    await user.click(screen.getByRole("button", { name: "Pindahkan ke halaman ini" }));
    await user.click(screen.getByRole("button", { name: "Selesai dan tanda tangani" }));
    await user.type(await screen.findByLabelText("PIN tanda tangan"), "135790{Enter}");

    await waitFor(() => expect(flow.runSignFlow).toHaveBeenCalled());
    expect(flow.runSignFlow.mock.calls[0][0].placement).toMatchObject({ pageIndex: 1 });
    const ok = await screen.findByText("Tanda tangan tersimpan");
    await waitFor(() => expect(ok.closest(".sdoc-ok")).toHaveFocus());
    await waitFor(() => expect(api.readFile).toHaveBeenCalledWith("req-uji", "ef".repeat(32)));
    const viewer = await screen.findByTestId("viewer");
    expect(viewer).toHaveAttribute("data-page", "2");
    expect(viewer).toHaveAttribute("data-zoom", "1.5");
  });

  it("PIN salah: ringkasan dimuat ulang supaya batas percobaan segar", async () => {
    flow.runSignFlow.mockRejectedValue({ code: "pin_wrong", message: "PIN salah. Sisa 4 percobaan." });
    const { user } = setup();
    await startPlacing(user);
    await user.click(screen.getByRole("button", { name: "Selesai dan tanda tangani" }));
    await user.type(await screen.findByLabelText("PIN tanda tangan"), "111111{Enter}");
    expect(await screen.findByText("PIN salah. Sisa 4 percobaan.")).toBeInTheDocument();
    await waitFor(() => expect(api.overview).toHaveBeenCalledTimes(2));
  });

  it("giliran hilang setelah bentrok: dialog PIN ditutup", async () => {
    flow.runSignFlow.mockRejectedValue({ code: "not_your_turn", message: "Belum giliran Anda." });
    const { user } = setup();
    await startPlacing(user);
    api.getRequest.mockResolvedValue(
      detail({
        signers: [
          signer({ position: 1, publicKey: OTHER, displayName: "Rekan Uji", isMe: false, canSignNow: true }),
          signer({ position: 2, canSignNow: false }),
        ],
      }),
    );
    await user.click(screen.getByRole("button", { name: "Selesai dan tanda tangani" }));
    await user.type(await screen.findByLabelText("PIN tanda tangan"), "135790{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText(/Belum giliran Anda\. Menunggu Rekan Uji/)).toBeInTheDocument();
  });

  it("masa tunggu tanda tangan baru: tombol nonaktif dengan alasannya", async () => {
    const later = new Date(Date.now() + 6 * 3600_000).toISOString();
    const base = overview().saved!;
    const { user } = setup(detail(), overview({ saved: { ...base, usableAfter: later } }));
    const place = await screen.findByRole("button", { name: "Tempatkan tanda tangan" });
    expect(place).toHaveAttribute("aria-disabled", "true");
    expect(place).toHaveAccessibleDescription(
      /^Tanda tangan baru Anda bisa dipakai mulai .+, karena tanda tangan sebelumnya dihapus tanpa PIN\.$/,
    );
    await user.click(place);
    expect(screen.queryByRole("group", { name: "Kotak tanda tangan Penanda Uji" })).not.toBeInTheDocument();
  });

  it("jejak audit: tanda tangan dihapus saat permintaan berjalan tampil sebagai peringatan", async () => {
    const base = detail();
    setup(
      detail({
        events: [
          ...base.events,
          {
            kind: "signature_deleted",
            actorKey: ME,
            actorName: "Penanda Uji",
            at: "2026-11-21T01:00:00Z",
            hashBefore: null,
            hashAfter: null,
            detail: "tanpa PIN (lupa PIN)",
            valid: true,
          },
        ],
      }),
    );
    expect(await screen.findByText("Menghapus tanda tangan")).toBeVisible();
    expect(screen.getByText("tanpa PIN (lupa PIN)")).toBeInTheDocument();
    expect(screen.getByText(/Terjadi saat permintaan ini berjalan/)).toBeInTheDocument();
    expect(screen.getByText(/1 perlu diperhatikan/)).toBeInTheDocument();
  });

  it("salinan utuh memakai chip netral, beberapa salinan berubah disebut jamak", async () => {
    setup(
      detail({
        exports: [
          { path: "C:\\Unduhan\\a.pdf", exportedAt: "2026-11-21T03:00:00Z", state: "intact" },
          { path: "C:\\Unduhan\\b.pdf", exportedAt: "2026-11-21T04:00:00Z", state: "changed" },
          { path: "C:\\Unduhan\\c.pdf", exportedAt: "2026-11-21T05:00:00Z", state: "changed" },
        ],
      }),
    );
    const intact = await screen.findByText("Utuh");
    expect(intact).toHaveClass("chip", "sdoc-chip-ok");
    expect(intact).not.toHaveClass("chip-on");
    expect(screen.getAllByText("Berubah")[0]).toHaveClass("sdoc-chip-bad");
    expect(
      screen.getByText("2 salinan yang disimpan di luar Mira berubah. Rinciannya ada di bagian Salinan PDF."),
    ).toBeInTheDocument();
  });

  it("versi yang ditolak: siapa dan kenapa dari kode, tanpa teks teknis inti", async () => {
    setup(
      detail({
        requestedBy: { publicKey: ME, displayName: "Penanda Uji" },
        rejected: [
          {
            signerName: "Rekan Uji",
            at: "2026-11-21T04:00:00Z",
            code: "version_changes_content",
            otherName: null,
            reason: "Objek 12 tidak ada di tabel startxref versi lama.",
          },
          {
            signerName: "Tamu Uji",
            at: "2026-11-21T05:00:00Z",
            code: "already_signed",
            otherName: null,
            reason: "Anda sudah menandatangani dokumen ini.",
          },
          {
            signerName: "Rekan Uji",
            at: "2026-11-21T06:00:00Z",
            code: "skipped_concurrent",
            otherName: "Tamu Uji",
            reason: "Ditandatangani bersamaan dengan Tamu Uji.",
          },
          { signerName: "Rekan Uji", at: "2026-11-21T07:00:00Z", code: "kode_baru", otherName: null, reason: "katalog rusak" },
        ],
      }),
    );
    const section = await screen.findByRole("region", { name: "Versi yang ditolak" });
    expect(within(section).getByText(/Dokumen tetap memakai versi sah terakhir/)).toBeInTheDocument();
    const items = within(section).getAllByRole("listitem");
    expect(
      within(items[0]).getByText("Versi dari Rekan Uji ditolak karena mengubah isi dokumen, bukan hanya menambah tanda tangan."),
    ).toBeInTheDocument();
    expect(within(items[0]).getByText(/21 November 2026/)).toBeInTheDocument();
    expect(
      within(items[1]).getByText("Versi dari Tamu Uji tidak dipakai karena Tamu Uji sudah menandatangani versi lain dokumen ini."),
    ).toBeInTheDocument();
    expect(within(items[2]).getByText(/karena Tamu Uji menandatangani versi yang sama lebih dulu/)).toBeInTheDocument();
    expect(within(items[3]).getByText("Versi dari Rekan Uji tidak dipakai Mira.")).toBeInTheDocument();
    expect(within(section).queryByText(/startxref|katalog|Anda sudah/)).not.toBeInTheDocument();
  });

  it("tanpa versi ditolak, bagiannya tidak tampil", async () => {
    setup();
    await screen.findByRole("heading", { level: 1, name: "Kontrak uji" });
    expect(screen.queryByText("Versi yang ditolak")).not.toBeInTheDocument();
  });

  it("bukti stempel menolak versi baru: pesan dengan kata biasa di dialog PIN", async () => {
    flow.runSignFlow.mockRejectedValue({ code: "version_changes_content", message: "increment check failed" });
    const { user } = setup();
    await startPlacing(user);
    await user.click(screen.getByRole("button", { name: "Selesai dan tanda tangani" }));
    await user.type(await screen.findByLabelText("PIN tanda tangan"), "135790{Enter}");
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText(/mengubah isi dokumen selain stempel tanda tangan\. Coba lagi\./),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("increment check failed")).not.toBeInTheDocument();
  });

  it("versi lama tidak utuh di dalam versi baru: pesannya sendiri", async () => {
    flow.runSignFlow.mockRejectedValue({ code: "version_not_prefix", message: "not a prefix" });
    const { user } = setup();
    await startPlacing(user);
    await user.click(screen.getByRole("button", { name: "Selesai dan tanda tangani" }));
    await user.type(await screen.findByLabelText("PIN tanda tangan"), "135790{Enter}");
    expect(await screen.findByText(/isi versi sebelumnya tidak utuh di dalamnya/)).toBeInTheDocument();
  });

  it("file kecil dari rekan belum tersalin dan rekan belum tersambung: disalin otomatis nanti", async () => {
    setup(detail({ fileAvailable: false, integrity: "missing", fileSize: 300 * 1024 }));
    expect(
      await screen.findByText("File disalin otomatis saat laptop rekan yang menyimpannya tersambung."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/sedang disalin/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Unduh file/ })).not.toBeInTheDocument();
  });

  it("ukuran file dari rekan tidak diketahui: Unduh file tanpa ukuran", async () => {
    setup(detail({ fileAvailable: false, integrity: "missing", fileSize: 0, downloadSize: null }));
    expect(
      await screen.findByText("File ini belum diunduh. Ukurannya belum diketahui, jadi tidak disalin otomatis."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unduh file" })).toBeInTheDocument();
  });

  it("ukuran di tombol unduh mengikuti downloadSize dari inti", async () => {
    setup(detail({ fileAvailable: false, integrity: "missing", fileSize: 25 * 1024 * 1024, downloadSize: 30 * 1024 * 1024 }));
    expect(await screen.findByRole("button", { name: "Unduh file (30 MB)" })).toBeInTheDocument();
  });

  it("file kecil dari rekan sedang disalin: status, tanpa banner hilang, belum bisa ditandatangani", async () => {
    setup(detail({ fileAvailable: false, integrity: "missing", fileSize: 300 * 1024, downloading: true }));
    expect(await screen.findByText(/File sedang disalin dari laptop rekan\. Halaman tampil di sini/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("File dokumen tidak ditemukan")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Unduh file/ })).not.toBeInTheDocument();
    expect(screen.getByText("Giliran Anda, menunggu file")).toBeInTheDocument();
    expect(
      screen.getByText("Giliran Anda. Tanda tangan bisa dibuat setelah file dokumen ada di laptop ini."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tempatkan tanda tangan" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Simpan salinan PDF" })).toHaveAccessibleDescription(
      "Salinan bisa disimpan setelah file dokumen ada di laptop ini.",
    );
    expect(api.readFile).not.toHaveBeenCalled();
  });

  it("file besar dari rekan: Unduh file sibuk, lalu dokumen tampil", async () => {
    const big = 30 * 1024 * 1024;
    let finish: (d: RequestDetail) => void = () => {};
    api.downloadFile.mockImplementation(() => new Promise<RequestDetail>((resolve) => (finish = resolve)));
    const { user, onChanged } = setup(detail({ fileAvailable: false, integrity: "missing", fileSize: big }));
    expect(await screen.findByText("File 30 MB belum diunduh. File di atas 20 MB tidak disalin otomatis.")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Unduh file (30 MB)" });
    await user.click(button);
    expect(api.downloadFile).toHaveBeenCalledWith("req-uji");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveTextContent("Mengunduh...");
    await user.click(button);
    expect(api.downloadFile).toHaveBeenCalledTimes(1);

    const after = detail({ fileSize: big });
    api.getRequest.mockResolvedValue(after);
    finish(after);
    expect(await screen.findByTestId("viewer")).toBeInTheDocument();
    expect(api.readFile).toHaveBeenCalledWith("req-uji", "cd".repeat(32));
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Unduh file/ })).not.toBeInTheDocument();
  });

  it("unduh gagal karena tidak ada rekan yang menyimpan file: pesan dengan kata biasa", async () => {
    api.downloadFile.mockRejectedValue({ code: "not_available", message: "no peer" });
    const { user } = setup(detail({ fileAvailable: false, integrity: "missing", fileSize: 30 * 1024 * 1024 }));
    await user.click(await screen.findByRole("button", { name: "Unduh file (30 MB)" }));
    expect(await screen.findByText("File belum bisa diunduh")).toBeInTheDocument();
    expect(screen.getByText(/^Belum ada laptop rekan yang tersambung dan menyimpan file ini\./)).toBeInTheDocument();
    expect(screen.queryByText("no peer")).not.toBeInTheDocument();
  });

  it("tanda tangan terbaru dari rekan sedang disalin: keterangan di atas layar", async () => {
    setup(detail({ pending: true, downloading: true, downloadSize: 2048 }));
    expect(
      await screen.findByText(/Tanda tangan terbaru dari rekan sedang disalin ke laptop ini\. Status penanda tangan/),
    ).toBeInTheDocument();
    expect(await screen.findByTestId("viewer")).toBeInTheDocument();
  });

  it("mode bebas, tanda tangan rekan belum sampai: tunggu dulu, tanpa tombol tanda tangan", async () => {
    setup(detail({ mode: "parallel", pending: true, downloadSize: 2048 }));
    expect(await screen.findByText("Tunggu tanda tangan terbaru dari rekan sampai, lalu tanda tangani.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tempatkan tanda tangan" })).not.toBeInTheDocument();
    expect(screen.getByText("Giliran Anda, menunggu tanda tangan rekan")).toBeInTheDocument();
    expect(
      screen.getByText("Tanda tangan terbaru dari rekan disalin otomatis saat laptop rekan yang menyimpannya tersambung."),
    ).toBeInTheDocument();
  });
});

describe("SignDocumentView: dibuka dari Tandatangani di daftar", () => {
  function open(d: RequestDetail = detail(), o: SignOverview = overview()) {
    api.getRequest.mockResolvedValue(d);
    api.overview.mockResolvedValue(o);
    api.readFile.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
    render(<SignDocumentView requestId="req-uji" onBack={vi.fn()} startSigning />);
  }

  it("giliran saya: kotak tanda tangan langsung ditempatkan dan difokus", async () => {
    open();
    const box = await screen.findByRole("group", { name: "Kotak tanda tangan Penanda Uji" });
    await waitFor(() => expect(box).toHaveFocus());
    expect(screen.getByRole("button", { name: "Selesai dan tanda tangani" })).toBeInTheDocument();
  });

  it("belum punya tanda tangan tersimpan: fokus ke Buat tanda tangan", async () => {
    open(detail(), overview({ saved: null }));
    const btn = await screen.findByRole("button", { name: "Buat tanda tangan" });
    await waitFor(() => expect(btn).toHaveFocus());
  });

  it("bukan giliran saya: layar dibuka biasa, fokus di judul", async () => {
    open(
      detail({
        signers: [
          signer({ position: 1, publicKey: OTHER, displayName: "Rekan Uji", isMe: false, canSignNow: false }),
          signer({ position: 2, canSignNow: false }),
        ],
      }),
    );
    const title = await screen.findByRole("heading", { level: 1, name: "Kontrak uji" });
    await waitFor(() => expect(title).toHaveFocus());
    expect(screen.queryByRole("group", { name: /Kotak tanda tangan/ })).not.toBeInTheDocument();
  });
});
