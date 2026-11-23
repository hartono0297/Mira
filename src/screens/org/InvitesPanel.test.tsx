import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Directory, InviteView, OrgInfo, TeamView } from "../../api";
import type { ProjectSummary } from "../../api/board";
import type { OrgOverview } from "../../api/org";
import { appState, directory, member, ME, PK_B, PK_C, router, rustError, TEAM_1 } from "../../test/fixtures";
import { adminOverview, department, memberOverview, overview, TEAM_2 } from "../../test/orgFixtures";
import { OrgScreen } from "./OrgScreen";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const state = appState() as AppState & { organization: OrgInfo };
const CODE = "ABCD-EFGH-JKMN-PQRS-TVWX";

const desain: TeamView = {
  id: TEAM_1,
  name: "Desain",
  createdAt: "2026-11-22T03:00:00Z",
  members: [
    { publicKey: ME, role: "admin" },
    { publicKey: PK_B, role: "member" },
  ],
};
const gudang: TeamView = { id: TEAM_2, name: "Gudang", createdAt: "2026-11-22T03:00:00Z", members: [] };

function dir(extra: Partial<Directory> = {}): Directory {
  return directory({ teams: [desain], ...extra });
}

// Admin departemen Desain, bukan superadmin.
const adminDir: Partial<Directory> = {
  me: { publicKey: ME, isSuperadmin: false },
  can: { createTeam: false, manageSuperadmins: false, removeMembers: false, manageTeamIds: [TEAM_1] },
  members: [
    member(ME, "Penguji", { orgRole: "team_admin", teams: [{ teamId: TEAM_1, role: "admin" }] }),
    member(PK_B, "Anggota Satu", { orgRole: "superadmin", isSuperadmin: true, teams: [{ teamId: TEAM_1, role: "member" }] }),
    member(PK_C, "Anggota Dua"),
  ],
};

// Anggota biasa tanpa izin mengundang.
const memberDir: Partial<Directory> = {
  me: { publicKey: ME, isSuperadmin: false },
  can: { createTeam: false, manageSuperadmins: false, removeMembers: false, manageTeamIds: [] },
  members: [member(ME, "Penguji"), member(PK_B, "Anggota Satu", { orgRole: "superadmin", isSuperadmin: true })],
};

function invite(extra: Partial<InviteView> = {}): InviteView {
  return {
    id: "7".repeat(32),
    teamId: TEAM_1,
    teamName: "Desain",
    role: "member",
    projectIds: [],
    validity: "24h",
    expiresAt: "2026-11-23T03:00:00Z",
    createdBy: ME,
    createdAt: "2026-11-22T03:00:00Z",
    status: "active",
    usedBy: [],
    ...extra,
  };
}

type Table = Record<string, unknown>;

function answer(extra: Table = {}, who: OrgOverview = overview()) {
  invoke.mockImplementation(
    router({
      org_overview: who,
      get_directory: dir(),
      org_fingerprint: "ABCD-EFGH",
      org_departments: [department(TEAM_1, "Desain")],
      ...(extra as Record<string, never>),
    }),
  );
}

async function openTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Undangan" }));
  return (await screen.findByRole("heading", { name: "Kode undangan" })).closest("section") as HTMLElement;
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await openTab(user);
  await user.click(screen.getByRole("button", { name: "Buat kode undangan" }));
  return screen.findByRole("dialog", { name: "Undang ke departemen" });
}

