import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonView } from "../../api/org";
import { setLang } from "../../i18n/core";
import { router } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import { adSettings, department, overview, person, PK_B, PK_C, TEAM_1, TEAM_2, TEAM_3 } from "../../test/orgFixtures";
import type { OrgPage } from "./context";
import { DepartmentsPanel } from "./DepartmentsPanel";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

function page(): OrgPage {
  return {
    overview: overview(),
    act: vi.fn(async () => true),
    pending: null,
    notify: vi.fn(),
    version: 0,
    refresh: vi.fn(),
    isMe: () => false,
  };
}

const desain = department(TEAM_1, "Desain", {
  memberCount: 2,
  admins: [{ publicKey: PK_C, displayName: "Citra" }],
  channelName: "desain",
});
const interior = department(TEAM_3, "Interior", { memberCount: 0 });
const lanskap = department(TEAM_2, "Lanskap", {
  archived: true,
  archivedAt: "2026-11-02T03:00:00Z",
  channelName: "lanskap",
});
const people: PersonView[] = [
  person(PK_B, "Bayu", { departmentId: TEAM_1 }),
  person(PK_C, "Citra", { departmentId: TEAM_1, departmentRole: "admin" }),
];

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  invoke.mockImplementation(router({ org_departments: [desain, interior, lanskap], org_people: people, org_ad_settings: adSettings() }));
});

afterEach(() => {
  setLang("id");
});

describe("Departemen dalam bahasa Inggris", () => {
  it("menulis tabel, tombol, dan dialog dalam bahasa Inggris", async () => {
    const user = userEvent.setup();
    renderInLang(() => <DepartmentsPanel page={page()} />, "en");

    expect(await screen.findByRole("table", { name: "Active departments" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Departments" })).toBeInTheDocument();
    expect(screen.getByText("2 active departments")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Department admins" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename Desain" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive Interior" })).toBeInTheDocument();
    expect(screen.getByText("Archived (1)")).toBeInTheDocument();
    expect(screen.queryByText(/Departemen|Ganti nama|Arsipkan|Diarsipkan/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Manage admins for Desain" }));
    expect(await screen.findByRole("dialog", { name: "Admins of Desain" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make admin, Bayu" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove admin, Citra" })).toBeInTheDocument();
    expect(screen.queryByText(/Jadikan admin|Lepas admin|Tutup/)).not.toBeInTheDocument();
  });

  it("mengikuti bahasa yang diganti saat layar terbuka", async () => {
    renderInLang(() => <DepartmentsPanel page={page()} />, "en");
    expect(await screen.findByRole("button", { name: "New department" })).toBeInTheDocument();
    act(() => setLang("id"));
    expect(screen.getByRole("button", { name: "Departemen baru" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Departemen aktif" })).toBeInTheDocument();
  });
});
