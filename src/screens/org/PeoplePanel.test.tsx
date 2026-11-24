import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, OrgInfo } from "../../api";
import type { OrgOverview, PersonView } from "../../api/org";
import { formatDate } from "../../api/format";
import { appState, directory, router } from "../../test/fixtures";
import { adminOverview, LABEL_1, LABEL_2, ME, memberOverview, person, PK_B, PK_C, PK_D, TEAM_2 } from "../../test/orgFixtures";
import { OrgScreen } from "./OrgScreen";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const state = appState() as AppState & { organization: OrgInfo };

function people(): PersonView[] {
  return [
    person(ME, "Penguji"),
    person(PK_B, "Rina", {
      departmentRole: "admin",
      labels: [
        { id: LABEL_1, name: "Arsitek" },
        { id: LABEL_2, name: "Senior" },
      ],
    }),
    person(PK_C, "Andi", { isSuperadmin: true, role: "superadmin", departmentId: TEAM_2, departmentName: "Keuangan" }),
    person(PK_D, "Yusuf", { isGuest: true, role: "guest", departmentId: null, departmentName: null, departmentRole: null }),
  ];
}

function renderPeople(table: Record<string, unknown> = {}, ov: OrgOverview = memberOverview()) {
  invoke.mockImplementation(
    router({
      org_overview: ov,
      get_directory: directory(),
      org_fingerprint: "ABCD-EFGH",
      org_people: people(),
      ...(table as Record<string, never>),
    }),
  );
  const ue = userEvent.setup();
  render(<OrgScreen state={state} onRefresh={vi.fn()} />);
  return ue;
}

async function openTab(ue: ReturnType<typeof userEvent.setup>) {
  await ue.click(await screen.findByRole("button", { name: "Anggota" }));
}

