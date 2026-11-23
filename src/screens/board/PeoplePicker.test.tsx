import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type FormEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PersonView } from "../../api/org";
import { describePicked, PeoplePicker, type PeoplePickerProps } from "./PeoplePicker";

const DESAIN = "1".repeat(32);
const DRAFTING = "2".repeat(32);
const SIPIL = "3".repeat(32);

function person(key: string, displayName: string, extra: Partial<PersonView> = {}): PersonView {
  return {
    publicKey: key.repeat(64),
    displayName,
    fingerprint: "AAAA AAAA AAAA AAAA",
    role: "member",
    isSuperadmin: false,
    isGuest: false,
    departmentId: null,
    departmentName: null,
    departmentRole: "member",
    labels: [],
    ...extra,
  };
}

const desain = { departmentId: DESAIN, departmentName: "Desain" };
const drafting = { departmentId: DRAFTING, departmentName: "Drafting" };
const sipil = { departmentId: SIPIL, departmentName: "Sipil dan Struktur" };

const DIMAS = person("b", "Dimas", desain);
const BUDI = person("c", "Budi", drafting);
const SARI = person("d", "Sari", drafting);
const HENDRA = person("e", "Hendra", sipil);
const RENE = person("f", "René Wibowo", sipil);
const YUSUF = person("9", "Yusuf", {
  isGuest: true,
  role: "guest",
  departmentRole: null,
});
const LINA = person("8", "Lina", { departmentRole: null });

const PEOPLE = [HENDRA, DIMAS, SARI, BUDI, RENE];

type HarnessProps = Partial<PeoplePickerProps> & {
  initial?: string[];
  onPick?: (keys: string[]) => void;
  onSubmitForm?: (e: FormEvent) => void;
};

function Harness({ initial = [], onPick, onSubmitForm, ...rest }: HarnessProps) {
  const [selected, setSelected] = useState<string[]>(initial);
  return (
    <form onSubmit={onSubmitForm}>
      <PeoplePicker
        people={PEOPLE}
        {...rest}
        selected={selected}
        onChange={(keys) => {
          setSelected(keys);
          onPick?.(keys);
        }}
      />
    </form>
  );
}

function names() {
  return within(screen.getByRole("list", { name: "Daftar orang" }))
    .getAllByRole("checkbox")
    .map((c) => c.closest("li")?.querySelector(".pp-name")?.textContent);
}

