import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatApi } from "../../api/chat";
import {
  clearStickerImageCache,
  loadStickerImage,
  STICKER_CACHE_MAX_CHARS,
  StickerImage,
} from "./StickerImage";

afterEach(() => clearStickerImageCache());

describe("StickerImage", () => {
  it("menampilkan gambar dari URL data: yang diberikan inti Rust", async () => {
    vi.spyOn(chatApi, "stickerImage").mockResolvedValue("data:image/png;base64,AAAA");
    render(<StickerImage hash={"a".repeat(64)} alt=":kopi:" size="large" />);
    await waitFor(() => expect(screen.getByRole("img", { name: ":kopi:" }).tagName).toBe("IMG"));
    expect(screen.getByRole("img", { name: ":kopi:" }).getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  it("belum ready: teks pengganti terlihat tanpa meminta gambar", () => {
    const spy = vi.spyOn(chatApi, "stickerImage");
    render(<StickerImage hash={"b".repeat(64)} alt=":kopi:" size="large" ready={false} />);
    expect(screen.getByRole("img", { name: ":kopi:" }).textContent).toBe(":kopi:");
    expect(spy).not.toHaveBeenCalled();
  });

  it("alt kosong: tempat kosong disembunyikan dari pembaca layar", () => {
    const { container } = render(<StickerImage hash={"c".repeat(64)} alt="" size="thumb" ready={false} />);
    expect(container.querySelector("[aria-hidden='true']")).not.toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("gagal memuat: teks pengganti", async () => {
    vi.spyOn(chatApi, "stickerImage").mockRejectedValue(new Error("tidak lolos"));
    render(<StickerImage hash={"d".repeat(64)} alt=":rusak:" size="inline" />);
    await waitFor(() => expect(screen.getByRole("img", { name: ":rusak:" }).tagName).toBe("SPAN"));
  });

  it("cache dibatasi ukurannya: yang paling lama tidak dipakai dibuang dulu", async () => {
    const big = "x".repeat(Math.floor(STICKER_CACHE_MAX_CHARS / 2) - 10);
    const spy = vi.spyOn(chatApi, "stickerImage").mockImplementation(async (h: string) => `${h}${big}`);
    await loadStickerImage("1");
    await loadStickerImage("2");
    await loadStickerImage("1"); // 1 baru dipakai, jadi 2 yang paling lama
    await loadStickerImage("3"); // melewati batas: 2 dibuang
    expect(spy).toHaveBeenCalledTimes(3);
    await loadStickerImage("1");
    expect(spy).toHaveBeenCalledTimes(3);
    await loadStickerImage("2");
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("permintaan bersamaan untuk hash yang sama hanya memanggil inti sekali", async () => {
    const spy = vi.spyOn(chatApi, "stickerImage").mockResolvedValue("data:image/gif;base64,R0lG");
    await Promise.all([loadStickerImage("e"), loadStickerImage("e")]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
