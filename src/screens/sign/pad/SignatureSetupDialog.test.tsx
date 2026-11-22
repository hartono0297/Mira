import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useImperativeHandle, type Ref } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignatureImage } from "./image";
import { SignatureSetupDialog, type SaveSignatureInput } from "./SignatureSetupDialog";
import type { SignaturePadHandle } from "./SignaturePad";

const imageMocks = vi.hoisted(() => ({ importSignatureImage: vi.fn() }));
vi.mock("./image", async (orig) => ({ ...(await orig<typeof import("./image")>()), ...imageMocks }));

// Kanvas tidak menggambar di jsdom: kotak gambar diganti tiruan yang hasil getPng-nya diatur tes.
const pad = vi.hoisted(() => ({ result: null as SignatureImage | null }));
vi.mock("./SignaturePad", () => ({
  SignaturePad: ({ ref }: { ref?: Ref<SignaturePadHandle> }) => {
    useImperativeHandle(ref, () => ({
      getPng: async () => pad.result,
      clear: () => {},
      isEmpty: () => pad.result === null,
    }));
    return <div data-testid="pad" />;
  },
}));

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const IMAGE: SignatureImage = { png: PNG, width: 420, height: 160 };

function setup(onSave: (input: SaveSignatureInput) => Promise<void> = vi.fn().mockResolvedValue(undefined)) {
  const onOpenChange = vi.fn();
  const user = userEvent.setup();
  render(<SignatureSetupDialog open onOpenChange={onOpenChange} onSave={onSave} />);
  return { user, onOpenChange, onSave };
}

async function importFile(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("radio", { name: "Impor gambar" }));
  const file = new File([PNG], "ttd-budi.png", { type: "image/png" });
  await user.upload(screen.getByLabelText("File gambar tanda tangan"), file);
  await screen.findByRole("img", { name: /Pratinjau tanda tangan dari ttd-budi\.png/ });
}

async function fillPins(user: ReturnType<typeof userEvent.setup>, pin: string, repeat: string) {
  if (pin) await user.type(screen.getByLabelText("PIN baru"), pin);
  if (repeat) await user.type(screen.getByLabelText("Ulangi PIN"), repeat);
  await user.click(screen.getByRole("button", { name: "Simpan tanda tangan" }));
}

beforeEach(() => {
  pad.result = null;
  imageMocks.importSignatureImage.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:pratinjau");
  URL.revokeObjectURL = vi.fn();
});

