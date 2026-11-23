import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonView, ProjectMembersView, ProjectMemberView } from "../../api/org";
import { ProjectMembersPanel, useProjectMembers } from "./ProjectMembersPanel";

const org = vi.hoisted(() => ({
  projectMembers: vi.fn(),
  people: vi.fn(),
  addProjectMember: vi.fn(),
  removeProjectMember: vi.fn(),
}));

// Event organisasi (mira://directory) dipicu sendiri oleh tes lewat orgEvent().
const orgListeners = vi.hoisted(() => new Set<() => void>());

vi.mock("../../api/org", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/org")>()),
  orgApi: org,
  subscribeOrg: (handler: () => void) => {
    orgListeners.add(handler);
    return () => orgListeners.delete(handler);
  },
}));

async function orgEvent() {
  await act(async () => {
    orgListeners.forEach((h) => h());
  });
}

const P1 = "1".repeat(32);
const ME = "a".repeat(64);
const PK_B = "b".repeat(64);
const PK_C = "c".repeat(64);
const PK_G = "d".repeat(64);
const PK_S = "e".repeat(64);
const PK_Y = "f".repeat(64);
const DEPT = "9".repeat(32);

function m(publicKey: string, displayName: string, extra: Partial<ProjectMemberView> = {}): ProjectMemberView {
  return { publicKey, displayName, departmentName: "Desain", role: "member", isCreator: false, byInvite: false, ...extra };
}

function members(extra: Partial<ProjectMembersView> = {}): ProjectMembersView {
  return {
    projectId: P1,
    registered: true,
    teamId: DEPT,
    creator: ME,
    members: [
      m(ME, "Rina Uji", { role: "manager", isCreator: true }),
      m(PK_B, "Budi Uji", { departmentName: "Drafting" }),
      m(PK_C, "Citra Uji", { departmentName: null }),
      m(PK_G, "Gita Tamu", { role: "guest", departmentName: null, byInvite: true }),
    ],
    canManage: true,
    canLeave: true,
    canJoinSelf: false,
    ...extra,
  };
}

function person(publicKey: string, displayName: string, extra: Partial<PersonView> = {}): PersonView {
  return {
    publicKey,
    displayName,
    fingerprint: "AAAA 0000",
    role: "member",
    isSuperadmin: false,
    isGuest: false,
    departmentId: DEPT,
    departmentName: "Desain",
    departmentRole: null,
    labels: [],
    ...extra,
  };
}

const PEOPLE = [
  person(ME, "Rina Uji"),
  person(PK_B, "Budi Uji"),
  person(PK_C, "Citra Uji"),
  person(PK_S, "Sari Uji"),
  person(PK_Y, "Yusuf Tamu", { isGuest: true, role: "guest", departmentId: null, departmentName: null }),
];

let current: ProjectMembersView;

function Harness({ onLeft = () => {} }: { onLeft?: () => void }) {
  const live = useProjectMembers(P1);
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Buka panel
      </button>
      <ProjectMembersPanel open={open} onOpenChange={setOpen} projectId={P1} me={ME} members={live} onLeft={onLeft} />
    </>
  );
}

async function openPanel() {
  const dlg = await screen.findByRole("dialog", { name: "Anggota proyek" });
  await within(dlg).findByText(/Hanya \d+ orang ini/);
  return dlg;
}

beforeEach(() => {
  orgListeners.clear();
  current = members();
  org.projectMembers.mockReset().mockImplementation(async () => current);
  org.people.mockReset().mockResolvedValue(PEOPLE);
  org.addProjectMember.mockReset().mockResolvedValue(null);
  org.removeProjectMember.mockReset().mockImplementation(async (_p: string, key: string) => {
    current = { ...current, members: current.members.filter((x) => x.publicKey !== key) };
    return null;
  });
});

