import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, OrgInfo } from "../../api";
import type { UserView } from "../../api/org";
import { setLang } from "../../i18n/core";
import { appState, directory, router } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import { department, label, LABEL_1, ME, memberOverview, overview, person, PK_B, PK_C, TEAM_1, TEAM_2, user } from "../../test/orgFixtures";
import { OrgScreen } from "./OrgScreen";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const state = appState() as AppState & { organization: OrgInfo };

function users(): UserView[] {
  return [
    user(ME, "Penguji", { role: "superadmin", isSuperadmin: true, lastIp: null }),
    user(PK_B, "Sari", { online: false, lastSeenAt: null, device: null, lastIp: null }),
    user(PK_C, "Wulan", { isGuest: true, role: "guest", departmentId: null, departmentName: null, departmentRole: null, guestProjectCount: 2 }),
  ];
}

function answer(extra: Record<string, unknown> = {}) {
  invoke.mockImplementation(
    router({
      org_overview: overview({ pendingJoinCount: 3 }),
      get_directory: directory(),
      org_fingerprint: "ABCD-EFGH",
      org_users: users(),
      org_people: [person(ME, "Penguji"), person(PK_B, "Sari", { departmentId: TEAM_2, departmentName: "Keuangan" })],
      org_departments: [department(TEAM_1, "Desain", { channelName: "desain" }), department(TEAM_2, "Keuangan")],
      org_labels: [label(LABEL_1, "Arsitek", [PK_B])],
      org_join_requests: [],
      board_list_projects: [],
      ...(extra as Record<string, never>),
    }),
  );
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

afterEach(() => {
  setLang("id");
});

describe("Organisasi dalam bahasa Inggris", () => {
  it("menulis tab, tabel Pengguna, dan dialog ubah peran dalam bahasa Inggris", async () => {
    answer();
    const ue = userEvent.setup();
    renderInLang(() => <OrgScreen state={state} onRefresh={vi.fn()} />, "en");

    expect(await screen.findByRole("heading", { name: "Organization", level: 1 })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Organization sections" });
    expect(within(nav).getByRole("button", { name: "Join requests, 3 waiting" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Users" })).toBeInTheDocument();
    expect(screen.getByText("fingerprint", { exact: false })).toBeInTheDocument();

    expect(await screen.findByRole("columnheader", { name: "Laptop and last IP" })).toBeInTheDocument();
    expect(screen.getByText("3 people")).toBeInTheDocument();
    expect(screen.getByText("Guest, 2 projects")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Everyone active" })).toBeInTheDocument();
    expect(screen.queryByText("Pengguna")).not.toBeInTheDocument();
    expect(screen.queryByText(/Belum ada departemen|Laptop ini|Bergabung/)).not.toBeInTheDocument();

    await ue.click(screen.getByRole("button", { name: "Actions for Sari" }));
    await ue.click(await screen.findByRole("menuitem", { name: "Change role" }));
    expect(await screen.findByRole("dialog", { name: "Change Sari's role" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save role" })).toBeInTheDocument();
    expect(screen.queryByText("Simpan peran")).not.toBeInTheDocument();
  });

  it("menulis saringan kosong dalam bahasa Inggris", async () => {
    answer();
    const ue = userEvent.setup();
    renderInLang(() => <OrgScreen state={state} onRefresh={vi.fn()} />, "en");
    await ue.type(await screen.findByRole("searchbox", { name: "Search" }), "zzz");
    expect(screen.getByText('No people who match "zzz"')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear search" })).toBeInTheDocument();
  });

  it("anggota biasa melihat daftar Anggota dalam bahasa Inggris, lalu kembali ke bahasa Indonesia", async () => {
    answer({ org_overview: memberOverview() });
    renderInLang(() => <OrgScreen state={state} onRefresh={vi.fn()} />, "en");

    expect(await screen.findByRole("heading", { name: "Organization members" })).toBeInTheDocument();
    expect(await screen.findByText("Keuangan · member")).toBeInTheDocument();
    expect(screen.getByText("Penguji")).toBeInTheDocument();
    expect(screen.getByText(/\(you\)/)).toBeInTheDocument();

    act(() => setLang("id"));
    expect(screen.getByRole("heading", { name: "Anggota organisasi" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Bagian organisasi" })).toBeInTheDocument();
  });
});