function renderOrg() {
  const onRefresh = vi.fn();
  render(<OrgScreen state={state} onRefresh={onRefresh} />);
  return { onRefresh };
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

describe("Undangan: daftar", () => {
  it("menampilkan status, pemakai, dan Cabut hanya untuk kode aktif", async () => {
    const user = userEvent.setup();
    answer({
      get_directory: dir({
        invites: [
          invite({ id: "4".repeat(32), status: "revoked" }),
          invite({ id: "6".repeat(32), status: "used", validity: "once", usedBy: [PK_C] }),
          invite(),
          invite({ id: "5".repeat(32), status: "expired" }),
        ],
      }),
    });
    renderOrg();
    const list = await openTab(user);
    const rows = within(list).getAllByRole("listitem");
    // Aktif dulu, lalu Terpakai, Kedaluwarsa, Dicabut.
    expect(rows.map((r) => within(r).getByText(/^(Aktif|Terpakai|Kedaluwarsa|Dicabut)$/).textContent)).toEqual([
      "Aktif",
      "Terpakai",
      "Kedaluwarsa",
      "Dicabut",
    ]);
    expect(within(list).getAllByText("Desain, Anggota")).toHaveLength(4);
    expect(within(list).getByText(/Dipakai oleh Anggota Dua/)).toBeInTheDocument();
    expect(within(list).getAllByRole("button", { name: /Cabut kode undangan/ })).toHaveLength(1);
  });

  it("mencabut kode memanggil revoke_invite dan menampilkan pesan berhasil", async () => {
    const user = userEvent.setup();
    answer({ get_directory: dir({ invites: [invite()] }) });
    const { onRefresh } = renderOrg();
    const list = await openTab(user);
    await user.click(within(list).getByRole("button", { name: "Cabut kode undangan Desain, Anggota" }));
    expect(invoke).toHaveBeenCalledWith("revoke_invite", { inviteId: "7".repeat(32) });
    expect(
      await screen.findByText("Kode undangan untuk Desain dicabut. Kode itu tidak bisa dipakai lagi."),
    ).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalled();
  });

  it("gagal mencabut: pesan dari Rust tampil", async () => {
    const user = userEvent.setup();
    answer({
      get_directory: dir({ invites: [invite()] }),
      revoke_invite: rustError("database", "Database terkunci."),
    });
    renderOrg();
    const list = await openTab(user);
    await user.click(within(list).getByRole("button", { name: "Cabut kode undangan Desain, Anggota" }));
    expect(await screen.findByText("Kode belum dicabut")).toBeInTheDocument();
    expect(screen.getByText("Database terkunci.")).toBeInTheDocument();
  });

  it("kosong untuk pengelola: diajak membuat kode", async () => {
    const user = userEvent.setup();
    answer();
    renderOrg();
    const list = await openTab(user);
    expect(within(list).getByText(/Belum ada kode undangan. Buat kode untuk mengundang orang baru ke departemen./)).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: "Buat kode undangan" })).toBeInTheDocument();
  });

  it("anggota biasa tidak melihat tombol buat dan diberi tahu siapa yang membuat kode", async () => {
    const user = userEvent.setup();
    answer({ get_directory: dir(memberDir) }, memberOverview());
    renderOrg();
    const list = await openTab(user);
    expect(within(list).getByText(/Kode undangan dibuat oleh admin departemen dan superadmin/)).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: "Buat kode undangan" })).not.toBeInTheDocument();
  });

  it("direktori gagal dibaca: error di tab dan Coba lagi memuat ulang", async () => {
    const user = userEvent.setup();
    let fail = true;
    answer({
      get_directory: () => {
        if (fail) throw { code: "database", message: "Database terkunci." };
        return dir();
      },
    });
    renderOrg();
    await user.click(await screen.findByRole("button", { name: "Undangan" }));
    expect(await screen.findByText("Kode undangan belum terbaca")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByRole("heading", { name: "Kode undangan" })).toBeInTheDocument();
  });
});

describe("Undangan: departemen yang bisa dipilih", () => {
  it("departemen yang diarsipkan tidak muncul di pilihan", async () => {
    const user = userEvent.setup();
    answer({
      get_directory: dir({
        teams: [desain, gudang],
        can: { createTeam: true, manageSuperadmins: true, removeMembers: true, manageTeamIds: [TEAM_1, TEAM_2] },
      }),
      // Gudang diarsipkan: tidak ada di daftar departemen terbuka.
      org_departments: [department(TEAM_1, "Desain")],
    });
    renderOrg();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("org_departments", { includeArchived: false }));
    const dialog = await openDialog(user);
    const select = within(dialog).getByRole("combobox", { name: "Departemen" });
    await waitFor(() => expect(within(select).queryByRole("option", { name: "Gudang" })).not.toBeInTheDocument());
    expect(within(select).getByRole("option", { name: "Desain" })).toBeInTheDocument();
  });

  it("daftar departemen belum terbaca: semua departemen yang dikelola tetap bisa dipilih", async () => {
    const user = userEvent.setup();
    answer({
      get_directory: dir({
        teams: [desain, gudang],
        can: { createTeam: true, manageSuperadmins: true, removeMembers: true, manageTeamIds: [TEAM_1, TEAM_2] },
      }),
      org_departments: rustError("database", "Database terkunci."),
    });
    renderOrg();
    const dialog = await openDialog(user);
    const select = within(dialog).getByRole("combobox", { name: "Departemen" });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Desain", "Gudang"]);
  });

  it("superadmin tanpa departemen terbuka: tidak ada tombol buat, sebabnya ditulis", async () => {
    const user = userEvent.setup();
    answer({ org_departments: [] });
    renderOrg();
    const list = await openTab(user);
    expect(await within(list).findByText(/belum ada\.? Buat atau pulihkan departemen di tab Departemen/)).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: "Buat kode undangan" })).not.toBeInTheDocument();
  });
});

