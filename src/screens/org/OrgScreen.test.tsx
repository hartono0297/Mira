import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Directory, OrgInfo } from "../../api";
import { appState, directory, member, ME, PK_B, PK_C, router, rustError, TEAM_1 } from "../../test/fixtures";
import { adminOverview, department, memberOverview, overview } from "../../test/orgFixtures";
import { OrgScreen } from "./OrgScreen";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const state = appState() as AppState & { organization: OrgInfo };

// Anggota biasa di direktori lama: bukan superadmin, tidak mengelola departemen.
const plainMember: Partial<Directory> = {
  me: { publicKey: ME, isSuperadmin: false },
  can: { createTeam: false, manageSuperadmins: false, removeMembers: false, manageTeamIds: [] },
  members: [
    member(ME, "Penguji", { teams: [{ teamId: TEAM_1, role: "member" }] }),
    member(PK_B, "Anggota Satu", { orgRole: "superadmin", isSuperadmin: true }),
    member(PK_C, "Anggota Dua"),
  ],
};

// Command panel lain dijawab kosong: panel itu diuji di filenya sendiri.
const otherPanels = {
  org_users: [],
  org_people: [],
  org_labels: [],
  org_join_requests: [],
  org_departments: [department(TEAM_1, "Desain")],
  board_list_projects: [],
};

function answer(extra: Record<string, unknown> = {}) {
  invoke.mockImplementation(
    router({
      org_overview: overview(),
      get_directory: directory(),
      org_fingerprint: "ABCD-EFGH",
      ...otherPanels,
      ...(extra as Record<string, never>),
    }),
  );
}

function renderOrg() {
  const onRefresh = vi.fn();
  render(<OrgScreen state={state} onRefresh={onRefresh} />);
  return { onRefresh };
}

