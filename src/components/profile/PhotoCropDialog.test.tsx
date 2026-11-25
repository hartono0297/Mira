import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PickedPhoto } from "../../api/profile";
import { setLang } from "../../i18n/core";

const profileSetPhoto = vi.fn();
vi.mock("../../api/profile", () => ({
  profileSetPhoto: (...args: unknown[]) => profileSetPhoto(...args),
}));

import { PhotoCropDialog } from "./PhotoCropDialog";

const picked: PickedPhoto = {
  token: "tok-1",
  preview: "AAAA",
  width: 2000,
  height: 1000,
  previewWidth: 1024,
  previewHeight: 512,
};

function setup() {
  const onCancel = vi.fn();
  const onSaved = vi.fn();
  render(<PhotoCropDialog picked={picked} onCancel={onCancel} onSaved={onSaved} />);
  return { onCancel, onSaved, user: userEvent.setup() };
}

beforeEach(() => {
  profileSetPhoto.mockReset();
  profileSetPhoto.mockResolvedValue({ owner: "me", hash: "h1" });
});

describe("PhotoCropDialog", () => {
  it("menampilkan pratinjau sebagai data URL JPEG di area posisi yang bisa difokus", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "Atur foto profil" })).toBeInTheDocument();
    const area = screen.getByRole("group", { name: "Posisi foto" });
    expect(area).toHaveAttribute("tabindex", "0");
    expect(area.querySelector("img")).toHaveAttribute("src", "data:image/jpeg;base64,AAAA");
  });

  it("Simpan memanggil API dengan token dan kotak di tengah dalam piksel sumber", async () => {
    const { onSaved, user } = setup();
    await user.click(screen.getByRole("button", { name: "Simpan foto" }));
    expect(profileSetPhoto).toHaveBeenCalledWith("tok-1", { x: 500, y: 0, size: 1000 });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ owner: "me", hash: "h1" }));
  });

  it("tombol panah menggeser foto ke arah panah", async () => {
    const { user } = setup();
    screen.getByRole("group", { name: "Posisi foto" }).focus();
    await user.keyboard("{ArrowRight}");
    await user.click(screen.getByRole("button", { name: "Simpan foto" }));
    expect(profileSetPhoto).toHaveBeenCalledWith("tok-1", { x: 450, y: 0, size: 1000 });
  });

  it("Shift + panah menggeser lebih jauh", async () => {
    const { user } = setup();
    screen.getByRole("group", { name: "Posisi foto" }).focus();
    await user.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    await user.click(screen.getByRole("button", { name: "Simpan foto" }));
    expect(profileSetPhoto).toHaveBeenCalledWith("tok-1", { x: 750, y: 0, size: 1000 });
  });

  it("slider Perbesar mengubah sisi potong", async () => {
    const { user } = setup();
    const slider = screen.getByRole("slider", { name: "Perbesar" });
    expect(slider).toHaveAttribute("min", "100");
    expect(slider).toHaveAttribute("max", "400");
    fireEvent.change(slider, { target: { value: "200" } });
    await user.click(screen.getByRole("button", { name: "Simpan foto" }));
    expect(profileSetPhoto).toHaveBeenCalledWith("tok-1", { x: 750, y: 250, size: 500 });
  });

  it("tombol perbesar dan perkecil mengubah zoom", async () => {
    const { user } = setup();
    const slider = screen.getByRole("slider", { name: "Perbesar" });
    await user.click(screen.getByRole("button", { name: "Perbesar foto" }));
    expect(Number((slider as HTMLInputElement).value)).toBeGreaterThan(100);
    await user.click(screen.getByRole("button", { name: "Perkecil foto" }));
    expect((slider as HTMLInputElement).value).toBe("100");
  });

  it("slider melangkah 5 persen", () => {
    setup();
    expect(screen.getByRole("slider", { name: "Perbesar" })).toHaveAttribute("step", "5");
  });

  it("geser dan zoom dengan keyboard diumumkan sekali setelah jeda", async () => {
    const { user } = setup();
    screen.getByRole("group", { name: "Posisi foto" }).focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    // Dua langkah, satu pengumuman: posisi akhir 40% dari kiri.
    const live = await screen.findByText("Posisi 40% dari kiri, 50% dari atas");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByText(/Posisi 45%/)).not.toBeInTheDocument();
    await user.keyboard("+");
    expect(await screen.findByText("Perbesaran 125%")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Perkecil foto" }));
    expect(await screen.findByText("Perbesaran 100%")).toBeInTheDocument();
  });

  it("roda mouse memperbesar", () => {
    setup();
    const area = screen.getByRole("group", { name: "Posisi foto" });
    fireEvent.wheel(area, { deltaY: -200 });
    expect(Number((screen.getByRole("slider") as HTMLInputElement).value)).toBeGreaterThan(100);
  });

  it("menyeret foto dengan pointer menggeser kotak potong", async () => {
    const { user } = setup();
    const area = screen.getByRole("group", { name: "Posisi foto" });
    // jsdom tidak punya ukuran tata letak; bingkai dianggap 280 piksel.
    fireEvent.pointerDown(area, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(area, { pointerId: 1, clientX: 128, clientY: 100 });
    fireEvent.pointerUp(area, { pointerId: 1, clientX: 128, clientY: 100 });
    await user.click(screen.getByRole("button", { name: "Simpan foto" }));
    expect(profileSetPhoto).toHaveBeenCalledWith("tok-1", { x: 400, y: 0, size: 1000 });
  });

  it("error dari API tampil di dialog dan dialog tetap terbuka", async () => {
    profileSetPhoto.mockRejectedValue({ code: "invalid_input", message: "Foto yang dipilih sudah kedaluwarsa. Pilih foto lagi." });
    const { onSaved, user } = setup();
    await user.click(screen.getByRole("button", { name: "Simpan foto" }));
    expect(await screen.findByText("Foto yang dipilih sudah kedaluwarsa. Pilih foto lagi.")).toBeInTheDocument();
    expect(screen.getByText("Foto belum tersimpan")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Batal memanggil onCancel", async () => {
    const { onCancel, user } = setup();
    await user.click(screen.getByRole("button", { name: "Batal" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(profileSetPhoto).not.toHaveBeenCalled();
  });

  it("Escape memanggil onCancel", async () => {
    const { onCancel, user } = setup();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("teks bahasa Inggris", () => {
    setLang("en");
    setup();
    expect(screen.getByRole("dialog", { name: "Adjust profile photo" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Photo position" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Zoom" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save photo" })).toBeInTheDocument();
  });
});