function itemOf(name: string): HTMLElement {
  const item = screen
    .getAllByRole("listitem")
    .find((li) => li.querySelector(".nwl-name")?.textContent?.startsWith(name));
  if (!item) throw new Error(`Baris ${name} tidak ada`);
  return item;
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

describe("Anggota (bukan superadmin)", () => {
  it("anggota biasa melihat tab Anggota, bukan Pengguna", async () => {
    const ue = renderPeople();
    await openTab(ue);
    expect(screen.queryByRole("button", { name: "Pengguna" })).not.toBeInTheDocument();
    expect(await screen.findByText("Rina")).toBeInTheDocument();
    expect(invoke.mock.calls.some((c) => c[0] === "org_users")).toBe(false);
  });

  it("admin departemen juga melihat tab Anggota, bukan Pengguna", async () => {
    const ue = renderPeople({}, adminOverview());
    await openTab(ue);
    expect(screen.queryByRole("button", { name: "Pengguna" })).not.toBeInTheDocument();
    expect(await screen.findByText("Rina")).toBeInTheDocument();
  });

  it("menampilkan nama, label, departemen, dan peran tanpa laptop atau aksi", async () => {
    const ue = renderPeople();
    await openTab(ue);
    await screen.findByText("Rina");

    const rina = itemOf("Rina");
    expect(within(rina).getByText("Arsitek")).toBeInTheDocument();
    expect(within(rina).getByText("Senior")).toBeInTheDocument();
    expect(within(rina).getByText("Desain, admin departemen")).toBeInTheDocument();
    expect(within(itemOf("Andi")).getByText("Keuangan, superadmin")).toBeInTheDocument();
    expect(within(itemOf("Yusuf")).getByText("Tamu")).toBeInTheDocument();
    expect(within(itemOf("Penguji")).getByText("(Anda)", { exact: false })).toBeInTheDocument();
    expect(within(itemOf("Penguji")).getByText("Desain, anggota")).toBeInTheDocument();

    expect(screen.queryByText(/LAPTOP-/)).not.toBeInTheDocument();
    expect(screen.queryByText(/192\.168/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Aksi untuk/ })).not.toBeInTheDocument();
    expect(screen.getByText("4 orang")).toBeInTheDocument();
  });

  it("mencari nama dan label; hasil kosong bisa dihapus", async () => {
    const ue = renderPeople();
    await openTab(ue);
    await screen.findByText("Rina");
    const search = screen.getByRole("searchbox", { name: "Cari" });

    await ue.type(search, "senior");
    expect(itemOf("Rina")).toBeInTheDocument();
    expect(screen.queryByText("Andi")).not.toBeInTheDocument();
    expect(screen.getByText("1 orang")).toBeInTheDocument();

    await ue.clear(search);
    await ue.type(search, "zzz");
    expect(screen.getByText('Tidak ada orang yang cocok dengan "zzz"')).toBeInTheDocument();
    await ue.click(screen.getByRole("button", { name: "Hapus pencarian" }));
    expect(search).toHaveValue("");
    expect(screen.getByText("4 orang")).toBeInTheDocument();
  });

  it("menampilkan keadaan memuat", async () => {
    let resolve: (v: PersonView[]) => void = () => {};
    const ue = renderPeople({ org_people: () => new Promise<PersonView[]>((r) => (resolve = r)) });
    await openTab(ue);
    expect(screen.getByText("Memuat daftar anggota...")).toBeInTheDocument();
    resolve(people());
    expect(await screen.findByText("Rina")).toBeInTheDocument();
  });

  it("error membaca daftar bisa dicoba lagi", async () => {
    let fail = true;
    const ue = renderPeople({
      org_people: () => {
        if (fail) throw { code: "database", message: "Database terkunci." };
        return people();
      },
    });
    await openTab(ue);
    expect(await screen.findByText("Daftar anggota belum terbaca")).toBeInTheDocument();
    fail = false;
    await ue.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByText("Rina")).toBeInTheDocument();
  });

  it("tanpa tanda aksi dari inti Rust tidak ada tombol Nonaktifkan", async () => {
    const ue = renderPeople({}, adminOverview());
    await openTab(ue);
    await screen.findByText("Rina");
    expect(screen.queryByRole("button", { name: /Nonaktifkan|Aktifkan lagi/ })).not.toBeInTheDocument();
  });

  it("hanya Anda: menyebut cara rekan bergabung", async () => {
    const ue = renderPeople({ org_people: [person(ME, "Penguji")] });
    await openTab(ue);
    expect(await screen.findByText(/Belum ada orang lain di organisasi ini/)).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });
});

// 0.5.1: org_people bisa membawa status dan tanda aksi per laptop yang melihat.
// PersonView belum punya field itu, jadi data uji menambahkannya sendiri.
type PersonRow = PersonView & {
  status?: "active" | "suspended";
  suspendedAt?: string | null;
  suspendedByName?: string | null;
  canSuspend?: boolean;
  canReinstate?: boolean;
};

const SUSPENDED_AT = "2026-11-23T03:00:00Z";

function deptPeople(): PersonRow[] {
  return [
    person(ME, "Penguji", { departmentRole: "admin" }),
    { ...person(PK_B, "Bayu"), status: "active", canSuspend: true, canReinstate: false },
    { ...person(PK_C, "Citra", { departmentRole: "admin" }), status: "active", canSuspend: false, canReinstate: false },
    {
      ...person(PK_D, "Dewi", { departmentId: null, departmentName: null, departmentRole: null }),
      status: "suspended",
      suspendedAt: SUSPENDED_AT,
      suspendedByName: "Penguji",
      canSuspend: false,
      canReinstate: true,
    },
  ];
}