function tabNames(): string[] {
  const nav = screen.getByRole("navigation", { name: "Bagian organisasi" });
  return within(nav)
    .getAllByRole("button")
    .map((b) => b.textContent ?? "");
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

describe("Organisasi: memuat dan error", () => {
  it("menampilkan Memuat lalu tab setelah data organisasi terbaca", async () => {
    answer();
    renderOrg();
    expect(screen.getByText("Memuat data organisasi...")).toBeInTheDocument();
    expect(await screen.findByRole("navigation", { name: "Bagian organisasi" })).toBeInTheDocument();
    expect(screen.queryByText("Memuat data organisasi...")).not.toBeInTheDocument();
  });

  it("error org_overview tampil, dan Coba baca lagi memuat ulang", async () => {
    const user = userEvent.setup();
    let fail = true;
    answer({
      org_overview: () => {
        if (fail) throw { code: "database", message: "Database terkunci." };
        return overview();
      },
    });
    renderOrg();
    expect(await screen.findByText("Data organisasi belum terbaca")).toBeInTheDocument();
    expect(screen.getByText("Database terkunci.")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Bagian organisasi" })).not.toBeInTheDocument();

    fail = false;
    await user.click(screen.getByRole("button", { name: "Coba baca lagi" }));
    expect(await screen.findByRole("navigation", { name: "Bagian organisasi" })).toBeInTheDocument();
    expect(screen.queryByText("Data organisasi belum terbaca")).not.toBeInTheDocument();
  });
});

describe("Organisasi: tab per peran", () => {
  it("superadmin melihat Pengguna, Departemen, Permintaan bergabung, Label, Undangan", async () => {
    answer();
    renderOrg();
    await screen.findByRole("navigation", { name: "Bagian organisasi" });
    expect(tabNames()).toEqual(["Pengguna", "Departemen", "Permintaan bergabung", "Label", "Undangan"]);
    expect(screen.getByRole("button", { name: "Pengguna" })).toHaveAttribute("aria-current", "true");
  });

  it("admin departemen melihat Anggota, Departemen, Permintaan bergabung, Undangan", async () => {
    answer({ org_overview: adminOverview() });
    renderOrg();
    await screen.findByRole("navigation", { name: "Bagian organisasi" });
    expect(tabNames()).toEqual(["Anggota", "Departemen", "Permintaan bergabung", "Undangan"]);
    expect(screen.getByRole("button", { name: "Anggota" })).toHaveAttribute("aria-current", "true");
  });

  it("anggota biasa melihat Anggota, Departemen, Undangan", async () => {
    answer({ org_overview: memberOverview(), get_directory: directory(plainMember) });
    renderOrg();
    await screen.findByRole("navigation", { name: "Bagian organisasi" });
    expect(tabNames()).toEqual(["Anggota", "Departemen", "Undangan"]);
    expect(screen.queryByRole("button", { name: /Permintaan bergabung/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Label" })).not.toBeInTheDocument();
  });

  it("pindah tab memindah aria-current, dan setiap tab terbuka tanpa error", async () => {
    const user = userEvent.setup();
    answer();
    renderOrg();
    await screen.findByRole("navigation", { name: "Bagian organisasi" });
    for (const name of ["Departemen", "Permintaan bergabung", "Label", "Undangan", "Pengguna"]) {
      const tab = screen.getByRole("button", { name });
      await user.click(tab);
      expect(tab).toHaveAttribute("aria-current", "true");
      const others = within(screen.getByRole("navigation", { name: "Bagian organisasi" }))
        .getAllByRole("button")
        .filter((b) => b !== tab);
      others.forEach((b) => expect(b).not.toHaveAttribute("aria-current"));
    }
    expect(screen.queryByText("Data organisasi belum terbaca")).not.toBeInTheDocument();
  });

  it("anggota biasa membuka tab Anggota dan Departemen tanpa error", async () => {
    const user = userEvent.setup();
    answer({ org_overview: memberOverview(), get_directory: directory(plainMember) });
    renderOrg();
    await user.click(await screen.findByRole("button", { name: "Departemen" }));
    expect(screen.getByRole("button", { name: "Departemen" })).toHaveAttribute("aria-current", "true");
    await user.click(screen.getByRole("button", { name: "Anggota" }));
    expect(screen.getByRole("button", { name: "Anggota" })).toHaveAttribute("aria-current", "true");
  });
});

describe("Organisasi: angka permintaan bergabung", () => {
  it("tampil di tab, dengan arti untuk pembaca layar", async () => {
    answer({ org_overview: overview({ pendingJoinCount: 3 }) });
    renderOrg();
    const tab = await screen.findByRole("button", { name: "Permintaan bergabung, 3 menunggu" });
    expect(within(tab).getByText("3")).toBeInTheDocument();
  });

  it("di atas 99 ditulis 99+", async () => {
    answer({ org_overview: overview({ pendingJoinCount: 120 }) });
    renderOrg();
    const tab = await screen.findByRole("button", { name: "Permintaan bergabung, 120 menunggu" });
    expect(within(tab).getByText("99+")).toBeInTheDocument();
  });

  it("tidak tampil kalau 0", async () => {
    answer({ org_overview: overview({ pendingJoinCount: 0 }) });
    renderOrg();
    const tab = await screen.findByRole("button", { name: "Permintaan bergabung" });
    expect(tab).toHaveTextContent(/^Permintaan bergabung$/);
  });
});

describe("Organisasi: header", () => {
  it("menampilkan nama organisasi dan sidiknya", async () => {
    answer();
    renderOrg();
    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();
    const head = screen.getByRole("heading", { name: "Organisasi", level: 1 }).closest("header") as HTMLElement;
    expect(within(head).getByText(/Kantor Uji/)).toBeInTheDocument();
    expect(within(head).getByText(/sidik/)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("org_fingerprint", undefined);
  });

  it("sidik gagal dibaca: header tetap tampil tanpa sidik", async () => {
    answer({ org_fingerprint: rustError("database", "Database terkunci.") });
    renderOrg();
    await screen.findByRole("navigation", { name: "Bagian organisasi" });
    const head = screen.getByRole("heading", { name: "Organisasi", level: 1 }).closest("header") as HTMLElement;
    expect(within(head).getByText("Kantor Uji")).toBeInTheDocument();
    expect(within(head).queryByText(/sidik/)).not.toBeInTheDocument();
    expect(screen.queryByText("Database terkunci.")).not.toBeInTheDocument();
  });
});

describe("Organisasi: peringatan superadmin tunggal", () => {
  const WARNING = "Organisasi ini baru punya satu superadmin";

  // Tab Undangan baru tampil setelah direktori (sumber jumlah superadmin) terbaca.
  async function directoryLoaded() {
    await userEvent.setup().click(await screen.findByRole("button", { name: "Undangan" }));
    await screen.findByRole("heading", { name: "Kode undangan" });
  }

  it("tampil untuk superadmin, dan tombolnya membuka tab Pengguna", async () => {
    const user = userEvent.setup();
    answer({ get_directory: directory({ superadminCount: 1 }) });
    renderOrg();
    expect(await screen.findByText(WARNING)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Departemen" }));
    expect(screen.getByRole("button", { name: "Departemen" })).toHaveAttribute("aria-current", "true");

    await user.click(screen.getByRole("button", { name: "Buka daftar Pengguna" }));
    expect(screen.getByRole("button", { name: "Pengguna" })).toHaveAttribute("aria-current", "true");
    // Sudah di Pengguna: tombol pindah tidak perlu lagi, peringatannya tetap.
    expect(screen.queryByRole("button", { name: "Buka daftar Pengguna" })).not.toBeInTheDocument();
    expect(screen.getByText(WARNING)).toBeInTheDocument();
  });

  it("tidak tampil kalau sudah dua superadmin", async () => {
    answer({ get_directory: directory({ superadminCount: 2 }) });
    renderOrg();
    await directoryLoaded();
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it("tidak tampil untuk yang bukan superadmin", async () => {
    answer({ org_overview: adminOverview(), get_directory: directory({ superadminCount: 1 }) });
    renderOrg();
    await directoryLoaded();
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });
});