describe("Undangan: dialog buat kode", () => {
  it("superadmin bisa memilih Anggota, Admin departemen, dan Tamu", async () => {
    const user = userEvent.setup();
    answer();
    renderOrg();
    const dialog = await openDialog(user);
    expect(within(dialog).getByRole("combobox", { name: "Departemen" })).toHaveValue(TEAM_1);
    expect(within(dialog).getByRole("radio", { name: /^Anggota/ })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /Admin departemen/ })).toBeEnabled();
    expect(within(dialog).getByRole("radio", { name: /Tamu/ })).toBeEnabled();
    expect(
      within(dialog).getByText("Chat di departemen ini, buat dan kerjakan task di proyek yang ia ikuti"),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "Kode berlaku selama" })).toHaveValue("24h");
    expect(within(dialog).queryByText(/\btim\b/i)).not.toBeInTheDocument();
  });

  it("admin departemen tidak bisa mengundang sebagai Admin departemen", async () => {
    const user = userEvent.setup();
    answer({ get_directory: dir(adminDir) }, adminOverview());
    renderOrg();
    const dialog = await openDialog(user);
    expect(within(dialog).queryByRole("radio", { name: /Admin departemen/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /^Anggota/ })).toBeChecked();
  });

  it("kode tampil sekali: setelah dialog ditutup dan dibuka lagi, kode tidak tampil", async () => {
    const user = userEvent.setup();
    const created = invite({ role: "team_admin", validity: "once" });
    answer({ create_invite: { code: CODE, invite: created } });
    renderOrg();
    let dialog = await openDialog(user);

    await user.click(within(dialog).getByRole("radio", { name: /Admin departemen/ }));
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Kode berlaku selama" }), "once");
    expect(within(dialog).getByText(/Untuk satu orang/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Buat kode undangan" }));

    expect(invoke).toHaveBeenCalledWith("create_invite", {
      teamId: TEAM_1,
      role: "team_admin",
      validity: "once",
      projectIds: [],
    });
    dialog = await screen.findByRole("dialog", { name: "Kode undangan siap" });
    expect(within(dialog).getByText(CODE)).toBeInTheDocument();
    expect(within(dialog).getByText(/hanya ditampilkan sekali/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Admin departemen di Desain/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Salin kode" })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Selesai" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Buat kode undangan" }));
    dialog = await screen.findByRole("dialog", { name: "Undang ke departemen" });
    expect(within(dialog).queryByText(CODE)).not.toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /^Anggota/ })).toBeChecked();
  });

  it("Escape menutup dialog dan fokus kembali ke tombol pembuka", async () => {
    const user = userEvent.setup();
    answer();
    renderOrg();
    await openDialog(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Buat kode undangan" })).toHaveFocus());
  });

  it("izin ditolak ditampilkan jelas di dialog", async () => {
    const user = userEvent.setup();
    answer({ create_invite: rustError("forbidden", "Anda bukan admin departemen ini.") });
    renderOrg();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Buat kode undangan" }));
    expect(await within(dialog).findByText("Anda tidak punya izin mengundang ke departemen ini")).toBeInTheDocument();
    expect(within(dialog).getByText("Anda bukan admin departemen ini.")).toBeInTheDocument();
  });
});

