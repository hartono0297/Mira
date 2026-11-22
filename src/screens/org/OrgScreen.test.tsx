import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Directory, InviteView, OrgInfo } from "../../api";
import type { ProjectSummary } from "../../api/board";
import { appState, directory, member, ME, PK_B, PK_C, router, rustError, TEAM_1 } from "../../test/fixtures";
import { OrgScreen } from "./OrgScreen";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const state = appState() as AppState & { organization: OrgInfo };

function renderOrg() {
  const onRefresh = vi.fn();
  render(<OrgScreen state={state} onRefresh={onRefresh} />);
  return { onRefresh };
}

function invite(extra: Partial<InviteView> = {}): InviteView {
  return {
    id: "7".repeat(32),
    teamId: TEAM_1,
    teamName: "Tim Uji",
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

const teamAdminOnly: Partial<Directory> = {
  me: { publicKey: ME, isSuperadmin: false },
  can: { createTeam: false, manageSuperadmins: false, removeMembers: false, manageTeamIds: [TEAM_1] },
  members: [
    member(ME, "Penguji", { orgRole: "team_admin", teams: [{ teamId: TEAM_1, role: "admin" }] }),
    member(PK_B, "Anggota Satu", { orgRole: "superadmin", isSuperadmin: true, teams: [{ teamId: TEAM_1, role: "member" }] }),
    member(PK_C, "Anggota Dua"),
  ],
};

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

describe("Organisasi: keadaan dasar", () => {
  it("memuat, lalu menampilkan daftar tim dan channel tim", async () => {
    invoke.mockImplementation(router({ get_directory: directory() }));
    renderOrg();
    expect(screen.getByText("Memuat data organisasi...")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Tim Uji/ })).toBeInTheDocument();
    expect(screen.getByText(/2 anggota, channel #tim-uji/)).toBeInTheDocument();
  });

  it("error membaca direktori bisa dicoba lagi", async () => {
    const user = userEvent.setup();
    let fail = true;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd !== "get_directory") return null;
      if (fail) throw { code: "database", message: "Database terkunci." };
      return directory();
    });
    renderOrg();
    expect(await screen.findByText("Data organisasi belum terbaca")).toBeInTheDocument();
    expect(screen.getByText("Database terkunci.")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Coba baca lagi" }));
    expect(await screen.findByRole("button", { name: /Tim Uji/ })).toBeInTheDocument();
  });

  it("belum ada tim: superadmin diajak membuat tim pertama", async () => {
    invoke.mockImplementation(router({ get_directory: directory({ teams: [] }) }));
    renderOrg();
    expect(await screen.findByText(/Belum ada tim. Buat tim pertama/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buat tim" })).toBeInTheDocument();
  });

  it("bukan superadmin tidak melihat tombol Buat tim", async () => {
    invoke.mockImplementation(router({ get_directory: directory(teamAdminOnly) }));
    renderOrg();
    expect(await screen.findByRole("button", { name: /Tim Uji/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Buat tim" })).not.toBeInTheDocument();
  });
});

describe("Organisasi: peringatan superadmin tunggal", () => {
  it("muncul untuk superadmin kalau superadmin baru satu, dan mengarah ke Anggota", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(router({ get_directory: directory({ superadminCount: 1 }) }));
    renderOrg();
    expect(await screen.findByText("Organisasi ini baru punya satu superadmin")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pilih anggota di bagian Anggota" }));
    expect(screen.getByRole("heading", { name: /Anggota organisasi/ })).toBeInTheDocument();
  });

  it("tidak muncul kalau sudah dua superadmin", async () => {
    invoke.mockImplementation(router({ get_directory: directory({ superadminCount: 2 }) }));
    renderOrg();
    await screen.findByRole("button", { name: /Tim Uji/ });
    expect(screen.queryByText("Organisasi ini baru punya satu superadmin")).not.toBeInTheDocument();
  });

  it("tidak muncul untuk yang bukan superadmin", async () => {
    invoke.mockImplementation(router({ get_directory: directory({ ...teamAdminOnly, superadminCount: 1 }) }));
    renderOrg();
    await screen.findByRole("button", { name: /Tim Uji/ });
    expect(screen.queryByText("Organisasi ini baru punya satu superadmin")).not.toBeInTheDocument();
  });
});

describe("Organisasi: dialog undangan", () => {
  async function openInvite(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: /Tim Uji/ }));
    await user.click(screen.getByRole("button", { name: "Undang ke tim" }));
    return screen.findByRole("dialog", { name: "Undang ke Tim Uji" });
  }

  it("superadmin bisa memilih Anggota, Admin tim, dan Tamu", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(router({ get_directory: directory() }));
    renderOrg();
    const dialog = await openInvite(user);

    expect(within(dialog).getByRole("radio", { name: /Anggota/ })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /Admin tim/ })).toBeEnabled();
    expect(within(dialog).getByRole("radio", { name: /Tamu/ })).toBeEnabled();
    expect(within(dialog).queryByText(/Tahap 3/)).not.toBeInTheDocument();
    expect(within(dialog).getByText("Chat, buat dan kerjakan task di semua proyek tim")).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "Kode berlaku selama" })).toHaveValue("24h");
  });

  it("admin tim tidak bisa mengundang sebagai Admin tim", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(router({ get_directory: directory(teamAdminOnly) }));
    renderOrg();
    const dialog = await openInvite(user);
    expect(within(dialog).queryByRole("radio", { name: /Admin tim/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /Anggota/ })).toBeChecked();
  });

  it("kode tampil sekali: setelah dialog ditutup dan dibuka lagi, kode tidak tampil", async () => {
    const user = userEvent.setup();
    const created = invite({ role: "team_admin", validity: "once" });
    invoke.mockImplementation(
      router({
        get_directory: directory(),
        create_invite: { code: "ABCD-EFGH-JKMN-PQRS-TVWX", invite: created },
      }),
    );
    renderOrg();
    let dialog = await openInvite(user);

    await user.click(within(dialog).getByRole("radio", { name: /Admin tim/ }));
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
    expect(within(dialog).getByText("ABCD-EFGH-JKMN-PQRS-TVWX")).toBeInTheDocument();
    expect(within(dialog).getByText(/hanya ditampilkan sekali/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Admin tim di Tim Uji/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Salin kode" })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Selesai" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Undang ke tim" }));
    dialog = await screen.findByRole("dialog", { name: "Undang ke Tim Uji" });
    expect(within(dialog).queryByText("ABCD-EFGH-JKMN-PQRS-TVWX")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /Anggota/ })).toBeChecked();
  });

  it("Escape menutup dialog", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(router({ get_directory: directory() }));
    renderOrg();
    await openInvite(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Undang ke tim" })).toHaveFocus());
  });

  it("izin ditolak ditampilkan jelas", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(
      router({ get_directory: directory(), create_invite: rustError("forbidden", "Anda bukan admin tim ini.") }),
    );
    renderOrg();
    const dialog = await openInvite(user);
    await user.click(within(dialog).getByRole("button", { name: "Buat kode undangan" }));
    expect(await within(dialog).findByText("Anda tidak punya izin mengundang ke tim ini")).toBeInTheDocument();
    expect(within(dialog).getByText("Anda bukan admin tim ini.")).toBeInTheDocument();
  });
});

