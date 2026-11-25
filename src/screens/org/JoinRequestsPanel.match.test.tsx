import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, OrgInfo } from "../../api";
import type { AdSettingsView, JoinRequestView, OuMapping, PreviouslyRemoved } from "../../api/org";
import { setLang } from "../../i18n/core";
import { appState, directory, router } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import {
  adCheck,
  adminOverview,
  adSettings,
  department,
  joinAd,
  joinRequest,
  overview,
  TEAM_1,
  TEAM_2,
  TEAM_3,
} from "../../test/orgFixtures";
import { dnOus } from "../onboarding/adProfile";
import type { OrgPage } from "./context";
import { planMatch } from "./JoinAdMatchOu";
import { JoinRequestsPanel } from "./JoinRequestsPanel";
import { OrgScreen } from "./OrgScreen";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("./UsersPanel", () => ({ UsersPanel: () => null }));
vi.mock("./PeoplePanel", () => ({ PeoplePanel: () => null }));
vi.mock("./DepartmentsPanel", () => ({ DepartmentsPanel: () => <h2>Panel Departemen</h2> }));
vi.mock("./LabelsPanel", () => ({ LabelsPanel: () => null }));

// DN Julius dari kantor uji: OU dengan spasi dan "&" harus utuh.
const JULIUS_DN =
  "CN=Julius,OU=IT- BussinesAnalyst_AppSupport & MIS_QA,OU=IT-Department,OU=IT & CP Department,OU=HO,OU=Member Users,DC=macf,DC=co,DC=id";
const JULIUS_OUS = dnOus(JULIUS_DN);
const INNER = "IT- BussinesAnalyst_AppSupport & MIS_QA";
const EXISTING: OuMapping[] = [{ ou: "Keuangan", team: TEAM_2 }];
const DEPTS = [department(TEAM_1, "Desain"), department(TEAM_2, "Drafting"), department(TEAM_3, "IT")];

function julius(extra: Partial<JoinRequestView> = {}): JoinRequestView {
  return joinRequest("r1", "Julius", {
    teamId: TEAM_1,
    teamName: "Desain",
    ad: joinAd({
      domain: "macf.co.id",
      user: "julius",
      dn: JULIUS_DN,
      name: "Julius",
      department: null,
      ous: JULIUS_OUS,
      suggestedTeamId: null,
      departmentInMira: false,
    }),
    ...extra,
  });
}

const NOT_IN_MIRA = adCheck({
  status: "exists",
  directoryName: "Julius",
  directoryDepartment: null,
  directoryOus: JULIUS_OUS,
  departmentInMira: false,
});

type World = { settings: AdSettingsView; mapped: boolean };

function setup(opts: { settings?: Partial<AdSettingsView>; superadmin?: boolean; request?: JoinRequestView } = {}) {
  const world: World = {
    settings: adSettings({ domain: "macf.co.id", ouMap: EXISTING, ...opts.settings }),
    mapped: false,
  };
  invoke.mockImplementation(
    router({
      org_join_requests: () => [
        world.mapped
          ? julius({ ad: { ...julius().ad!, suggestedTeamId: TEAM_3, departmentInMira: true } })
          : (opts.request ?? julius()),
      ],
      org_join_ad_check: () => (world.mapped ? { ...NOT_IN_MIRA, departmentInMira: true } : NOT_IN_MIRA),
      org_ad_settings: () => world.settings,
      org_departments: DEPTS,
      org_set_ad_settings: (args) => {
        const a = args as { domain: string; ouMap: OuMapping[] };
        world.settings = { ...world.settings, domain: a.domain, ouMap: a.ouMap };
        world.mapped = true;
        return null;
      },
    }),
  );
  const refresh = vi.fn();
  const p: OrgPage = {
    overview: opts.superadmin === false ? adminOverview() : overview(),
    act: vi.fn(async () => true),
    pending: null,
    notify: vi.fn(),
    version: 0,
    refresh,
    isMe: () => false,
  };
  const view = render(<JoinRequestsPanel page={p} />);
  return { world, refresh, view, page: p };
}

function calls(cmd: string) {
  return invoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
}

