import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SignaturePad } from "./SignaturePad";

describe("SignaturePad", () => {
  it("tombol hapus semua goresan bernama Kosongkan, nonaktif selama belum ada goresan", () => {
    render(<SignaturePad />);
    expect(screen.getByRole("button", { name: "Kosongkan" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Batalkan goresan" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Ulangi" })).not.toBeInTheDocument();
  });
});
