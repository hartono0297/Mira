import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, OrgInfo } from "../../api";
import { formatDate } from "../../api/format";
import type { UserView } from "../../api/org";
import { appState, directory, router, rustError } from "../../test/fixtures";
import { adminOverview, department, label, LABEL_1, ME, overview, PK_B, PK_C, PK_D, TEAM_1, TEAM_2, TEAM_3, user } from "../../test/orgFixtures";
import { OrgScreen } from "./OrgScreen";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const state = appState() as AppState & { organization: OrgInfo };
const PK_E = "e".repeat(64);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

const departments = [
  department(TEAM_1, "Desain", { channelName: "desain" }),
  department(TEAM_2, "Keuangan", { channelName: "keuangan" }),
  department(TEAM_3, "Drafting", { channelName: "drafting" }),
];

function people(): UserView[] {
  return [
    user(ME, "Penguji", { role: "superadmin", isSuperadmin: true, lastIp: null, online: false }),
    user(PK_B, "Sari", {
      canSuspend: true,
      canRemove: true,
      device: { laptop: "LAPTOP-DRAFT-02", os: "Windows 11 24H2", appVersion: "0.3.0", reportedAt: hoursAgo(3) },
      lastIp: "192.168.1.42",
      online: false,
      lastSeenAt: hoursAgo(2),
      labels: [{ id: LABEL_1, name: "Arsitek" }],
    }),
    user(PK_C, "Wulan", {
      role: "team_admin",
      canSuspend: true,
      canRemove: true,
      departmentId: TEAM_2,
      departmentName: "Keuangan",
      departmentRole: "admin",
      device: null,
      lastIp: null,
      online: false,
      lastSeenAt: null,
    }),
    user(PK_D, "Yusuf", {
      role: "guest",
      isGuest: true,
      canSuspend: true,
      canRemove: true,
      departmentId: null,
      departmentName: null,
      departmentRole: null,
      device: { laptop: "MacBook-Klien", os: "macOS 15.1", appVersion: "0.2.0", reportedAt: hoursAgo(1) },
      lastIp: "192.168.1.77",
      online: true,
      guestProjectCount: 1,
    }),
    user(PK_E, "Dimas", { status: "removed", removedAt: "2026-11-21T02:00:00Z", online: false }),
  ];
}

function renderUsers(table: Record<string, unknown> = {}) {
  invoke.mockImplementation(
    router({
      org_overview: overview(),
      get_directory: directory(),
      org_fingerprint: "ABCD-EFGH",
      org_users: people(),
      org_departments: departments,
      org_labels: [label(LABEL_1, "Arsitek", [PK_B])],
      org_suspend_gate: { allowed: true, outdated: [] },
      ...(table as Record<string, never>),
    }),
  );
  const ue = userEvent.setup();
  render(<OrgScreen state={state} onRefresh={vi.fn()} />);
  return ue;
}

async function openTab(ue: ReturnType<typeof userEvent.setup>) {
  await ue.click(await screen.findByRole("button", { name: "Pengguna" }));
}

// Teks peran di bawah nama, dipakai sebagai sasaran klik kanan.
function roleTextOf(name: string): string {
  return { Sari: "Anggota", Penguji: "Superadmin", Yusuf: "Tamu" }[name] ?? "Anggota";
}

function rowOf(name: string): HTMLElement {
  const row = screen
    .getAllByRole("row")
    .find((r) => r.querySelector(".nwl-name")?.textContent?.startsWith(name));
  if (!row) throw new Error(`Baris ${name} tidak ada`);
  return row;
}

async function ready(ue: ReturnType<typeof userEvent.setup>) {
  await openTab(ue);
  await screen.findByText("Sari");
}

async function openMenuItem(ue: ReturnType<typeof userEvent.setup>, who: string, item: string) {
  await ue.click(screen.getByRole("button", { name: `Aksi untuk ${who}` }));
  await ue.click(screen.getByRole("menuitem", { name: item }));
}

