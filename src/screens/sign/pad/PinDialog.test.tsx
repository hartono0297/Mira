import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PinDialog } from "./PinDialog";
import { lockMinutesFromMessage, validatePin } from "./pin";

function setup(onSubmit: (pin: string) => Promise<void>, extra: { lockedUntil?: string | null } = {}) {
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

  it("pin_locked: tombol nonaktif dan pesan menjelaskan kapan bisa mencoba lagi", async () => {
    const message = "Terlalu banyak PIN salah. Coba lagi sekitar 5 menit lagi.";
    const onSubmit = vi.fn().mockRejectedValue({ code: "pin_locked", message });
    const { user, input } = setup(onSubmit);
    await user.type(input(), "999999{Enter}");

    const alert = screen.getByRole("alert");
    await waitFor(() => expect(alert).toHaveTextContent(message));
    expect(alert).toHaveTextContent(/Bisa dicoba lagi sekitar pukul \d{2}\.\d{2}\./);
    expect(screen.getByRole("button", { name: "Tanda tangani" })).toBeDisabled();

    await user.type(input(), "123456{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("lockedUntil di masa depan membuka dialog dalam keadaan terkunci", () => {
    const until = new Date(Date.now() + 5 * 60_000).toISOString();
    setup(vi.fn(), { lockedUntil: until });
    expect(screen.getByRole("button", { name: "Tanda tangani" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/dicoba lagi pukul \d{2}\.\d{2}\./);
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
