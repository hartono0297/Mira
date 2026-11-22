import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifyResult } from "../../api/signing";
import { VerifyDialog } from "./VerifyDialog";

const api = vi.hoisted(() => ({ verifyFile: vi.fn() }));
vi.mock("../../api/signing", async (orig) => ({
  ...(await orig<typeof import("../../api/signing")>()),
  signingApi: api,
}));

// Data uji: judul dan nama jelas buatan.
const HASH = "0123456789abcdef".repeat(4);

function result(extra: Partial<VerifyResult>): VerifyResult {
  return {
    state: "unknown",
    fileHash: HASH,
    requestId: null,
    title: null,
    completedAt: null,
    signers: [],
    ...extra,
  };
}

async function check(res: VerifyResult, onOpenRequest = vi.fn()) {
  api.verifyFile.mockResolvedValueOnce(res);
  const user = userEvent.setup();
  render(<VerifyDialog open onOpenChange={vi.fn()} onOpenRequest={onOpenRequest} />);
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("input file tidak ada");
  await user.upload(input, new File(["%PDF-1.7 uji"], "Hasil Uji.pdf", { type: "application/pdf" }));
  return { user, onOpenRequest };
}

beforeEach(() => {
  api.verifyFile.mockReset();
});

describe("VerifyDialog", () => {
  it("match_final: asli, judul, waktu selesai, penanda tangan, hash 16 karakter", async () => {
    const { user, onOpenRequest } = await check(
      result({
        state: "match_final",
        requestId: "r1",
        title: "Dokumen Uji",
        completedAt: "2026-11-22T08:00:00Z",
        signers: [
          { displayName: "Penguji", signedAt: "2026-11-22T07:00:00Z" },
          { displayName: "Anggota Uji", signedAt: "2026-11-22T08:00:00Z" },
        ],
      }),
    );
    expect(await screen.findByText(/File ini asli: sama persis/)).toBeInTheDocument();
    expect(api.verifyFile.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
    expect(screen.getByText("Dokumen Uji")).toBeInTheDocument();
    expect(screen.getByText(/Selesai 22 November 2026/)).toBeInTheDocument();
    expect(screen.getByText("Anggota Uji")).toBeInTheDocument();
    expect(screen.getByText("0123456789abcdef")).toHaveClass("mono");
    expect(screen.getByRole("button", { name: "Periksa file lain" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Buka dokumen" }));
    expect(onOpenRequest).toHaveBeenCalledWith("r1");
  });

  it("match_version: versi tercatat, belum final", async () => {
    await check(
      result({
        state: "match_version",
        requestId: "r1",
        title: "Dokumen Uji",
        signers: [{ displayName: "Anggota Uji", signedAt: null }],
      }),
    );
    expect(await screen.findByText(/sama dengan salah satu versi yang tercatat, tetapi belum versi final/)).toBeInTheDocument();
    expect(screen.getByText("Belum menandatangani")).toBeInTheDocument();
  });

  it("changed: peringatan, judul dokumen asli, saran salinan Mira", async () => {
    await check(result({ state: "changed", requestId: "r1", title: "Dokumen Uji" }));
    expect(await screen.findByText("File ini berubah setelah ditandatangani di Mira")).toBeInTheDocument();
    expect(screen.getByText("Dokumen aslinya: Dokumen Uji")).toBeInTheDocument();
    expect(screen.getByText(/Pakai salinan yang disimpan dari Mira/)).toBeInTheDocument();
  });

  it("unknown: tidak dikenali, tanpa tombol buka dokumen", async () => {
    await check(result({ state: "unknown" }));
    expect(await screen.findByText("Mira di laptop ini tidak mengenali file ini")).toBeInTheDocument();
    expect(screen.getByText(/pengiriman lewat jaringan belum tersedia/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Buka dokumen" })).not.toBeInTheDocument();
  });

  it("error inti dan file bukan PDF ditampilkan", async () => {
    api.verifyFile.mockRejectedValueOnce({ code: "pdf_too_large", message: "Ukuran PDF melebihi batas 50 MB." });
    const user = userEvent.setup();
    render(<VerifyDialog open onOpenChange={vi.fn()} />);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(input, new File(["%PDF"], "Besar Uji.pdf", { type: "application/pdf" }));
    expect(await screen.findByText("Ukuran PDF melebihi batas 50 MB.")).toBeInTheDocument();

    fireEvent.change(input, { target: { files: [new File(["x"], "catatan.txt", { type: "text/plain" })] } });
    expect(await screen.findByText(/File ini bukan PDF/)).toBeInTheDocument();
    expect(api.verifyFile).toHaveBeenCalledTimes(1);
  });
});