describe("Undangan: kode untuk Tamu", () => {
  const PA = "5".repeat(32);
  const PB = "6".repeat(32);
  const PC = "8".repeat(32);

  function project(id: string, code: string, name: string, teamId: string | null): ProjectSummary {
    return { id, code, name, teamId, teamName: teamId ? "Desain" : null, openCount: 0, taskCount: 0, canManage: true };
  }

  const projects = [
    project(PA, "PA", "Proyek Alfa", TEAM_1),
    project(PB, "KB", "Kantor Baru", TEAM_1),
    project(PC, "LN", "Proyek Lain", "4".repeat(32)),
  ];

  async function openGuest(user: ReturnType<typeof userEvent.setup>) {
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("radio", { name: /Tamu/ }));
    return dialog;
  }

  it("memilih proyek departemen, minimal satu, lalu mengirim id proyek dan menampilkan namanya", async () => {
    const user = userEvent.setup();
    const created = invite({ role: "guest", projectIds: [PB] });
    answer({ board_list_projects: projects, create_invite: { code: CODE, invite: created } });
    renderOrg();
    const dialog = await openGuest(user);
    const alfa = await within(dialog).findByRole("checkbox", { name: /Proyek Alfa/ });
    expect(within(dialog).getByRole("checkbox", { name: /Kantor Baru/ })).not.toBeChecked();
    // Proyek departemen lain tidak ditawarkan.
    expect(within(dialog).queryByRole("checkbox", { name: /Proyek Lain/ })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Buat kode undangan" }));
    expect(within(dialog).getByText("Centang minimal satu proyek yang boleh dilihat Tamu.")).toBeInTheDocument();
    expect(alfa).toHaveFocus();
    expect(alfa).toHaveAttribute("aria-invalid", "true");
    expect(invoke).not.toHaveBeenCalledWith("create_invite", expect.anything());

    await user.click(within(dialog).getByRole("checkbox", { name: /Kantor Baru/ }));
    await user.click(within(dialog).getByRole("button", { name: "Buat kode undangan" }));
    expect(invoke).toHaveBeenCalledWith("create_invite", { teamId: TEAM_1, role: "guest", validity: "24h", projectIds: [PB] });
    const done = await screen.findByRole("dialog", { name: "Kode undangan siap" });
    expect(within(done).getByText(/Tamu di Desain/)).toBeInTheDocument();
    expect(within(done).getByText("KB Kantor Baru")).toBeInTheDocument();
  });

  it("departemen tanpa proyek yang terlihat: dijelaskan dan tombol buat mati", async () => {
    const user = userEvent.setup();
    answer({ board_list_projects: [projects[2]] });
    renderOrg();
    const dialog = await openGuest(user);
    expect(
      await within(dialog).findByText(/Departemen Desain belum punya proyek yang terlihat di laptop ini/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Proyek hanya terlihat kalau Anda anggotanya/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Buat kode undangan" })).toBeDisabled();
  });

  it("daftar proyek gagal dibaca bisa dicoba lagi", async () => {
    const user = userEvent.setup();
    let fail = true;
    answer({
      board_list_projects: () => {
        if (fail) throw { code: "database", message: "Database terkunci." };
        return projects;
      },
    });
    renderOrg();
    const dialog = await openGuest(user);
    expect(await within(dialog).findByText("Daftar proyek belum terbaca")).toBeInTheDocument();
    fail = false;
    await user.click(within(dialog).getByRole("button", { name: "Coba baca lagi" }));
    expect(await within(dialog).findByRole("checkbox", { name: /Proyek Alfa/ })).toBeInTheDocument();
  });

  it("kembali ke Anggota: undangan dikirim tanpa proyek", async () => {
    const user = userEvent.setup();
    answer({ board_list_projects: projects, create_invite: { code: CODE, invite: invite() } });
    renderOrg();
    const dialog = await openGuest(user);
    await user.click(await within(dialog).findByRole("checkbox", { name: /Proyek Alfa/ }));
    await user.click(within(dialog).getByRole("radio", { name: /^Anggota/ }));
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Buat kode undangan" }));
    expect(invoke).toHaveBeenCalledWith("create_invite", { teamId: TEAM_1, role: "member", validity: "24h", projectIds: [] });
  });

  it("paling banyak 50 proyek: centang ke-51 dimatikan dengan keterangan", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 51 }, (_, i) => project(String(i + 10).padStart(32, "0"), `P${i}`, `Proyek ${i}`, TEAM_1));
    answer({ board_list_projects: many });
    renderOrg();
    const dialog = await openGuest(user);
    const boxes = await within(dialog).findAllByRole("checkbox");
    expect(boxes).toHaveLength(51);
    boxes.slice(0, 50).forEach((box) => fireEvent.click(box));
    expect(boxes[49]).toBeChecked();
    expect(boxes[50]).toBeDisabled();
    expect(within(dialog).getByText("Sudah 50 proyek, batas satu kode undangan.")).toBeInTheDocument();
    fireEvent.click(boxes[0]);
    expect(boxes[50]).toBeEnabled();
  });

  it("ganti departemen membuang centang proyek departemen sebelumnya", async () => {
    const user = userEvent.setup();
    const stok = project("9".repeat(32), "GD", "Stok Gudang", TEAM_2);
    answer({
      get_directory: dir({
        teams: [desain, gudang],
        can: { createTeam: true, manageSuperadmins: true, removeMembers: true, manageTeamIds: [TEAM_1, TEAM_2] },
      }),
      org_departments: [department(TEAM_1, "Desain"), department(TEAM_2, "Gudang")],
      board_list_projects: [...projects, stok],
      create_invite: { code: CODE, invite: invite({ role: "guest", teamId: TEAM_2, teamName: "Gudang", projectIds: [stok.id] }) },
    });
    renderOrg();
    const dialog = await openGuest(user);
    await user.click(await within(dialog).findByRole("checkbox", { name: /Proyek Alfa/ }));

    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Departemen" }), TEAM_2);
    expect(within(dialog).queryByRole("checkbox", { name: /Proyek Alfa/ })).not.toBeInTheDocument();
    const box = within(dialog).getByRole("checkbox", { name: /Stok Gudang/ });
    expect(box).not.toBeChecked();
    await user.click(box);
    await user.click(within(dialog).getByRole("button", { name: "Buat kode undangan" }));
    expect(invoke).toHaveBeenCalledWith("create_invite", {
      teamId: TEAM_2,
      role: "guest",
      validity: "24h",
      projectIds: [stok.id],
    });
  });
});

