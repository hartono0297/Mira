import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, OrgInfo } from "../../api";
import type { DepartmentView, OrgOverview, PersonView } from "../../api/org";
import { appState, directory, router, rustError } from "../../test/fixtures";
import {
  department,
  memberOverview,
  overview,
  person,
  PK_B,
  PK_C,
  PK_D,
  TEAM_1,
  TEAM_2,
  TEAM_3,
} from "../../test/orgFixtures";
import { channelNameFor } from "./DepartmentsPanel";
import { OrgScreen } from "./OrgScreen";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
// Tab lain diuji di filenya sendiri; di sini cukup kerangka halaman dan tab Departemen.
vi.mock("./UsersPanel", () => ({ UsersPanel: () => null }));
vi.mock("./PeoplePanel", () => ({ PeoplePanel: () => null }));
vi.mock("./LabelsPanel", () => ({ LabelsPanel: () => null }));
vi.mock("./JoinRequestsPanel", () => ({ JoinRequestsPanel: () => null }));

const state = appState() as AppState & { organization: OrgInfo };

const desain = department(TEAM_1, "Desain", {
  memberCount: 3,
  admins: [{ publicKey: PK_C, displayName: "Citra" }],
  channelName: "desain",
});
const keuangan = department(TEAM_2, "Keuangan", { memberCount: 2 });
const interior = department(TEAM_3, "Interior", { memberCount: 0 });
const lanskap = department("6".repeat(32), "Lanskap", {
  archived: true,
  archivedAt: "2026-11-02T03:00:00Z",
  channelName: "lanskap",
});

const people: PersonView[] = [
  person(PK_B, "Bayu", { departmentId: TEAM_1 }),
  person(PK_C, "Citra", { departmentId: TEAM_1, departmentRole: "admin" }),
  person(PK_D, "Dewi Tamu", { departmentId: TEAM_1, isGuest: true, role: "guest" }),
];

type Table = Record<string, unknown>;

function setup(extra: Table = {}, ov: OrgOverview = overview()) {
  invoke.mockImplementation(
    router({
      org_overview: ov,
      get_directory: directory(),
      org_fingerprint: "ABCD-EFGH",
      org_users: [],
      org_labels: [],
      org_join_requests: [],
      org_departments: [desain, keuangan, interior, lanskap],
      org_people: people,
      ...(extra as Record<string, never>),
    }),
  );
  render(<OrgScreen state={state} onRefresh={vi.fn()} />);
}

async function openTab() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^Departemen$/ }));
  return user;
}

async function openTable() {
  const user = await openTab();
  await screen.findByRole("table", { name: "Departemen aktif" });
  return user;
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

describe("Departemen: keadaan", () => {
  it("menampilkan teks memuat sebelum data datang", async () => {
    setup({ org_departments: () => new Promise(() => {}) });
    await openTab();
    expect(screen.getByText("Memuat daftar departemen...")).toBeInTheDocument();
  });

  it("kosong untuk superadmin mengajak membuat departemen", async () => {
    setup({ org_departments: [] });
    await openTab();
    expect(
      await screen.findByText(
        "Belum ada departemen. Buat departemen pertama, lalu pindahkan orang ke sana lewat tab Pengguna.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Departemen baru" })).toBeInTheDocument();
  });

  it("kosong untuk bukan superadmin menyebut siapa yang membuat", async () => {
    setup({ org_departments: [lanskap] }, memberOverview());
    await openTab();
    expect(await screen.findByText("Belum ada departemen. Superadmin yang membuat departemen.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Departemen baru" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Diarsipkan/)).not.toBeInTheDocument();
  });

  it("error menampilkan pesan Rust, Coba lagi memuat ulang", async () => {
    let fail = true;
    setup({
      org_departments: () => {
        if (fail) throw { code: "io", message: "Basis data sedang dipakai proses lain." };
        return [desain];
      },
    });
    const user = await openTab();
    expect(await screen.findByText("Daftar departemen belum terbaca")).toBeInTheDocument();
    expect(screen.getByText("Basis data sedang dipakai proses lain.")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByRole("table", { name: "Departemen aktif" })).toBeInTheDocument();
  });
});

