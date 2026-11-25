import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, OrgInfo } from "../../api";
import type { DeptOverview } from "../../api/division";
import { setLang } from "../../i18n/core";
import { appState, directory, router, rustError } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import { adminOverview } from "../../test/orgFixtures";
import { deptOverview, ME, PK_D, TEAM_1 } from "./myDepartmentFixtures";
import { OrgScreen } from "./OrgScreen";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
// UsersPanel memakai helper lain dari PeoplePanel: hanya panelnya yang diganti.
vi.mock("./PeoplePanel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./PeoplePanel")>()),
  PeoplePanel: () => null,
}));

const state = appState() as AppState & { organization: OrgInfo };

const dir = directory({
  me: { publicKey: ME, isSuperadmin: false },
  can: { createTeam: false, manageSuperadmins: false, removeMembers: false, manageTeamIds: [TEAM_1] },
});

// Kata Indonesia yang tidak mungkin muncul di teks Inggris (sama dengan src/i18n/noIndonesian.test.tsx).
const WORDS = [
  "yang", "dan", "untuk", "dengan", "belum", "sudah", "tidak", "Anda", "ini", "itu", "dari", "pada",
  "akan", "bisa", "harus", "oleh", "atau", "kalau", "lagi", "baru", "semua", "Simpan", "Batal", "Hapus",
  "Tutup", "Buka", "Kirim", "Tambah", "Pilih", "Cari", "Pesan", "Pengaturan", "Organisasi", "di", "ke",
  "tanpa", "saat", "sedang", "masih", "Proyek", "Anggota", "Tamu", "Ubah", "Keluar", "Lihat", "Divisi",
  "Kepala", "Departemen", "Arsipkan", "Pulihkan", "Jadikan", "Lepas", "Catatan", "Riwayat", "Ditolak",
];
const PATTERN = new RegExp(`(?<![\\p{L}\\p{N}])(?:${WORDS.join("|")})(?![\\p{L}\\p{N}])`, "gu");
const ATTRS = ["aria-label", "title", "placeholder", "alt"];

function indonesian(): string[] {
  const texts: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent?.trim();
    if (t) texts.push(t);
  }
  for (const el of document.body.querySelectorAll("*")) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v) texts.push(v);
    }
  }
  return texts.filter((t) => {
    PATTERN.lastIndex = 0;
    return PATTERN.test(t);
  });
}

function setup(dept: DeptOverview, extra: Record<string, unknown> = {}) {
  invoke.mockImplementation(
    router({
      org_overview: adminOverview(),
      get_directory: dir,
      org_fingerprint: "ABCD-EFGH",
      org_join_requests: [],
      org_departments: [],
      dept_overview: dept,
      ...(extra as Record<string, never>),
    }),
  );
  renderInLang(() => <OrgScreen state={state} onRefresh={vi.fn()} onOpenChat={vi.fn()} onOpenProject={vi.fn()} />, "en");
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

afterEach(() => setLang("id"));

describe("Departemen saya dalam bahasa Inggris", () => {
  it("semua bagian, tombol, dan pemberitahuan gerbang tanpa teks Indonesia", async () => {
    const user = userEvent.setup();
    setup(
      deptOverview({
        gate: { open: false, since: "0.6.0", blockers: [{ publicKey: PK_D, name: "Dewi", appVersion: null }] },
        channel: {
          conv: "c1",
          name: "desain",
          settings: { pinned: "Standup at 9", announce: true, setAt: "2026-11-24T03:00:00Z", setByName: "Citra" },
        },
      }),
    );
    await user.click(await screen.findByRole("button", { name: "My department" }));
    expect(await screen.findByRole("heading", { name: "Department members", level: 2 })).toBeInTheDocument();
    for (const name of ["Divisions", "Join requests", "Invite codes", "Department projects", "Department channel"]) {
      expect(screen.getByRole("heading", { name, level: 2 })).toBeInTheDocument();
    }
    expect(screen.getByText("Division changes are waiting for every laptop to run Mira 0.6.0")).toBeInTheDocument();
    expect(screen.getByText("Dewi, version not reported")).toBeInTheDocument();
    expect(screen.getByText("Admin history (2)")).toBeInTheDocument();
    expect(screen.getAllByText("You can change this once every laptop in the office runs Mira 0.6.0.").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Open chat, Mobile division" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open chat, # desain" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open on the Board, Aplikasi Kasir" })).toBeInTheDocument();
    expect(screen.getByText("Only department admins and superadmins can post.")).toBeInTheDocument();
    expect(screen.getByText("Rejected")).toBeInTheDocument();
    await user.click(screen.getByText("Archived (1)"));
    await user.click(screen.getAllByText("Division chat")[0]);
    await user.click(screen.getByText("Admin history (2)"));
    // Data uji (nama divisi, proyek) memakai kata yang bukan kata Indonesia di daftar.
    expect(indonesian()).toEqual([]);
  });

  it("aksi pengelola dan dialog dalam bahasa Inggris; pesan admin terakhir diterjemahkan", async () => {
    const user = userEvent.setup();
    // Citra ikut admin, jadi Penguji bukan admin terakhir di layar; Rust tetap menolak.
    const base = deptOverview();
    setup(
      { ...base, members: base.members.map((m) => (m.displayName === "Citra" ? { ...m, isAdmin: true } : m)) },
      { dept_set_admin: rustError("forbidden", "Departemen harus punya minimal satu admin. Angkat admin lain dulu.") },
    );
    await user.click(await screen.findByRole("button", { name: "My department" }));
    await screen.findByRole("heading", { name: "Department members" });
    expect(screen.getByRole("button", { name: "Make admin, Bayu" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make head, Bayu, Mobile" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make member, Citra, Mobile" })).toHaveTextContent("Make member");
    expect(screen.getByLabelText("New division name")).toBeInTheDocument();
    expect(screen.getByText("Divisions: Mobile (head)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Archive division Web" }));
    const archive = await screen.findByRole("dialog", { name: "Archive division Web?" });
    expect(indonesian()).toEqual([]);
    await user.click(within(archive).getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Remove admin, Penguji" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove yourself as department admin?" });
    await user.click(within(dialog).getByRole("button", { name: "Remove admin" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("dept_set_admin", { teamId: TEAM_1, publicKey: ME, admin: false }),
    );
    expect(
      await screen.findByText("The department must have at least one admin. Appoint another admin first."),
    ).toBeInTheDocument();
    expect(indonesian()).toEqual([]);
  });

  it("admin terakhir: penjelasan dalam bahasa Inggris dan tombolnya nonaktif", async () => {
    const user = userEvent.setup();
    setup(deptOverview());
    await user.click(await screen.findByRole("button", { name: "My department" }));
    await screen.findByRole("heading", { name: "Department members" });
    const btn = screen.getByRole("button", { name: "Remove admin, Penguji" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription(
      "You're the last admin of this department. Make someone else an admin first, then give up this role.",
    );
    expect(indonesian()).toEqual([]);
  });
});