describe("Organisasi: undangan Tamu", () => {
  const PA = "5".repeat(32);
  const PB = "6".repeat(32);
  const PC = "8".repeat(32);

  function project(id: string, code: string, name: string, teamId: string | null): ProjectSummary {
    return { id, code, name, teamId, teamName: teamId ? "Tim Uji" : null, openCount: 0, taskCount: 0, canManage: true };
  }

  const projects = [
    project(PA, "PA", "Proyek Alfa", TEAM_1),
    project(PB, "KB", "Kantor Baru", TEAM_1),
    project(PC, "LN", "Tim Lain", "4".repeat(32)),
  ];

  async function openGuestInvite(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: /Tim Uji/ }));
    await user.click(screen.getByRole("button", { name: "Undang ke tim" }));
    const dialog = await screen.findByRole("dialog", { name: "Undang ke Tim Uji" });
    await user.click(within(dialog).getByRole("radio", { name: /Tamu/ }));
    return dialog;
  }

  it("memilih proyek tim, minimal satu, lalu mengirim id proyek dan menampilkan namanya", async () => {
    const user = userEvent.setup();
    const created = invite({ role: "guest", projectIds: [PB] });
    invoke.mockImplementation(
      router({
        get_directory: directory(),
        board_list_projects: projects,
        create_invite: { code: "ABCD-EFGH-JKMN-PQRS-TVWX", invite: created },
      }),
    );
    renderOrg();
    const dialog = await openGuestInvite(user);
    expect(
      within(dialog).getByText(/Tamu hanya bisa melihat board dan komentar proyek yang dicentang, tidak bisa mengubah task/),
    ).toBeInTheDocument();
    const alfa = await within(dialog).findByRole("checkbox", { name: /Proyek Alfa/ });
    expect(within(dialog).getByRole("checkbox", { name: /Kantor Baru/ })).not.toBeChecked();
    // Proyek tim lain tidak ditawarkan.
    expect(within(dialog).queryByRole("checkbox", { name: /Tim Lain/ })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Buat kode undangan" }));
    expect(within(dialog).getByText("Centang minimal satu proyek yang boleh dilihat Tamu.")).toBeInTheDocument();
    expect(alfa).toHaveFocus();
    expect(invoke).not.toHaveBeenCalledWith("create_invite", expect.anything());

    await user.click(within(dialog).getByRole("checkbox", { name: /Kantor Baru/ }));
    await user.click(within(dialog).getByRole("button", { name: "Buat kode undangan" }));
    expect(invoke).toHaveBeenCalledWith("create_invite", {
      teamId: TEAM_1,
      role: "guest",
      validity: "24h",
      projectIds: [PB],
    });
    const done = await screen.findByRole("dialog", { name: "Kode undangan siap" });
    expect(within(done).getByText(/Tamu di Tim Uji/)).toBeInTheDocument();
    expect(within(done).getByText("KB Kantor Baru")).toBeInTheDocument();
  });

  it("tim tanpa proyek yang terlihat: dijelaskan dan tombol buat mati", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(router({ get_directory: directory(), board_list_projects: [projects[2]] }));
    renderOrg();
    const dialog = await openGuestInvite(user);
    expect(await within(dialog).findByText(/Tim Uji belum punya proyek yang terlihat di laptop ini/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Buat kode undangan" })).toBeDisabled();
  });

  it("kembali ke Anggota: undangan dikirim tanpa proyek", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(
      router({
        get_directory: directory(),
        board_list_projects: projects,
        create_invite: { code: "ABCD-EFGH-JKMN-PQRS-TVWX", invite: invite() },
      }),
    );
    renderOrg();
    const dialog = await openGuestInvite(user);
    await user.click(await within(dialog).findByRole("checkbox", { name: /Proyek Alfa/ }));
    await user.click(within(dialog).getByRole("radio", { name: /Anggota/ }));
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Buat kode undangan" }));
    expect(invoke).toHaveBeenCalledWith("create_invite", { teamId: TEAM_1, role: "member", validity: "24h", projectIds: [] });
  });

  it("paling banyak 50 proyek: centang ke-51 dimatikan dengan keterangan", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 51 }, (_, i) =>
      project(String(i + 10).padStart(32, "0"), `P${i}`, `Proyek ${i}`, TEAM_1),
    );
    invoke.mockImplementation(router({ get_directory: directory(), board_list_projects: many }));
    renderOrg();
    const dialog = await openGuestInvite(user);
    const boxes = await within(dialog).findAllByRole("checkbox");
    expect(boxes).toHaveLength(51);
    boxes.slice(0, 50).forEach((box) => fireEvent.click(box));
    expect(boxes[49]).toBeChecked();
    expect(boxes[50]).toBeDisabled();
    expect(within(dialog).getByText("Sudah 50 proyek, batas satu kode undangan.")).toBeInTheDocument();
    fireEvent.click(boxes[0]);
    expect(boxes[50]).toBeEnabled();
  });

  it("ganti tim membuang centang proyek tim sebelumnya", async () => {
    const user = userEvent.setup();
    const TEAM_2 = "4".repeat(32);
    const dir = directory({
      teams: [
        ...directory().teams,
        { id: TEAM_2, name: "Gudang", createdAt: "2026-11-22T03:00:00Z", members: [{ publicKey: ME, role: "admin" }] },
      ],
      can: { createTeam: true, manageSuperadmins: true, removeMembers: true, manageTeamIds: [TEAM_1, TEAM_2] },
    });
    const gudang = project("9".repeat(32), "GD", "Stok Gudang", TEAM_2);
    invoke.mockImplementation(
      router({
        get_directory: dir,
        board_list_projects: [...projects, gudang],
        create_invite: { code: "ABCD-EFGH-JKMN-PQRS-TVWX", invite: invite({ role: "guest", teamId: TEAM_2, projectIds: [gudang.id] }) },
      }),
    );
    renderOrg();
    await user.click(await screen.findByRole("button", { name: "Kode undangan" }));
    await user.click(screen.getByRole("button", { name: "Buat kode undangan" }));
    const dialog = await screen.findByRole("dialog", { name: "Undang ke tim" });
    await user.click(within(dialog).getByRole("radio", { name: /Tamu/ }));
    await user.click(await within(dialog).findByRole("checkbox", { name: /Proyek Alfa/ }));

    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Tim" }), TEAM_2);
    expect(within(dialog).queryByRole("checkbox", { name: /Proyek Alfa/ })).not.toBeInTheDocument();
    const stok = within(dialog).getByRole("checkbox", { name: /Stok Gudang/ });
    expect(stok).not.toBeChecked();
    await user.click(stok);
    await user.click(within(dialog).getByRole("button", { name: "Buat kode undangan" }));
    expect(invoke).toHaveBeenCalledWith("create_invite", {
      teamId: TEAM_2,
      role: "guest",
      validity: "24h",
      projectIds: [gudang.id],
    });
  });

  it("superadmin di luar tim: diberi tahu proyek tim baru terlihat setelah masuk tim", async () => {
    const user = userEvent.setup();
    const outside = directory({
      teams: [{ id: TEAM_1, name: "Tim Uji", createdAt: "2026-11-22T03:00:00Z", members: [{ publicKey: PK_B, role: "admin" }] }],
    });
    invoke.mockImplementation(router({ get_directory: outside, board_list_projects: [] }));
    renderOrg();
    const dialog = await openGuestInvite(user);
    expect(await within(dialog).findByText(/masuk dulu ke tim itu supaya proyeknya terlihat/)).toBeInTheDocument();
  });

  it("tanpa centang: kotak pertama ditandai tidak valid", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(router({ get_directory: directory(), board_list_projects: projects }));
    renderOrg();
    const dialog = await openGuestInvite(user);
    const first = await within(dialog).findByRole("checkbox", { name: /Proyek Alfa/ });
    await user.click(within(dialog).getByRole("button", { name: "Buat kode undangan" }));
    expect(first).toHaveAttribute("aria-invalid", "true");
    expect(first).toHaveAccessibleDescription(/Centang minimal satu proyek/);
  });
});

