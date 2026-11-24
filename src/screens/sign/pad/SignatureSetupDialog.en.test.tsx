// Dialog tanda tangan dan PIN dalam bahasa Inggris.
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useImperativeHandle, type Ref } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../../../i18n/core";
import { renderInLang } from "../../../test/i18n";
import type { SignatureImage } from "./image";
import { PinDialog } from "./PinDialog";
import { validatePin } from "./pin";
import { SignatureSetupDialog } from "./SignatureSetupDialog";
import type { SignaturePadHandle } from "./SignaturePad";

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

afterEach(() => {
  setLang("id");
  pad.result = null;
});

describe("tanda tangan tersimpan dalam bahasa Inggris", () => {
  it("SignatureSetupDialog: langkah gambar dan PIN", async () => {
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
    const user = userEvent.setup();
    renderInLang(() => <SignatureSetupDialog open onOpenChange={() => {}} onSave={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Create a signature" })).toBeInTheDocument();
    expect(screen.getByText("Step 1 of 2: signature image")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Import an image" })).toBeInTheDocument();
    expect(screen.queryByText("Buat tanda tangan")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Batal" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue to PIN" }));
    expect(screen.getByText("The drawing box is still empty. Sign above the line first.")).toBeInTheDocument();

    pad.result = { png: new Uint8Array([1, 2, 3]), width: 10, height: 4 };
    await user.click(screen.getByRole("button", { name: "Continue to PIN" }));
    expect(await screen.findByText("Step 2 of 2: create a PIN")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save signature" }));
    expect(screen.getByText("Create a PIN first, 6 to 12 digits.")).toBeInTheDocument();
    expect(screen.queryByText(/Langkah|PIN baru|Ulangi PIN/)).not.toBeInTheDocument();
  });

  it("PinDialog dan validatePin", async () => {
    const user = userEvent.setup();
    renderInLang(() => <PinDialog open onOpenChange={() => {}} onSubmit={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Enter your PIN" })).toBeInTheDocument();
    expect(screen.getByLabelText("Signature PIN")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign" }));
    expect(screen.getByText("Enter your PIN.")).toBeInTheDocument();
    expect(screen.queryByText(/Masukkan PIN|Tanda tangani|Batal/)).not.toBeInTheDocument();
    expect(validatePin("12 456")).toBe("Use only the digits 0 to 9 in your PIN.");
  });
});