// Id item di menu yang sedang terbuka, berurutan.
function menuIds(): (string | null)[] {
  return within(screen.getByRole("menu")).getAllByRole("menuitem").map((el) => el.getAttribute("data-menu-item"));
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

describe("Pengguna: data", () => {
  it("menampilkan laptop, IP, sistem, status, peran, dan tanggal bergabung", async () => {
    const ue = renderUsers();
    await ready(ue);

    const sari = rowOf("Sari");
    expect(within(sari).getByText("LAPTOP-DRAFT-02")).toBeInTheDocument();
    expect(within(sari).getByText("192.168.1.42")).toBeInTheDocument();
    expect(within(sari).getByText("Windows 11 24H2")).toBeInTheDocument();
    expect(within(sari).getByText("Mira 0.3.0")).toBeInTheDocument();
    expect(within(sari).getByText("Terakhir terlihat 2 jam lalu")).toBeInTheDocument();
    expect(within(sari).getByText("Anggota")).toBeInTheDocument();
    expect(within(sari).getByText("Arsitek")).toBeInTheDocument();
    expect(within(sari).getByText("Desain")).toBeInTheDocument();
    expect(within(sari).getByText(formatDate("2026-11-04T02:00:00Z"))).toBeInTheDocument();

    const me = rowOf("Penguji");
    expect(within(me).getByText("(Anda)", { exact: false })).toBeInTheDocument();
    expect(within(me).getByText("Superadmin")).toBeInTheDocument();
    // IP laptop ini dan statusnya.
    expect(within(me).getByText("Laptop ini")).toBeInTheDocument();
    expect(within(me).getByText("Tidak dicatat")).toBeInTheDocument();

    const wulan = rowOf("Wulan");
    expect(within(wulan).getByText("Admin departemen")).toBeInTheDocument();
    expect(within(wulan).getByText("Keuangan")).toBeInTheDocument();
    expect(within(wulan).getAllByText("Belum dilaporkan").length).toBeGreaterThan(0);
    expect(within(wulan).getByText("Belum terlihat")).toBeInTheDocument();
    expect(within(wulan).getByText("Belum pernah terlihat")).toBeInTheDocument();

    const yusuf = rowOf("Yusuf");
    expect(within(yusuf).getByText("Tamu, 1 proyek")).toBeInTheDocument();
    expect(within(yusuf).getByText("Tamu")).toBeInTheDocument();
    expect(within(yusuf).getByText("Online")).toBeInTheDocument();
    expect(within(yusuf).getByText("macOS 15.1")).toBeInTheDocument();
    expect(within(yusuf).getByText("Mira 0.2.0")).toBeInTheDocument();

    // Orang yang sudah dikeluarkan hanya tampil dengan saringan Dikeluarkan.
    expect(screen.queryByText("Dimas")).not.toBeInTheDocument();
    expect(screen.getByText("4 orang")).toBeInTheDocument();
  });

  it("superadmin yang juga admin departemen ditulis keduanya", async () => {
    const ue = renderUsers({
      org_users: [user(ME, "Penguji", { isSuperadmin: true, departmentRole: "admin", lastIp: null })],
    });
    await openTab(ue);
    expect(await screen.findByText("Superadmin, admin departemen")).toBeInTheDocument();
  });

  it("menampilkan keadaan memuat", async () => {
    let resolve: (v: UserView[]) => void = () => {};
    const ue = renderUsers({ org_users: () => new Promise<UserView[]>((r) => (resolve = r)) });
    await openTab(ue);
    expect(screen.getByText("Memuat daftar pengguna...")).toBeInTheDocument();
    resolve(people());
    expect(await screen.findByText("Sari")).toBeInTheDocument();
  });

  it("error membaca daftar bisa dicoba lagi", async () => {
    let fail = true;
    const ue = renderUsers({
      org_users: () => {
        if (fail) throw { code: "database", message: "Database terkunci." };
        return people();
      },
    });
    await openTab(ue);
    expect(await screen.findByText("Daftar pengguna belum terbaca")).toBeInTheDocument();
    expect(screen.getByText("Database terkunci.").closest("[role=alert]")).not.toBeNull();
    fail = false;
    await ue.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByText("Sari")).toBeInTheDocument();
  });

  it("hanya Anda: diajak membuat kode undangan", async () => {
    const ue = renderUsers({ org_users: [user(ME, "Penguji", { isSuperadmin: true, lastIp: null })] });
    await openTab(ue);
    expect(await screen.findByText(/Baru Anda di organisasi ini. Buat kode undangan di tab Undangan/)).toBeInTheDocument();
  });
});

