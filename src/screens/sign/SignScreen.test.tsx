import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Candidate, RequestDetail, RequestSummary, SignOverview } from "../../api/signing";
import { SignScreen, sortRequests, waitingRequests } from "./SignScreen";
import { integrityLabel } from "./labels";

const api = vi.hoisted(() => ({
  overview: vi.fn(),
  saveSignature: vi.fn(),
  deleteSignature: vi.fn(),
  importPdf: vi.fn(),
  listCandidates: vi.fn(),
  createRequest: vi.fn(),
  verifyFile: vi.fn(),
  downloadFile: vi.fn(),
}));
vi.mock("../../api/signing", async (orig) => ({
  ...(await orig<typeof import("../../api/signing")>()),
  signingApi: api,
}));

// Proyek untuk dialog permintaan baru; dialognya dites sendiri.
const board = vi.hoisted(() => ({ listProjects: vi.fn() }));
vi.mock("../../api/board", async (orig) => ({
  ...(await orig<typeof import("../../api/board")>()),
  boardApi: board,
}));

// Event Tauri mira://feature. Hanya dipakai kalau tes memasang __TAURI_INTERNALS__.
const tauriEvent = vi.hoisted(() => ({
  handlers: [] as { event: string; fn: (e: { payload: unknown }) => void }[],
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriEvent.listen }));

// Layar dokumen dibuat terpisah; di sini cukup tiruan dengan props yang sama.
vi.mock("./SignDocumentView", () => ({
  SignDocumentView: (p: { requestId: string; onBack: () => void; onChanged?: () => void }) => (
    <div>
      <p>Layar dokumen {p.requestId}</p>
      <button type="button" onClick={p.onBack}>
        Kembali ke daftar
      </button>
    </div>
  ),
}));

// Dialog gambar tanda tangan sudah dites sendiri; tiruan ini langsung memanggil onSave.
vi.mock("./pad/SignatureSetupDialog", () => ({
  SignatureSetupDialog: (p: {
    open: boolean;
    onOpenChange: (o: boolean) => void;
    onSave: (i: { png: Uint8Array; width: number; height: number; pin: string }) => Promise<void>;
  }) =>
    p.open ? (
      <div role="dialog" aria-label="Buat tanda tangan">
        <button
          type="button"
          onClick={() =>
            void p.onSave({ png: new Uint8Array([1, 2, 3]), width: 10, height: 4, pin: "135790" }).then(() =>
              p.onOpenChange(false),
            )
          }
        >
          Simpan tiruan
        </button>
      </div>
    ) : null,
}));

// Data uji: judul, nama, dan kunci jelas buatan.
const ME_KEY = "a".repeat(64);
const KEY_B = "b".repeat(64);

function summary(extra: Partial<RequestSummary> = {}): RequestSummary {
  return {
    id: "1".repeat(32),
    title: "Dokumen Uji",
    mode: "sequential",
    status: "in_progress",
    myState: "waiting_others",
    signedCount: 0,
    signerCount: 2,
    createdAt: "2026-11-22T01:00:00Z",
    updatedAt: "2026-11-22T02:00:00Z",
    completedAt: null,
    integrity: "intact",
    exportWarnings: 0,
    fromPeer: false,
    requestedByName: "Penguji",
    fileAvailable: true,
    fileSize: 2048,
    pending: false,
    ...extra,
  };
}

function overview(extra: Partial<SignOverview> = {}): SignOverview {
  return {
    saved: null,
    requests: [],
    canRequest: true,
    me: { publicKey: ME_KEY, displayName: "Penguji", kind: "member" },
    ...extra,
  };
}

const saved = {
  width: 300,
  height: 120,
  createdAt: "2026-11-20T03:00:00Z",
  failedAttempts: 0,
  lockedUntil: null,
  attemptsLeft: 5,
  usableAfter: null,
};

// PDF sungguhan buatan pdf-lib, karena layar memeriksa PDF sebelum mengimpor.
let PDF_BYTES: Uint8Array;
let ENCRYPTED_BYTES: Uint8Array;
beforeAll(async () => {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  PDF_BYTES = await doc.save();
  const enc = await PDFDocument.load(PDF_BYTES);
  enc.context.trailerInfo.Encrypt = enc.context.obj({ Filter: "Standard", V: 1, R: 2 });
  ENCRYPTED_BYTES = await enc.save({ useObjectStreams: false });
});

