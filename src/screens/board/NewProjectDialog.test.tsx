import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSummary } from "../../api/board";
import type { DepartmentView, OrgOverview, PersonView } from "../../api/org";
import { CODE_RULE, NewProjectDialog } from "./NewProjectDialog";

const board = vi.hoisted(() => ({ createProject: vi.fn() }));
vi.mock("../../api/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/board")>()),
  boardApi: board,
}));

const org = vi.hoisted(() => ({
  overview: vi.fn(),
  people: vi.fn(),
  departments: vi.fn(),
  listeners: new Set<() => void>(),
}));
vi.mock("../../api/org", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/org")>()),
  orgApi: {
    overview: org.overview,
    people: org.people,
    departments: org.departments,
  },
  subscribeOrg: (handler: () => void) => {
    org.listeners.add(handler);
    return () => org.listeners.delete(handler);
  },
}));

const ME = "a".repeat(64);
const DESAIN = "1".repeat(32);
const DRAFTING = "2".repeat(32);
const SIPIL = "3".repeat(32);

function overview(extra: Partial<OrgOverview> = {}): OrgOverview {
  return {
    publicKey: ME,
    isSuperadmin: false,
    isGuest: false,
    departmentId: DESAIN,
    decideJoinTeamIds: [],
    pendingJoinCount: 0,
    manageOrg: false,
    ...extra,
  };
}

function person(key: string, displayName: string, extra: Partial<PersonView> = {}): PersonView {
  return {
    publicKey: key.repeat(64),
    displayName,
    fingerprint: "AAAA AAAA AAAA AAAA",
    role: "member",
    isSuperadmin: false,
    isGuest: false,
    departmentId: null,
    departmentName: null,
    departmentRole: "member",
    labels: [],
    ...extra,
  };
}

function dep(id: string, name: string, admins: string[] = []): DepartmentView {
  return {
    id,
    name,
    createdAt: "2026-11-22T03:00:00Z",
    archived: false,
    archivedAt: null,
    memberCount: 2,
    admins: admins.map((n, i) => ({
      publicKey: String(i).repeat(64),
      displayName: n,
    })),
    channelId: null,
    channelName: null,
  };
}

const desain = { departmentId: DESAIN, departmentName: "Desain" };
const RINA = person("a", "Rina", { ...desain, departmentRole: "admin" });
const DIMAS = person("b", "Dimas", desain);
const BUDI = person("c", "Budi", {
  departmentId: DRAFTING,
  departmentName: "Drafting",
});
const HENDRA = person("e", "Hendra", {
  departmentId: SIPIL,
  departmentName: "Sipil dan Struktur",
});
const YUSUF = person("9", "Yusuf", {
  isGuest: true,
  role: "guest",
  departmentRole: null,
});
const DEPARTMENTS = [dep(DESAIN, "Desain", ["Rina"]), dep(DRAFTING, "Drafting"), dep(SIPIL, "Sipil dan Struktur")];

function created(name: string, code: string): ProjectSummary {
  return {
    id: "7".repeat(32),
    code,
    name,
    teamId: DESAIN,
    teamName: "Desain",
    openCount: 0,
    taskCount: 0,
    canManage: true,
  };
}

beforeEach(() => {
  org.listeners.clear();
  org.overview.mockReset().mockResolvedValue(overview());
  org.people.mockReset().mockResolvedValue([RINA, DIMAS, BUDI, HENDRA, YUSUF]);
  org.departments.mockReset().mockResolvedValue(DEPARTMENTS);
  board.createProject.mockReset();
});

function renderDialog(onCreated = vi.fn(), onOpenChange = vi.fn()) {
  render(<NewProjectDialog open onOpenChange={onOpenChange} onCreated={onCreated} />);
  return screen.getByRole("dialog", { name: "Proyek baru" });
}

async function ready(dlg: HTMLElement) {
  return within(dlg).findByRole("combobox", { name: "Departemen" });
}

