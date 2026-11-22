import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { PlacementBox, resizeRect } from "./PlacementBox";
import type { CssRect } from "./types";

const BOUNDS = { width: 400, height: 300 };

function Harness({ initial, aspectRatio, onChange }: { initial: CssRect; aspectRatio?: number; onChange?: (r: CssRect) => void }) {
  const [rect, setRect] = useState(initial);
  return (
    <>
      <PlacementBox
        rect={rect}
        bounds={BOUNDS}
        onChange={(r) => {
          setRect(r);
          onChange?.(r);
        }}
        label="Tanda tangan Anda"
        description="Halaman 1"
        aspectRatio={aspectRatio}
        step={5}
      >
        <span>isi</span>
      </PlacementBox>
      <output data-testid="rect">{JSON.stringify(rect)}</output>
    </>
  );
}

function current(): CssRect {
  return JSON.parse(screen.getByTestId("rect").textContent ?? "{}");
}

function box() {
  return screen.getByRole("group", { name: "Tanda tangan Anda" });
}

describe("PlacementBox", () => {
  it("punya label, roledescription, petunjuk keyboard, dan bisa difokus", async () => {
    render(<Harness initial={{ left: 10, top: 10, width: 100, height: 50 }} />);
    const el = box();
    expect(el).toHaveAttribute("tabindex", "0");
    expect(el).toHaveAttribute("aria-roledescription", "kotak yang bisa dipindah");
    expect(el).toHaveAccessibleDescription(/Halaman 1.*Tombol panah memindah kotak/);
    await userEvent.tab();
    expect(el).toHaveFocus();
  });

  it("panah memindah sebesar step, Shift+panah 4 kali", async () => {
    render(<Harness initial={{ left: 100, top: 100, width: 100, height: 50 }} />);
    box().focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(current()).toEqual({ left: 105, top: 100, width: 100, height: 50 });
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(current()).toEqual({ left: 105, top: 110, width: 100, height: 50 });
    await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    expect(current()).toEqual({ left: 85, top: 110, width: 100, height: 50 });
    await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
    expect(current()).toEqual({ left: 85, top: 90, width: 100, height: 50 });
  });

  it("tidak keluar dari bounds dan mengumumkan tepi halaman", async () => {
    render(<Harness initial={{ left: 295, top: 248, width: 100, height: 50 }} />);
    box().focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(current().left).toBe(300);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(current().top).toBe(250);
    expect(screen.getByText("Sudah di tepi halaman.")).toBeInTheDocument();
    for (let i = 0; i < 30; i++) {
      fireEvent.keyDown(box(), { key: "ArrowLeft", shiftKey: true });
      fireEvent.keyDown(box(), { key: "ArrowUp", shiftKey: true });
    }
    expect(current()).toEqual({ left: 0, top: 0, width: 100, height: 50 });
  });

  it("Alt+panah mengubah lebar dan tinggi tanpa rasio", async () => {
    render(<Harness initial={{ left: 10, top: 10, width: 100, height: 50 }} />);
    box().focus();
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(current()).toEqual({ left: 10, top: 10, width: 105, height: 50 });
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(current()).toEqual({ left: 10, top: 10, width: 105, height: 55 });
    await userEvent.keyboard("{Alt>}{Shift>}{ArrowLeft}{/Shift}{/Alt}");
    expect(current()).toEqual({ left: 10, top: 10, width: 85, height: 55 });
  });

  it("plus dan minus mengubah ukuran dengan menjaga rasio", async () => {
    render(<Harness initial={{ left: 10, top: 10, width: 100, height: 50 }} aspectRatio={2} />);
    box().focus();
    await userEvent.keyboard("+");
    expect(current()).toEqual({ left: 10, top: 10, width: 105, height: 52.5 });
    await userEvent.keyboard("--");
    expect(current()).toEqual({ left: 10, top: 10, width: 95, height: 47.5 });
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(current()).toEqual({ left: 10, top: 10, width: 100, height: 50 });
  });

  it("ukuran dijepit ke bounds dan ke lebar minimum", async () => {
    render(<Harness initial={{ left: 300, top: 200, width: 80, height: 40 }} aspectRatio={2} />);
    box().focus();
    for (let i = 0; i < 10; i++) fireEvent.keyDown(box(), { key: "+", shiftKey: true });
    // Sisa ruang: lebar 100, tinggi 100 (rasio 2 => lebar maksimal 100).
    expect(current()).toEqual({ left: 300, top: 200, width: 100, height: 50 });
    expect(screen.getByText("Sudah ukuran terbesar di posisi ini.")).toBeInTheDocument();
    for (let i = 0; i < 20; i++) fireEvent.keyDown(box(), { key: "-", shiftKey: true });
    expect(current()).toEqual({ left: 300, top: 200, width: 24, height: 12 });
  });

  it("menyeret dengan pointer memindah kotak dan tetap di dalam bounds", () => {
    const onChange = vi.fn();
    render(<Harness initial={{ left: 50, top: 50, width: 100, height: 50 }} onChange={onChange} />);
    const el = box();
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 130, clientY: 120 });
    expect(current()).toEqual({ left: 80, top: 70, width: 100, height: 50 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 1000, clientY: 1000 });
    expect(current()).toEqual({ left: 300, top: 250, width: 100, height: 50 });
    fireEvent.pointerUp(el, { pointerId: 1 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 0, clientY: 0 });
    expect(current()).toEqual({ left: 300, top: 250, width: 100, height: 50 });
  });

  it("pegangan sudut mengubah ukuran dengan rasio", () => {
    render(<Harness initial={{ left: 50, top: 50, width: 100, height: 50 }} aspectRatio={2} />);
    const handle = box().querySelector(".pdf-place-handle") as HTMLElement;
    fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientX: 150, clientY: 100 });
    fireEvent.pointerMove(box(), { pointerId: 2, clientX: 190, clientY: 100 });
    expect(current()).toEqual({ left: 50, top: 50, width: 140, height: 70 });
    fireEvent.pointerMove(box(), { pointerId: 2, clientX: 2000, clientY: 2000 });
    expect(current()).toEqual({ left: 50, top: 50, width: 350, height: 175 });
  });

  it("Escape saat menyeret mengembalikan posisi awal", async () => {
    render(<Harness initial={{ left: 50, top: 50, width: 100, height: 50 }} />);
    const el = box();
    fireEvent.pointerDown(el, { pointerId: 3, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(el, { pointerId: 3, clientX: 150, clientY: 150 });
    expect(current().left).toBe(100);
    fireEvent.keyDown(el, { key: "Escape" });
    expect(current()).toEqual({ left: 50, top: 50, width: 100, height: 50 });
  });
});

describe("resizeRect", () => {
  it("tidak lebih kecil dari minWidth kecuali ruang habis", () => {
    expect(resizeRect({ left: 0, top: 0, width: 50, height: 50 }, 5, 5, BOUNDS)).toEqual({ left: 0, top: 0, width: 24, height: 24 });
    expect(resizeRect({ left: 390, top: 0, width: 10, height: 10 }, 50, 50, BOUNDS)).toEqual({ left: 390, top: 0, width: 10, height: 50 });
  });
});