describe("Organisasi: daftar undangan", () => {
  it("menampilkan status dan tombol Cabut hanya untuk yang aktif", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(
      router({
        get_directory: directory({
          invites: [
            invite(),
            invite({ id: "6".repeat(32), status: "used", validity: "once", usedBy: [PK_C] }),
            invite({ id: "5".repeat(32), status: "expired" }),
            invite({ id: "4".repeat(32), status: "revoked" }),
          ],
        }),
      }),
    );
    renderOrg();
    await user.click(await screen.findByRole("button", { name: "Kode undangan" }));

    const list = screen.getByRole("heading", { name: "Kode undangan" }).closest("section") as HTMLElement;
    for (const label of ["Aktif", "Terpakai", "Kedaluwarsa", "Dicabut"]) {
      expect(within(list).getByText(label)).toBeInTheDocument();
    }
    expect(within(list).getByText(/Dipakai oleh Anggota Dua/)).toBeInTheDocument();
    const revoke = within(list).getAllByRole("button", { name: /Cabut kode undangan/ });
    expect(revoke).toHaveLength(1);

    await user.click(revoke[0]);
    expect(invoke).toHaveBeenCalledWith("revoke_invite", { inviteId: "7".repeat(32) });
    expect(await screen.findByText(/dicabut. Kode itu tidak bisa dipakai lagi/)).toBeInTheDocument();
  });
});