describe("PeoplePicker", () => {
  it("kotak centang bernama persis nama orang, departemen sebagai keterangan, urut nama", () => {
    render(<Harness />);
    expect(names()).toEqual(["Budi", "Dimas", "Hendra", "René Wibowo", "Sari"]);
    const dimas = screen.getByRole("checkbox", { name: "Dimas" });
    expect(dimas).toHaveAccessibleDescription("Desain");
    expect(screen.getByRole("searchbox", { name: "Cari nama atau departemen" })).toBeInTheDocument();
  });

  it("tombol saringan: Semua, departemen yang ada, Tamu, dan Belum ada departemen", async () => {
    const user = userEvent.setup();
    render(<Harness people={[...PEOPLE, YUSUF, LINA]} />);
    const group = screen.getByRole("group", {
      name: "Saring menurut departemen",
    });
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Semua", "Desain", "Drafting", "Sipil dan Struktur", "Tamu", "Belum ada departemen"]);
    expect(within(group).getByRole("button", { name: "Semua" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("checkbox", { name: "Yusuf" })).toHaveAccessibleDescription("Tamu");
    expect(screen.getByRole("checkbox", { name: "Lina" })).toHaveAccessibleDescription("Belum ada departemen");

    await user.click(within(group).getByRole("button", { name: "Drafting" }));
    expect(within(group).getByRole("button", { name: "Drafting" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "Semua" })).toHaveAttribute("aria-pressed", "false");
    expect(names()).toEqual(["Budi", "Sari"]);

    await user.click(within(group).getByRole("button", { name: "Tamu" }));
    expect(names()).toEqual(["Yusuf"]);
    await user.click(within(group).getByRole("button", { name: "Belum ada departemen" }));
    expect(names()).toEqual(["Lina"]);
  });

  it("pilihan tetap terpilih saat saringan menyembunyikannya, dan tampil di ringkasan", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await user.click(screen.getByRole("checkbox", { name: "Dimas" }));
    await user.click(screen.getByRole("checkbox", { name: "Budi" }));
    await user.click(screen.getByRole("button", { name: "Sipil dan Struktur" }));
    await user.click(screen.getByRole("checkbox", { name: "Hendra" }));
    expect(onPick).toHaveBeenLastCalledWith([DIMAS.publicKey, BUDI.publicKey, HENDRA.publicKey]);
    expect(screen.queryByRole("checkbox", { name: "Dimas" })).not.toBeInTheDocument();

    const picked = screen.getByRole("list", { name: "Orang yang dipilih" });
    expect(
      within(picked)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Dimas", "Budi", "Hendra"]);
    expect(screen.getByText("3 orang dari 3 departemen dipilih.")).toBeInTheDocument();
  });

  it("tombol hapus di ringkasan membatalkan pilihan dan memindah fokus ke pilihan berikutnya", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[DIMAS.publicKey, BUDI.publicKey]} />);
    await user.click(screen.getByRole("button", { name: "Hapus Dimas dari pilihan" }));
    expect(screen.getByRole("checkbox", { name: "Dimas" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Hapus Budi dari pilihan" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Hapus Budi dari pilihan" }));
    expect(screen.getByRole("searchbox", { name: "Cari nama atau departemen" })).toHaveFocus();
    expect(screen.getByText("Belum ada yang dipilih.")).toBeInTheDocument();
  });

  it("cari nama dan departemen, tanpa peduli huruf besar dan aksen", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const search = screen.getByRole("searchbox", { name: "Cari nama atau departemen" });
    await user.type(search, "rene");
    expect(names()).toEqual(["René Wibowo"]);
    await user.clear(search);
    await user.type(search, "DRAFT");
    expect(names()).toEqual(["Budi", "Sari"]);
    await user.clear(search);
    await user.type(search, "zaki");
    expect(screen.queryByRole("list", { name: "Daftar orang" })).not.toBeInTheDocument();
    expect(screen.getByText('Tidak ada nama yang cocok dengan "zaki".')).toBeInTheDocument();
  });

  it("tidak ada yang cocok di departemen yang disaring: saringannya disebut", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Desain" }));
    await user.type(screen.getByRole("searchbox", { name: "Cari nama atau departemen" }), "budi");
    expect(screen.getByText('Tidak ada nama yang cocok dengan "budi" di Desain.')).toBeInTheDocument();
  });

  it("Enter di kotak cari tidak mengirim form", async () => {
    const user = userEvent.setup();
    const submit = vi.fn((e: FormEvent) => e.preventDefault());
    render(<Harness onSubmitForm={submit} />);
    await user.type(screen.getByRole("searchbox", { name: "Cari nama atau departemen" }), "budi{Enter}");
    expect(submit).not.toHaveBeenCalled();
  });

  it("keyboard: Tab ke kotak cari, saringan, lalu kotak centang; Spasi mencentang", async () => {
    const user = userEvent.setup();
    render(<Harness people={[DIMAS, BUDI]} />);
    await user.tab();
    expect(screen.getByRole("searchbox", { name: "Cari nama atau departemen" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Semua" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Desain" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Drafting" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("checkbox", { name: "Budi" })).toHaveFocus();
    await user.keyboard(" ");
    expect(screen.getByRole("checkbox", { name: "Budi" })).toBeChecked();
  });

  it("exclude tidak ditawarkan; daftar kosong memakai teks kosong", () => {
    const { unmount } = render(<Harness exclude={[DIMAS.publicKey]} />);
    expect(screen.queryByRole("checkbox", { name: "Dimas" })).not.toBeInTheDocument();
    unmount();
    render(<Harness people={[DIMAS]} exclude={[DIMAS.publicKey]} emptyText="Semua orang sudah jadi anggota." />);
    expect(screen.getByText("Semua orang sudah jadi anggota.")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Cari nama atau departemen" })).not.toBeInTheDocument();
  });

  it("baris tetap dan ringkasan khusus dari pemanggil", () => {
    render(
      <Harness
        initial={[DIMAS.publicKey]}
        fixedNote={<span>Anda, pengelola</span>}
        summary={(picked) => `${picked.length} anggota tambahan`}
      />,
    );
    expect(screen.getByText("Anda, pengelola")).toBeInTheDocument();
    expect(screen.getByText("1 anggota tambahan")).toBeInTheDocument();
  });

  it("disabled: semua kontrol mati", () => {
    render(<Harness disabled initial={[DIMAS.publicKey]} />);
    expect(screen.getByRole("searchbox", { name: "Cari nama atau departemen" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Semua" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Budi" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Hapus Dimas dari pilihan" })).toBeDisabled();
  });
});

describe("describePicked", () => {
  it("menghitung orang dan departemen", () => {
    expect(describePicked([DIMAS, BUDI, SARI, HENDRA])).toBe("4 orang dari 3 departemen");
    expect(describePicked([DIMAS, LINA])).toBe("1 orang dari 1 departemen dan 1 orang tanpa departemen");
    expect(describePicked([DIMAS, BUDI, YUSUF])).toBe("2 orang dari 2 departemen dan 1 Tamu");
    expect(describePicked([LINA, YUSUF])).toBe("1 orang tanpa departemen dan 1 Tamu");
    expect(describePicked([DIMAS, LINA, YUSUF])).toBe(
      "1 orang dari 1 departemen, 1 orang tanpa departemen, dan 1 Tamu",
    );
  });
});