describe("Departemen: daftar", () => {
  it("menampilkan nama, jumlah orang, admin, channel, dan departemen sendiri", async () => {
    setup();
    await openTable();
    expect(invoke).toHaveBeenCalledWith("org_departments", { includeArchived: true });
    const table = screen.getByRole("table", { name: "Departemen aktif" });
    const rows = within(table).getAllByRole("row");
    // Baris judul + tiga departemen aktif, urut nama.
    expect(rows).toHaveLength(4);
    expect(within(rows[1]).getByText("Desain")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Departemen Anda")).toBeInTheDocument();
    expect(within(rows[1]).getByText("3")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Citra")).toBeInTheDocument();
    expect(within(rows[1]).getByText("# desain")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Interior")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Belum ada")).toBeInTheDocument();
    expect(within(rows[3]).getByText("Keuangan")).toBeInTheDocument();
    expect(within(rows[3]).queryByText("Departemen Anda")).not.toBeInTheDocument();
    expect(screen.getByText("3 departemen aktif")).toBeInTheDocument();
    expect(screen.getByText("Diarsipkan (1)")).toBeInTheDocument();
  });

  it("bukan superadmin melihat daftar tanpa tombol aksi dan tanpa bagian Diarsipkan", async () => {
    setup({}, memberOverview());
    await openTab();
    const table = await screen.findByRole("table", { name: "Departemen aktif" });
    expect(within(table).queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Departemen baru" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Diarsipkan/)).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("org_people", undefined);
  });
});

describe("Departemen: buat", () => {
  it("membuat departemen dan menampilkan pesan berhasil", async () => {
    const created: DepartmentView = department("7".repeat(32), "Interior Kantor", { channelName: "interior-kantor" });
    setup({ org_create_department: created });
    const user = await openTable();
    await user.click(screen.getByRole("button", { name: "Departemen baru" }));
    const dialog = screen.getByRole("dialog", { name: "Departemen baru" });
    expect(within(dialog).getByText(/mendapat channel chat sendiri/)).toBeInTheDocument();
    const input = within(dialog).getByLabelText("Nama departemen");
    expect(input).toHaveFocus();
    await user.type(input, "  Interior Kantor ");
    expect(within(dialog).getByText("Nama channel: # interior-kantor")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Buat departemen" }));
    expect(invoke).toHaveBeenCalledWith("org_create_department", { name: "Interior Kantor" });
    expect(await screen.findByText("Departemen Interior Kantor dibuat, dengan channel # interior-kantor.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("nama kosong ditolak di isian tanpa memanggil Rust", async () => {
    setup();
    const user = await openTable();
    await user.click(screen.getByRole("button", { name: "Departemen baru" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Buat departemen" }));
    expect(within(dialog).getByText("Isi nama departemen dulu.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Nama departemen")).toHaveAttribute("aria-invalid", "true");
    expect(invoke).not.toHaveBeenCalledWith("org_create_department", expect.anything());
  });

  it("error invalid_name dari Rust tampil di isian", async () => {
    setup({
      org_create_department: rustError("invalid_name", "Nama tim berisi karakter yang tidak diizinkan, misalnya baris baru atau tab."),
    });
    const user = await openTable();
    await user.click(screen.getByRole("button", { name: "Departemen baru" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Nama departemen"), "Gudang");
    await user.click(within(dialog).getByRole("button", { name: "Buat departemen" }));
    expect(await within(dialog).findByText(/karakter yang tidak diizinkan/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Nama departemen")).toHaveAttribute("aria-invalid", "true");
  });

  it("error lain dari Rust tampil sebagai kotak error di dialog", async () => {
    setup({ org_create_department: rustError("forbidden", "Hanya superadmin yang boleh melakukan ini.") });
    const user = await openTable();
    await user.click(screen.getByRole("button", { name: "Departemen baru" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Nama departemen"), "Gudang");
    await user.click(within(dialog).getByRole("button", { name: "Buat departemen" }));
    expect(await within(dialog).findByText("Departemen belum dibuat")).toBeInTheDocument();
    expect(within(dialog).getByText("Hanya superadmin yang boleh melakukan ini.")).toBeInTheDocument();
  });

  it("Escape menutup dialog", async () => {
    setup();
    const user = await openTable();
    await user.click(screen.getByRole("button", { name: "Departemen baru" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("Departemen: ganti nama", () => {
  it("menyimpan nama baru dengan argumen yang benar", async () => {
    setup();
    const user = await openTable();
    await user.click(screen.getByRole("button", { name: "Ganti nama Desain" }));
    const input = screen.getByLabelText("Nama baru untuk departemen Desain");
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, "Desain Arsitektur");
    expect(screen.getByText("Channel # desain ikut menjadi # desain-arsitektur.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Simpan nama" }));
    expect(invoke).toHaveBeenCalledWith("org_rename_department", { teamId: TEAM_1, name: "Desain Arsitektur" });
    expect(
      await screen.findByText("Departemen Desain sekarang bernama Desain Arsitektur. Channelnya menjadi # desain-arsitektur."),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Ganti nama Desain" })).toHaveFocus());
  });

  it("Escape membatalkan dan mengembalikan fokus ke tombol Ganti nama", async () => {
    setup();
    const user = await openTable();
    await user.click(screen.getByRole("button", { name: "Ganti nama Keuangan" }));
    await user.type(screen.getByLabelText("Nama baru untuk departemen Keuangan"), " Baru");
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Nama baru untuk departemen Keuangan")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ganti nama Keuangan" })).toHaveFocus();
    expect(invoke).not.toHaveBeenCalledWith("org_rename_department", expect.anything());
  });

  it("error invalid_name dari Rust tampil di isian", async () => {
    setup({ org_rename_department: rustError("invalid_name", "Nama tim paling banyak 60 karakter.") });
    const user = await openTable();
    await user.click(screen.getByRole("button", { name: "Ganti nama Desain" }));
    const input = screen.getByLabelText("Nama baru untuk departemen Desain");
    await user.type(input, " Baru");
    await user.click(screen.getByRole("button", { name: "Simpan nama" }));
    expect(await screen.findByText("Nama tim paling banyak 60 karakter.")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("nama channel ditiru dari aturan Rust", () => {
    expect(channelNameFor("  Tim Desain Grafis ")).toBe("tim-desain-grafis");
  });
});

describe("Departemen: arsipkan dan pulihkan", () => {
  it("Arsipkan hanya muncul untuk departemen kosong, petunjuk muncul sekali", async () => {
    setup();
    await openTable();
    expect(screen.getByRole("button", { name: "Arsipkan Interior" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Arsipkan Desain" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Arsipkan Keuangan" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/pindahkan orangnya dulu/)).toHaveLength(1);
  });

  it("mengarsipkan setelah konfirmasi, lalu fokus pindah ke bagian Diarsipkan", async () => {
    let list = [desain, keuangan, interior, lanskap];
    setup({
      org_departments: () => list,
      org_set_department_archived: (args: { teamId: string; archived: boolean }) => {
        list = list.map((d) => (d.id === args.teamId ? { ...d, archived: args.archived, archivedAt: "2026-11-23T03:00:00Z" } : d));
        return null;
      },
    });
    const user = await openTable();
    await user.click(screen.getByRole("button", { name: "Arsipkan Interior" }));
    const dialog = screen.getByRole("dialog", { name: "Arsipkan Interior?" });
    expect(within(dialog).getByText(/menjadi\s+hanya-baca/)).toBeInTheDocument();
    expect(within(dialog).getByText(/tidak bisa dipilih lagi saat orang bergabung atau diundang/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Batal" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Arsipkan Interior" }));
    expect(invoke).toHaveBeenCalledWith("org_set_department_archived", { teamId: TEAM_3, archived: true });
    expect(await screen.findByText("Departemen Interior diarsipkan.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Diarsipkan (2)").closest("summary")).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Arsipkan Interior" })).not.toBeInTheDocument();
  });

  it("error Rust saat mengarsipkan ditampilkan", async () => {
    setup({ org_set_department_archived: rustError("department_not_empty", "Departemen ini masih punya orang.") });
    const user = await openTable();
    await user.click(screen.getByRole("button", { name: "Arsipkan Interior" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Arsipkan Interior" }));
    expect(await screen.findByText("Departemen ini masih punya orang.")).toBeInTheDocument();
  });

  it("memulihkan departemen dari bagian Diarsipkan, lalu fokus pindah ke barisnya", async () => {
    let list = [desain, keuangan, interior, lanskap];
    setup({
      org_departments: () => list,
      org_set_department_archived: (args: { teamId: string; archived: boolean }) => {
        list = list.map((d) => (d.id === args.teamId ? { ...d, archived: args.archived, archivedAt: null } : d));
        return null;
      },
    });
    const user = await openTable();
    await user.click(screen.getByText("Diarsipkan (1)"));
    expect(screen.getByText("Diarsipkan 2 November 2026. Channel # lanskap, hanya-baca.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pulihkan Lanskap" }));
    expect(invoke).toHaveBeenCalledWith("org_set_department_archived", { teamId: lanskap.id, archived: false });
    expect(await screen.findByText("Departemen Lanskap dipulihkan.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Ganti nama Lanskap" })).toHaveFocus());
    expect(screen.queryByText(/^Diarsipkan \(/)).not.toBeInTheDocument();
  });
});

describe("Departemen: atur admin", () => {
  it("menjadikan dan melepas admin departemen per orang, tanpa Tamu", async () => {
    setup();
    const user = await openTable();
    await user.click(screen.getByRole("button", { name: "Atur admin Desain" }));
    const dialog = screen.getByRole("dialog", { name: "Admin departemen Desain" });
    expect(within(dialog).queryByText("Dewi Tamu")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Lepas admin, Citra" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Jadikan admin, Bayu" }));
    expect(invoke).toHaveBeenCalledWith("org_set_department_admin", { teamId: TEAM_1, publicKey: PK_B, admin: true });
    expect(await screen.findByText("Bayu sekarang admin departemen Desain.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Lepas admin, Citra" }));
    expect(invoke).toHaveBeenCalledWith("org_set_department_admin", { teamId: TEAM_1, publicKey: PK_C, admin: false });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("error Rust tampil di dialog", async () => {
    setup({ org_set_department_admin: rustError("forbidden", "Hanya superadmin yang boleh melakukan ini.") });
    const user = await openTable();
    await user.click(screen.getByRole("button", { name: "Atur admin Desain" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Jadikan admin, Bayu" }));
    expect(await within(dialog).findByText("Hanya superadmin yang boleh melakukan ini.")).toBeInTheDocument();
  });

  it("departemen kosong menjelaskan bahwa orang perlu dipindah dulu", async () => {
    setup();
    const user = await openTable();
    await user.click(screen.getByRole("button", { name: "Atur admin Interior" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Pindahkan orang ke departemen ini dulu lewat tab Pengguna/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Jadikan admin/ })).not.toBeInTheDocument();
  });
});
