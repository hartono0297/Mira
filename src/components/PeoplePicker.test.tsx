import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PersonView } from "../api/org";
import { ME, PK_B, PK_C, PK_D, person } from "../test/orgFixtures";
import { PeoplePicker } from "./PeoplePicker";

const PEOPLE: PersonView[] = [
  person(PK_C, "Sari", { departmentName: "Drafting", labels: [{ id: "4".repeat(32), name: "Drafter" }] }),
  person(ME, "Andi", { departmentName: "Administrasi" }),
  person(PK_B, "Budi", { departmentName: "Drafting" }),
  person(PK_D, "Yusuf", {
    isGuest: true,
    role: "guest",
    departmentId: null,
    departmentName: null,
    departmentRole: null,
  }),
];

function Harness({ onToggle = vi.fn() }: { onToggle?: (pk: string, on: boolean) => void }) {
  const [picked, setPicked] = useState(new Set<string>([PK_B]));
  return (
    <PeoplePicker
      people={PEOPLE}
      selected={picked}
      listLabel="Penanggung jawab"
      isMe={(pk) => pk === ME}
      onToggle={(pk, on) => {
        onToggle(pk, on);
        setPicked((s) => {
          const n = new Set(s);
          if (on) n.add(pk);
          else n.delete(pk);
          return n;
        });
      }}
    />
  );
}

describe("PeoplePicker", () => {
  it("urut nama, dengan departemen, Tamu, label, dan (Anda)", () => {
    render(<Harness />);
    const list = screen.getByRole("list", { name: "Penanggung jawab" });
    const boxes = within(list).getAllByRole("checkbox");
    expect(
      boxes.map(
        (b) =>
          b.getAttribute("aria-labelledby") && document.getElementById(b.getAttribute("aria-labelledby")!)?.textContent,
      ),
    ).toEqual([
      expect.stringMatching(/^Andi/),
      expect.stringMatching(/^Budi/),
      expect.stringMatching(/^Sari.*Drafter/),
      expect.stringMatching(/^Yusuf/),
    ]);
    expect(screen.getByText("(Anda)", { exact: false })).toBeInTheDocument();
    expect(within(list).getByText("Tamu")).toBeInTheDocument();
    expect(screen.getByText("1 orang dipilih")).toBeInTheDocument();
  });

  it("mencentang dan melepas memanggil onToggle", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<Harness onToggle={onToggle} />);
    const boxes = within(screen.getByRole("list")).getAllByRole("checkbox");
    await user.click(boxes[1]); // Budi, sudah dicentang
    await user.click(boxes[2]); // Sari
    expect(onToggle.mock.calls).toEqual([
      [PK_B, false],
      [PK_C, true],
    ]);
    expect(screen.getByText("1 orang dipilih")).toBeInTheDocument();
  });

  it("menyaring nama dan departemen, lalu kembali ke semua orang", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.selectOptions(screen.getByLabelText("Departemen"), "Drafting");
    expect(within(screen.getByRole("list")).getAllByRole("checkbox")).toHaveLength(2);
    await user.type(screen.getByLabelText("Cari nama"), "zz");
    expect(screen.getByText(/Tidak ada orang yang cocok dengan nama "zz" dan saringan Drafting/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tampilkan semua orang" }));
    expect(within(screen.getByRole("list")).getAllByRole("checkbox")).toHaveLength(4);
    expect(screen.getByLabelText("Cari nama")).toHaveFocus();
  });

  it("saringan Tamu hanya memuat Tamu", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.selectOptions(screen.getByLabelText("Departemen"), "Tamu");
    const boxes = within(screen.getByRole("list")).getAllByRole("checkbox");
    expect(boxes).toHaveLength(1);
  });
});
