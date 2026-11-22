import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { PinDialog, isLockMessage } from "./PinDialog";
import { lockMinutesFromMessage, validatePin } from "./pin";

type Extra = { lockedUntil?: string | null; usableAfter?: string | null; extraAction?: ReactNode; danger?: boolean };

// Jam dan zona, mis. "15.04 WIB" atau "08.04 UTC", tergantung zona mesin tes.
const CLOCK = String.raw`\d{2}\.\d{2} (WIB|WITA|WIT|UTC\S*)`;

function setup(onSubmit: (pin: string) => Promise<void>, extra: Extra = {}) {
  const onOpenChange = vi.fn();
  const user = userEvent.setup();
  render(<PinDialog open onOpenChange={onOpenChange} onSubmit={onSubmit} submitLabel="Tanda tangani" {...extra} />);
  return { user, onOpenChange, input: () => screen.getByLabelText("PIN tanda tangan") };
}

describe("PinDialog", () => {
  it("Enter mengirim PIN lalu dialog ditutup", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { user, onOpenChange, input } = setup(onSubmit);
    expect(input()).toHaveFocus();
    await user.type(input(), "135790{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("135790");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("memeriksa format sebelum memanggil onSubmit", async () => {
    const onSubmit = vi.fn();
    const { user, input } = setup(onSubmit);
    await user.type(input(), "12a{Enter}");
    expect(await screen.findByText("PIN hanya boleh berisi angka 0 sampai 9.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tanda tangani" }));
    expect(input()).toHaveAttribute("aria-invalid", "true");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("pin_wrong: pesan dibacakan, isian dikosongkan dan difokus lagi", async () => {
    const onSubmit = vi.fn().mockRejectedValue({ code: "pin_wrong", message: "PIN salah. Sisa 4 percobaan." });
    const { user, onOpenChange, input } = setup(onSubmit);
    await user.type(input(), "111111{Enter}");

    const alert = screen.getByRole("alert");
    await waitFor(() => expect(alert).toHaveTextContent("PIN salah. Sisa 4 percobaan."));
    expect(input()).toHaveValue("");
    await waitFor(() => expect(input()).toHaveFocus());
    expect(input()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Tanda tangani" })).toBeEnabled();
    expect(onOpenChange).not.toHaveBeenCalled();

    onSubmit.mockRejectedValueOnce({ code: "pin_wrong", message: "PIN salah. Sisa 3 percobaan." });
    await user.type(input(), "222222{Enter}");
    await waitFor(() => expect(alert).toHaveTextContent("Sisa 3 percobaan."));
    expect(onSubmit).toHaveBeenLastCalledWith("222222");
  });

  it("pin_locked: tombol nonaktif, satu pesan dengan jam dan zona", async () => {
    const message = "Terlalu banyak PIN salah. Coba lagi dalam sekitar 5 menit.";
    const onSubmit = vi.fn().mockRejectedValue({ code: "pin_locked", message });
    const { user, input } = setup(onSubmit);
    await user.type(input(), "999999{Enter}");

    const alert = screen.getByRole("alert");
    await waitFor(() =>
      expect(alert.textContent).toMatch(new RegExp(`^Terlalu banyak PIN salah\\. Coba lagi pukul ${CLOCK}\\.$`)),
    );
    expect(screen.getByRole("button", { name: "Tanda tangani" })).toBeDisabled();

    await user.type(input(), "123456{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("pin_wrong yang menyebut dikunci diperlakukan seperti pin_locked", async () => {
    const onSubmit = vi.fn().mockRejectedValue({
      code: "pin_wrong",
      message: "PIN salah. Tanda tangan dikunci sementara, coba lagi dalam sekitar 1 menit.",
    });
    const { user, input } = setup(onSubmit);
    await user.type(input(), "999999{Enter}");
    const alert = screen.getByRole("alert");
    await waitFor(() => expect(alert.textContent).toMatch(new RegExp(`Coba lagi pukul ${CLOCK}\\.$`)));
    expect(screen.getByRole("button", { name: "Tanda tangani" })).toBeDisabled();
    expect(input()).not.toHaveAttribute("aria-invalid");
  });

  it("isLockMessage membedakan kunci dari peringatan sisa percobaan", () => {
    expect(isLockMessage("PIN salah. Tanda tangan dikunci sementara, coba lagi dalam sekitar 1 menit.")).toBe(true);
    expect(isLockMessage("PIN salah. Sisa 2 kali lagi sebelum dikunci sementara.")).toBe(false);
    expect(isLockMessage("PIN salah. Sisa 4 percobaan.")).toBe(false);
  });

  it("pin_wrong dengan sisa percobaan tidak mengunci", async () => {
    const onSubmit = vi.fn().mockRejectedValue({
      code: "pin_wrong",
      message: "PIN salah. Sisa 2 kali lagi sebelum dikunci sementara.",
    });
    const { user, input } = setup(onSubmit);
    await user.type(input(), "999999{Enter}");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Sisa 2 kali lagi"));
    expect(screen.getByRole("button", { name: "Tanda tangani" })).toBeEnabled();
  });

  it("lockedUntil di masa depan membuka dialog dalam keadaan terkunci", () => {
    const until = new Date(Date.now() + 5 * 60_000).toISOString();
    setup(vi.fn(), { lockedUntil: until });
    expect(screen.getByRole("button", { name: "Tanda tangani" })).toBeDisabled();
    expect(screen.getByRole("alert").textContent).toMatch(new RegExp(`^Terlalu banyak PIN salah\\. Coba lagi pukul ${CLOCK}\\.$`));
  });

  it("signature_cooling: pesan dari inti, tombol nonaktif", async () => {
    const message = "Tanda tangan ini baru bisa dipakai 24 jam setelah tanda tangan lama dihapus tanpa PIN.";
    const onSubmit = vi.fn().mockRejectedValue({ code: "signature_cooling", message });
    const { user, input } = setup(onSubmit);
    await user.type(input(), "123456{Enter}");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
    expect(screen.getByRole("button", { name: "Tanda tangani" })).toBeDisabled();
    await user.type(input(), "123456{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("usableAfter di masa depan membuka dialog dalam masa tunggu", () => {
    const usableAfter = new Date(Date.now() + 20 * 60 * 60_000).toISOString();
    setup(vi.fn(), { usableAfter });
    expect(screen.getByRole("button", { name: "Tanda tangani" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/Tanda tangan ini baru bisa dipakai mulai .+, 24 jam setelah/);
  });

  it("usableAfter yang sudah lewat diabaikan; aksi tambahan dan tombol bahaya tampil", () => {
    setup(vi.fn(), {
      usableAfter: new Date(Date.now() - 1000).toISOString(),
      extraAction: <button type="button">Lupa PIN?</button>,
      danger: true,
    });
    expect(screen.getByRole("button", { name: "Tanda tangani" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Tanda tangani" })).toHaveClass("btn-danger");
    expect(screen.getByRole("button", { name: "Lupa PIN?" })).toBeInTheDocument();
  });

  it("lockedUntil yang sudah lewat diabaikan", () => {
    setup(vi.fn(), { lockedUntil: new Date(Date.now() - 1000).toISOString() });
    expect(screen.getByRole("button", { name: "Tanda tangani" })).toBeEnabled();
  });

  it("error lain ditampilkan sebagai kotak error tanpa mengunci", async () => {
    const onSubmit = vi.fn().mockRejectedValue({ code: "database", message: "Basis data Mira tidak bisa dibaca." });
    const { user } = setup(onSubmit);
    await user.type(screen.getByLabelText("PIN tanda tangan"), "123456{Enter}");
    expect(await screen.findByText("Basis data Mira tidak bisa dibaca.")).toBeInTheDocument();
    expect(screen.getByText("Belum bisa dilanjutkan")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tanda tangani" })).toBeEnabled();
  });

  it("menampilkan keadaan memeriksa selama onSubmit berjalan", async () => {
    let resolve: () => void = () => {};
    const onSubmit = vi.fn(() => new Promise<void>((res) => (resolve = res)));
    const { user, onOpenChange, input } = setup(onSubmit);
    await user.type(input(), "123456{Enter}");
    expect(screen.getByRole("button", { name: "Memeriksa PIN..." })).toBeDisabled();
    expect(input()).toBeDisabled();
    resolve();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});

describe("pin", () => {
  it("validatePin", () => {
    expect(validatePin("")).toBe("Masukkan PIN Anda.");
    expect(validatePin("12345")).toBe("PIN harus 6 sampai 12 angka.");
    expect(validatePin("1234567890123")).toBe("PIN harus 6 sampai 12 angka.");
    expect(validatePin("12 456")).toBe("PIN hanya boleh berisi angka 0 sampai 9.");
    expect(validatePin("123456")).toBeNull();
    expect(validatePin("123456789012")).toBeNull();
  });

  it("lockMinutesFromMessage", () => {
    expect(lockMinutesFromMessage("Coba lagi sekitar 15 menit lagi.")).toBe(15);
    expect(lockMinutesFromMessage("Tunggu satu menit lalu coba lagi.")).toBe(1);
  });
});
