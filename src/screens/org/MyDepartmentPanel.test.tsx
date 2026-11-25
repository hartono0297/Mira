import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Directory, InviteView, OrgInfo } from "../../api";
import type { DeptOverview } from "../../api/division";
import type { OrgOverview } from "../../api/org";
import { appState, directory, router, rustError } from "../../test/fixtures";
import { adminOverview, joinRequest, memberOverview, overview } from "../../test/orgFixtures";
import {
  deptOverview,
  DIV_1,
  DIV_2,
  DIV_3,
  headOverview,
  ME,
  PK_B,
  PK_C,
  PK_D,
  TEAM_1,
  TEAM_2,
} from "./myDepartmentFixtures";
import { OrgScreen } from "./OrgScreen";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
// Tab lain diuji di filenya sendiri. Permintaan bergabung dan Undangan tetap asli:
// tab ini memakainya dengan filter departemen.
vi.mock("./UsersPanel", () => ({ UsersPanel: () => null }));
// UsersPanel memakai helper lain dari PeoplePanel: hanya panelnya yang diganti.
vi.mock("./PeoplePanel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./PeoplePanel")>()),
  PeoplePanel: () => null,
}));
vi.mock("./LabelsPanel", () => ({ LabelsPanel: () => null }));
vi.mock("./DepartmentsPanel", () => ({ DepartmentsPanel: () => null }));

const state = appState() as AppState & { organization: OrgInfo };

function invite(id: string, teamId: string, teamName: string): InviteView {
  return {
    id,
    teamId,
    teamName,
    role: "member",
    projectIds: [],
    validity: "7d",
    expiresAt: "2026-12-30T03:00:00Z",
    createdBy: ME,
    createdAt: "2026-11-24T03:00:00Z",
    status: "active",
    usedBy: [],
  };
}

const adminDir: Directory = directory({
  me: { publicKey: ME, isSuperadmin: false },
  can: { createTeam: false, manageSuperadmins: false, removeMembers: false, manageTeamIds: [TEAM_1] },
  teams: [
    { id: TEAM_1, name: "Desain", createdAt: "2026-11-22T03:00:00Z", members: [{ publicKey: ME, role: "admin" }] },
    { id: TEAM_2, name: "Keuangan", createdAt: "2026-11-22T03:00:00Z", members: [] },
  ],
  invites: [invite("i1", TEAM_1, "Desain"), invite("i2", TEAM_2, "Keuangan")],
});

const plainDir: Directory = directory({
  me: { publicKey: ME, isSuperadmin: false },
  can: { createTeam: false, manageSuperadmins: false, removeMembers: false, manageTeamIds: [] },
});

type Extra = Record<string, unknown>;

function setup(opts: { ov?: OrgOverview; dept?: DeptOverview | null; dir?: Directory; extra?: Extra; props?: Extra } = {}) {
  const dept = opts.dept === undefined ? deptOverview() : opts.dept;
  invoke.mockImplementation(
    router({
      org_overview: opts.ov ?? adminOverview(),
      get_directory: opts.dir ?? adminDir,
      org_fingerprint: "ABCD-EFGH",
      org_join_requests: [],
      org_departments: [],
      dept_overview: dept,
      ...(opts.extra as Record<string, never>),
    }),
  );
  render(<OrgScreen state={state} onRefresh={vi.fn()} {...opts.props} />);
}

async function openTab() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Departemen saya" }));
  await screen.findByRole("heading", { name: "Anggota departemen", level: 2 });
  return user;
}

function tabNames(): string[] {
  const nav = screen.getByRole("navigation", { name: "Bagian organisasi" });
  return within(nav)
    .getAllByRole("button")
    .map((b) => b.textContent ?? "");
}