describe("Panel Anggota proyek: daftar", () => {
  it("mengelompokkan Pengelola, Anggota, dan Tamu dengan keterangan tiap orang", async () => {
    render(<Harness />);
    const dlg = await openPanel();
    expect(within(dlg).getByText("Hanya 4 orang ini yang melihat board, chat, dan dokumen proyek ini.")).toBeInTheDocument();

    const managers = within(dlg).getByRole("region", { name: "Pengelola" });
    expect(within(managers).getByText("Rina Uji (Anda)")).toBeInTheDocument();
    expect(within(managers).getByText("Desain, pembuat proyek")).toBeInTheDocument();

    const regular = within(dlg).getByRole("region", { name: "Anggota" });
    expect(within(regular).getAllByRole("listitem").map((li) => li.querySelector(".pm-name")?.textContent)).toEqual([
      "Budi Uji",
      "Citra Uji",
    ]);
    expect(within(regular).getByText("Drafting")).toBeInTheDocument();
    expect(within(regular).getByText("Tanpa departemen")).toBeInTheDocument();

    const guests = within(dlg).getByRole("region", { name: "Tamu" });
    expect(within(guests).getByText("Tamu lewat undangan")).toBeInTheDocument();
    expect(within(guests).getByText("GT")).toHaveAttribute("aria-hidden", "true");
  });

  it("anggota biasa melihat daftar yang sama tanpa tombol kelola", async () => {
    current = members({ canManage: false, canLeave: false });
    render(<Harness />);
    const dlg = await openPanel();
    expect(within(dlg).queryByRole("button", { name: /^Keluarkan/ })).not.toBeInTheDocument();
    expect(within(dlg).queryByRole("button", { name: "Tambah anggota" })).not.toBeInTheDocument();
    expect(within(dlg).queryByRole("button", { name: "Keluar dari proyek" })).not.toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Tutup" })).toBeInTheDocument();
  });

  it("gagal dibaca: penjelasan dan Coba lagi", async () => {
    const user = userEvent.setup();
    org.projectMembers.mockRejectedValueOnce({ code: "database", message: "Database terkunci." });
    render(<Harness />);
    const dlg = await screen.findByRole("dialog", { name: "Anggota proyek" });
    expect(await within(dlg).findByText("Daftar anggota belum terbaca")).toBeInTheDocument();
    expect(within(dlg).getByText("Database terkunci.")).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Coba lagi" }));
    expect(await within(dlg).findByText(/Hanya 4 orang ini/)).toBeInTheDocument();
  });

  it("dimuat ulang saat data organisasi berubah", async () => {
    render(<Harness />);
    const dlg = await openPanel();
    current = { ...current, members: [...current.members, m(PK_S, "Sari Uji")] };
    await orgEvent();
    expect(await within(dlg).findByText("Sari Uji")).toBeInTheDocument();
    expect(within(dlg).getByText(/Hanya 5 orang ini/)).toBeInTheDocument();
  });

  it("proyek belum terdaftar: dijelaskan, tanpa tombol tambah", async () => {
    current = members({ registered: false, members: [], canManage: true, canLeave: false });
    render(<Harness />);
    const dlg = await screen.findByRole("dialog", { name: "Anggota proyek" });
    expect(await within(dlg).findByText(/belum terdaftar di organisasi/)).toBeInTheDocument();
    expect(within(dlg).queryByRole("button", { name: "Tambah anggota" })).not.toBeInTheDocument();
  });
});