async function card(name: string): Promise<HTMLElement> {
  return (await screen.findByRole("heading", { name, level: 3 })).closest("li") as HTMLElement;
}

async function openMatch(user: ReturnType<typeof userEvent.setup>, scope: HTMLElement) {
  const toggle = await within(scope).findByRole("button", { name: "Cocokkan OU ini ke departemen (akun Julius)" });
  expect(toggle).toHaveTextContent("Cocokkan OU ini ke departemen...");
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  await user.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  return toggle;
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  setLang("id");
});

describe("Cocokkan OU ke departemen dari kartu permintaan", () => {
  it("DN Julius terurai utuh, termasuk spasi dan &", () => {
    expect(JULIUS_OUS).toEqual([INNER, "IT-Department", "IT & CP Department", "HO", "Member Users"]);
  });

  it("menambah baris OU paling dalam ke pemetaan yang ada, lalu kartu dimuat ulang", async () => {
    const user = userEvent.setup();
    const { refresh } = setup();
    const julius = await card("Julius");
    await waitFor(() =>
      expect(within(julius).getByTestId("join-ad-status")).toHaveAttribute("data-status", "exists"),
    );
    await openMatch(user, julius);

    const group = await within(julius).findByRole("group", { name: "OU yang dicocokkan" });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    // Dari luar ke dalam, seperti lokasi di kartu.
    expect(radios.map((r) => r.value)).toEqual([...JULIUS_OUS].reverse());
    expect(within(group).getByRole("radio", { name: /\(paling dalam\)/ })).toBeChecked();
    // Fokus pindah ke OU terpilih setelah form termuat.
    expect(within(group).getByRole("radio", { checked: true })).toHaveFocus();

    // Departemen terbuka, bawaan departemen yang dipilih peminta.
    const select = within(julius).getByRole("combobox", { name: "Departemen di Mira" }) as HTMLSelectElement;
    expect(select.value).toBe(TEAM_1);
    await user.selectOptions(select, "IT");
    await user.click(within(julius).getByRole("button", { name: "Cocokkan" }));

    await waitFor(() => expect(calls("org_set_ad_settings")).toHaveLength(1));
    expect(calls("org_set_ad_settings")[0]).toEqual({
      domain: "macf.co.id",
      ouMap: [...EXISTING, { ou: INNER, team: TEAM_3 }],
    });
    // Pengaturan AD dibaca ulang tepat sebelum menulis.
    expect(calls("org_ad_settings")).toHaveLength(2);
    expect(refresh).toHaveBeenCalled();
    // Cek AD dipaksa ulang supaya kartu menampilkan departemen yang cocok.
    await waitFor(() => expect(calls("org_join_ad_check")).toContainEqual({ requestId: "r1", refresh: true }));

    const done = await within(julius).findByTestId("join-ad-matched");
    expect(done).toHaveTextContent(
      `OU ${INNER} sekarang dicocokkan ke departemen IT. Laptop baru dari OU ini akan mendapat usulan departemen IT. Permintaan ini tetap ke departemen Desain yang dipilih peminta.`,
    );
    expect(done).toHaveFocus();
    await waitFor(() =>
      expect(within(julius).queryByRole("button", { name: /Cocokkan OU ini ke departemen \(akun Julius\)/ })).not.toBeInTheDocument(),
    );
  });

  it("OU lain bisa dipilih; departemen yang sama dengan permintaan tidak menambah kalimat lain", async () => {
    const user = userEvent.setup();
    setup();
    const julius = await card("Julius");
    await openMatch(user, julius);
    await user.click(await within(julius).findByRole("radio", { name: "IT & CP Department" }));
    await user.click(within(julius).getByRole("button", { name: "Cocokkan" }));
    await waitFor(() => expect(calls("org_set_ad_settings")).toHaveLength(1));
    expect(calls("org_set_ad_settings")[0]).toEqual({
      domain: "macf.co.id",
      ouMap: [...EXISTING, { ou: "IT & CP Department", team: TEAM_1 }],
    });
    const done = await within(julius).findByTestId("join-ad-matched");
    expect(done).not.toHaveTextContent("tetap ke departemen");
  });

  it("baris yang sama persis sudah ada (beda huruf besar): tidak menulis apa pun", async () => {
    const user = userEvent.setup();
    const { refresh } = setup({ settings: { ouMap: [...EXISTING, { ou: INNER.toUpperCase(), team: TEAM_1 }] } });
    const julius = await card("Julius");
    await openMatch(user, julius);
    await within(julius).findByRole("group", { name: "OU yang dicocokkan" });
    await user.click(within(julius).getByRole("button", { name: "Cocokkan" }));
    expect(await within(julius).findByTestId("join-ad-matched")).toHaveTextContent(`OU ${INNER} sekarang dicocokkan`);
    expect(calls("org_set_ad_settings")).toHaveLength(0);
    expect(refresh).toHaveBeenCalled();
  });

  it("OU sudah dipetakan admin lain ke departemen terbuka lain: tidak ditimpa", async () => {
    const user = userEvent.setup();
    const { world } = setup();
    const julius = await card("Julius");
    await openMatch(user, julius);
    await within(julius).findByRole("group", { name: "OU yang dicocokkan" });
    // Diubah di laptop lain setelah form terbuka.
    world.settings = { ...world.settings, ouMap: [...EXISTING, { ou: INNER, team: TEAM_2 }] };
    await user.click(within(julius).getByRole("button", { name: "Cocokkan" }));
    expect(await within(julius).findByText("OU belum dicocokkan")).toBeInTheDocument();
    expect(within(julius).getByText(/sudah dicocokkan ke departemen Drafting, mungkin baru saja oleh admin lain/)).toBeInTheDocument();
    expect(calls("org_set_ad_settings")).toHaveLength(0);
  });

  it("pemetaan ke departemen yang sudah tidak terbuka diganti", () => {
    const plan = planMatch([{ ou: "HO", team: "9".repeat(32) }], "ho", TEAM_1, [TEAM_1]);
    expect(plan).toEqual({ kind: "write", map: [{ ou: "HO", team: TEAM_1 }] });
    const full = Array.from({ length: 100 }, (_, i) => ({ ou: `OU ${i}`, team: TEAM_1 }));
    expect(planMatch(full, "Baru", TEAM_1, [TEAM_1])).toEqual({ kind: "full" });
  });

  it("Batal dan Escape menutup form dan mengembalikan fokus ke tombol", async () => {
    const user = userEvent.setup();
    setup();
    const julius = await card("Julius");
    const toggle = await openMatch(user, julius);
    await within(julius).findByRole("group", { name: "OU yang dicocokkan" });
    await user.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
    await user.click(toggle);
    await user.click(await within(julius).findByRole("button", { name: "Batal" }));
    expect(within(julius).queryByRole("group", { name: "OU yang dicocokkan" })).not.toBeInTheDocument();
    expect(calls("org_set_ad_settings")).toHaveLength(0);
  });

  it("OU lebih dari 64 karakter tidak bisa dipilih", async () => {
    const user = userEvent.setup();
    const long = "x".repeat(65);
    const ad = joinAd({ ous: [long, "HO"], suggestedTeamId: null, departmentInMira: false });
    invoke.mockImplementation(
      router({
        org_join_requests: [joinRequest("r1", "Julius", { ad })],
        org_join_ad_check: () => ({ ...NOT_IN_MIRA, directoryOus: [long, "HO"] }),
        org_ad_settings: adSettings({ domain: "macf.co.id" }),
        org_departments: DEPTS,
      }),
    );
    render(<JoinRequestsPanel page={{ ...setupPage() }} />);
    const julius = await card("Julius");
    await openMatch(user, julius);
    const tooLong = await within(julius).findByRole("radio", { name: /terlalu panjang, paling banyak 64 karakter/ });
    expect(tooLong).toBeDisabled();
    expect(within(julius).getByRole("radio", { name: "HO" })).toBeChecked();
  });

  it("gerbang versi tertutup: laptop yang menghalangi disebutkan, tanpa tombol Cocokkan", async () => {
    const user = userEvent.setup();
    setup({ settings: { allowed: false, outdated: [{ name: "Budi", appVersion: "0.4.0" }] } });
    const julius = await card("Julius");
    await openMatch(user, julius);
    const blocked = await within(julius).findByTestId("join-ad-match-blocked");
    expect(blocked).toHaveTextContent("Pemetaan OU belum bisa diubah sampai laptop berikut memperbarui Mira:");
    expect(blocked).toHaveTextContent("Budi, versi 0.4.0");
    expect(within(julius).queryByRole("button", { name: "Cocokkan" })).not.toBeInTheDocument();
  });

  it("tanpa domain AD kantor: penjelasan dan tombol Atur domain AD", async () => {
    const user = userEvent.setup();
    setup({ settings: { domain: null } });
    const julius = await card("Julius");
    await openMatch(user, julius);
    const msg = await within(julius).findByTestId("join-ad-match-no-domain");
    expect(msg).toHaveTextContent("Kantor ini belum punya domain AD, jadi OU belum bisa dicocokkan.");
    expect(within(julius).queryByRole("button", { name: "Cocokkan" })).not.toBeInTheDocument();
  });

  it("tidak tampil untuk admin departemen, atau kalau departemen AD sudah ada di Mira", async () => {
    setup({ superadmin: false });
    const julius = await card("Julius");
    await waitFor(() =>
      expect(within(julius).getByTestId("join-ad-status")).toHaveAttribute("data-status", "exists"),
    );
    expect(within(julius).queryByTestId("join-ad-match")).not.toBeInTheDocument();
  });

  it("tidak tampil saat departemen AD sudah dikenal", async () => {
    invoke.mockImplementation(
      router({ org_join_requests: [joinRequest("r1", "Rina", { ad: joinAd() })], org_join_ad_check: adCheck() }),
    );
    render(<JoinRequestsPanel page={setupPage()} />);
    const rina = await card("Rina");
    await waitFor(() => expect(within(rina).getByTestId("join-ad-status")).toHaveAttribute("data-status", "match"));
    expect(within(rina).queryByTestId("join-ad-match")).not.toBeInTheDocument();
  });
});

