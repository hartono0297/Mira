import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, OrgInfo } from "../../api";
import type { AdSettingsView } from "../../api/org";
import { setLang } from "../../i18n/core";
import { appState, directory, router, TEAM_1 } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import { adSettings, adminOverview, department, overview, TEAM_2 } from "../../test/orgFixtures";
import { offerKey } from "./DomainOffer";
import { OrgScreen } from "./OrgScreen";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("./UsersPanel", () => ({ UsersPanel: () => null }));
vi.mock("./PeoplePanel", () => ({ PeoplePanel: () => null }));
vi.mock("./DepartmentsPanel", () => ({ DepartmentsPanel: () => <p>Panel Departemen</p> }));
vi.mock("./LabelsPanel", () => ({ LabelsPanel: () => null }));

const state = appState() as AppState & { organization: OrgInfo };
const MAP = [{ ou: "Keuangan", team: TEAM_1 }];

function answer(settings: AdSettingsView | (() => AdSettingsView), extra: Record<string, unknown> = {}) {
  invoke.mockImplementation(
    router({
      org_overview: overview(),
      get_directory: directory(),
      org_fingerprint: "ABCD-EFGH",
      org_join_requests: [],
      org_departments: [department(TEAM_1, "Desain"), department(TEAM_2, "Drafting")],
      org_other_offices: null,
      org_ad_settings: typeof settings === "function" ? settings : () => settings,
      org_set_ad_settings: null,
      ...(extra as Record<string, never>),
    }),
  );
}

function calls(cmd: string) {
  return invoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
}

async function settled() {
  await screen.findByRole("navigation", { name: "Bagian organisasi" });
  await waitFor(() => expect(calls("org_ad_settings").length).toBeGreaterThan(0));
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  setLang("id");
});

