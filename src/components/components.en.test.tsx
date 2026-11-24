// Komponen bersama dalam bahasa Inggris, termasuk ganti bahasa di tengah jalan.
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PersonView } from "../api/org";
import { setLang } from "../i18n/core";
import { firewallName, keyStoreName } from "../platform";
import { ME, PK_B, PK_D, person } from "../test/orgFixtures";
import { renderInLang } from "../test/i18n";
import { ConfirmDialog } from "./ConfirmDialog";
import { NameWithLabels } from "./NameWithLabels";
import { PeoplePicker } from "./PeoplePicker";
import { SidebarCount } from "./SidebarCount";
import { PlacementBox } from "./pdf";

const PEOPLE: PersonView[] = [
  person(ME, "Andi", { departmentName: "Administrasi" }),
  person(PK_B, "Budi", { departmentName: null, departmentId: null, departmentRole: null }),
  person(PK_D, "Yusuf", {
    isGuest: true,
    role: "guest",
    departmentId: null,
    departmentName: null,
    departmentRole: null,
  }),
];

describe("komponen bersama dalam bahasa Inggris", () => {
  it("PeoplePicker memakai teks Inggris dan kembali ke Indonesia saat bahasa diganti", async () => {
    const user = userEvent.setup();
    renderInLang(() => (
      <PeoplePicker people={PEOPLE} selected={new Set([PK_B])} onToggle={vi.fn()} listLabel="People" isMe={(pk) => pk === ME} />
    ));

    expect(screen.getByLabelText("Search names")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "All departments" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Guest" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "No department yet" })).toBeInTheDocument();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getByText("(you)", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(/orang dipilih|Cari nama|Tamu|\(Anda\)/)).toBeNull();

    await user.type(screen.getByLabelText("Search names"), "zzz");
    expect(screen.getByText('No one matches name "zzz".')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show everyone" })).toBeInTheDocument();

    act(() => setLang("id"));
    expect(screen.getByText('Tidak ada orang yang cocok dengan nama "zzz".')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tampilkan semua orang" })).toBeInTheDocument();
  });

  it("label, hitungan, dan dialog konfirmasi dibacakan dalam bahasa Inggris", () => {
    const labels = [
      { id: "1".repeat(32), name: "Architect" },
      { id: "2".repeat(32), name: "Senior" },
      { id: "3".repeat(32), name: "Drafter" },
      { id: "4".repeat(32), name: "Lead" },
      { id: "5".repeat(32), name: "Mentor" },
    ];
    renderInLang(() => (
      <>
        <NameWithLabels name="Rina" labels={labels} />
        <SidebarCount count={150} meaning="unread" />
        <ConfirmDialog open onOpenChange={vi.fn()} title="Delete file" confirmLabel="Delete" busyLabel="Deleting..." busy={false} onConfirm={vi.fn()}>
          Body
        </ConfirmDialog>
      </>
    ));
    expect(screen.getByText(", labels")).toBeInTheDocument();
    expect(screen.getByText(", and 2 more labels")).toBeInTheDocument();
    expect(screen.getByText(", more than 99 unread")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Batal" })).toBeNull();
  });

  it("nama sistem macOS mengikuti urutan kata bahasa Inggris", () => {
    setLang("en");
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(firewallName()).toBe("macOS Firewall");
    expect(keyStoreName()).toBe("macOS Keychain");
    vi.restoreAllMocks();
    expect(firewallName(false)).toBe("Windows Firewall");
  });

  it("catatan tepi PlacementBox ikut bahasa aktif", async () => {
    const user = userEvent.setup();
    renderInLang(() => (
      <PlacementBox rect={{ left: 0, top: 0, width: 40, height: 20 }} bounds={{ width: 100, height: 100 }} onChange={vi.fn()} label="Signature" />
    ));
    const box = screen.getByRole("group", { name: "Signature" });
    expect(box).toHaveAttribute("aria-roledescription", "movable box");
    box.focus();
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(screen.getByText("Already at the edge of the page.")).toBeInTheDocument());
    act(() => setLang("id"));
    expect(screen.getByText("Sudah di tepi halaman.")).toBeInTheDocument();
  });
});