function setupPage(): OrgPage {
  return {
    overview: overview(),
    act: vi.fn(async () => true),
    pending: null,
    notify: vi.fn(),
    version: 0,
    refresh: vi.fn(),
    isMe: () => false,
  };
}

describe("Atur domain AD dari kartu permintaan (OrgScreen)", () => {
  const state = appState() as AppState & { organization: OrgInfo };

  function answer(settings: AdSettingsView) {
    invoke.mockImplementation(
      router({
        org_overview: overview({ pendingJoinCount: 1 }),
        get_directory: directory(),
        org_fingerprint: "ABCD-EFGH",
        org_join_requests: [julius()],
        org_join_ad_check: NOT_IN_MIRA,
        org_ad_settings: settings,
        org_departments: DEPTS,
        org_other_offices: null,
      }),
    );
  }

  async function openRequests(user: ReturnType<typeof userEvent.setup>) {
    render(<OrgScreen state={state} onRefresh={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: /Permintaan bergabung/ }));
    const scope = await card("Julius");
    await openMatch(user, scope);
    await user.click(await within(scope).findByRole("button", { name: "Atur domain AD" }));
  }

  it("menampilkan lagi tawaran domain yang tadi disembunyikan, dengan fokus di judulnya", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(`mira.adDomainOffer.hidden.${state.organization.id}`, "1");
    answer(adSettings({ domain: null, machineDomain: "macf.co.id" }));
    await openRequests(user);
    const offer = await screen.findByTestId("org-domain-offer");
    expect(within(offer).getByRole("heading", { name: "Pakai macf.co.id sebagai domain AD kantor ini?" })).toHaveFocus();
  });

  it("tanpa tawaran (laptop ini bukan laptop domain): membuka tab Departemen", async () => {
    const user = userEvent.setup();
    answer(adSettings({ domain: null, machineDomain: null }));
    await openRequests(user);
    expect(await screen.findByRole("heading", { name: "Panel Departemen" })).toBeInTheDocument();
  });
});

