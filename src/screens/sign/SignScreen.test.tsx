import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Candidate, RequestDetail, RequestSummary, SignOverview } from "../../api/signing";
import { SignScreen, sortRequests } from "./SignScreen";

const api = vi.hoisted(() => ({
  overview: vi.fn(),
  saveSignature: vi.fn(),
  deleteSignature: vi.fn(),
  importPdf: vi.fn(),
  listCandidates: vi.fn(),
  createRequest: vi.fn(),
  verifyFile: vi.fn(),
}));
vi.mock("../../api/signing", async (orig) => ({
  ...(await orig<typeof import("../../api/signing")>()),
  signingApi: api,
}));

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
};

const candidates: Candidate[] = [
  { publicKey: ME_KEY, displayName: "Penguji", kind: "member", isMe: true },
  { publicKey: KEY_B, displayName: "Anggota Uji", kind: "member", isMe: false },
];

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listCandidates.mockResolvedValue(candidates);
});

describe("SignScreen: keadaan dasar", () => {
  it("memuat, lalu keadaan kosong untuk anggota", async () => {
    api.overview.mockResolvedValue(overview());
    render(<SignScreen />);
    expect(screen.getByText("Memuat tanda tangan dan daftar dokumen...")).toBeInTheDocument();
    expect(await screen.findByText(/Belum ada dokumen. Pilih PDF/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pilih PDF untuk ditandatangani" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buat tanda tangan" })).toBeInTheDocument();
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
    expect(await screen.findByText(/Tamu tidak bisa meminta tanda tangan/)).toBeInTheDocument();
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

  it("menghapus tanda tangan dengan konfirmasi yang menjelaskan jalan keluar lupa PIN", async () => {
    api.overview.mockResolvedValueOnce(overview({ saved }));
    api.overview.mockResolvedValue(overview());
    api.deleteSignature.mockResolvedValue(null);
    const user = userEvent.setup();
    render(<SignScreen />);
    await user.click(await screen.findByRole("button", { name: "Hapus tanda tangan" }));
    const dialog = screen.getByRole("dialog", { name: "Hapus tanda tangan tersimpan?" });
    expect(within(dialog).getByText(/Gambar tanda tangan dan PIN-nya dihapus/)).toBeInTheDocument();
    expect(within(dialog).getByText(/kalau Anda lupa PIN/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Batal" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Hapus tanda tangan" }));
    expect(api.deleteSignature).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Buat tanda tangan" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Buat tanda tangan" })).toHaveFocus());
  });

  it("gagal menghapus: error tampil di dialog", async () => {
    api.overview.mockResolvedValue(overview({ saved }));
    api.deleteSignature.mockRejectedValue({ code: "database", message: "Database terkunci." });
    const user = userEvent.setup();
    render(<SignScreen />);
    await user.click(await screen.findByRole("button", { name: "Hapus tanda tangan" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Hapus tanda tangan" }));
    expect(await within(dialog).findByText("Database terkunci.")).toBeInTheDocument();
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
    expect(await screen.findByText("Isi file berubah sejak ditandatangani")).toBeInTheDocument();
    expect(screen.getByText("File hilang dari penyimpanan Mira")).toBeInTheDocument();
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
    await user.upload(input, new File(["%PDF-1.7 uji"], "Kontrak Uji.pdf", { type: "application/pdf" }));
    expect(api.importPdf).toHaveBeenCalledWith(expect.any(Uint8Array), "Kontrak Uji.pdf");
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
    await user.upload(input, new File(["bukan"], "Rusak Uji.pdf", { type: "application/pdf" }));
    expect(await screen.findByText("Isi file bukan PDF yang bisa dibaca.")).toBeInTheDocument();
    expect(screen.getByText("PDF belum bisa dibuka")).toBeInTheDocument();
  });

  it("tombol Periksa file PDF membuka dialog periksa", async () => {
    api.overview.mockResolvedValue(overview());
    const user = userEvent.setup();
    render(<SignScreen />);
    await user.click(await screen.findByRole("button", { name: "Periksa file PDF" }));
    expect(screen.getByRole("dialog", { name: "Periksa file PDF" })).toBeInTheDocument();
  });

  it("sortRequests tidak mengubah array asal", () => {
    const list = [summary({ id: "x", status: "completed" }), summary({ id: "y", myState: "your_turn" })];
    expect(sortRequests(list).map((r) => r.id)).toEqual(["y", "x"]);
    expect(list.map((r) => r.id)).toEqual(["x", "y"]);
  });
});