describe("Organisasi: anggota", () => {
  it("mengeluarkan anggota butuh konfirmasi yang menjelaskan data tetap di laptopnya", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(router({ get_directory: directory() }));
    const { onRefresh } = renderOrg();
    await user.click(await screen.findByRole("button", { name: "Anggota" }));

    expect(screen.queryByRole("button", { name: "Keluarkan Penguji dari organisasi" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keluarkan Anggota Dua dari organisasi" }));

    const dialog = await screen.findByRole("dialog", { name: "Keluarkan Anggota Dua dari organisasi?" });
    expect(within(dialog).getByText(/tetap ada di sana. Mira tidak bisa menghapusnya dari jauh/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Batal" })).toHaveFocus();
    expect(invoke).not.toHaveBeenCalledWith("remove_member", expect.anything());

    await user.click(within(dialog).getByRole("button", { name: "Keluarkan Anggota Dua" }));
    expect(invoke).toHaveBeenCalledWith("remove_member", { publicKey: PK_C });
    expect(await screen.findByText("Anggota Dua sudah dikeluarkan dari organisasi.")).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalled();
  });

  it("batal tidak mengeluarkan siapa pun", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(router({ get_directory: directory() }));
    renderOrg();
    await user.click(await screen.findByRole("button", { name: "Anggota" }));
    await user.click(screen.getByRole("button", { name: "Keluarkan Anggota Dua dari organisasi" }));
    await user.click(await screen.findByRole("button", { name: "Batal" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(invoke).not.toHaveBeenCalledWith("remove_member", expect.anything());
  });

  it("menjadikan superadmin, dan error superadmin terakhir dijelaskan", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(
      router({
        get_directory: directory(),
        remove_superadmin: rustError("last_superadmin", "Superadmin terakhir tidak bisa dilepas."),
      }),
    );
    renderOrg();
    await user.click(await screen.findByRole("button", { name: "Anggota" }));

    await user.click(screen.getByRole("button", { name: "Jadikan Anggota Satu superadmin" }));
    expect(invoke).toHaveBeenCalledWith("add_superadmin", { publicKey: PK_B });
    expect(await screen.findByText("Anggota Satu sekarang superadmin.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Lepas peran superadmin Anda" }));
    expect(await screen.findByText("Organisasi butuh minimal satu superadmin")).toBeInTheDocument();
    expect(screen.getByText("Superadmin terakhir tidak bisa dilepas.")).toBeInTheDocument();
    expect(screen.getByText(/Jadikan anggota lain superadmin dulu/)).toBeInTheDocument();
  });

  it("tanpa izin, tidak ada tombol kelola anggota", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(router({ get_directory: directory(teamAdminOnly) }));
    renderOrg();
    await user.click(await screen.findByRole("button", { name: "Anggota" }));
    expect(screen.getByText("Anggota Dua")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /superadmin/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /dari organisasi/ })).not.toBeInTheDocument();
  });

  it("error forbidden dari Rust ditampilkan jelas", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(
      router({ get_directory: directory(), add_superadmin: rustError("forbidden", "Hanya superadmin yang boleh.") }),
    );
    renderOrg();
    await user.click(await screen.findByRole("button", { name: "Anggota" }));
    await user.click(screen.getByRole("button", { name: "Jadikan Anggota Satu superadmin" }));
    expect(await screen.findByText("Anda tidak punya izin untuk ini")).toBeInTheDocument();
    expect(screen.getByText("Hanya superadmin yang boleh.")).toBeInTheDocument();
  });
});