describe("Anggota: admin departemen menonaktifkan dan mengaktifkan lagi", () => {
  it("tombol mengikuti tanda; orang nonaktif ditandai dengan tanggal dan nama", async () => {
    const ue = renderPeople({ org_people: deptPeople() }, adminOverview());
    await openTab(ue);
    await screen.findByText("Bayu");

    expect(within(itemOf("Bayu")).getByRole("button", { name: "Nonaktifkan, Bayu" })).toHaveTextContent("Nonaktifkan");
    expect(within(itemOf("Citra")).queryByRole("button")).not.toBeInTheDocument();
    expect(within(itemOf("Penguji")).queryByRole("button")).not.toBeInTheDocument();

    const dewi = itemOf("Dewi");
    expect(within(dewi).getByText("Nonaktif")).toBeInTheDocument();
    expect(within(dewi).getByText(`Dinonaktifkan ${formatDate(SUSPENDED_AT)} oleh Penguji`)).toBeInTheDocument();
    expect(within(dewi).getByRole("button", { name: "Aktifkan lagi, Dewi" })).toHaveTextContent("Aktifkan lagi");
    expect(within(dewi).queryByRole("button", { name: /Nonaktifkan/ })).not.toBeInTheDocument();
  });

  it("Nonaktifkan: hanya satu pilihan, tanpa Keluarkan permanen, lalu daftar dimuat ulang", async () => {
    let done = false;
    const ue = renderPeople(
      {
        org_people: () =>
          done
            ? deptPeople().map((p) =>
                p.publicKey === PK_B ? { ...p, status: "suspended", suspendedAt: SUSPENDED_AT, suspendedByName: "Penguji", canSuspend: false, canReinstate: true } : p,
              )
            : deptPeople(),
        org_suspend_gate: { allowed: true, outdated: [] },
        org_suspend_member: () => {
          done = true;
          return null;
        },
      },
      adminOverview(),
    );
    await openTab(ue);
    await ue.click(await screen.findByRole("button", { name: "Nonaktifkan, Bayu" }));
    const dialog = await screen.findByRole("dialog", { name: "Nonaktifkan Bayu?" });
    expect(within(dialog).queryByRole("radio")).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("Keluarkan permanen");
    expect(dialog).toHaveTextContent("Bisa diaktifkan lagi nanti.");
    const submit = await within(dialog).findByRole("button", { name: "Nonaktifkan Bayu" });
    await waitFor(() => expect(submit).toBeEnabled());
    await ue.click(submit);
    expect(invoke).toHaveBeenCalledWith("org_suspend_member", { publicKey: PK_B });
    expect(invoke).not.toHaveBeenCalledWith("org_remove_member", expect.anything());
    expect(await screen.findByText(/Bayu sekarang nonaktif/)).toBeInTheDocument();
    expect(await within(itemOf("Bayu")).findByRole("button", { name: "Aktifkan lagi, Bayu" })).toBeInTheDocument();
  });

  it("gerbang tertutup: tombol Nonaktifkan di dialog mati dan laptop yang menghalangi disebut", async () => {
    const ue = renderPeople(
      { org_people: deptPeople(), org_suspend_gate: { allowed: false, outdated: [{ name: "Citra", appVersion: "0.5.0" }] } },
      adminOverview(),
    );
    await openTab(ue);
    await ue.click(await screen.findByRole("button", { name: "Nonaktifkan, Bayu" }));
    const dialog = await screen.findByRole("dialog", { name: "Nonaktifkan Bayu?" });
    expect(
      await within(dialog).findByText("Belum bisa dipilih. Laptop berikut perlu diperbarui ke Mira 0.5.1 dulu: Citra (Mira 0.5.0)."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Nonaktifkan Bayu" })).toBeDisabled();
    expect(invoke).not.toHaveBeenCalledWith("org_suspend_member", expect.anything());
  });

  it("Aktifkan lagi memanggil org_reinstate_member", async () => {
    const ue = renderPeople({ org_people: deptPeople(), org_reinstate_member: null }, adminOverview());
    await openTab(ue);
    await ue.click(await screen.findByRole("button", { name: "Aktifkan lagi, Dewi" }));
    const dialog = await screen.findByRole("dialog", { name: "Aktifkan Dewi lagi?" });
    await ue.click(within(dialog).getByRole("button", { name: "Aktifkan Dewi" }));
    expect(invoke).toHaveBeenCalledWith("org_reinstate_member", { publicKey: PK_D });
    expect(await screen.findByText("Dewi aktif lagi.")).toBeInTheDocument();
  });
});
