import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, OrgInfo } from "../../api";
import type { OrgOverview, PersonView } from "../../api/org";
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
    expect(within(rina).getByText("Desain · admin departemen")).toBeInTheDocument();
    expect(within(itemOf("Andi")).getByText("Keuangan · superadmin")).toBeInTheDocument();
    expect(within(itemOf("Yusuf")).getByText("Tamu")).toBeInTheDocument();
    expect(within(itemOf("Penguji")).getByText("(Anda)", { exact: false })).toBeInTheDocument();
    expect(within(itemOf("Penguji")).getByText("Desain · anggota")).toBeInTheDocument();

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

  it("hanya Anda: menyebut cara rekan bergabung", async () => {
    const ue = renderPeople({ org_people: [person(ME, "Penguji")] });
    await openTab(ue);
    expect(await screen.findByText(/Belum ada orang lain di organisasi ini/)).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });
});

describe("Anggota: divisi", () => {
  it("menulis divisi setelah departemen dan bisa dicari dengan nama divisi", async () => {
    const list = people();
    list[1] = { ...list[1], divisions: [{ id: "d1", name: "Mobile" }, { id: "d2", name: "Web" }] };
    const ue = renderPeople({ org_people: list });
    await openTab(ue);
    await screen.findByText("Rina");
    expect(within(itemOf("Rina")).getByText("Desain · Mobile, Web · admin departemen")).toBeInTheDocument();
    expect(within(itemOf("Penguji")).getByText("Desain · anggota")).toBeInTheDocument();

    await ue.type(screen.getByRole("searchbox", { name: "Cari" }), "mobile");
    expect(itemOf("Rina")).toBeInTheDocument();
    expect(screen.getByText("1 orang")).toBeInTheDocument();
  });
});