function card(name: string): HTMLElement {
  return screen.getByRole("article", { name });
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

describe("Departemen saya: siapa yang melihat tab", () => {
  it("superadmin: tab tampil sesudah Departemen", async () => {
    setup({ ov: overview(), dir: directory() });
    await screen.findByRole("navigation", { name: "Bagian organisasi" });
    expect(tabNames()).toEqual([
      "Pengguna",
      "Departemen",
      "Departemen saya",
      "Permintaan bergabung",
      "Label",
      "Undangan",
      "Kopi",
    ]);
  });

  it("admin departemen: tab tampil", async () => {
    setup();
    await screen.findByRole("navigation", { name: "Bagian organisasi" });
    expect(tabNames()).toEqual(["Pengguna", "Departemen saya", "Permintaan bergabung", "Undangan", "Kopi"]);
  });

  it("kepala divisi tanpa hak admin: tab tampil karena dept_overview(null) tidak null", async () => {
    setup({ ov: memberOverview(), dir: plainDir, dept: headOverview() });
    expect(await screen.findByRole("button", { name: "Departemen saya" })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("dept_overview", { teamId: null });
  });

  it("anggota biasa: dept_overview null, tab tidak tampil", async () => {
    setup({ ov: memberOverview(), dir: plainDir, dept: null });
    await screen.findByRole("navigation", { name: "Bagian organisasi" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("dept_overview", { teamId: null }));
    expect(screen.queryByRole("button", { name: "Departemen saya" })).not.toBeInTheDocument();
    expect(tabNames()).toEqual(["Anggota", "Kopi"]);
  });
});

describe("Departemen saya: admin departemen", () => {
  it("menampilkan semua bagian dan aksi pengelola", async () => {
    setup();
    await openTab();
    for (const name of [
      "Anggota departemen",
      "Divisi",
      "Permintaan bergabung",
      "Kode undangan",
      "Proyek departemen",
      "Channel departemen",
    ]) {
      expect(screen.getByRole("heading", { name, level: 2 })).toBeInTheDocument();
    }
    // Nama departemen di atas tab juga judul.
    expect(screen.getByRole("heading", { name: "Desain", level: 2 })).toBeInTheDocument();
    // Divisi di atas Anggota departemen; Riwayat admin dilipat dengan jumlahnya.
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf("Divisi")).toBeLessThan(headings.indexOf("Anggota departemen"));
    const history = screen.getByText("Riwayat admin (2)").closest("details");
    expect(history).not.toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Buat divisi" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Jadikan admin, Bayu" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ganti nama divisi Mobile" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Arsipkan divisi Mobile" })).toBeInTheDocument();
    // Peran tampil sebagai teks, status online dengan teks juga.
    expect(screen.getAllByText("Admin departemen").length).toBeGreaterThan(0);
    expect(screen.getByText("Divisi: Mobile (kepala)")).toBeInTheDocument();
    expect(screen.getByText("Laptop ini")).toBeInTheDocument();
    // Kepala lebih dulu di kartu divisi.
    const names = within(card("Mobile"))
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    expect(names[0]).toMatch(/^Citra/);
    // Riwayat: yang ditolak diberi label.
    expect(screen.getByText("Ditolak")).toBeInTheDocument();
    expect(screen.getByText("Penguji menjadikan Citra admin departemen")).toBeInTheDocument();
    expect(screen.getByText("Aplikasi Kasir")).toBeInTheDocument();
    expect(screen.getByText("Divisi Mobile")).toBeInTheDocument();
  });

  it("Buat divisi memanggil division_create dengan departemen dan nama", async () => {
    setup();
    const user = await openTab();
    await user.type(screen.getByLabelText("Nama divisi baru"), "  Backend ");
    await user.click(screen.getByRole("button", { name: "Buat divisi" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("division_create", { teamId: TEAM_1, name: "Backend" }));
    expect(await screen.findByText("Divisi Backend dibuat. Chatnya ada di Chat, bagian Departemen.")).toBeInTheDocument();
  });

  it("nama divisi terlalu pendek ditolak sebelum dikirim", async () => {
    setup();
    const user = await openTab();
    await user.type(screen.getByLabelText("Nama divisi baru"), "A");
    await user.click(screen.getByRole("button", { name: "Buat divisi" }));
    expect(screen.getByLabelText("Nama divisi baru")).toHaveAttribute("aria-invalid", "true");
    expect(invoke).not.toHaveBeenCalledWith("division_create", expect.anything());
  });

  it("Ganti nama memanggil division_rename", async () => {
    setup();
    const user = await openTab();
    await user.click(screen.getByRole("button", { name: "Ganti nama divisi Web" }));
    const input = screen.getByLabelText("Nama baru untuk divisi Web");
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, "Frontend");
    await user.click(screen.getByRole("button", { name: "Simpan" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("division_rename", { divisionId: DIV_2, name: "Frontend" }));
    // Baris edit tertutup: fokus kembali ke tombol Ganti nama, tidak jatuh ke body.
    await waitFor(() => expect(screen.getByRole("button", { name: "Ganti nama divisi Web" })).toHaveFocus());
  });

  it("Escape menutup baris ganti nama dan fokus kembali ke tombolnya", async () => {
    setup();
    const user = await openTab();
    await user.click(screen.getByRole("button", { name: "Ganti nama divisi Mobile" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Nama baru untuk divisi Mobile")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ganti nama divisi Mobile" })).toHaveFocus();
    expect(invoke).not.toHaveBeenCalledWith("division_rename", expect.anything());
  });

  it("Arsipkan lewat konfirmasi, lalu fokus pindah ke bagian Diarsipkan; Pulihkan langsung ke kartunya", async () => {
    let data = deptOverview();
    setup({
      extra: {
        dept_overview: () => data,
        division_archive: (args: { divisionId: string; archived: boolean }) => {
          data = {
            ...data,
            divisions: data.divisions.map((d) => (d.id === args.divisionId ? { ...d, archived: args.archived } : d)),
          };
          return null;
        },
      },
    });
    const user = await openTab();
    await user.click(screen.getByRole("button", { name: "Arsipkan divisi Web" }));
    const dialog = await screen.findByRole("dialog", { name: "Arsipkan divisi Web?" });
    expect(invoke).not.toHaveBeenCalledWith("division_archive", expect.anything());
    await user.click(within(dialog).getByRole("button", { name: "Arsipkan Web" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("division_archive", { divisionId: DIV_2, archived: true }),
    );
    expect(await screen.findByText("Divisi Web diarsipkan.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Diarsipkan (2)").closest("summary")).toHaveFocus());

    await user.click(screen.getByText("Diarsipkan (2)"));
    await user.click(screen.getByRole("button", { name: "Pulihkan divisi Lama" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("division_archive", { divisionId: DIV_3, archived: false }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Ganti nama divisi Lama" })).toHaveFocus());
    expect(card("Lama")).not.toHaveClass("md-div-archived");
  });

  it("error saat mengarsipkan tampil di dalam dialog yang tetap terbuka", async () => {
    setup({ extra: { division_archive: rustError("forbidden", "Anda tidak boleh mengarsipkan divisi ini.") } });
    const user = await openTab();
    await user.click(screen.getByRole("button", { name: "Arsipkan divisi Web" }));
    const dialog = await screen.findByRole("dialog", { name: "Arsipkan divisi Web?" });
    await user.click(within(dialog).getByRole("button", { name: "Arsipkan Web" }));
    expect(await within(dialog).findByText("Anda tidak boleh mengarsipkan divisi ini.")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Arsipkan divisi Web?" })).toBeInTheDocument();
  });

  it("tunjuk dan lepas kepala divisi memanggil division_set_head", async () => {
    setup();
    const user = await openTab();
    await user.click(screen.getByRole("button", { name: "Jadikan kepala, Bayu, divisi Mobile" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("division_set_head", { divisionId: DIV_1, publicKey: PK_B, head: true }),
    );
    const demote = await screen.findByRole("button", { name: "Jadikan anggota, Citra, divisi Mobile" });
    expect(demote).toHaveTextContent("Jadikan anggota");
    await user.click(demote);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("division_set_head", { divisionId: DIV_1, publicKey: PK_C, head: false }),
    );
  });

  it("tambah orang hanya dari anggota departemen yang belum di divisi itu", async () => {
    setup();
    const user = await openTab();
    const select = within(card("Mobile")).getByLabelText("Tambah orang ke divisi Mobile");
    const options = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["Pilih orang", "Dewi", "Penguji"]);
    expect(within(card("Mobile")).getByRole("button", { name: "Tambahkan" })).toBeDisabled();
    await user.selectOptions(select, PK_D);
    await user.click(within(card("Mobile")).getByRole("button", { name: "Tambahkan" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("division_add_member", { divisionId: DIV_1, publicKey: PK_D }),
    );
  });

  it("Keluarkan memanggil division_remove_member", async () => {
    setup();
    const user = await openTab();
    await user.click(screen.getByRole("button", { name: "Keluarkan Bayu dari divisi Mobile" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("division_remove_member", { divisionId: DIV_1, publicKey: PK_B }),
    );
    expect(await screen.findByText("Bayu dikeluarkan dari divisi Mobile.")).toBeInTheDocument();
  });

  it("setelah Keluarkan, fokus pindah ke judul kartu divisi", async () => {
    let data = deptOverview();
    setup({
      extra: {
        dept_overview: () => data,
        division_remove_member: (args: { divisionId: string; publicKey: string }) => {
          data = {
            ...data,
            divisions: data.divisions.map((d) =>
              d.id === args.divisionId ? { ...d, members: d.members.filter((m) => m.publicKey !== args.publicKey) } : d,
            ),
          };
          return null;
        },
      },
    });
    const user = await openTab();
    await user.click(screen.getByRole("button", { name: "Keluarkan Bayu dari divisi Mobile" }));
    await waitFor(() => expect(within(card("Mobile")).getByRole("heading", { name: "Mobile" })).toHaveFocus());
  });

  it("Jadikan admin memanggil dept_set_admin", async () => {
    setup();
    const user = await openTab();
    await user.click(screen.getByRole("button", { name: "Jadikan admin, Bayu" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("dept_set_admin", { teamId: TEAM_1, publicKey: PK_B, admin: true }),
    );
  });

  it("admin terakhir: Lepas admin untuk dirinya nonaktif dengan penjelasan", async () => {
    setup();
    await openTab();
    const btn = screen.getByRole("button", { name: "Lepas admin, Penguji" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription(
      "Anda admin terakhir departemen ini. Jadikan orang lain admin dulu, baru lepaskan peran ini.",
    );
  });

  it("superadmin yang juga admin terakhir tetap bisa melepas dirinya", async () => {
    const base = deptOverview();
    setup({
      dept: {
        ...base,
        me: { ...base.me, isSuperadmin: true },
        members: base.members.map((m) => (m.publicKey === ME ? { ...m, isSuperadmin: true } : m)),
      },
    });
    await openTab();
    expect(screen.getByRole("button", { name: "Lepas admin, Penguji" })).toBeEnabled();
    expect(screen.queryByText(/Anda admin terakhir/)).not.toBeInTheDocument();
  });

  it("melepas diri sendiri: dikonfirmasi dulu, lalu pesan Rust tampil kalau ditolak", async () => {
    // Masih ada admin lain di layar, tetapi Rust menolak (misalnya admin lain baru dilepas di laptop lain).
    const base = deptOverview();
    setup({
      dept: { ...base, members: base.members.map((m) => (m.publicKey === PK_B ? { ...m, isAdmin: true } : m)) },
      extra: {
        dept_set_admin: rustError("forbidden", "Departemen harus punya minimal satu admin. Angkat admin lain dulu."),
      },
    });
    const user = await openTab();
    await user.click(screen.getByRole("button", { name: "Lepas admin, Penguji" }));
    const dialog = await screen.findByRole("dialog", { name: "Lepas diri Anda dari admin departemen?" });
    await user.click(within(dialog).getByRole("button", { name: "Lepas admin" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("dept_set_admin", { teamId: TEAM_1, publicKey: ME, admin: false }),
    );
    expect(
      await screen.findByText("Departemen harus punya minimal satu admin. Angkat admin lain dulu."),
    ).toBeInTheDocument();
  });

  it("pengaturan channel departemen: catatan dengan penghitung dan mode pengumuman", async () => {
    setup();
    const user = await openTab();
    const section = screen.getByRole("region", { name: "Channel departemen" });
    const save = within(section).getByRole("button", { name: "Simpan pengaturan chat" });
    expect(save).toBeDisabled();
    expect(within(section).getByText("Hanya admin departemen dan superadmin yang bisa menulis.")).toBeInTheDocument();
    await user.type(within(section).getByLabelText("Catatan disematkan"), "Rapat Senin jam 9");
    expect(within(section).getByText("17 dari 500 karakter")).toBeInTheDocument();
    await user.click(within(section).getByRole("checkbox", { name: "Mode pengumuman" }));
    await user.click(save);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("chat_settings_set", {
        teamId: TEAM_1,
        divisionId: null,
        pinned: "Rapat Senin jam 9",
        announce: true,
      }),
    );
  });

  it("catatan lebih dari 500 karakter tidak bisa disimpan", async () => {
    const long = "a".repeat(501);
    setup({
      dept: deptOverview({
        channel: { conv: "c1", name: "desain", settings: { pinned: "", announce: false, setAt: null, setByName: null } },
      }),
    });
    const user = await openTab();
    const section = screen.getByRole("region", { name: "Channel departemen" });
    const box = within(section).getByLabelText("Catatan disematkan");
    await user.click(box);
    await user.paste(long);
    expect(within(section).getByText("501 dari 500 karakter")).toBeInTheDocument();
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(within(section).getByRole("button", { name: "Simpan pengaturan chat" })).toBeDisabled();
  });

  it("catatan lebih dari 20 baris tidak bisa disimpan; tab dan CRLF dirapikan sebelum dikirim", async () => {
    setup();
    const user = await openTab();
    const section = screen.getByRole("region", { name: "Channel departemen" });
    expect(
      within(section).getByText("Paling banyak 500 karakter dan 20 baris. Kosongkan untuk menghapus catatan."),
    ).toBeInTheDocument();
    const box = within(section).getByLabelText("Catatan disematkan");
    await user.click(box);
    await user.paste(Array.from({ length: 21 }, (_, i) => `baris ${i + 1}`).join("\n"));
    expect(within(section).getByText("Catatan paling banyak 20 baris. Kurangi barisnya dulu.")).toBeInTheDocument();
    expect(box).toHaveAttribute("aria-invalid", "true");
    const save = within(section).getByRole("button", { name: "Simpan pengaturan chat" });
    expect(save).toBeDisabled();
    await user.clear(box);
    await user.paste("Rapat\tSenin\r\njam 9");
    await user.click(save);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("chat_settings_set", {
        teamId: TEAM_1,
        divisionId: null,
        pinned: "Rapat Senin\njam 9",
        announce: false,
      }),
    );
  });

  it("menyimpan pengaturan chat tidak memasang ulang formulir", async () => {
    let data = deptOverview();
    setup({
      extra: {
        dept_overview: () => data,
        chat_settings_set: (args: { pinned: string; announce: boolean }) => {
          data = {
            ...data,
            channel: {
              ...data.channel,
              settings: { pinned: args.pinned, announce: args.announce, setAt: "2026-11-25T03:00:00Z", setByName: "Penguji" },
            },
          };
          return null;
        },
      },
    });
    const user = await openTab();
    const section = screen.getByRole("region", { name: "Channel departemen" });
    const box = within(section).getByLabelText("Catatan disematkan");
    await user.type(box, "  Rapat Senin  ");
    await user.click(within(section).getByRole("button", { name: "Simpan pengaturan chat" }));
    await waitFor(() => expect(within(section).getByText(/^Terakhir diubah Penguji/)).toBeInTheDocument());
    // Elemen yang sama, isinya kembali ke nilai tersimpan (sudah dirapikan).
    expect(within(section).getByLabelText("Catatan disematkan")).toBe(box);
    // Isian disetel ulang di efek sesudah data baru tampil, satu render kemudian.
    await waitFor(() => expect(box).toHaveValue("Rapat Senin"));
  });

  it("pengaturan chat divisi memakai id divisi", async () => {
    setup();
    const user = await openTab();
    const mobile = card("Mobile");
    await user.click(within(mobile).getByText("Chat divisi"));
    expect(
      within(mobile).getByText("Hanya kepala divisi, admin departemen, dan superadmin yang bisa menulis."),
    ).toBeInTheDocument();
    await user.click(within(mobile).getByRole("checkbox", { name: "Mode pengumuman" }));
    await user.click(within(mobile).getByRole("button", { name: "Simpan pengaturan chat" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("chat_settings_set", {
        teamId: TEAM_1,
        divisionId: DIV_1,
        pinned: "",
        announce: true,
      }),
    );
  });

  it("Buka chat dan Buka di Board memanggil navigasi dari pemanggil", async () => {
    const onOpenChat = vi.fn();
    const onOpenProject = vi.fn();
    setup({ props: { onOpenChat, onOpenProject } });
    const user = await openTab();
    await user.click(screen.getByRole("button", { name: "Buka chat divisi Mobile" }));
    expect(onOpenChat).toHaveBeenCalledWith(`ch:${DIV_1}`);
    await user.click(screen.getByRole("button", { name: "Buka chat # desain" }));
    expect(onOpenChat).toHaveBeenLastCalledWith(`c${TEAM_1.slice(1)}`);
    await user.click(screen.getByRole("button", { name: "Buka di Board, proyek Aplikasi Kasir" }));
    expect(onOpenProject).toHaveBeenCalledWith("p".repeat(32));
  });

  it("tanpa navigasi dari pemanggil, tombol Buka chat tidak tampil", async () => {
    setup();
    await openTab();
    expect(screen.queryByRole("button", { name: /Buka chat/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Buka di Board/ })).not.toBeInTheDocument();
  });

  it("pemilih departemen memuat departemen pilihan", async () => {
    setup({
      dept: deptOverview({
        choices: [
          { id: TEAM_1, name: "Desain" },
          { id: TEAM_2, name: "Keuangan" },
        ],
      }),
    });
    const user = await openTab();
    await user.selectOptions(screen.getByLabelText("Departemen yang diatur"), TEAM_2);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("dept_overview", { teamId: TEAM_2 }));
  });
});

describe("Departemen saya: permintaan bergabung dan kode undangan per departemen", () => {
  it("hanya permintaan dan kode untuk departemen ini", async () => {
    setup({
      extra: {
        org_join_requests: [
          joinRequest("r1", "Rina", { teamId: TEAM_1, teamName: "Desain" }),
          joinRequest("r2", "Sari", { teamId: TEAM_2, teamName: "Keuangan" }),
        ],
      },
    });
    await openTab();
    const requests = screen.getByRole("region", { name: "Permintaan bergabung" });
    expect(await within(requests).findByRole("heading", { name: "Rina" })).toBeInTheDocument();
    expect(within(requests).queryByRole("heading", { name: "Sari" })).not.toBeInTheDocument();
    const invites = screen.getByRole("region", { name: "Kode undangan" });
    expect(within(invites).getByText("Desain, Anggota")).toBeInTheDocument();
    expect(within(invites).queryByText(/Keuangan/)).not.toBeInTheDocument();
  });
});

describe("Departemen saya: kepala divisi", () => {
  it("hanya bisa mengubah anggota divisinya sendiri", async () => {
    setup({ ov: memberOverview(), dir: plainDir, dept: headOverview() });
    await openTab();
    expect(screen.getByText(/Anda kepala divisi di departemen ini/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Buat divisi" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(Jadikan|Lepas) admin/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Ganti nama divisi/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Arsipkan divisi/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Jadikan (kepala|anggota)/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Riwayat admin/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Permintaan bergabung" })).not.toBeInTheDocument();

    const mobile = card("Mobile");
    expect(within(mobile).getByRole("button", { name: "Keluarkan Bayu dari divisi Mobile" })).toBeInTheDocument();
    expect(within(mobile).getByRole("button", { name: "Keluar dari divisi Mobile" })).toBeInTheDocument();
    expect(within(mobile).getByLabelText("Tambah orang ke divisi Mobile")).toBeInTheDocument();
    const web = card("Web");
    expect(within(web).queryByLabelText(/Tambah orang/)).not.toBeInTheDocument();
    expect(within(web).queryByText("Chat divisi")).not.toBeInTheDocument();
    // Channel departemen hanya dibaca oleh kepala divisi.
    const channel = screen.getByRole("region", { name: "Channel departemen" });
    expect(within(channel).queryByRole("button", { name: "Simpan pengaturan chat" })).not.toBeInTheDocument();
    expect(within(channel).getByText("Belum ada catatan disematkan.")).toBeInTheDocument();
  });

  it("keluar dari divisi sendiri lewat konfirmasi", async () => {
    setup({ ov: memberOverview(), dir: plainDir, dept: headOverview() });
    const user = await openTab();
    await user.click(within(card("Mobile")).getByRole("button", { name: "Keluar dari divisi Mobile" }));
    const dialog = await screen.findByRole("dialog", { name: "Keluar dari divisi Mobile?" });
    expect(
      within(dialog).getByText(
        "Anda tidak lagi menjadi anggota Mobile dan tidak lagi menerima chatnya. Untuk kembali, minta admin departemen menambahkan Anda.",
      ),
    ).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("division_remove_member", expect.anything());
    await user.click(within(dialog).getByRole("button", { name: "Keluar dari divisi" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("division_remove_member", { divisionId: DIV_1, publicKey: PK_C }),
    );
    expect(await screen.findByText("Anda keluar dari divisi Mobile.")).toBeInTheDocument();
  });
});

describe("Departemen saya: gerbang versi", () => {
  it("tertutup: daftar laptop tampil dan aksi divisi nonaktif", async () => {
    setup({
      dept: deptOverview({
        gate: {
          open: false,
          since: "0.6.0",
          blockers: [
            { publicKey: PK_B, name: "Bayu", appVersion: "0.5.0" },
            { publicKey: PK_D, name: "Dewi", appVersion: null },
          ],
        },
      }),
    });
    await openTab();
    expect(screen.getByText("Perubahan divisi menunggu semua laptop memakai Mira 0.6.0")).toBeInTheDocument();
    expect(screen.getByText("Bayu, Mira 0.5.0")).toBeInTheDocument();
    expect(screen.getByText("Dewi, versi belum dilaporkan")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buat divisi" })).toBeDisabled();
    expect(screen.getByLabelText("Nama divisi baru")).toBeDisabled();
    const hint = "Bisa diubah setelah semua laptop kantor memakai Mira 0.6.0.";
    expect(screen.getAllByText(hint).length).toBeGreaterThan(0);
    // Tombol tetap tampil tetapi nonaktif, dengan penjelasan yang dibacakan bersamanya.
    const rename = screen.getByRole("button", { name: "Ganti nama divisi Mobile" });
    expect(rename).toBeDisabled();
    expect(rename).toHaveAccessibleDescription(hint);
    const admin = screen.getByRole("button", { name: "Jadikan admin, Bayu" });
    expect(admin).toBeDisabled();
    expect(admin).toHaveAccessibleDescription(hint);
    expect(screen.getByRole("button", { name: "Keluarkan Bayu dari divisi Mobile" })).toBeDisabled();
    const channel = screen.getByRole("region", { name: "Channel departemen" });
    expect(within(channel).getByLabelText("Catatan disematkan")).toBeDisabled();
    expect(within(channel).getByRole("button", { name: "Simpan pengaturan chat" })).toHaveAccessibleDescription(hint);
  });

  it("tertutup tanpa daftar laptop: penjelasan tanpa menyebut laptop di atas", async () => {
    setup({ dept: deptOverview({ gate: { open: false, since: "0.6.0", blockers: [] } }) });
    await openTab();
    expect(
      screen.getByText(
        "Sampai semua laptop kantor diperbarui, divisi, kepala divisi, pengaturan chat, dan pengangkatan admin oleh admin departemen belum bisa disimpan.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Laptop berikut/)).not.toBeInTheDocument();
  });

  it("tertutup: superadmin tetap bisa mengangkat admin (op lama)", async () => {
    setup({
      ov: overview(),
      dir: directory(),
      dept: deptOverview({
        me: { publicKey: ME, isSuperadmin: true, isAdmin: false, headOf: [] },
        gate: { open: false, since: "0.6.0", blockers: [{ publicKey: PK_B, name: "Bayu", appVersion: "0.5.0" }] },
      }),
    });
    await openTab();
    expect(screen.getByRole("button", { name: "Jadikan admin, Bayu" })).toBeEnabled();
  });
});

describe("Departemen saya: keadaan", () => {
  it("dept_overview gagal: pesan error dan Coba lagi", async () => {
    let fail = true;
    setup({
      extra: {
        dept_overview: () => {
          if (fail) throw { code: "database", message: "Database sedang dipakai." };
          return deptOverview();
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Departemen saya" }));
    expect(await screen.findByText("Data departemen belum terbaca")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByRole("heading", { name: "Anggota departemen" })).toBeInTheDocument();
  });

  it("divisi kosong menjelaskan apa itu divisi", async () => {
    setup({ dept: deptOverview({ divisions: [] }) });
    await openTab();
    expect(
      screen.getByText(
        "Divisi mengelompokkan orang di departemen ini, misalnya Mobile atau Web. Setiap divisi punya chat sendiri.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Belum ada divisi. Buat divisi pertama dengan kolom di atas.")).toBeInTheDocument();
  });
});