describe("Petunjuk akun atau laptop yang pernah dipakai", () => {
  function show(prev: PreviouslyRemoved | null) {
    invoke.mockImplementation(router({ org_join_requests: [joinRequest("r1", "Bayu", { previouslyRemoved: prev })] }));
    render(<JoinRequestsPanel page={setupPage()} />);
  }

  it.each<[PreviouslyRemoved["match"], PreviouslyRemoved["status"], RegExp]>([
    ["ad_account", "removed", /^Akun Windows ini pernah dipakai Sinta, yang dikeluarkan pada 3 November 2026\.$/],
    ["laptop", "removed", /^Laptop dengan nama ini pernah dipakai Sinta, yang dikeluarkan pada 3 November 2026\.$/],
    [
      "ad_account",
      "suspended",
      /^Akun Windows ini pernah dipakai Sinta, yang sedang dinonaktifkan sejak 3 November 2026\. Pertimbangkan mengaktifkan lagi orang itu daripada menyetujui laptop baru\.$/,
    ],
    [
      "laptop",
      "suspended",
      /^Laptop dengan nama ini pernah dipakai Sinta, yang sedang dinonaktifkan sejak 3 November 2026\. Pertimbangkan mengaktifkan lagi/,
    ],
  ])("%s, %s", async (match, status, text) => {
    show({ name: "Sinta", status, at: "2026-11-03T05:00:00Z", match });
    const bayu = await card("Bayu");
    const hint = within(bayu).getByTestId("join-previously-removed");
    expect(hint).toHaveAttribute("data-match", match);
    expect(hint).toHaveAttribute("data-status", status);
    const [line, note] = hint.querySelectorAll("p");
    expect(line.textContent).toMatch(text);
    // Nada peringatan, bukan alert merah, dan jelas bahwa ini petunjuk.
    expect(hint).not.toHaveClass("alert");
    expect(note).toHaveTextContent("Ini petunjuk, bukan bukti: nama akun dan nama laptop dilaporkan oleh laptop peminta.");
  });

  it("tidak tampil kalau null atau bentuknya tidak dikenal", async () => {
    show({ name: "Sinta", status: "aneh", at: "2026-11-03T05:00:00Z", match: "laptop" } as unknown as PreviouslyRemoved);
    const bayu = await card("Bayu");
    expect(within(bayu).queryByTestId("join-previously-removed")).not.toBeInTheDocument();
  });
});