function pdfFile(bytes: Uint8Array, name: string): File {
  return new File([bytes as BlobPart], name, { type: "application/pdf" });
}

const candidates: Candidate[] = [
  { publicKey: ME_KEY, displayName: "Penguji", kind: "member", isMe: true },
  { publicKey: KEY_B, displayName: "Anggota Uji", kind: "member", isMe: false },
];

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listCandidates.mockResolvedValue(candidates);
  board.listProjects.mockReset().mockResolvedValue([]);
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  tauriEvent.handlers = [];
  tauriEvent.listen.mockReset().mockImplementation(async (event: string, fn: (e: { payload: unknown }) => void) => {
    const entry = { event, fn };
    tauriEvent.handlers.push(entry);
    return () => {
      tauriEvent.handlers = tauriEvent.handlers.filter((h) => h !== entry);
    };
  });
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("SignScreen: keadaan dasar", () => {
  it("memuat, lalu keadaan kosong untuk anggota", async () => {
    api.overview.mockResolvedValue(overview());
    render(<SignScreen />);
    expect(screen.getByText("Memuat tanda tangan dan daftar dokumen...")).toBeInTheDocument();
    expect(await screen.findByText(/Belum ada dokumen. Pilih PDF/)).toBeInTheDocument();
    // Tanpa tanda tangan tersimpan hanya ada satu tombol utama: Buat tanda tangan.
    expect(screen.getByRole("button", { name: "Pilih PDF untuk ditandatangani" })).toHaveClass("btn-ghost");
    expect(screen.getByRole("button", { name: "Buat tanda tangan" })).not.toHaveClass("btn-ghost");
    expect(screen.getByText("Belum ada tanda tangan tersimpan")).toBeInTheDocument();
  });

  it("error membaca bisa dicoba lagi", async () => {
    api.overview.mockRejectedValueOnce({ code: "database", message: "Database tidak bisa dibuka." });
    api.overview.mockResolvedValueOnce(overview());
    const user = userEvent.setup();
    render(<SignScreen />);
    expect(await screen.findByText("Database tidak bisa dibuka.")).toBeInTheDocument();
    expect(screen.getByText("Daftar tanda tangan belum terbaca")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByText(/Belum ada dokumen/)).toBeInTheDocument();
  });

  it("Tamu tidak melihat aksi meminta tanda tangan", async () => {
    api.overview.mockResolvedValue(
      overview({ canRequest: false, me: { publicKey: ME_KEY, displayName: "Penguji", kind: "guest" } }),
    );
    render(<SignScreen />);
    expect(
      await screen.findByText(
        "Tamu tidak bisa meminta tanda tangan, tetapi bisa menandatangani dokumen yang dikirim rekan untuk proyek yang boleh Anda buka.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pilih PDF untuk ditandatangani" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Periksa file PDF" })).toBeInTheDocument();
    expect(screen.getByText(/Belum ada dokumen untuk Anda tanda tangani/)).toBeInTheDocument();
  });

  it("memuat ulang saat jendela kembali fokus", async () => {
    api.overview.mockResolvedValue(overview());
    render(<SignScreen />);
    await screen.findByText(/Belum ada dokumen/);
    api.overview.mockResolvedValue(overview({ requests: [summary({ title: "Dokumen Baru Uji" })] }));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByText("Dokumen Baru Uji")).toBeInTheDocument();
  });
});

describe("SignScreen: tanda tangan saya", () => {
  it("membuat tanda tangan lewat dialog, lalu status tersimpan tampil", async () => {
    api.overview.mockResolvedValueOnce(overview());
    api.overview.mockResolvedValue(overview({ saved }));
    api.saveSignature.mockResolvedValue(saved);
    const user = userEvent.setup();
    render(<SignScreen />);
    await user.click(await screen.findByRole("button", { name: "Buat tanda tangan" }));
    await user.click(screen.getByRole("button", { name: "Simpan tiruan" }));
    expect(api.saveSignature).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "135790");
    expect(await screen.findByText(/Tersimpan sejak 20 November 2026.*dipakai dengan PIN/)).toBeInTheDocument();
    expect(screen.getByText(/Tanda tangan tersimpan. Mira akan meminta PIN/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Hapus tanda tangan" })).toHaveFocus());
  });

  it("menghapus dengan PIN: dialog PIN, lalu tanda tangan baru langsung bisa dibuat", async () => {
    api.overview.mockResolvedValueOnce(overview({ saved }));
    api.overview.mockResolvedValue(overview());
    api.deleteSignature.mockResolvedValue(null);
    const user = userEvent.setup();
    render(<SignScreen />);
    // Dengan tanda tangan tersimpan, Pilih PDF kembali jadi tombol utama.
    expect(await screen.findByRole("button", { name: "Pilih PDF untuk ditandatangani" })).not.toHaveClass("btn-ghost");
    await user.click(screen.getByRole("button", { name: "Hapus tanda tangan" }));
    const dialog = screen.getByRole("dialog", { name: "Hapus tanda tangan tersimpan?" });
    expect(within(dialog).getByText(/Tanda tangan baru bisa langsung dibuat dan dipakai/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("PIN tanda tangan")).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "Hapus tanda tangan" })).toHaveClass("btn-danger");
    await user.type(within(dialog).getByLabelText("PIN tanda tangan"), "135790{Enter}");
    expect(api.deleteSignature).toHaveBeenCalledWith("135790");
    expect(await screen.findByText(/Tanda tangan baru bisa langsung dibuat dan dipakai/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Buat tanda tangan" })).toHaveFocus());
  });

  it("PIN salah saat menghapus: pesan di dialog, tidak terhapus", async () => {
    api.overview.mockResolvedValue(overview({ saved }));
    api.deleteSignature.mockRejectedValue({ code: "pin_wrong", message: "PIN salah. Sisa 4 kali lagi sebelum dikunci sementara." });
    const user = userEvent.setup();
    render(<SignScreen />);
    await user.click(await screen.findByRole("button", { name: "Hapus tanda tangan" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("PIN tanda tangan"), "111111{Enter}");
    expect(await within(dialog).findByText(/Sisa 4 kali lagi/)).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Hapus tanda tangan tersimpan?" })).toBeInTheDocument();
  });

  it("Lupa PIN: konfirmasi menjelaskan masa tunggu 24 jam, lalu hapus tanpa PIN", async () => {
    api.overview.mockResolvedValueOnce(overview({ saved }));
    api.overview.mockResolvedValue(overview());
    api.deleteSignature.mockResolvedValue(null);
    const user = userEvent.setup();
    render(<SignScreen />);
    await user.click(await screen.findByRole("button", { name: "Hapus tanda tangan" }));
    await user.click(screen.getByRole("button", { name: "Lupa PIN?" }));
    const dialog = await screen.findByRole("dialog", { name: "Hapus tanda tangan tanpa PIN?" });
    expect(screen.queryByRole("dialog", { name: "Hapus tanda tangan tersimpan?" })).not.toBeInTheDocument();
    expect(within(dialog).getByText(/baru bisa dipakai 24 jam setelah penghapusan/)).toBeInTheDocument();
    expect(within(dialog).getByText(/menandatangani dengan PIN buatannya sendiri/)).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Batal" })).toHaveFocus());
    await user.click(within(dialog).getByRole("button", { name: "Hapus tanpa PIN" }));
    expect(api.deleteSignature).toHaveBeenCalledTimes(1);
    expect(api.deleteSignature).toHaveBeenCalledWith();
    expect(await screen.findByText(/dipakai 24 jam setelah penghapusan ini/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Buat tanda tangan" })).toHaveFocus());
  });

  it("Lupa PIN gagal: error tampil di dialog konfirmasi", async () => {
    api.overview.mockResolvedValue(overview({ saved }));
    api.deleteSignature.mockRejectedValue({ code: "database", message: "Database terkunci." });
    const user = userEvent.setup();
    render(<SignScreen />);
    await user.click(await screen.findByRole("button", { name: "Hapus tanda tangan" }));
    await user.click(screen.getByRole("button", { name: "Lupa PIN?" }));
    const dialog = await screen.findByRole("dialog", { name: "Hapus tanda tangan tanpa PIN?" });
    await user.click(within(dialog).getByRole("button", { name: "Hapus tanpa PIN" }));
    expect(await within(dialog).findByText("Database terkunci.")).toBeInTheDocument();
  });

  it("masa tunggu: tampil kapan tanda tangan bisa dipakai", async () => {
    const usableAfter = "2099-11-23T08:04:00Z";
    api.overview.mockResolvedValue(overview({ saved: { ...saved, usableAfter } }));
    render(<SignScreen />);
    expect(await screen.findByText(/^Bisa dipakai mulai 23 November 2099, \d{2}\.\d{2}/)).toBeInTheDocument();
    expect(screen.getByText(/24 jam setelah tanda tangan sebelumnya dihapus tanpa PIN/)).toBeInTheDocument();
  });

  it("masa tunggu yang sudah lewat tidak ditampilkan", async () => {
    api.overview.mockResolvedValue(overview({ saved: { ...saved, usableAfter: "2020-01-01T00:00:00Z" } }));
    render(<SignScreen />);
    await screen.findByText(/Tersimpan sejak/);
    expect(screen.queryByText(/Bisa dipakai mulai/)).not.toBeInTheDocument();
  });

  it("status terkunci sementara kalau lockedUntil di masa depan", async () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    api.overview.mockResolvedValue(overview({ saved: { ...saved, failedAttempts: 5, attemptsLeft: 0, lockedUntil: future } }));
    render(<SignScreen />);
    expect(await screen.findByText(/Terkunci sementara sampai/)).toBeInTheDocument();
  });
});

describe("SignScreen: daftar dokumen", () => {
  it("Giliran Anda paling atas, label status, jumlah tanda tangan", async () => {
    api.overview.mockResolvedValue(
      overview({
        requests: [
          summary({ id: "a1", title: "Selesai Uji", status: "completed", myState: "signed", signedCount: 2, completedAt: "2026-11-22T05:00:00Z", updatedAt: "2026-11-22T05:00:00Z" }),
          summary({ id: "a2", title: "Menunggu Uji", updatedAt: "2026-11-22T06:00:00Z" }),
          summary({ id: "a3", title: "Giliran Uji", myState: "your_turn", signedCount: 1, updatedAt: "2026-11-21T01:00:00Z" }),
          summary({ id: "a4", title: "Batal Uji", status: "cancelled", updatedAt: "2026-11-22T07:00:00Z" }),
        ],
      }),
    );
    render(<SignScreen />);
    await screen.findByText("Giliran Uji");
    const titles = Array.from(document.querySelectorAll(".sign-row-title")).map((el) => el.textContent);
    expect(titles).toEqual(["Giliran Uji", "Menunggu Uji", "Selesai Uji", "Batal Uji"]);
    expect(screen.getByRole("button", { name: /Giliran Uji.*1 dari 2 sudah tanda tangan.*Giliran Anda/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Selesai Uji.*Selesai, terkunci/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Batal Uji.*Dibatalkan/ })).toBeInTheDocument();
    expect(screen.getByText("1 dokumen menunggu tanda tangan Anda")).toBeInTheDocument();
  });

  it("giliran Anda atas file yang berubah tidak dihitung dan tidak di atas", async () => {
    api.overview.mockResolvedValue(
      overview({
        requests: [
          summary({ id: "b1", title: "Menunggu Uji", updatedAt: "2026-11-22T06:00:00Z" }),
          summary({ id: "b2", title: "Berubah Uji", myState: "your_turn", integrity: "changed", updatedAt: "2026-11-21T01:00:00Z" }),
          summary({ id: "b3", title: "Giliran Uji", myState: "your_turn", updatedAt: "2026-11-20T01:00:00Z" }),
        ],
      }),
    );
    render(<SignScreen />);
    await screen.findByText("Berubah Uji");
    const titles = Array.from(document.querySelectorAll(".sign-row-title")).map((el) => el.textContent);
    expect(titles).toEqual(["Giliran Uji", "Menunggu Uji", "Berubah Uji"]);
    expect(screen.getByText("1 dokumen menunggu tanda tangan Anda")).toBeInTheDocument();
    const changed = screen.getByRole("button", { name: /Berubah Uji/ });
    expect(changed.querySelector(".chip")).not.toHaveClass("chip-on");
    expect(changed.querySelector(".chip")).not.toHaveTextContent("Giliran Anda");
  });

  it("peringatan integritas dan salinan luar tampil", async () => {
    api.overview.mockResolvedValue(
      overview({
        requests: [
          summary({ id: "w1", title: "Berubah Uji", status: "completed", integrity: "changed" }),
          summary({ id: "w2", title: "Hilang Uji", integrity: "missing" }),
          summary({ id: "w3", title: "Ekspor Uji", status: "completed", exportWarnings: 1 }),
          summary({ id: "w4", title: "Utuh Uji" }),
        ],
      }),
    );
    render(<SignScreen />);
    expect(await screen.findByText(integrityLabel("changed"))).toBeInTheDocument();
    expect(screen.getByText(integrityLabel("missing"))).toBeInTheDocument();
    expect(screen.getByText("Salinan PDF yang disimpan di luar Mira berubah")).toBeInTheDocument();
    expect(screen.getByText("3 dokumen perlu diperiksa")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Utuh Uji/ })).not.toHaveClass("sign-row-warn");
  });

  it("membuka dokumen dengan Enter, lalu kembali ke daftar dan fokus ke baris", async () => {
    api.overview.mockResolvedValue(overview({ requests: [summary({ id: "doc1", title: "Buka Uji" })] }));
    const user = userEvent.setup();
    render(<SignScreen />);
    const row = await screen.findByRole("button", { name: /Buka Uji/ });
    row.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByText("Layar dokumen doc1")).toBeInTheDocument();
    const calls = api.overview.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Kembali ke daftar" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Buka Uji/ })).toHaveFocus());
    expect(api.overview.mock.calls.length).toBeGreaterThan(calls);
  });

  it("memilih PDF: impor, dialog permintaan, lalu dokumen baru terbuka", async () => {
    api.overview.mockResolvedValue(overview());
    api.importPdf.mockResolvedValue({ fileHash: "f".repeat(64), size: 12, fileName: "Kontrak Uji.pdf" });
    api.createRequest.mockResolvedValue({ id: "baru1" } as RequestDetail);
    const user = userEvent.setup();
    render(<SignScreen />);
    await screen.findByRole("button", { name: "Pilih PDF untuk ditandatangani" });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(input, pdfFile(PDF_BYTES, "Kontrak Uji.pdf"));
    await waitFor(() => expect(api.importPdf).toHaveBeenCalledWith(expect.any(Uint8Array), "Kontrak Uji.pdf"));
    const dialog = await screen.findByRole("dialog", { name: "Minta tanda tangan" });
    expect(within(dialog).getByLabelText("Judul dokumen")).toHaveValue("Kontrak Uji");
    await within(dialog).findByRole("checkbox", { name: "Penguji (Anda)" });
    await user.click(within(dialog).getByRole("button", { name: "Buat permintaan" }));
    expect(await screen.findByText("Layar dokumen baru1")).toBeInTheDocument();
  });

  it("impor gagal: error tampil", async () => {
    api.overview.mockResolvedValue(overview());
    api.importPdf.mockRejectedValue({ code: "pdf_invalid", message: "Isi file bukan PDF yang bisa dibaca." });
    const user = userEvent.setup();
    render(<SignScreen />);
    await screen.findByRole("button", { name: "Pilih PDF untuk ditandatangani" });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(input, pdfFile(PDF_BYTES, "Rusak Uji.pdf"));
    expect(await screen.findByText("Isi file bukan PDF yang bisa dibaca.")).toBeInTheDocument();
    expect(screen.getByText("PDF belum bisa dibuka")).toBeInTheDocument();
  });

  it("PDF berkata sandi pemilik ditolak sebelum diimpor", async () => {
    api.overview.mockResolvedValue(overview());
    const user = userEvent.setup();
    render(<SignScreen />);
    await screen.findByRole("button", { name: "Pilih PDF untuk ditandatangani" });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(input, pdfFile(ENCRYPTED_BYTES, "Terkunci Uji.pdf"));
    expect(await screen.findByText(/PDF ini dilindungi kata sandi pemilik/)).toBeInTheDocument();
    expect(screen.getByText("PDF belum bisa dibuka")).toBeInTheDocument();
    expect(api.importPdf).not.toHaveBeenCalled();
  });

  it("PDF rusak ditolak sebelum diimpor", async () => {
    api.overview.mockResolvedValue(overview());
    const user = userEvent.setup();
    render(<SignScreen />);
    await screen.findByRole("button", { name: "Pilih PDF untuk ditandatangani" });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(input, new File(["%PDF-1.7 sampah"], "Rusak Uji.pdf", { type: "application/pdf" }));
    expect(await screen.findByText(/PDF ini rusak atau formatnya tidak didukung/)).toBeInTheDocument();
    expect(api.importPdf).not.toHaveBeenCalled();
  });

  it("tombol Periksa file PDF membuka dialog periksa", async () => {
    api.overview.mockResolvedValue(overview());
    const user = userEvent.setup();
    render(<SignScreen />);
    await user.click(await screen.findByRole("button", { name: "Periksa file PDF" }));
    expect(screen.getByRole("dialog", { name: "Periksa file PDF" })).toBeInTheDocument();
  });

  it("waitingRequests: hanya dari rekan, giliran saya dulu, lalu menunggu orang lain", () => {
    const list = [
      summary({ id: "w1", fromPeer: true, myState: "waiting_others", updatedAt: "2026-11-22T09:00:00Z" }),
      summary({ id: "w2", fromPeer: true, myState: "your_turn", fileAvailable: false, updatedAt: "2026-11-22T08:00:00Z" }),
      summary({ id: "w3", fromPeer: true, myState: "your_turn", updatedAt: "2026-11-21T08:00:00Z" }),
      summary({ id: "w4", fromPeer: false, myState: "your_turn" }),
      summary({ id: "w5", fromPeer: true, myState: "signed" }),
      summary({ id: "w6", fromPeer: true, myState: "your_turn", status: "cancelled" }),
      summary({ id: "w7", fromPeer: true, myState: "not_involved" }),
    ];
    expect(waitingRequests(list).map((r) => r.id)).toEqual(["w3", "w2", "w1"]);
  });
});

describe("SignScreen: permintaan dari rekan", () => {
  const fromRekan = (extra: Partial<RequestSummary>) =>
    summary({ fromPeer: true, requestedByName: "Rekan Pengirim", ...extra });

  it("Menunggu tanda tangan: giliran Anda di atas, nama peminta tampil, tidak ganda di Dokumen", async () => {
    api.overview.mockResolvedValue(
      overview({
        requests: [
          fromRekan({ id: "r1", title: "Menunggu Rekan Uji", myState: "waiting_others", updatedAt: "2026-11-22T09:00:00Z" }),
          fromRekan({ id: "r2", title: "Giliran Rekan Uji", myState: "your_turn", updatedAt: "2026-11-20T09:00:00Z" }),
          summary({ id: "r3", title: "Milik Saya Uji" }),
          fromRekan({ id: "r4", title: "Sudah Saya Uji", myState: "signed" }),
        ],
      }),
    );
    render(<SignScreen />);
    const wait = await screen.findByRole("region", { name: "Menunggu tanda tangan" });
    const titles = within(wait)
      .getAllByRole("listitem")
      .map((li) => li.querySelector(".sign-row-title")?.textContent);
    expect(titles).toEqual(["Giliran Rekan Uji", "Menunggu Rekan Uji"]);
    expect(within(wait).getAllByText("Diminta oleh Rekan Pengirim")).toHaveLength(2);
    expect(
      within(wait).getByRole("button", { name: /Giliran Rekan Uji.*Diminta oleh Rekan Pengirim.*Giliran Anda/ }),
    ).toBeInTheDocument();

    const docs = screen.getByRole("region", { name: "Dokumen" });
    expect(within(docs).queryByText("Giliran Rekan Uji")).not.toBeInTheDocument();
    expect(within(docs).getByText("Milik Saya Uji")).toBeInTheDocument();
    // Permintaan rekan yang sudah saya tanda tangani tetap di Dokumen, dengan nama pemintanya.
    expect(within(docs).getByText("Sudah Saya Uji")).toBeInTheDocument();
    expect(within(docs).getByText("Diminta oleh Rekan Pengirim")).toBeInTheDocument();
    expect(screen.getByText("1 dokumen menunggu tanda tangan Anda")).toBeInTheDocument();
  });

  it("tanpa permintaan dari rekan, bagian Menunggu tanda tangan tidak tampil", async () => {
    api.overview.mockResolvedValue(overview({ requests: [summary({ title: "Milik Saya Uji" })] }));
    render(<SignScreen />);
    await screen.findByText("Milik Saya Uji");
    expect(screen.queryByText("Menunggu tanda tangan")).not.toBeInTheDocument();
  });

  it("file kecil yang belum tersalin: status tenang, tanpa tombol, tanpa peringatan file hilang", async () => {
    api.overview.mockResolvedValue(
      overview({
        requests: [
          fromRekan({ id: "k1", title: "Kecil Uji", myState: "your_turn", fileAvailable: false, integrity: "missing" }),
        ],
      }),
    );
    render(<SignScreen />);
    const wait = await screen.findByRole("region", { name: "Menunggu tanda tangan" });
    expect(within(wait).getByText("File sedang disalin dari laptop rekan")).toBeInTheDocument();
    expect(within(wait).getByText("Menunggu file")).toBeInTheDocument();
    expect(within(wait).queryByRole("button", { name: /^Unduh file/ })).not.toBeInTheDocument();
    expect(screen.queryByText(integrityLabel("missing"))).not.toBeInTheDocument();
    expect(screen.queryByText(/perlu diperiksa/)).not.toBeInTheDocument();
    // Belum bisa ditandatangani, jadi belum dihitung menunggu tanda tangan Anda.
    expect(screen.queryByText(/menunggu tanda tangan Anda/)).not.toBeInTheDocument();
  });

  it("file besar: Unduh file sibuk, lalu berhasil dan fokus ke baris", async () => {
    const big = 32 * 1024 * 1024;
    const before = fromRekan({ id: "b1", title: "Besar Uji", myState: "your_turn", fileAvailable: false, integrity: "missing", fileSize: big });
    api.overview.mockResolvedValue(overview({ requests: [before] }));
    let finish: (d: RequestDetail) => void = () => {};
    api.downloadFile.mockImplementation(() => new Promise<RequestDetail>((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    render(<SignScreen />);

    expect(
      await screen.findByText("File 32 MB belum diunduh. File di atas 20 MB tidak disalin otomatis."),
    ).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Unduh file Besar Uji, 32 MB" });
    expect(button).toHaveTextContent("Unduh file (32 MB)");
    await user.click(button);
    expect(api.downloadFile).toHaveBeenCalledWith("b1");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveTextContent("Mengunduh...");
    expect(button).toHaveFocus();
    await user.click(button);
    expect(api.downloadFile).toHaveBeenCalledTimes(1);

    api.overview.mockResolvedValue(overview({ requests: [{ ...before, fileAvailable: true, integrity: "intact" }] }));
    await act(async () => finish({ id: "b1" } as RequestDetail));
    expect(await screen.findByText("File Besar Uji sudah ada di laptop ini.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Unduh file/ })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: /^Besar Uji/ })).toHaveFocus());
  });

  it("unduh gagal karena tidak ada rekan yang menyimpan file: pesan dengan kata biasa", async () => {
    api.overview.mockResolvedValue(
      overview({
        requests: [fromRekan({ id: "b2", title: "Besar Uji", fileAvailable: false, integrity: "missing", fileSize: 25 * 1024 * 1024 })],
      }),
    );
    api.downloadFile.mockRejectedValue({ code: "not_available", message: "no peer" });
    const user = userEvent.setup();
    render(<SignScreen />);
    await user.click(await screen.findByRole("button", { name: /^Unduh file Besar Uji/ }));
    expect(await screen.findByText("File belum bisa diunduh")).toBeInTheDocument();
    expect(screen.getByText(/^Belum ada laptop rekan yang tersambung dan menyimpan file ini\./)).toBeInTheDocument();
    expect(screen.queryByText("no peer")).not.toBeInTheDocument();
  });

  it("event mira://feature memuat ulang hanya untuk topik sign", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    api.overview.mockResolvedValue(overview());
    render(<SignScreen />);
    await screen.findByText(/Belum ada dokumen/);
    await waitFor(() => expect(tauriEvent.handlers.some((h) => h.event === "mira://feature")).toBe(true));
    const emit = (topic: string) =>
      act(() => {
        for (const h of tauriEvent.handlers.filter((x) => x.event === "mira://feature")) h.fn({ payload: { topic } });
      });
    const calls = api.overview.mock.calls.length;

    emit("docs");
    emit("board");
    await act(async () => {});
    expect(api.overview.mock.calls.length).toBe(calls);

    api.overview.mockResolvedValue(overview({ requests: [fromRekan({ title: "Baru dari Rekan Uji", myState: "your_turn" })] }));
    emit("sign");
    expect(await screen.findByText("Baru dari Rekan Uji")).toBeInTheDocument();
    expect(api.overview.mock.calls.length).toBe(calls + 1);
  });

  it("sortRequests tidak mengubah array asal", () => {
    const list = [summary({ id: "x", status: "completed" }), summary({ id: "y", myState: "your_turn" })];
    expect(sortRequests(list).map((r) => r.id)).toEqual(["y", "x"]);
    expect(list.map((r) => r.id)).toEqual(["x", "y"]);
  });
});