describe("Panel Anggota proyek: keluarkan dan keluar", () => {
  it("pengelola mengeluarkan anggota setelah konfirmasi", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const dlg = await openPanel();
    expect(within(dlg).queryByRole("button", { name: "Keluarkan Rina Uji dari proyek" })).not.toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Keluarkan Budi Uji dari proyek" }));

    const confirm = screen.getByRole("dialog", { name: "Keluarkan Budi Uji dari proyek?" });
    expect(within(confirm).getByText(/berhenti menerima data baru proyek ini/)).toBeInTheDocument();
    expect(within(confirm).getByRole("button", { name: "Batal" })).toHaveFocus();
    await user.click(within(confirm).getByRole("button", { name: "Keluarkan" }));

    expect(org.removeProjectMember).toHaveBeenCalledWith(P1, PK_B);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Keluarkan Budi/ })).not.toBeInTheDocument());
    expect(within(dlg).queryByText("Budi Uji")).not.toBeInTheDocument();
    expect(within(dlg).getByText(/Hanya 3 orang ini/)).toBeInTheDocument();
    expect(within(dlg).getByText("Budi Uji dikeluarkan dari proyek.")).toBeInTheDocument();
    await waitFor(() => expect(within(dlg).getByText(/Hanya 3 orang ini/).closest("p")).toHaveFocus());
  });

  it("Tamu lewat undangan juga bisa dikeluarkan, dengan keterangan aksesnya dicabut", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const dlg = await openPanel();
    await user.click(within(dlg).getByRole("button", { name: "Keluarkan Gita Tamu dari proyek" }));
    const confirm = screen.getByRole("dialog", { name: "Keluarkan Gita Tamu dari proyek?" });
    expect(within(confirm).getByText(/Akses Tamu lewat undangan untuk proyek ini ikut dicabut/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Keluarkan" }));
    expect(org.removeProjectMember).toHaveBeenCalledWith(P1, PK_G);
  });

  it("gagal mengeluarkan: error di dialog konfirmasi, anggota tetap ada", async () => {
    const user = userEvent.setup();
    org.removeProjectMember.mockRejectedValueOnce({ code: "forbidden", message: "Anda bukan pengelola proyek ini." });
    render(<Harness />);
    const dlg = await openPanel();
    await user.click(within(dlg).getByRole("button", { name: "Keluarkan Budi Uji dari proyek" }));
    const confirm = screen.getByRole("dialog", { name: "Keluarkan Budi Uji dari proyek?" });
    await user.click(within(confirm).getByRole("button", { name: "Keluarkan" }));
    expect(await within(confirm).findByText("Budi Uji belum dikeluarkan")).toBeInTheDocument();
    expect(within(confirm).getByText("Anda bukan pengelola proyek ini.")).toBeInTheDocument();
    expect(within(dlg).getByText("Budi Uji")).toBeInTheDocument();
  });

  it("anggota keluar sendiri: konfirmasi, panel tertutup, dan pemanggil diberi tahu", async () => {
    const user = userEvent.setup();
    const onLeft = vi.fn();
    render(<Harness onLeft={onLeft} />);
    const dlg = await openPanel();
    await user.click(within(dlg).getByRole("button", { name: "Keluar dari proyek" }));
    const confirm = screen.getByRole("dialog", { name: "Keluar dari proyek ini?" });
    expect(within(confirm).getByText(/minta pengelola proyek menambahkan Anda lagi/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Keluar dari proyek" }));
    expect(org.removeProjectMember).toHaveBeenCalledWith(P1, ME);
    await waitFor(() => expect(onLeft).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("Panel Anggota proyek: tambah anggota", () => {
  async function openAdd(user: ReturnType<typeof userEvent.setup>) {
    render(<Harness />);
    const dlg = await openPanel();
    await user.click(within(dlg).getByRole("button", { name: "Tambah anggota" }));
    const add = screen.getByRole("dialog", { name: "Tambah anggota proyek" });
    await within(add).findByRole("checkbox", { name: "Sari Uji" });
    return { dlg, add };
  }

  it("hanya menawarkan yang belum anggota, termasuk Tamu, dan menambah satu per satu", async () => {
    const user = userEvent.setup();
    const { dlg, add } = await openAdd(user);
    expect(within(add).getAllByRole("checkbox")).toHaveLength(2);
    expect(within(add).queryByRole("checkbox", { name: "Budi Uji" })).not.toBeInTheDocument();
    expect(within(add).getByRole("checkbox", { name: "Yusuf Tamu" })).toBeInTheDocument();

    await user.click(within(add).getByRole("checkbox", { name: "Sari Uji" }));
    await user.click(within(add).getByRole("checkbox", { name: "Yusuf Tamu" }));
    org.addProjectMember.mockImplementation(async (_p: string, key: string) => {
      const p = PEOPLE.find((x) => x.publicKey === key)!;
      current = { ...current, members: [...current.members, m(key, p.displayName, { role: p.isGuest ? "guest" : "member" })] };
      return null;
    });
    await user.click(within(add).getByRole("button", { name: "Tambahkan" }));

    expect(org.addProjectMember.mock.calls).toEqual([
      [P1, PK_S],
      [P1, PK_Y],
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Tambah anggota proyek" })).not.toBeInTheDocument());
    expect(within(dlg).getByText("Sari Uji")).toBeInTheDocument();
    expect(within(dlg).getByText("Tamu, ditambahkan ke proyek ini")).toBeInTheDocument();
    expect(within(dlg).getByText("2 orang ditambahkan ke proyek.")).toBeInTheDocument();
  });

  it("tanpa pilihan: diminta memilih dulu", async () => {
    const user = userEvent.setup();
    const { add } = await openAdd(user);
    await user.click(within(add).getByRole("button", { name: "Tambahkan" }));
    expect(within(add).getByText("Pilih minimal satu orang.")).toBeInTheDocument();
    expect(org.addProjectMember).not.toHaveBeenCalled();
  });

  it("sebagian gagal: yang gagal disebut dan tetap terpilih", async () => {
    const user = userEvent.setup();
    const { add } = await openAdd(user);
    await user.click(within(add).getByRole("checkbox", { name: "Sari Uji" }));
    await user.click(within(add).getByRole("checkbox", { name: "Yusuf Tamu" }));
    org.addProjectMember
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce({ code: "invalid_input", message: "Orang ini sudah dikeluarkan dari organisasi." });
    await user.click(within(add).getByRole("button", { name: "Tambahkan" }));

    expect(await within(add).findByText("Yusuf Tamu belum ditambahkan")).toBeInTheDocument();
    expect(within(add).getByText("Yusuf Tamu: Orang ini sudah dikeluarkan dari organisasi.")).toBeInTheDocument();
    expect(within(add).getByRole("checkbox", { name: "Yusuf Tamu" })).toBeChecked();
    expect(within(add).getByRole("checkbox", { name: "Sari Uji" })).not.toBeChecked();
    expect(org.addProjectMember).toHaveBeenCalledTimes(2);
  });

  it("daftar orang gagal dibaca: Tambahkan mati sampai terbaca", async () => {
    const user = userEvent.setup();
    org.people.mockRejectedValueOnce({ code: "database", message: "Database terkunci." });
    render(<Harness />);
    const dlg = await openPanel();
    await user.click(within(dlg).getByRole("button", { name: "Tambah anggota" }));
    const add = screen.getByRole("dialog", { name: "Tambah anggota proyek" });
    expect(await within(add).findByText("Daftar orang belum terbaca")).toBeInTheDocument();
    expect(within(add).getByRole("button", { name: "Tambahkan" })).toBeDisabled();
    await user.click(within(add).getByRole("button", { name: "Coba lagi" }));
    expect(await within(add).findByRole("checkbox", { name: "Sari Uji" })).toBeInTheDocument();
    expect(within(add).getByRole("button", { name: "Tambahkan" })).toBeEnabled();
  });
});