describe("Undangan: memakai kode", () => {
  it("tidak tampil untuk orang yang sudah di departemen", async () => {
    const user = userEvent.setup();
    answer();
    renderOrg();
    await openTab(user);
    expect(screen.queryByLabelText("Kode undangan", { selector: "input" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pakai kode" })).not.toBeInTheDocument();
  });

  it("orang tanpa departemen memakai kode, lalu pesan berhasil tampil", async () => {
    const user = userEvent.setup();
    answer({ get_directory: dir(memberDir) }, memberOverview({ departmentId: null }));
    renderOrg();
    await openTab(user);
    expect(screen.getByRole("heading", { name: "Belum punya departemen? Pakai kode undangan" })).toBeInTheDocument();
    expect(screen.getByText(/Kode memasukkan Anda ke departemen yang tertulis di kode itu/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Kode undangan", { selector: "input" }), "abcdefghjkmnpqrstvwx");
    await user.click(screen.getByRole("button", { name: "Pakai kode" }));
    expect(invoke).toHaveBeenCalledWith("redeem_invite", { code: CODE });
    expect(await screen.findByText(/Kode diterima. Anda sekarang anggota departemen/)).toBeInTheDocument();
    expect(screen.getByLabelText("Kode undangan", { selector: "input" })).toHaveValue("");
  });

  it("kode kedaluwarsa dijelaskan", async () => {
    const user = userEvent.setup();
    answer(
      { get_directory: dir(memberDir), redeem_invite: rustError("invite_expired", "Kedaluwarsa.") },
      memberOverview({ departmentId: null }),
    );
    renderOrg();
    await openTab(user);
    await user.type(screen.getByLabelText("Kode undangan", { selector: "input" }), "abcdefghjkmnpqrstvwx");
    await user.click(screen.getByRole("button", { name: "Pakai kode" }));
    expect(await screen.findByText("Kode sudah kedaluwarsa")).toBeInTheDocument();
  });

  it("kode yang bentuknya salah ditolak sebelum dikirim", async () => {
    const user = userEvent.setup();
    answer({ get_directory: dir(memberDir) }, memberOverview({ departmentId: null }));
    renderOrg();
    await openTab(user);
    const input = screen.getByLabelText("Kode undangan", { selector: "input" });
    await user.type(input, "abc");
    await user.click(screen.getByRole("button", { name: "Pakai kode" }));
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveFocus();
    expect(invoke).not.toHaveBeenCalledWith("redeem_invite", expect.anything());
  });

  it("Tamu melihat kalimat untuk proyek", async () => {
    const user = userEvent.setup();
    const guestDir: Partial<Directory> = {
      ...memberDir,
      members: [member(ME, "Penguji", { orgRole: "guest" }), member(PK_B, "Anggota Satu", { orgRole: "superadmin", isSuperadmin: true })],
    };
    answer({ get_directory: dir(guestDir) }, memberOverview({ isGuest: true, departmentId: null }));
    renderOrg();
    await openTab(user);
    expect(screen.getByRole("heading", { name: "Punya kode undangan Tamu yang baru?" })).toBeInTheDocument();
    expect(screen.getByText("Kode Tamu membuka proyek yang tertulis di kode itu untuk Anda.")).toBeInTheDocument();
  });
});