describe("SignatureSetupDialog", () => {
  it("impor gambar, buat PIN, lalu onSave menerima gambar dan PIN", async () => {
    imageMocks.importSignatureImage.mockResolvedValue(IMAGE);
    const { user, onSave, onOpenChange } = setup();

    await importFile(user);
    expect(imageMocks.importSignatureImage).toHaveBeenCalledWith(expect.objectContaining({ name: "ttd-budi.png" }));
    expect(screen.getByText("ttd-budi.png")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Lanjut ke PIN" }));
    expect(screen.getByText("Langkah 2 dari 2: buat PIN")).toBeInTheDocument();
    expect(screen.getByLabelText("PIN baru")).toHaveFocus();
    expect(screen.getByLabelText("PIN baru")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("PIN baru")).toHaveAttribute("inputmode", "numeric");
    expect(screen.getByText(/PIN tidak bisa dipulihkan/)).toBeInTheDocument();

    await fillPins(user, "48151623", "48151623");
    expect(onSave).toHaveBeenCalledWith({ png: PNG, width: 420, height: 160, pin: "48151623" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("menolak PIN yang terlalu pendek atau berisi huruf", async () => {
    imageMocks.importSignatureImage.mockResolvedValue(IMAGE);
    const { user, onSave } = setup();
    await importFile(user);
    await user.click(screen.getByRole("button", { name: "Lanjut ke PIN" }));

    await fillPins(user, "123", "123");
    expect(await screen.findByText("PIN harus 6 sampai 12 angka.")).toBeInTheDocument();
    expect(screen.getByLabelText("PIN baru")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("PIN baru")).toHaveFocus();

    await user.clear(screen.getByLabelText("PIN baru"));
    await user.type(screen.getByLabelText("PIN baru"), "12ab56");
    await user.click(screen.getByRole("button", { name: "Simpan tanda tangan" }));
    expect(await screen.findByText("PIN hanya boleh berisi angka 0 sampai 9.")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("PIN baru"));
    await user.click(screen.getByRole("button", { name: "Simpan tanda tangan" }));
    expect(await screen.findByText("Buat PIN dulu, 6 sampai 12 angka.")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("PIN yang diulang harus sama", async () => {
    imageMocks.importSignatureImage.mockResolvedValue(IMAGE);
    const { user, onSave } = setup();
    await importFile(user);
    await user.click(screen.getByRole("button", { name: "Lanjut ke PIN" }));

    await fillPins(user, "123456", "123457");
    expect(await screen.findByText("PIN yang diulang tidak sama. Ketik ulang PIN yang sama.")).toBeInTheDocument();
    expect(screen.getByLabelText("Ulangi PIN")).toHaveFocus();
    expect(screen.getByLabelText("Ulangi PIN")).toHaveAttribute("aria-invalid", "true");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("menampilkan error impor dari importSignatureImage", async () => {
    imageMocks.importSignatureImage.mockRejectedValue({
      code: "image_invalid",
      message: "Ukuran gambar lebih dari 5 MB. Perkecil gambarnya atau pilih file lain.",
    });
    const { user } = setup();
    await user.click(screen.getByRole("radio", { name: "Impor gambar" }));
    await user.upload(screen.getByLabelText("File gambar tanda tangan"), new File([PNG], "besar.png", { type: "image/png" }));
    expect(await screen.findByText(/lebih dari 5 MB/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pilih file gambar/ })).toBeEnabled();
  });

  it("tidak lanjut ke PIN sebelum ada gambar", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Lanjut ke PIN" }));
    expect(await screen.findByText("Kotak gambar masih kosong. Tanda tangani dulu di atas garis.")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Impor gambar" }));
    await user.click(screen.getByRole("button", { name: "Lanjut ke PIN" }));
    expect(await screen.findByText("Belum ada gambar. Pilih file gambar tanda tangan dulu.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pilih file gambar/ })).toHaveFocus();
  });

  it("gambar dari kotak gambar ikut dikirim ke onSave", async () => {
    pad.result = IMAGE;
    const { user, onSave } = setup();
    await user.click(screen.getByRole("button", { name: "Lanjut ke PIN" }));
    await fillPins(user, "246810", "246810");
    expect(onSave).toHaveBeenCalledWith({ png: PNG, width: 420, height: 160, pin: "246810" });
  });

  it("Kembali ke langkah gambar lalu lanjut lagi tanpa kehilangan gambar impor", async () => {
    imageMocks.importSignatureImage.mockResolvedValue(IMAGE);
    const { user } = setup();
    await importFile(user);
    await user.click(screen.getByRole("button", { name: "Lanjut ke PIN" }));
    await user.click(screen.getByRole("button", { name: "Kembali" }));
    expect(screen.getByRole("radio", { name: "Impor gambar" })).toHaveFocus();
    expect(screen.getByText("ttd-budi.png")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Lanjut ke PIN" }));
    expect(screen.getByLabelText("PIN baru")).toBeInTheDocument();
  });

  it("menampilkan keadaan menyimpan lalu error dari onSave", async () => {
    pad.result = IMAGE;
    let reject: (err: unknown) => void = () => {};
    const onSave = vi.fn(() => new Promise<void>((_, rej) => (reject = rej)));
    const { user, onOpenChange } = setup(onSave);
    await user.click(screen.getByRole("button", { name: "Lanjut ke PIN" }));
    await fillPins(user, "123456", "123456");

    const busy = screen.getByRole("button", { name: "Menyimpan..." });
    expect(busy).toBeDisabled();
    expect(screen.getByLabelText("PIN baru")).toBeDisabled();

    reject({ code: "signature_exists", message: "Sudah ada tanda tangan tersimpan. Hapus dulu yang lama." });
    expect(await screen.findByText("Sudah ada tanda tangan tersimpan. Hapus dulu yang lama.")).toBeInTheDocument();
    expect(screen.getByText("Tanda tangan belum tersimpan")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Simpan tanda tangan" })).toBeEnabled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("error pin_invalid dari inti Rust ditampilkan di isian PIN", async () => {
    pad.result = IMAGE;
    const onSave = vi.fn().mockRejectedValue({ code: "pin_invalid", message: "PIN harus 6 sampai 12 angka." });
    const { user } = setup(onSave);
    await user.click(screen.getByRole("button", { name: "Lanjut ke PIN" }));
    await fillPins(user, "123456", "123456");
    expect(await screen.findByText("PIN harus 6 sampai 12 angka.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("PIN baru")).toHaveFocus());
  });
});