describe("Organisasi: detail tim", () => {
  it("menambah anggota yang sudah ada dan mengangkat admin tim", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(router({ get_directory: directory() }));
    renderOrg();
    await user.click(await screen.findByRole("button", { name: /Tim Uji/ }));

    const select = screen.getByRole("combobox", { name: "Tambah anggota organisasi ke tim" });
    await user.selectOptions(select, PK_C);
    await user.click(screen.getByRole("button", { name: "Tambahkan" }));
    expect(invoke).toHaveBeenCalledWith("add_team_member", { teamId: TEAM_1, publicKey: PK_C });

    await user.click(screen.getByRole("button", { name: "Jadikan admin tim" }));
    expect(invoke).toHaveBeenCalledWith("set_team_admin", { teamId: TEAM_1, publicKey: PK_B, admin: true });
  });

  it("menghapus tim butuh konfirmasi", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(router({ get_directory: directory() }));
    renderOrg();
    await user.click(await screen.findByRole("button", { name: /Tim Uji/ }));
    await user.click(screen.getByRole("button", { name: "Hapus tim" }));
    const dialog = await screen.findByRole("dialog", { name: "Hapus Tim Uji?" });
    expect(within(dialog).getByText(/tidak bisa dikembalikan/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Hapus tim" }));
    expect(invoke).toHaveBeenCalledWith("delete_team", { teamId: TEAM_1 });
  });

  it("membuat tim lewat dialog dengan validasi nama", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(
      router({
        get_directory: directory(),
        create_team: { id: "2".repeat(32), name: "Tim Baru", createdAt: "2026-11-22T05:00:00Z", members: [] },
      }),
    );
    renderOrg();
    await user.click(await screen.findByRole("button", { name: "Buat tim" }));
    const dialog = await screen.findByRole("dialog", { name: "Buat tim" });
    await user.type(within(dialog).getByLabelText("Nama tim"), "A");
    await user.click(within(dialog).getByRole("button", { name: "Buat tim" }));
    expect(await within(dialog).findByText("Nama tim minimal 2 karakter.")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("create_team", expect.anything());

    await user.type(within(dialog).getByLabelText("Nama tim"), "  Tim Baru");
    await user.clear(within(dialog).getByLabelText("Nama tim"));
    await user.type(within(dialog).getByLabelText("Nama tim"), "Tim Baru");
    await user.click(within(dialog).getByRole("button", { name: "Buat tim" }));
    expect(invoke).toHaveBeenCalledWith("create_team", { name: "Tim Baru" });
    expect(await screen.findByText(/Tim Baru dibuat/)).toBeInTheDocument();
  });

  it("anggota memakai kode undangan untuk tim lain", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(
      router({ get_directory: directory(), redeem_invite: rustError("invite_expired", "Kedaluwarsa.") }),
    );
    renderOrg();
    await screen.findByRole("button", { name: /Tim Uji/ });
    await user.type(screen.getByLabelText("Kode undangan"), "abcdefghjkmnpqrstvwx");
    await user.click(screen.getByRole("button", { name: "Pakai kode" }));
    expect(invoke).toHaveBeenCalledWith("redeem_invite", { code: "ABCD-EFGH-JKMN-PQRS-TVWX" });
    expect(await screen.findByText("Kode sudah kedaluwarsa")).toBeInTheDocument();
  });
});