describe("Tawaran domain AD di Organisasi", () => {
  it("tampil untuk superadmin di laptop domain saat kantor belum punya domain", async () => {
    answer(adSettings({ machineDomain: "macf.co.id", ouMap: MAP }));
    render(<OrgScreen state={state} onRefresh={vi.fn()} />);
    const offer = await screen.findByTestId("org-domain-offer");
    expect(
      within(offer).getByRole("heading", { name: "Pakai macf.co.id sebagai domain AD kantor ini?" }),
    ).toBeInTheDocument();
    expect(offer).toHaveTextContent(/akun domain macf\.co\.id akan mengisi nama dari akun Windows-nya, dan departemen kalau sudah dicocokkan/);
    expect(within(offer).getByRole("button", { name: "Pakai macf.co.id" })).toBeInTheDocument();
    expect(within(offer).getByRole("button", { name: "Sembunyikan" })).toBeInTheDocument();
    // Tenang: kotak netral, bukan .notice atau .alert.
    expect(offer).toHaveClass("org-other");
    expect(offer).not.toHaveClass("notice");
  });

  it.each([
    ["kantor sudah punya domain", adSettings({ domain: "macf.co.id", machineDomain: "macf.co.id" })],
    ["laptop ini bukan laptop domain", adSettings({ machineDomain: null })],
    ["domain laptop tidak sah", adSettings({ machineDomain: "bukan domain" })],
    ["bukan superadmin (canEdit false)", adSettings({ machineDomain: "macf.co.id", canEdit: false })],
  ])("tidak tampil kalau %s", async (_, settings) => {
    answer(settings);
    render(<OrgScreen state={state} onRefresh={vi.fn()} />);
    await settled();
    expect(screen.queryByTestId("org-domain-offer")).not.toBeInTheDocument();
  });

  it("tidak tampil dan tidak membaca pengaturan AD untuk admin departemen", async () => {
    answer(adSettings({ machineDomain: "macf.co.id" }), { org_overview: adminOverview() });
    render(<OrgScreen state={state} onRefresh={vi.fn()} />);
    await screen.findByRole("navigation", { name: "Bagian organisasi" });
    expect(screen.queryByTestId("org-domain-offer")).not.toBeInTheDocument();
    expect(calls("org_ad_settings")).toHaveLength(0);
  });

  it("Pakai menyimpan domain laptop ini dengan pemetaan OU yang ada, lalu tawaran hilang", async () => {
    const user = userEvent.setup();
    let saved = false;
    answer(() => adSettings({ machineDomain: "MACF.co.id", ouMap: MAP, domain: saved ? "macf.co.id" : null }), {
      org_set_ad_settings: () => {
        saved = true;
        return null;
      },
    });
    const onRefresh = vi.fn();
    render(<OrgScreen state={state} onRefresh={onRefresh} />);
    const offer = await screen.findByTestId("org-domain-offer");
    await user.click(within(offer).getByRole("button", { name: "Pakai macf.co.id" }));
    expect(calls("org_set_ad_settings")).toEqual([{ domain: "macf.co.id", ouMap: MAP }]);
    await waitFor(() => expect(screen.queryByTestId("org-domain-offer")).not.toBeInTheDocument());
    expect(await screen.findByText("Domain AD kantor ini sekarang macf.co.id.")).toBeInTheDocument();
    // Fokus tidak jatuh ke awal dokumen.
    expect(screen.getByRole("heading", { name: "Organisasi", level: 1 })).toHaveFocus();
    // Pengaturan AD dimuat ulang.
    await waitFor(() => expect(calls("org_ad_settings").length).toBeGreaterThan(1));
  });

  it("galat simpan tampil di dalam tawaran", async () => {
    const user = userEvent.setup();
    answer(adSettings({ machineDomain: "macf.co.id" }), {
      org_set_ad_settings: () => {
        throw { code: "invalid", message: "Ada laptop yang belum diperbarui." };
      },
    });
    render(<OrgScreen state={state} onRefresh={vi.fn()} />);
    const offer = await screen.findByTestId("org-domain-offer");
    await user.click(within(offer).getByRole("button", { name: "Pakai macf.co.id" }));
    expect(await within(offer).findByText("Domain AD belum disimpan")).toBeInTheDocument();
    expect(within(offer).getByText("Ada laptop yang belum diperbarui.")).toBeInTheDocument();
  });

  it("Sembunyikan: tawaran hilang dan diingat untuk organisasi ini", async () => {
    const user = userEvent.setup();
    answer(adSettings({ machineDomain: "macf.co.id" }));
    const first = render(<OrgScreen state={state} onRefresh={vi.fn()} />);
    const offer = await screen.findByTestId("org-domain-offer");
    await user.click(within(offer).getByRole("button", { name: "Sembunyikan" }));
    expect(screen.queryByTestId("org-domain-offer")).not.toBeInTheDocument();
    expect(screen.getByText(/Tawaran disembunyikan/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Organisasi", level: 1 })).toHaveFocus();
    expect(window.localStorage.getItem(offerKey(state.organization.id))).toBe("1");
    expect(calls("org_set_ad_settings")).toHaveLength(0);

    first.unmount();
    render(<OrgScreen state={state} onRefresh={vi.fn()} />);
    await settled();
    expect(screen.queryByTestId("org-domain-offer")).not.toBeInTheDocument();
  });

  it("localStorage yang menolak tidak merusak tawaran", async () => {
    const user = userEvent.setup();
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("diblokir");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("diblokir");
    });
    try {
      answer(adSettings({ machineDomain: "macf.co.id" }));
      render(<OrgScreen state={state} onRefresh={vi.fn()} />);
      const offer = await screen.findByTestId("org-domain-offer");
      await user.click(within(offer).getByRole("button", { name: "Sembunyikan" }));
      expect(screen.queryByTestId("org-domain-offer")).not.toBeInTheDocument();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it("gerbang versi tertutup: tanpa tombol Pakai, laptop yang menghalangi disebutkan", async () => {
    answer(
      adSettings({
        machineDomain: "macf.co.id",
        allowed: false,
        outdated: [
          { name: "Budi", appVersion: "0.4.0" },
          { name: "Sari", appVersion: null },
        ],
      }),
    );
    render(<OrgScreen state={state} onRefresh={vi.fn()} />);
    const offer = await screen.findByTestId("org-domain-offer");
    expect(within(offer).queryByRole("button", { name: /Pakai/ })).not.toBeInTheDocument();
    expect(offer).toHaveTextContent("macf.co.id baru bisa dipakai setelah laptop berikut memperbarui Mira:");
    const list = within(offer).getByTestId("org-domain-offer-blocked");
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Budi, versi 0.4.0",
      "Sari, versi belum dilaporkan",
    ]);
    expect(within(offer).getByRole("button", { name: "Sembunyikan" })).toBeInTheDocument();
  });

  it("bahasa Inggris tanpa kata Indonesia", async () => {
    answer(adSettings({ machineDomain: "macf.co.id", allowed: false, outdated: [{ name: "Budi", appVersion: "0.4.0" }] }));
    renderInLang(() => <OrgScreen state={state} onRefresh={vi.fn()} />, "en");
    const offer = await screen.findByTestId("org-domain-offer");
    expect(within(offer).getByRole("heading", { name: "Use macf.co.id as this office's AD domain?" })).toBeInTheDocument();
    expect(offer).toHaveTextContent("macf.co.id can be used once these laptops update Mira:");
    expect(offer).toHaveTextContent("Budi, version 0.4.0");
    expect(within(offer).getByRole("button", { name: "Hide" })).toBeInTheDocument();
    expect(offer.textContent).not.toMatch(/\b(Pakai|Sembunyikan|kantor|laptop berikut|versi)\b/);
  });
});