describe("Bahasa Inggris", () => {
  it("petunjuk dan form Cocokkan OU tanpa kata Indonesia", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(
      router({
        org_join_requests: [
          julius({
            previouslyRemoved: { name: "Sinta", status: "suspended", at: "2026-11-03T05:00:00Z", match: "ad_account" },
          }),
        ],
        org_join_ad_check: NOT_IN_MIRA,
        org_ad_settings: adSettings({ domain: "macf.co.id" }),
        org_departments: DEPTS,
      }),
    );
    renderInLang(() => <JoinRequestsPanel page={setupPage()} />, "en");
    const julius_ = await card("Julius");
    const hint = within(julius_).getByTestId("join-previously-removed");
    expect(hint).toHaveTextContent(
      "This Windows account was used by Sinta, who has been deactivated since 3 November 2026. Consider reactivating that person instead of approving a new laptop.",
    );
    expect(hint).toHaveTextContent("This is a hint, not proof");

    const toggle = await within(julius_).findByRole("button", { name: "Match this OU to a department (Julius's account)" });
    expect(toggle).toHaveTextContent("Match this OU to a department...");
    await user.click(toggle);
    const group = await within(julius_).findByRole("group", { name: "OU to match" });
    expect(within(group).getByRole("radio", { name: /\(innermost\)/ })).toBeChecked();
    expect(within(julius_).getByRole("combobox", { name: "Department in Mira" })).toBeInTheDocument();
    expect(within(julius_).getByRole("button", { name: "Match" })).toBeInTheDocument();
    expect(within(julius_).getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    const own = [hint, within(julius_).getByTestId("join-ad-match")].map((el) => el.textContent ?? "").join(" ");
    expect(own).not.toMatch(/\b(yang|dan|ini|Cocokkan|Batal|Pilih|pernah|dipakai|petunjuk|bukti|paling)\b/);
  });
});
