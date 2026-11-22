import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PdfViewer } from "./PdfViewer";
import type { PageGeometry } from "./types";

// pdf.js tidak dimuat di jsdom: dokumen tiruan dua halaman, render langsung selesai.
// Halaman pertama ber-/Rotate 45 seperti yang dibaca mentah, untuk memeriksa normalisasi.
vi.mock("./pdfjs", () => {
  const page = (rotate: number) => ({
    view: [0, 0, 600, 800],
    rotate,
    userUnit: 1,
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
  });
  return {
    loadPdf: vi.fn(async () => ({
      doc: { numPages: 2, getPage: async (n: number) => page(n === 1 ? 45 : 90) },
      destroy: async () => {},
    })),
    describePdfError: () => ({ title: "Galat uji", detail: "Rincian uji" }),
    isRenderCancelled: () => false,
  };
});

const DATA = new Uint8Array([1]);

async function setup() {
  const onLoaded = vi.fn();
  const user = userEvent.setup();
  render(<PdfViewer data={DATA} label="Uji.pdf" onLoaded={onLoaded} />);
  await waitFor(() => expect(onLoaded).toHaveBeenCalled());
  return { user, onLoaded };
}

describe("PdfViewer", () => {
  it("rotasi bukan kelipatan 90 dianggap 0", async () => {
    const { onLoaded } = await setup();
    const pages = onLoaded.mock.calls[0][0].pages as PageGeometry[];
    expect(pages.map((p) => p.rotation)).toEqual([0, 90]);
  });

  it("tombol di batas halaman memakai aria-disabled, fokus tetap di tombol", async () => {
    const { user } = await setup();
    const prev = screen.getByRole("button", { name: "Sebelumnya" });
    const next = screen.getByRole("button", { name: "Berikutnya" });
    expect(prev).toHaveAttribute("aria-disabled", "true");
    expect(prev).toBeEnabled();
    expect(prev).toHaveAttribute("title", "Halaman sebelumnya");

    await user.click(next);
    expect(screen.getByRole("group", { name: "Halaman 2 dari 2" })).toBeInTheDocument();
    expect(next).toHaveAttribute("aria-disabled", "true");
    expect(next).toHaveFocus();
    expect(prev).not.toHaveAttribute("aria-disabled");

    // Enter di tombol yang sudah di batas tidak berbuat apa-apa dan fokus tidak lepas.
    await user.keyboard("{Enter}");
    expect(screen.getByRole("group", { name: "Halaman 2 dari 2" })).toBeInTheDocument();
    expect(next).toHaveFocus();
  });

  it("tombol zoom di batas memakai aria-disabled dan tidak mengubah skala", async () => {
    const { user } = await setup();
    // jsdom tidak punya lebar area, jadi "Sesuai lebar" jatuh ke skala terkecil 25%.
    const out = screen.getByRole("button", { name: "Perkecil" });
    expect(out).toHaveAttribute("aria-disabled", "true");
    out.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Perbesaran 25 persen")).toBeInTheDocument();
    expect(out).toHaveFocus();

    const zoomIn = screen.getByRole("button", { name: "Perbesar" });
    for (let i = 0; i < 12; i++) await user.click(zoomIn);
    expect(screen.getByLabelText("Perbesaran 400 persen")).toBeInTheDocument();
    expect(zoomIn).toHaveAttribute("aria-disabled", "true");
    expect(zoomIn).toHaveFocus();
    expect(out).not.toHaveAttribute("aria-disabled");
  });
});