describe("NewProjectDialog: nama dan kode", () => {
  it("mengusulkan kode dari nama, menolak kode yang salah, lalu membuat proyek", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const project = created("Laporan Keuangan Utama", "LKU");
    board.createProject.mockResolvedValue(project);
    const dlg = renderDialog(onCreated);
    await ready(dlg);
    await user.type(within(dlg).getByLabelText("Nama proyek"), "Laporan Keuangan");
    const code = within(dlg).getByLabelText("Kode proyek");
    expect(code).toHaveValue("LK");

    await user.clear(code);
    await user.type(code, "1a");
    expect(code).toHaveValue("1A");
    await user.click(within(dlg).getByRole("button", { name: "Buat proyek" }));
    expect(within(dlg).getByText(CODE_RULE)).toBeInTheDocument();
    expect(code).toHaveAttribute("aria-invalid", "true");
    expect(code).toHaveFocus();
    expect(board.createProject).not.toHaveBeenCalled();

    // Kode yang sudah diketik sendiri tidak ditimpa usulan.
    await user.type(within(dlg).getByLabelText("Nama proyek"), " Utama");
    expect(code).toHaveValue("1A");

    await user.clear(code);
    await user.type(code, "lku");
    await user.click(within(dlg).getByRole("button", { name: "Buat proyek" }));
    expect(board.createProject).toHaveBeenCalledWith("Laporan Keuangan Utama", "LKU", DESAIN, []);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project));
  });

  it("nama kosong: pesan di kolom nama", async () => {
    const user = userEvent.setup();
    const dlg = renderDialog();
    await ready(dlg);
    await user.click(within(dlg).getByRole("button", { name: "Buat proyek" }));
    expect(within(dlg).getByText("Tulis nama proyek dulu.")).toBeInTheDocument();
    expect(within(dlg).getByLabelText("Nama proyek")).toHaveFocus();
  });

  it("tanpa izin dari inti Rust: pesan jelas", async () => {
    const user = userEvent.setup();
    board.createProject.mockRejectedValue({
      code: "forbidden",
      message: "Anda tidak bisa membuat proyek di departemen ini.",
    });
    const dlg = renderDialog();
    await ready(dlg);
    await user.type(within(dlg).getByLabelText("Nama proyek"), "Riset Pasar");
    await user.click(within(dlg).getByRole("button", { name: "Buat proyek" }));
    expect(await within(dlg).findByText("Anda tidak punya izin membuat proyek")).toBeInTheDocument();
    expect(within(dlg).getByText(/Minta admin departemen Anda membuatkannya/)).toBeInTheDocument();
  });

  it("kode sudah dipakai: error di kolom kode", async () => {
    const user = userEvent.setup();
    board.createProject.mockRejectedValue({
      code: "invalid_input",
      message: "Kode PA sudah dipakai proyek lain.",
    });
    const dlg = renderDialog();
    await ready(dlg);
    await user.type(within(dlg).getByLabelText("Nama proyek"), "Proyek Anyar");
    await user.click(within(dlg).getByRole("button", { name: "Buat proyek" }));
    expect(await within(dlg).findByText("Kode PA sudah dipakai proyek lain.")).toBeInTheDocument();
    expect(within(dlg).getByLabelText("Kode proyek")).toHaveAttribute("aria-invalid", "true");
  });
});

