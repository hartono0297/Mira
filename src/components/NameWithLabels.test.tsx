import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { LabelRef } from "../api/org";
import { LabelChips, MAX_LABELS_SHOWN, NameWithLabels } from "./NameWithLabels";

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
    // Bukan sekadar atribut title: tooltip sendiri saat diarahkan atau difokus.
    expect(more.title).toBe("");
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
    expect(container.querySelector(".nwl-name")?.textContent).toBe("Andi (Anda), label ");
    expect(container.querySelector(".nwl-suffix")?.textContent).toBe(" (Anda)");
    expect(container.textContent).toBe("Andi (Anda), label Senior");
  });

  it("className tambahan dipasang bersama kelas dasar", () => {
    const { container } = render(<NameWithLabels name="Andi" labels={[]} className="extra" />);
    expect(container.firstElementChild?.className).toBe("nwl extra");
  });

  it("+N adalah tombol yang bisa difokus dan nama aksesibelnya menyebut semua sisa label", async () => {
    const user = userEvent.setup();
    render(<NameWithLabels name="Hendra" labels={EIGHT} />);
    const more = screen.getByRole("button", { name: ", dan 5 label lain: Pengawas lapangan, Juru gambar senior, Estimator biaya, Ahli struktur baja, Koordinator K3" });
    expect(more).toHaveTextContent("+5");
    await user.tab();
    expect(more).toHaveFocus();
    const tip = document.querySelector(".lab-tip") as HTMLElement;
    expect(tip).not.toBeNull();
    expect(tip).toHaveAttribute("aria-hidden", "true");
    expect([...tip.querySelectorAll(".lab")].map((el) => el.textContent)).toEqual(EIGHT.slice(3).map((l) => l.name));
  });

  it("tooltip +N muncul saat diarahkan kursor, Esc menutupnya, klik menahannya", async () => {
    const user = userEvent.setup();
    render(<NameWithLabels name="Hendra" labels={EIGHT} />);
    const more = screen.getByRole("button", { name: /dan 5 label lain/ });
    expect(document.querySelector(".lab-tip")).toBeNull();
    await user.hover(more);
    expect(document.querySelector(".lab-tip")).toHaveTextContent("Koordinator K3");
    await user.unhover(more);
    expect(document.querySelector(".lab-tip")).toBeNull();

    await user.click(more);
    expect(document.querySelector(".lab-tip")).not.toBeNull();
    await user.unhover(more);
    // Diklik: tetap terbuka selama tombol masih difokus.
    expect(document.querySelector(".lab-tip")).not.toBeNull();
    fireEvent.keyDown(more, { key: "Escape" });
    expect(document.querySelector(".lab-tip")).toBeNull();
    expect(more).toHaveFocus();
    await user.click(more);
    expect(document.querySelector(".lab-tip")).not.toBeNull();
    // Kursor pergi dan fokus pindah: tertutup.
    await user.unhover(more);
    await user.tab();
    expect(document.querySelector(".lab-tip")).toBeNull();
  });

  it("Esc saat tooltip terbuka tidak diteruskan ke panel di sekitarnya", () => {
    let outer = 0;
    render(
      <div onKeyDown={() => (outer += 1)}>
        <NameWithLabels name="Hendra" labels={EIGHT} />
      </div>,
    );
    const more = screen.getByRole("button", { name: /dan 5 label lain/ });
    fireEvent.focus(more);
    fireEvent.keyDown(more, { key: "Escape" });
    expect(outer).toBe(0);
    // Tooltip sudah tertutup: Esc berikutnya diteruskan (misalnya menutup panel).
    fireEvent.keyDown(more, { key: "Escape" });
    expect(outer).toBe(1);
  });

  it("klik +N di dalam label kotak centang tidak mencentang", async () => {
    const user = userEvent.setup();
    render(
      <label>
        <input type="checkbox" />
        <NameWithLabels name="Hendra" labels={EIGHT} />
      </label>,
    );
    await user.click(screen.getByRole("button", { name: /dan 5 label lain/ }));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("all menampilkan semua label tanpa +N", () => {
    const { container } = render(<NameWithLabels name="Hendra" labels={EIGHT} all />);
    expect(visibleLabels(container)).toEqual(EIGHT.map((l) => l.name));
    expect(container.querySelector(".lab-more")).toBeNull();
    expect(container.textContent).toBe(`Hendra, label ${EIGHT.map((l) => l.name).join(", ")}`);
  });

  it("max Infinity sama dengan all", () => {
    const { container } = render(<NameWithLabels name="Hendra" labels={EIGHT} max={Infinity} />);
    expect(visibleLabels(container)).toEqual(EIGHT.map((l) => l.name));
    expect(container.querySelector(".lab-more")).toBeNull();
  });

  it("wrap memberi kelas supaya chip boleh turun baris; bawaan tidak", () => {
    const { container, rerender } = render(<NameWithLabels name="Hendra" labels={EIGHT} all wrap />);
    expect(container.querySelector(".nwl")).toHaveClass("nwl-wrap-all");
    expect(container.querySelector(".nwl-labels")).toHaveClass("nwl-wrap");
    rerender(<NameWithLabels name="Hendra" labels={EIGHT} />);
    expect(container.querySelector(".nwl")).not.toHaveClass("nwl-wrap-all");
    expect(container.querySelector(".nwl-labels")).not.toHaveClass("nwl-wrap");
  });

  it("LabelChips staticMore: +N hanya tampilan, bukan tombol", () => {
    const { container } = render(<LabelChips labels={EIGHT} max={2} staticMore />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(visibleLabels(container)).toEqual(["Arsitek", "Drafter"]);
    expect(container.querySelector(".lab-more [aria-hidden='true']")?.textContent).toBe("+6");
  });

  it("LabelChips tanpa label tidak menulis apa pun", () => {
    const { container } = render(<LabelChips labels={[]} all />);
    expect(container.innerHTML).toBe("");
  });
});

const EIGHT = labels(
  "Arsitek",
  "Drafter",
  "Surveyor",
  "Pengawas lapangan",
  "Juru gambar senior",
  "Estimator biaya",
  "Ahli struktur baja",
  "Koordinator K3",
);
