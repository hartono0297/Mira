import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LabelRef } from "../api/org";
import { MAX_LABELS_SHOWN, NameWithLabels } from "./NameWithLabels";

function labels(...names: string[]): LabelRef[] {
  return names.map((name, i) => ({ id: String(i).repeat(32), name }));
}

function visibleLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".lab:not(.lab-more)")].map((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".sr-only").forEach((s) => s.remove());
    return copy.textContent ?? "";
  });
}

describe("NameWithLabels", () => {
  it("tanpa label hanya menampilkan nama", () => {
    const { container } = render(<NameWithLabels name="Rina" labels={[]} />);
    expect(container.textContent).toBe("Rina");
    expect(container.querySelector(".nwl-labels")).toBeNull();
    expect(container.querySelector(".lab")).toBeNull();
  });

  it.each([1, 2, 3])("menampilkan %i label tanpa ringkasan", (n) => {
    const list = labels("Arsitek", "K3", "Senior").slice(0, n);
    const { container } = render(<NameWithLabels name="Rina" labels={list} />);
    expect(visibleLabels(container)).toEqual(list.map((l) => l.name));
    expect(container.querySelector(".lab-more")).toBeNull();
    expect(container.textContent).toContain(", label ");
  });

  it("lima label: tiga tampil dan sisanya menjadi +2 dengan teks pembaca layar", () => {
    const { container } = render(
      <NameWithLabels name="Hendra" labels={labels("Arsitek", "Drafter", "K3", "Senior", "Surveyor")} />,
    );
    expect(MAX_LABELS_SHOWN).toBe(3);
    expect(visibleLabels(container)).toEqual(["Arsitek", "Drafter", "K3"]);
    const more = container.querySelector(".lab-more") as HTMLElement;
    expect(more.querySelector("[aria-hidden='true']")?.textContent).toBe("+2");
    expect(more.querySelector(".sr-only")?.textContent).toBe(", dan 2 label lain");
    expect(more.title).toBe("Senior, Surveyor");
  });

  it("max khusus membatasi jumlah label yang tampil", () => {
    const { container } = render(<NameWithLabels name="Sari" labels={labels("Arsitek", "K3", "Senior")} max={1} />);
    expect(visibleLabels(container)).toEqual(["Arsitek"]);
    expect(container.querySelector(".lab-more [aria-hidden='true']")?.textContent).toBe("+2");
  });

  it("max 0 menyembunyikan semua label", () => {
    const { container } = render(<NameWithLabels name="Sari" labels={labels("Arsitek")} max={0} />);
    expect(container.textContent).toBe("Sari");
    expect(container.querySelector(".lab")).toBeNull();
  });

  it("suffix ditulis sesudah nama dan sebelum label", () => {
    const { container } = render(<NameWithLabels name="Andi" labels={labels("Senior")} suffix=" (Anda)" />);
    expect(container.querySelector(".nwl-name")?.textContent).toBe("Andi (Anda)");
    expect(container.querySelector(".nwl-suffix")?.textContent).toBe(" (Anda)");
    expect(container.textContent).toBe("Andi (Anda), label Senior");
  });

  it("className tambahan dipasang bersama kelas dasar", () => {
    const { container } = render(<NameWithLabels name="Andi" labels={[]} className="extra" />);
    expect(container.firstElementChild?.className).toBe("nwl extra");
  });
});