describe("Pengguna: cari dan saring", () => {
  it("mencari nama, label, laptop, dan IP", async () => {
    const ue = renderUsers();
    await ready(ue);
    const search = screen.getByRole("searchbox", { name: "Cari" });

    await ue.type(search, "draft-02");
    expect(screen.getByText("1 orang")).toBeInTheDocument();
    expect(rowOf("Sari")).toBeInTheDocument();
    expect(screen.queryByText("Wulan")).not.toBeInTheDocument();

    await ue.clear(search);
    await ue.type(search, "192.168.1.77");
    expect(rowOf("Yusuf")).toBeInTheDocument();
    expect(screen.queryByText("Sari")).not.toBeInTheDocument();

    await ue.clear(search);
    await ue.type(search, "arsitek");
    expect(rowOf("Sari")).toBeInTheDocument();
    expect(screen.getByText("1 orang")).toBeInTheDocument();

    await ue.clear(search);
    await ue.type(search, "wul");
    expect(rowOf("Wulan")).toBeInTheDocument();
    expect(screen.getByText("1 orang")).toBeInTheDocument();
  });

  it("menyaring departemen dan Tamu", async () => {
    const ue = renderUsers();
    await ready(ue);
    const dept = screen.getByRole("combobox", { name: "Departemen" });

    await ue.selectOptions(dept, "Keuangan");
    expect(rowOf("Wulan")).toBeInTheDocument();
    expect(screen.queryByText("Sari")).not.toBeInTheDocument();
    expect(screen.getByText("1 orang")).toBeInTheDocument();

    await ue.selectOptions(dept, "Tamu");
    expect(rowOf("Yusuf")).toBeInTheDocument();
    expect(screen.queryByText("Wulan")).not.toBeInTheDocument();
  });

  it("menyaring status online, offline, dan dikeluarkan", async () => {
    const ue = renderUsers();
    await ready(ue);
    const status = screen.getByRole("combobox", { name: "Status" });

    await ue.selectOptions(status, "Online");
    expect(rowOf("Penguji")).toBeInTheDocument();
    expect(rowOf("Yusuf")).toBeInTheDocument();
    expect(screen.queryByText("Sari")).not.toBeInTheDocument();
    expect(screen.getByText("2 orang")).toBeInTheDocument();

    await ue.selectOptions(status, "Offline");
    expect(rowOf("Sari")).toBeInTheDocument();
    expect(rowOf("Wulan")).toBeInTheDocument();
    expect(screen.queryByText("Yusuf")).not.toBeInTheDocument();

    await ue.selectOptions(status, "Dikeluarkan");
    const dimas = rowOf("Dimas");
    expect(within(dimas).getByText(`Dikeluarkan ${formatDate("2026-11-21T02:00:00Z")}`)).toBeInTheDocument();
    expect(within(dimas).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("1 orang")).toBeInTheDocument();
  });

  it("hasil saring kosong menyebut saringannya dan bisa dilonggarkan", async () => {
    const ue = renderUsers();
    await ready(ue);
    await ue.selectOptions(screen.getByRole("combobox", { name: "Departemen" }), "Keuangan");
    await ue.selectOptions(screen.getByRole("combobox", { name: "Status" }), "Online");

    expect(screen.getByText("Tidak ada orang Keuangan yang sedang online")).toBeInTheDocument();
    expect(screen.getByText("1 orang di Keuangan sedang offline.")).toBeInTheDocument();
    expect(screen.getByText("0 orang")).toBeInTheDocument();

    await ue.click(screen.getByRole("button", { name: "Hapus saringan status" }));
    expect(rowOf("Wulan")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("current");
    expect(screen.getByRole("combobox", { name: "Departemen" })).toHaveValue(TEAM_2);
  });

  it("tanpa departemen kosong: tombol melepas saringan departemen", async () => {
    const ue = renderUsers();
    await ready(ue);
    await ue.selectOptions(screen.getByRole("combobox", { name: "Departemen" }), "Belum ada departemen");
    expect(screen.getByText("Tidak ada orang tanpa departemen")).toBeInTheDocument();
    await ue.click(screen.getByRole("button", { name: "Hapus saringan departemen" }));
    expect(rowOf("Sari")).toBeInTheDocument();
    expect(screen.getByText("4 orang")).toBeInTheDocument();
  });
});

describe("Pengguna: menu aksi", () => {
  it("dibuka dengan keyboard, ditutup dengan Escape, fokus kembali", async () => {
    const ue = renderUsers();
    await ready(ue);
    const toggle = screen.getByRole("button", { name: "Aksi untuk Sari" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    toggle.focus();
    await ue.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "Aksi untuk Sari" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Ubah departemen" })).toHaveFocus();
    await ue.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Ubah peran" })).toHaveFocus();
    await ue.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
    expect(screen.queryByRole("menuitem", { name: "Ubah departemen" })).not.toBeInTheDocument();
  });

  it("klik di luar menutup menu", async () => {
    const ue = renderUsers();
    await ready(ue);
    const toggle = screen.getByRole("button", { name: "Aksi untuk Sari" });
    await ue.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await ue.click(screen.getByRole("heading", { name: "Pengguna" }));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("Tamu tidak punya Ubah departemen dan Ubah peran; diri sendiri tidak punya Nonaktifkan atau keluarkan", async () => {
    const ue = renderUsers();
    await ready(ue);
    await ue.click(screen.getByRole("button", { name: "Aksi untuk Yusuf" }));
    expect(menuIds()).toEqual(["takeout"]);
    expect(screen.getByRole("menuitem", { name: "Nonaktifkan atau keluarkan" })).toBeInTheDocument();
    await ue.keyboard("{Escape}");

    await ue.click(screen.getByRole("button", { name: "Aksi untuk Penguji" }));
    expect(menuIds()).toEqual(["move", "role"]);
    expect(screen.queryByRole("menuitem", { name: "Nonaktifkan atau keluarkan" })).not.toBeInTheDocument();
  });

  it("klik kanan di baris membuka menu yang sama dengan tombol titik tiga", async () => {
    const ue = renderUsers();
    await ready(ue);
    for (const who of ["Sari", "Penguji", "Yusuf"]) {
      await ue.click(screen.getByRole("button", { name: `Aksi untuk ${who}` }));
      const fromButton = menuIds();
      await ue.keyboard("{Escape}");

      await ue.pointer({ keys: "[MouseRight]", target: within(rowOf(who)).getByText(roleTextOf(who)) });
      expect(screen.getByRole("menu", { name: `Aksi untuk ${who}` })).toBeInTheDocument();
      expect(menuIds()).toEqual(fromButton);
      await ue.keyboard("{Escape}");
    }
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("klik kanan lalu Nonaktifkan atau keluarkan membuka dialog pilihan", async () => {
    const ue = renderUsers();
    await ready(ue);
    await ue.pointer({ keys: "[MouseRight]", target: within(rowOf("Sari")).getByText("LAPTOP-DRAFT-02") });
    const takeOut = screen.getByRole("menuitem", { name: "Nonaktifkan atau keluarkan" });
    expect(takeOut).toHaveClass("cmenu-danger");
    await ue.click(takeOut);
    const dialog = await screen.findByRole("dialog", { name: "Nonaktifkan atau keluarkan Sari?" });
    await ue.click(within(dialog).getByRole("button", { name: "Batal" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(invoke).not.toHaveBeenCalledWith("org_suspend_member", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("org_remove_member", expect.anything());
    expect(screen.getByRole("button", { name: "Aksi untuk Sari" })).toHaveFocus();
  });

  it("Shift+F10 dari baris yang terfokus membuka menu, Escape mengembalikan fokus", async () => {
    const ue = renderUsers();
    await ready(ue);
    const toggle = screen.getByRole("button", { name: "Aksi untuk Wulan" });
    toggle.focus();
    await ue.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menu", { name: "Aksi untuk Wulan" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Ubah departemen" })).toHaveFocus();
    expect(menuIds()).toEqual(["move", "role", "takeout"]);
    await ue.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });

  it("orang yang sudah dikeluarkan tidak punya menu", async () => {
    const ue = renderUsers();
    await ready(ue);
    await ue.selectOptions(screen.getByRole("combobox", { name: "Status" }), "Dikeluarkan");
    const dimas = rowOf("Dimas");
    await ue.pointer({ keys: "[MouseRight]", target: within(dimas).getByText("Anggota") });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(within(dimas).queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("Pengguna: ubah departemen", () => {
  it("memindah orang ke departemen lain", async () => {
    const ue = renderUsers();
    await ready(ue);
    await openMenuItem(ue, "Sari", "Ubah departemen");

    const dialog = await screen.findByRole("dialog", { name: "Ubah departemen Sari" });
    expect(within(dialog).getByText("Desain")).toBeInTheDocument();
    const select = within(dialog).getByRole("combobox", { name: "Pindah ke" });
    const options = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Pilih departemen", "Drafting", "Keuangan"]);
    expect(select).toHaveValue("");
    expect(within(dialog).getByRole("button", { name: "Pindahkan" })).toBeDisabled();
    expect(dialog).not.toHaveTextContent("Keanggotaan proyek");

    await ue.selectOptions(select, "Keuangan");
    expect(dialog).toHaveTextContent("Sari keluar dari # desain dan masuk ke # keuangan. Riwayat # desain tidak terlihat lagi olehnya.");
    expect(dialog).toHaveTextContent("Keanggotaan proyek dan grup tidak berubah.");

    await ue.click(within(dialog).getByRole("button", { name: "Pindahkan" }));
    expect(invoke).toHaveBeenCalledWith("org_move_member", { publicKey: PK_B, teamId: TEAM_2 });
    expect(await screen.findByText("Sari sekarang di departemen Keuangan.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("admin departemen diberi tahu hak adminnya hilang", async () => {
    const ue = renderUsers();
    await ready(ue);
    await openMenuItem(ue, "Wulan", "Ubah departemen");
    const dialog = await screen.findByRole("dialog", { name: "Ubah departemen Wulan" });
    await ue.selectOptions(within(dialog).getByRole("combobox", { name: "Pindah ke" }), "Desain");
    expect(within(dialog).getByText(/Hak admin departemen Keuangan juga hilang/)).toBeInTheDocument();
  });

  it("gagal: pesan Rust tampil di dialog, kata tim menjadi departemen", async () => {
    const ue = renderUsers({ org_move_member: rustError("forbidden", "Hanya admin tim yang boleh memindah orang.") });
    await ready(ue);
    await openMenuItem(ue, "Sari", "Ubah departemen");
    const dialog = await screen.findByRole("dialog");
    await ue.selectOptions(within(dialog).getByRole("combobox", { name: "Pindah ke" }), "Drafting");
    await ue.click(within(dialog).getByRole("button", { name: "Pindahkan" }));
    expect(await within(dialog).findByText("Hanya admin departemen yang boleh memindah orang.")).toBeInTheDocument();
    expect(within(dialog).getByText("Anda tidak punya izin untuk ini")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Escape menutup dialog dan fokus kembali ke tombol aksi", async () => {
    const ue = renderUsers();
    await ready(ue);
    await openMenuItem(ue, "Sari", "Ubah departemen");
    await screen.findByRole("dialog");
    await ue.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Aksi untuk Sari" })).toHaveFocus();
  });
});

describe("Pengguna: ubah departemen lewat klik kanan", () => {
  it("dialog dibuka dari menu klik kanan dan fokus kembali ke tombol aksi baris", async () => {
    const ue = renderUsers();
    await ready(ue);
    await ue.pointer({ keys: "[MouseRight]", target: within(rowOf("Sari")).getByText("Desain") });
    await ue.click(screen.getByRole("menuitem", { name: "Ubah departemen" }));
    await screen.findByRole("dialog", { name: "Ubah departemen Sari" });
    await ue.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Aksi untuk Sari" })).toHaveFocus();
  });
});

describe("Pengguna: ubah peran", () => {
  it("melepas admin departemen dan menjadikan superadmin, berurutan", async () => {
    const ue = renderUsers();
    await ready(ue);
    await openMenuItem(ue, "Wulan", "Ubah peran");
    const dialog = await screen.findByRole("dialog", { name: "Ubah peran Wulan" });
    const save = within(dialog).getByRole("button", { name: "Simpan peran" });
    expect(save).toBeDisabled();

    await ue.click(within(dialog).getByRole("radio", { name: /Anggota/ }));
    await ue.click(within(dialog).getByRole("checkbox", { name: /Jadikan superadmin/ }));
    await ue.click(save);

    expect(invoke).toHaveBeenCalledWith("org_set_department_admin", { teamId: TEAM_2, publicKey: PK_C, admin: false });
    expect(invoke).toHaveBeenCalledWith("add_superadmin", { publicKey: PK_C });
    const order = invoke.mock.calls.map((c) => c[0]);
    expect(order.indexOf("org_set_department_admin")).toBeLessThan(order.indexOf("add_superadmin"));
    expect(await screen.findByText("Peran Wulan sekarang: Superadmin.")).toBeInTheDocument();
  });

  it("menjadikan admin departemen", async () => {
    const ue = renderUsers();
    await ready(ue);
    await openMenuItem(ue, "Sari", "Ubah peran");
    const dialog = await screen.findByRole("dialog");
    await ue.click(within(dialog).getByRole("radio", { name: /Admin departemen/ }));
    await ue.click(within(dialog).getByRole("button", { name: "Simpan peran" }));
    expect(invoke).toHaveBeenCalledWith("org_set_department_admin", { teamId: TEAM_1, publicKey: PK_B, admin: true });
    expect(invoke).not.toHaveBeenCalledWith("add_superadmin", expect.anything());
    expect(await screen.findByText("Peran Sari sekarang: Admin departemen.")).toBeInTheDocument();
  });

  it("superadmin terakhir tidak bisa dilepas", async () => {
    const ue = renderUsers();
    await ready(ue);
    await openMenuItem(ue, "Penguji", "Ubah peran");
    const dialog = await screen.findByRole("dialog", { name: "Ubah peran Anda" });
    expect(within(dialog).getByRole("checkbox", { name: /Jadikan superadmin/ })).toBeDisabled();
    expect(within(dialog).getByText(/Anda satu-satunya superadmin/)).toBeInTheDocument();
  });

  it("last_superadmin dari Rust tampil di dialog", async () => {
    const list = people();
    list[1] = { ...list[1], isSuperadmin: true };
    const ue = renderUsers({
      org_users: list,
      remove_superadmin: rustError("last_superadmin", "Organisasi harus punya minimal satu superadmin."),
    });
    await ready(ue);
    await openMenuItem(ue, "Sari", "Ubah peran");
    const dialog = await screen.findByRole("dialog");
    const box = within(dialog).getByRole("checkbox", { name: /Jadikan superadmin/ });
    expect(box).toBeChecked();
    await ue.click(box);
    await ue.click(within(dialog).getByRole("button", { name: "Simpan peran" }));
    expect(invoke).toHaveBeenCalledWith("remove_superadmin", { publicKey: PK_B });
    expect(await within(dialog).findByText("Organisasi harus punya minimal satu superadmin.")).toBeInTheDocument();
    expect(within(dialog).getByText("Organisasi butuh minimal satu superadmin")).toBeInTheDocument();
    expect(within(dialog).getByText(/Jadikan orang lain superadmin dulu/)).toBeInTheDocument();
  });

  it("perubahan pertama gagal: perubahan kedua tidak dijalankan", async () => {
    const ue = renderUsers({ org_set_department_admin: rustError("not_found", "Departemen tidak ditemukan.") });
    await ready(ue);
    await openMenuItem(ue, "Wulan", "Ubah peran");
    const dialog = await screen.findByRole("dialog");
    await ue.click(within(dialog).getByRole("radio", { name: /Anggota/ }));
    await ue.click(within(dialog).getByRole("checkbox", { name: /Jadikan superadmin/ }));
    await ue.click(within(dialog).getByRole("button", { name: "Simpan peran" }));
    expect(await within(dialog).findByText("Departemen tidak ditemukan.")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("add_superadmin", expect.anything());
  });

  it("orang tanpa departemen hanya bisa diubah superadminnya", async () => {
    const ue = renderUsers({
      org_users: [
        user(ME, "Penguji", { isSuperadmin: true, lastIp: null }),
        user(PK_B, "Sari", { departmentId: null, departmentName: null, departmentRole: null }),
      ],
    });
    await ready(ue);
    await openMenuItem(ue, "Sari", "Ubah peran");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("radio")).not.toBeInTheDocument();
    expect(within(dialog).getByText(/Sari belum masuk departemen/)).toBeInTheDocument();
    await ue.click(within(dialog).getByRole("checkbox", { name: /Jadikan superadmin/ }));
    await ue.click(within(dialog).getByRole("button", { name: "Simpan peran" }));
    expect(invoke).toHaveBeenCalledWith("add_superadmin", { publicKey: PK_B });
    expect(invoke).not.toHaveBeenCalledWith("org_set_department_admin", expect.anything());
  });
});

const SUSPENDED_AT = "2026-11-23T03:00:00Z";

// Sari setelah dinonaktifkan oleh Penguji.
function suspendedSari(extra: Partial<UserView> = {}): UserView {
  return {
    ...people()[1],
    status: "suspended",
    role: "member",
    departmentId: null,
    departmentName: null,
    departmentRole: null,
    labels: [],
    online: false,
    suspendedAt: SUSPENDED_AT,
    suspendedByName: "Penguji",
    canSuspend: false,
    canReinstate: true,
    canRemove: true,
    ...extra,
  };
}

function withSuspended(extra: Partial<UserView> = {}): UserView[] {
  return people().map((p) => (p.publicKey === PK_B ? suspendedSari(extra) : p));
}

async function openTakeOut(ue: ReturnType<typeof userEvent.setup>, who = "Sari") {
  await openMenuItem(ue, who, "Nonaktifkan atau keluarkan");
  return screen.findByRole("dialog", { name: `Nonaktifkan atau keluarkan ${who}?` });
}

describe("Pengguna: nonaktifkan atau keluarkan", () => {
  it("Nonaktifkan terpilih lebih dulu, memanggil org_suspend_member, baris tetap tampil dengan status Nonaktif", async () => {
    let suspended = false;
    const ue = renderUsers({
      org_users: () => (suspended ? withSuspended() : people()),
      org_suspend_member: () => {
        suspended = true;
        return null;
      },
    });
    await ready(ue);
    const dialog = await openTakeOut(ue);
    const suspend = within(dialog).getByRole("radio", { name: /^Nonaktifkan/ });
    const remove = within(dialog).getByRole("radio", { name: /^Keluarkan permanen/ });
    await waitFor(() => expect(suspend).toBeChecked());
    expect(remove).not.toBeChecked();
    expect(dialog).toHaveTextContent("Bisa diaktifkan lagi nanti.");
    expect(dialog).toHaveTextContent("memakai laptop yang sama, datanya tetap ada");
    expect(dialog).toHaveTextContent("Tidak bisa dibatalkan.");
    expect(dialog).toHaveTextContent("laptopnya harus direset lalu meminta bergabung lagi");

    await ue.click(within(dialog).getByRole("button", { name: "Nonaktifkan Sari" }));
    expect(invoke).toHaveBeenCalledWith("org_suspend_member", { publicKey: PK_B });
    expect(invoke).not.toHaveBeenCalledWith("org_remove_member", expect.anything());
    expect(await screen.findByText(/Sari sekarang nonaktif/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    const sari = await waitFor(() => {
      const row = rowOf("Sari");
      expect(within(row).getByText("Nonaktif")).toBeInTheDocument();
      return row;
    });
    expect(within(sari).getByText(`Dinonaktifkan ${formatDate(SUSPENDED_AT)} oleh Penguji`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aksi untuk Sari" })).toHaveFocus();
  });

  it("Keluarkan permanen memanggil org_remove_member, baris hilang, fokus ke orang berikutnya", async () => {
    let gone = false;
    const ue = renderUsers({
      org_users: () => (gone ? people().filter((p) => p.publicKey !== PK_B) : people()),
      org_remove_member: () => {
        gone = true;
        return null;
      },
    });
    await ready(ue);
    const dialog = await openTakeOut(ue);
    await ue.click(within(dialog).getByRole("radio", { name: /^Keluarkan permanen/ }));
    const submit = within(dialog).getByRole("button", { name: "Keluarkan Sari permanen" });
    expect(submit).toHaveClass("btn-danger");
    await ue.click(submit);
    expect(invoke).toHaveBeenCalledWith("org_remove_member", { publicKey: PK_B });
    expect(invoke).not.toHaveBeenCalledWith("org_suspend_member", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("remove_member", expect.anything());
    expect(await screen.findByText("Sari sudah dikeluarkan permanen dari organisasi.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Sari")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Aksi untuk Wulan" })).toHaveFocus());
  });

  it("gerbang tertutup: Nonaktifkan tidak bisa dipilih dan laptop yang menghalangi disebut", async () => {
    const ue = renderUsers({
      org_suspend_gate: {
        allowed: false,
        outdated: [
          { name: "Wulan", appVersion: "0.5.0" },
          { name: "Yusuf", appVersion: null },
        ],
      },
    });
    await ready(ue);
    const dialog = await openTakeOut(ue);
    const suspend = within(dialog).getByRole("radio", { name: /^Nonaktifkan/ });
    await waitFor(() => expect(suspend).toBeDisabled());
    const note =
      "Belum bisa dipilih. Laptop berikut perlu diperbarui ke Mira 0.5.1 dulu: Wulan (Mira 0.5.0) dan Yusuf (versi belum dilaporkan). Kalau hanya perlu sementara, perbarui laptop itu dulu; Keluarkan permanen tidak bisa dibatalkan.";
    expect(within(dialog).getByText(note)).toBeInTheDocument();
    expect(suspend).toHaveAccessibleDescription(note);
    expect(suspend).not.toBeChecked();
    // Selama Nonaktifkan tertutup, fokus awal di Batal, bukan di Keluarkan permanen.
    expect(within(dialog).getByRole("button", { name: "Batal" })).toHaveFocus();

    // Keluar permanen tetap bisa, tapi harus dipilih sendiri.
    const submit = within(dialog).getByRole("button", { name: "Pilih salah satu dulu" });
    expect(submit).toBeDisabled();
    await ue.click(within(dialog).getByRole("radio", { name: /^Keluarkan permanen/ }));
    expect(within(dialog).getByRole("button", { name: "Keluarkan Sari permanen" })).toBeEnabled();
  });

  it("gagal: dialog tetap terbuka dan pesan Rust tampil di dalamnya", async () => {
    const ue = renderUsers({
      org_suspend_member: rustError("invalid", "Ada laptop yang belum diperbarui ke Mira 0.5.1: Wulan. Perbarui dulu, lalu coba lagi."),
    });
    await ready(ue);
    const dialog = await openTakeOut(ue);
    await waitFor(() => expect(within(dialog).getByRole("radio", { name: /^Nonaktifkan/ })).toBeChecked());
    await ue.click(within(dialog).getByRole("button", { name: "Nonaktifkan Sari" }));
    expect(await within(dialog).findByText(/Ada laptop yang belum diperbarui ke Mira 0.5.1: Wulan/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Nonaktifkan Sari" })).toBeEnabled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("menu mengikuti tanda dari inti Rust", async () => {
    const list = people().map((p) => {
      if (p.publicKey === PK_B) return { ...p, canSuspend: true, canRemove: false };
      if (p.publicKey === PK_C) return { ...p, canSuspend: false, canRemove: false };
      return p;
    });
    const ue = renderUsers({ org_users: list });
    await ready(ue);

    await ue.click(screen.getByRole("button", { name: "Aksi untuk Wulan" }));
    expect(menuIds()).toEqual(["move", "role"]);
    await ue.keyboard("{Escape}");

    await openMenuItem(ue, "Sari", "Nonaktifkan");
    const dialog = await screen.findByRole("dialog", { name: "Nonaktifkan Sari?" });
    expect(within(dialog).queryByRole("radio")).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("Keluarkan permanen");
    expect(await within(dialog).findByRole("button", { name: "Nonaktifkan Sari" })).toBeEnabled();
  });
});

describe("Pengguna: orang yang nonaktif", () => {
  it("tampil di saringan bawaan dengan status, tanggal, dan siapa yang menonaktifkan", async () => {
    const ue = renderUsers({ org_users: withSuspended() });
    await ready(ue);
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("current");
    const sari = rowOf("Sari");
    expect(sari).toHaveClass("ut-off");
    expect(within(sari).getByText("Nonaktif")).toBeInTheDocument();
    expect(within(sari).getByText(`Dinonaktifkan ${formatDate(SUSPENDED_AT)} oleh Penguji`)).toBeInTheDocument();
    expect(screen.getByText("4 orang")).toBeInTheDocument();

    // Online dan Offline hanya untuk yang aktif; Nonaktif hanya yang nonaktif.
    const status = screen.getByRole("combobox", { name: "Status" });
    await ue.selectOptions(status, "Offline");
    expect(screen.queryByText("Sari")).not.toBeInTheDocument();
    await ue.selectOptions(status, "Nonaktif");
    expect(rowOf("Sari")).toBeInTheDocument();
    expect(screen.getByText("1 orang")).toBeInTheDocument();
  });

  it("tanpa nama penonaktif: hanya tanggal", async () => {
    const ue = renderUsers({ org_users: withSuspended({ suspendedByName: null }) });
    await ready(ue);
    expect(within(rowOf("Sari")).getByText(`Dinonaktifkan ${formatDate(SUSPENDED_AT)}`)).toBeInTheDocument();
  });

  it("menu: Aktifkan lagi dan Keluarkan permanen, tanpa Ubah departemen dan Ubah peran", async () => {
    const ue = renderUsers({ org_users: withSuspended() });
    await ready(ue);
    await ue.click(screen.getByRole("button", { name: "Aksi untuk Sari" }));
    expect(menuIds()).toEqual(["reinstate", "remove"]);
    expect(screen.getByRole("menuitem", { name: "Keluarkan permanen" })).toHaveClass("cmenu-danger");
  });

  it("tanpa canReinstate hanya Keluarkan permanen; tanpa tanda apa pun tidak ada menu", async () => {
    const ue = renderUsers({
      org_users: [
        ...withSuspended({ canReinstate: false }),
        user("f".repeat(64), "Fajar", { status: "suspended", suspendedAt: SUSPENDED_AT, suspendedByName: "Wulan" }),
      ],
    });
    await ready(ue);
    await ue.click(screen.getByRole("button", { name: "Aksi untuk Sari" }));
    expect(menuIds()).toEqual(["remove"]);
    await ue.keyboard("{Escape}");
    expect(within(rowOf("Fajar")).queryByRole("button")).not.toBeInTheDocument();
    expect(within(rowOf("Fajar")).getByText(`Dinonaktifkan ${formatDate(SUSPENDED_AT)} oleh Wulan`)).toBeInTheDocument();
  });

  it("Aktifkan lagi memanggil org_reinstate_member dan status kembali", async () => {
    let back = false;
    const ue = renderUsers({
      org_users: () => (back ? people() : withSuspended()),
      org_reinstate_member: () => {
        back = true;
        return null;
      },
    });
    await ready(ue);
    await openMenuItem(ue, "Sari", "Aktifkan lagi");
    const dialog = await screen.findByRole("dialog", { name: "Aktifkan Sari lagi?" });
    expect(dialog).toHaveTextContent("laptop yang sama");
    expect(dialog).toHaveTextContent("tidak ikut kembali");
    expect(within(dialog).getByRole("button", { name: "Batal" })).toHaveFocus();
    const confirm = within(dialog).getByRole("button", { name: "Aktifkan Sari" });
    expect(confirm).not.toHaveClass("btn-danger");
    await ue.click(confirm);
    expect(invoke).toHaveBeenCalledWith("org_reinstate_member", { publicKey: PK_B });
    expect(await screen.findByText("Sari aktif lagi.")).toBeInTheDocument();
    await waitFor(() => expect(within(rowOf("Sari")).queryByText("Nonaktif")).not.toBeInTheDocument());
    expect(within(rowOf("Sari")).getByText("Terakhir terlihat 2 jam lalu")).toBeInTheDocument();
  });

  it("Keluarkan permanen dari status nonaktif memanggil org_remove_member", async () => {
    let gone = false;
    const ue = renderUsers({
      org_users: () => (gone ? people().filter((p) => p.publicKey !== PK_B) : withSuspended()),
      org_remove_member: () => {
        gone = true;
        return null;
      },
    });
    await ready(ue);
    await openMenuItem(ue, "Sari", "Keluarkan permanen");
    const dialog = await screen.findByRole("dialog", { name: "Keluarkan Sari permanen?" });
    expect(dialog).toHaveTextContent("Tidak bisa dibatalkan.");
    await ue.click(within(dialog).getByRole("button", { name: "Keluarkan Sari permanen" }));
    expect(invoke).toHaveBeenCalledWith("org_remove_member", { publicKey: PK_B });
    expect(await screen.findByText("Sari sudah dikeluarkan permanen dari organisasi.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Sari")).not.toBeInTheDocument());
  });

  it("Aktifkan lagi gagal: pesan tampil di dialog", async () => {
    const ue = renderUsers({
      org_users: withSuspended(),
      org_reinstate_member: rustError("target_not_suspended", "Orang itu tidak sedang dinonaktifkan."),
    });
    await ready(ue);
    await openMenuItem(ue, "Sari", "Aktifkan lagi");
    const dialog = await screen.findByRole("dialog");
    await ue.click(within(dialog).getByRole("button", { name: "Aktifkan Sari" }));
    expect(await within(dialog).findByText("Orang itu tidak sedang dinonaktifkan.")).toBeInTheDocument();
    expect(within(dialog).getByText("Sari belum diaktifkan")).toBeInTheDocument();
  });
});

// 0.5.1: admin departemen melihat Pengguna untuk departemennya sendiri. Daftar
// dari inti Rust sudah terbatas; layar menyembunyikan saringan dan aksi superadmin.
function deptUsers(): UserView[] {
  return [
    user(ME, "Penguji", { departmentRole: "admin", lastIp: null }),
    user(PK_B, "Sari", { canSuspend: true }),
    user(PK_C, "Wulan", { departmentRole: "admin" }),
    user(PK_D, "Dimas", {
      status: "suspended",
      departmentId: null,
      departmentName: null,
      departmentRole: null,
      online: false,
      suspendedAt: SUSPENDED_AT,
      suspendedByName: "Penguji",
      canReinstate: true,
    }),
  ];
}

function renderDeptAdmin(table: Record<string, unknown> = {}) {
  return renderUsers({ org_overview: adminOverview({ listUsers: true }), org_users: deptUsers(), ...table });
}

describe("Pengguna: admin departemen", () => {
  it("tanpa saringan departemen dan Dikeluarkan, dengan petunjuk untuk departemennya", async () => {
    renderDeptAdmin();
    expect(await screen.findByText("Sari")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pengguna" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByText(/Orang di departemen Anda, termasuk yang dinonaktifkan dari departemen ini/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Departemen" })).not.toBeInTheDocument();
    const status = screen.getByRole("combobox", { name: "Status" });
    expect(within(status).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Semua kecuali yang dikeluarkan",
      "Online",
      "Offline",
      "Nonaktif",
    ]);
    expect(within(rowOf("Dimas")).getByText(`Dinonaktifkan ${formatDate(SUSPENDED_AT)} oleh Penguji`)).toBeInTheDocument();
  });

  it("menu hanya aksi status sesuai tanda: tanpa Ubah departemen dan Ubah peran", async () => {
    const ue = renderDeptAdmin();
    await screen.findByText("Sari");
    await ue.click(screen.getByRole("button", { name: "Aksi untuk Sari" }));
    expect(menuIds()).toEqual(["takeout"]);
    expect(screen.getByRole("menuitem", { name: "Nonaktifkan" })).toBeInTheDocument();
    await ue.keyboard("{Escape}");

    await ue.click(screen.getByRole("button", { name: "Aksi untuk Dimas" }));
    expect(menuIds()).toEqual(["reinstate"]);
    await ue.keyboard("{Escape}");

    // Admin lain dan diri sendiri: tidak ada tanda, tidak ada menu.
    expect(within(rowOf("Wulan")).queryByRole("button")).not.toBeInTheDocument();
    expect(within(rowOf("Penguji")).queryByRole("button")).not.toBeInTheDocument();
  });

  it("Nonaktifkan tanpa pilihan Keluarkan permanen, lalu daftar dimuat ulang", async () => {
    let done = false;
    const ue = renderDeptAdmin({
      org_users: () =>
        done
          ? deptUsers().map((u) =>
              u.publicKey === PK_B
                ? { ...u, status: "suspended" as const, suspendedAt: SUSPENDED_AT, suspendedByName: "Penguji", canSuspend: false, canReinstate: true }
                : u,
            )
          : deptUsers(),
      org_suspend_member: () => {
        done = true;
        return null;
      },
    });
    await screen.findByText("Sari");
    await openMenuItem(ue, "Sari", "Nonaktifkan");
    const dialog = await screen.findByRole("dialog", { name: "Nonaktifkan Sari?" });
    expect(within(dialog).queryByRole("radio")).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("Keluarkan permanen");
    const submit = await within(dialog).findByRole("button", { name: "Nonaktifkan Sari" });
    await waitFor(() => expect(submit).toBeEnabled());
    await ue.click(submit);
    expect(invoke).toHaveBeenCalledWith("org_suspend_member", { publicKey: PK_B });
    await waitFor(() => expect(within(rowOf("Sari")).getByText("Nonaktif")).toBeInTheDocument());
  });

  it("gerbang tertutup: tombol Nonaktifkan mati dan laptop yang menghalangi disebut", async () => {
    const ue = renderDeptAdmin({ org_suspend_gate: { allowed: false, outdated: [{ name: "Wulan", appVersion: "0.5.0" }] } });
    await screen.findByText("Sari");
    await openMenuItem(ue, "Sari", "Nonaktifkan");
    const dialog = await screen.findByRole("dialog", { name: "Nonaktifkan Sari?" });
    expect(
      await within(dialog).findByText(
        "Belum bisa dipilih. Laptop berikut perlu diperbarui ke Mira 0.5.1 dulu: Wulan (Mira 0.5.0). Kalau hanya perlu sementara, perbarui laptop itu dulu; Keluarkan permanen tidak bisa dibatalkan.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Nonaktifkan Sari" })).toBeDisabled();
  });

  it("Aktifkan lagi memanggil org_reinstate_member", async () => {
    const ue = renderDeptAdmin({ org_reinstate_member: null });
    await screen.findByText("Dimas");
    await openMenuItem(ue, "Dimas", "Aktifkan lagi");
    const dialog = await screen.findByRole("dialog", { name: "Aktifkan Dimas lagi?" });
    await ue.click(within(dialog).getByRole("button", { name: "Aktifkan Dimas" }));
    expect(invoke).toHaveBeenCalledWith("org_reinstate_member", { publicKey: PK_D });
    expect(await screen.findByText("Dimas aktif lagi.")).toBeInTheDocument();
  });
});
