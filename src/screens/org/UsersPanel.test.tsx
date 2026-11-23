import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, OrgInfo } from "../../api";
import { formatDate } from "../../api/format";
import type { UserView } from "../../api/org";
import { appState, directory, router, rustError } from "../../test/fixtures";
import { department, label, LABEL_1, ME, overview, PK_B, PK_C, PK_D, TEAM_1, TEAM_2, TEAM_3, user } from "../../test/orgFixtures";
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
      device: { laptop: "LAPTOP-DRAFT-02", os: "Windows 11 24H2", appVersion: "0.3.0", reportedAt: hoursAgo(3) },
      lastIp: "192.168.1.42",
      online: false,
      lastSeenAt: hoursAgo(2),
      labels: [{ id: LABEL_1, name: "Arsitek" }],
    }),
    user(PK_C, "Wulan", {
      role: "team_admin",
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
  await ue.click(screen.getByRole("button", { name: item }));
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
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("active");
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
    expect(screen.getByRole("button", { name: "Ubah departemen" })).toBeVisible();
    await ue.tab();
    expect(screen.getByRole("button", { name: "Ubah departemen" })).toHaveFocus();
    await ue.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Ubah departemen" })).not.toBeInTheDocument();
  });

  it("klik di luar menutup menu", async () => {
    const ue = renderUsers();
    await ready(ue);
    const toggle = screen.getByRole("button", { name: "Aksi untuk Sari" });
    await ue.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await ue.click(screen.getByRole("heading", { name: "Pengguna" }));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("Tamu tidak punya Ubah departemen dan Ubah peran; diri sendiri tidak punya Keluarkan", async () => {
    const ue = renderUsers();
    await ready(ue);
    await ue.click(screen.getByRole("button", { name: "Aksi untuk Yusuf" }));
    expect(screen.getByRole("button", { name: "Keluarkan dari organisasi" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ubah departemen" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ubah peran" })).not.toBeInTheDocument();
    await ue.keyboard("{Escape}");

    await ue.click(screen.getByRole("button", { name: "Aksi untuk Penguji" }));
    expect(screen.getByRole("button", { name: "Ubah departemen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ubah peran" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Keluarkan dari organisasi" })).not.toBeInTheDocument();
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

describe("Pengguna: keluarkan", () => {
  it("mengeluarkan orang setelah konfirmasi, fokus pindah ke orang berikutnya", async () => {
    let gone = false;
    const ue = renderUsers({
      org_users: () => (gone ? people().filter((p) => p.publicKey !== PK_B) : people()),
      remove_member: () => {
        gone = true;
        return null;
      },
    });
    await ready(ue);
    await openMenuItem(ue, "Sari", "Keluarkan dari organisasi");
    const dialog = await screen.findByRole("dialog", { name: "Keluarkan Sari dari organisasi?" });
    expect(within(dialog).getByText(/Langkah ini tidak bisa dibatalkan/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Batal" })).toHaveFocus();
    await ue.click(within(dialog).getByRole("button", { name: "Keluarkan Sari" }));
    expect(invoke).toHaveBeenCalledWith("remove_member", { publicKey: PK_B });
    expect(await screen.findByText("Sari sudah dikeluarkan dari organisasi.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("Sari")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Aksi untuk Wulan" })).toHaveFocus());
  });

  it("gagal: dialog tetap terbuka dan pesan Rust tampil di dalamnya", async () => {
    const ue = renderUsers({ remove_member: rustError("forbidden", "Hanya superadmin yang boleh mengeluarkan anggota tim.") });
    await ready(ue);
    await openMenuItem(ue, "Sari", "Keluarkan dari organisasi");
    const dialog = await screen.findByRole("dialog");
    await ue.click(within(dialog).getByRole("button", { name: "Keluarkan Sari" }));
    expect(
      await within(dialog).findByText("Hanya superadmin yang boleh mengeluarkan anggota departemen."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Keluarkan Sari" })).toBeEnabled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