describe("NewProjectDialog: departemen dan anggota", () => {
  it("admin departemen: departemennya atau tanpa departemen, bawaan departemennya", async () => {
    const user = userEvent.setup();
    board.createProject.mockResolvedValue(created("Arsip", "AR"));
    const dlg = renderDialog();
    const select = await ready(dlg);
    expect(select).toHaveValue(DESAIN);
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Desain", "Tanpa departemen"]);
    expect(within(dlg).getByText(/Admin departemen Desain ikut mengelola proyek ini bersama Anda/)).toBeInTheDocument();

    await user.selectOptions(select, "Tanpa departemen");
    expect(within(dlg).getByText(/Proyek tanpa departemen dikelola oleh Anda/)).toBeInTheDocument();
    await user.type(within(dlg).getByLabelText("Nama proyek"), "Arsip");
    await user.click(within(dlg).getByRole("button", { name: "Buat proyek" }));
    expect(board.createProject).toHaveBeenCalledWith("Arsip", "ARS", null, []);
  });

  it("superadmin: semua departemen terbuka", async () => {
    org.overview.mockResolvedValue(overview({ isSuperadmin: true }));
    org.people.mockResolvedValue([
      {
        ...RINA,
        isSuperadmin: true,
        role: "superadmin",
        departmentRole: "member",
      },
      DIMAS,
    ]);
    const dlg = renderDialog();
    const select = await ready(dlg);
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Desain", "Drafting", "Sipil dan Struktur", "Tanpa departemen"]);
  });

  it("pemilih orang: tanpa Tamu dan tanpa saya, baris tetap untuk saya, anggota terpilih dikirim", async () => {
    const user = userEvent.setup();
    board.createProject.mockResolvedValue(created("Rumah Tinggal", "RT"));
    const dlg = renderDialog();
    await ready(dlg);
    expect(within(dlg).getByRole("searchbox", { name: "Cari nama atau departemen" })).toBeInTheDocument();
    expect(within(dlg).getByText("Anda, pengelola")).toBeInTheDocument();
    expect(within(dlg).queryByRole("checkbox", { name: "Rina" })).not.toBeInTheDocument();
    expect(within(dlg).queryByRole("checkbox", { name: "Yusuf" })).not.toBeInTheDocument();
    expect(within(dlg).queryByRole("button", { name: "Tamu" })).not.toBeInTheDocument();
    expect(
      within(dlg).getByText(/Belum ada yang dipilih: proyek ini hanya berisi Anda sebagai pengelola\./),
    ).toBeInTheDocument();

    await user.click(within(dlg).getByRole("checkbox", { name: "Dimas" }));
    await user.click(within(dlg).getByRole("button", { name: "Sipil dan Struktur" }));
    expect(within(dlg).getByRole("button", { name: "Sipil dan Struktur" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(dlg).getByRole("checkbox", { name: "Hendra" }));
    expect(
      within(dlg).getByText(
        "2 orang dari 2 departemen, ditambah Anda sebagai pengelola. Tamu diundang setelah proyek dibuat, dari panel Anggota proyek.",
      ),
    ).toBeInTheDocument();

    await user.type(within(dlg).getByLabelText("Nama proyek"), "Rumah Tinggal");
    await user.click(within(dlg).getByRole("button", { name: "Buat proyek" }));
    expect(board.createProject).toHaveBeenCalledWith("Rumah Tinggal", "RT", DESAIN, [
      DIMAS.publicKey,
      HENDRA.publicKey,
    ]);
  });

  it("tidak ada orang lain: proyek tetap bisa dibuat", async () => {
    org.people.mockResolvedValue([RINA, YUSUF]);
    const dlg = renderDialog();
    await ready(dlg);
    expect(within(dlg).getByText(/Belum ada orang lain yang bisa dipilih/)).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Buat proyek" })).toBeEnabled();
  });

  it("anggota biasa: tidak ada form, penjelasan menyebut admin departemennya", async () => {
    org.people.mockResolvedValue([{ ...RINA, departmentRole: "member" }, DIMAS]);
    const dlg = renderDialog();
    expect(
      await within(dlg).findByText(/Hanya superadmin atau admin departemen yang bisa membuat proyek/),
    ).toBeInTheDocument();
    expect(within(dlg).getByText(/Minta admin departemen Anda \(Rina\) membuatkannya/)).toBeInTheDocument();
    expect(within(dlg).queryByRole("button", { name: "Buat proyek" })).not.toBeInTheDocument();
    expect(within(dlg).queryByLabelText("Nama proyek")).not.toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Tutup" })).toBeInTheDocument();
  });

  it("data gagal dibaca: Buat proyek mati sampai terbaca, lalu Coba baca lagi", async () => {
    const user = userEvent.setup();
    org.overview.mockRejectedValue({
      code: "database",
      message: "Database terkunci.",
    });
    board.createProject.mockResolvedValue(created("Riset", "RIS"));
    const dlg = renderDialog();
    expect(
      await within(dlg).findByText(/Daftar departemen dan orang belum terbaca \(Database terkunci\.\)/),
    ).toBeInTheDocument();
    await user.type(within(dlg).getByLabelText("Nama proyek"), "Riset");
    expect(within(dlg).getByRole("button", { name: "Buat proyek" })).toBeDisabled();

    org.overview.mockResolvedValue(overview());
    await user.click(within(dlg).getByRole("button", { name: "Coba baca lagi" }));
    expect(await ready(dlg)).toHaveValue(DESAIN);
    await user.click(within(dlg).getByRole("button", { name: "Buat proyek" }));
    expect(board.createProject).toHaveBeenCalledWith("Riset", "RIS", DESAIN, []);
  });

  it("memuat: status terbaca dan Buat proyek mati", async () => {
    org.overview.mockReturnValue(new Promise(() => {}));
    const dlg = renderDialog();
    expect(within(dlg).getByRole("status")).toHaveTextContent("Memuat daftar departemen dan orang...");
    expect(within(dlg).getByRole("button", { name: "Buat proyek" })).toBeDisabled();
  });

  it("tidak ada teks tim lagi", async () => {
    const dlg = renderDialog();
    await ready(dlg);
    expect(dlg.textContent).not.toMatch(/\btim\b/i);
  });
});
