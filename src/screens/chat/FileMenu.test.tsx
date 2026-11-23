import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileView } from "../../api/chat";
import { file } from "./conversationTestData";
import { FileCard } from "./FileCard";

const chat = vi.hoisted(() => ({
  fileOpen: vi.fn(),
  fileSave: vi.fn(),
  fileDownload: vi.fn(),
}));

vi.mock("../../api/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/chat")>()),
  chatApi: chat,
}));

const HASH = "f".repeat(64);

function renderCard(extra: Partial<FileView> = {}) {
  const onDownloaded = vi.fn();
  const onAnnounce = vi.fn();
  render(<FileCard messageId="m1" file={file(extra)} onDownloaded={onDownloaded} onAnnounce={onAnnounce} />);
  return { onDownloaded, onAnnounce, card: screen.getByText("kontrak-draft.pdf") };
}

const itemNames = () => screen.getAllByRole("menuitem").map((m) => m.textContent);

beforeEach(() => {
  chat.fileOpen.mockResolvedValue(null);
  chat.fileSave.mockResolvedValue(true);
  chat.fileDownload.mockResolvedValue(file({ state: "local" }));
});

describe("Menu lampiran", () => {
  it("file di laptop ini: Buka, Simpan salinan, Salin nama file", async () => {
    const user = userEvent.setup();
    const { card } = renderCard();
    fireEvent.contextMenu(card);
    expect(screen.getByRole("menu", { name: "Aksi untuk kontrak-draft.pdf" })).toBeInTheDocument();
    expect(itemNames()).toEqual(["Buka", "Simpan salinan", "Salin nama file"]);
    await user.click(screen.getByRole("menuitem", { name: "Buka" }));
    expect(chat.fileOpen).toHaveBeenCalledWith("m1", HASH);
    fireEvent.contextMenu(card);
    await user.click(screen.getByRole("menuitem", { name: "Simpan salinan" }));
    expect(chat.fileSave).toHaveBeenCalledWith(HASH);
    expect(await screen.findByText("kontrak-draft.pdf tersimpan.")).toBeInTheDocument();
  });

  it("file di laptop rekan: Unduh dari rekan dengan ukuran", async () => {
    const user = userEvent.setup();
    const { card, onDownloaded } = renderCard({ state: "remote" });
    fireEvent.contextMenu(card);
    expect(itemNames()).toEqual([expect.stringMatching(/^Unduh dari rekan \(1[.,]2 MB\)$/), "Salin nama file"]);
    await user.click(screen.getByRole("menuitem", { name: /Unduh dari rekan/ }));
    expect(chat.fileDownload).toHaveBeenCalledWith(HASH);
    await vi.waitFor(() => expect(onDownloaded).toHaveBeenCalledTimes(1));
  });

  it.each(["missing", "fetching"] as const)("file %s: hanya Salin nama file, tombol ... tetap ada", async (state) => {
    const user = userEvent.setup();
    renderCard({ state });
    await user.click(screen.getByRole("button", { name: "Aksi lain untuk kontrak-draft.pdf" }));
    expect(itemNames()).toEqual(["Salin nama file"]);
  });

  it("selama aksi berjalan, aksi file lain nonaktif dengan alasan", async () => {
    const user = userEvent.setup();
    chat.fileOpen.mockReturnValue(new Promise(() => {}));
    const { card } = renderCard();
    await user.click(screen.getByRole("button", { name: "Buka kontrak-draft.pdf" }));
    fireEvent.contextMenu(card);
    const open = screen.getByRole("menuitem", { name: "Buka" });
    expect(open).toHaveAttribute("aria-disabled", "true");
    expect(open).toHaveAccessibleDescription("Tunggu aksi lain selesai");
    expect(screen.getByRole("menuitem", { name: "Simpan salinan" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: "Salin nama file" })).not.toHaveAttribute("aria-disabled");
    await user.click(open);
    expect(chat.fileOpen).toHaveBeenCalledTimes(1);
  });

  it("Salin nama file menyalin dan mengumumkan hasilnya", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText, readText: vi.fn() }, configurable: true });
    const { card, onAnnounce } = renderCard();
    fireEvent.contextMenu(card);
    await user.click(screen.getByRole("menuitem", { name: "Salin nama file" }));
    expect(writeText).toHaveBeenCalledWith("kontrak-draft.pdf");
    await vi.waitFor(() => expect(onAnnounce).toHaveBeenCalledWith("Nama kontrak-draft.pdf disalin."));
  });

  it("tombol ... dengan keyboard: Enter membuka, Esc menutup dan fokus kembali", async () => {
    const user = userEvent.setup();
    renderCard();
    const more = screen.getByRole("button", { name: "Aksi lain untuk kontrak-draft.pdf" });
    more.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menuitem", { name: "Buka" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Simpan salinan" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(more).toHaveFocus();
  });
});
