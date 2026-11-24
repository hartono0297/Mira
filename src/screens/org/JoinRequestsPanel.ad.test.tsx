import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, OrgInfo } from "../../api";
import type { AdCheck, AdCheckStatus, JoinRequestView } from "../../api/org";
import { setLang } from "../../i18n/core";
import { appState, directory, router } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import { adCheck, joinAd, joinRequest, overview, TEAM_2 } from "../../test/orgFixtures";
import type { OrgPage } from "./context";
import { JoinRequestsPanel } from "./JoinRequestsPanel";
import { OrgScreen } from "./OrgScreen";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("./UsersPanel", () => ({ UsersPanel: () => null }));
vi.mock("./PeoplePanel", () => ({ PeoplePanel: () => null }));
vi.mock("./DepartmentsPanel", () => ({ DepartmentsPanel: () => null }));
vi.mock("./LabelsPanel", () => ({ LabelsPanel: () => null }));

type Handler = (args?: Record<string, unknown>) => unknown;

function page(): OrgPage {
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

function calls(cmd: string) {
  return invoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
}

function setup(requests: JoinRequestView[], check: AdCheck | Handler = adCheck()) {
  invoke.mockImplementation(
    router({
      org_join_requests: requests,
      org_join_ad_check: typeof check === "function" ? check : () => check,
    }),
  );
  return render(<JoinRequestsPanel page={page()} />);
}

async function card(name: string): Promise<HTMLElement> {
  return (await screen.findByRole("heading", { name, level: 3 })).closest("li") as HTMLElement;
}

function fact(scope: HTMLElement, label: string): HTMLElement {
  return within(scope).getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
}

const RINA = joinRequest("r1", "Rina W.", { teamName: "Desain", ad: joinAd() });
const FAJAR = joinRequest("r2", "Fajar", { teamId: TEAM_2, teamName: "Drafting", ip: null });

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

afterEach(() => {
  setLang("id");
});

describe("Kartu permintaan tanpa data AD", () => {
  it("tidak berubah: tanpa blok AD, tanpa cek AD, tanpa peringatan versi", async () => {
    setup([FAJAR]);
    const fajar = await card("Fajar");
    expect(within(fajar).queryByTestId("join-ad")).not.toBeInTheDocument();
    expect(within(fajar).queryByText("Active Directory")).not.toBeInTheDocument();
    expect(within(fajar).queryByText(/Tanpa data AD/)).not.toBeInTheDocument();
    expect(within(fajar).queryByTestId("join-requester-outdated")).not.toBeInTheDocument();
    expect(calls("org_join_ad_check")).toHaveLength(0);
  });
});

describe("Kartu permintaan dengan data AD", () => {
  it("menampilkan data AD dari laptop peminta dan memanggil cek AD sekali", async () => {
    let answer: (v: AdCheck) => void = () => {};
    setup([RINA, FAJAR], () => new Promise<AdCheck>((resolve) => (answer = resolve)));
    const rina = await card("Rina W.");
    const block = within(rina).getByTestId("join-ad");
    expect(within(block).getByRole("heading", { name: "Active Directory", level: 4 })).toBeInTheDocument();
    expect(within(block).getByText("Dilaporkan laptop peminta, lalu diperiksa ulang dari laptop ini.")).toBeInTheDocument();
    expect(fact(block, "Akun")).toHaveTextContent(/^rina@kantor-uji\.test$/);
    expect(fact(block, "Akun")).toHaveClass("mono");
    expect(fact(block, "Nama di AD")).toHaveTextContent("Rina Wijaya");
    expect(fact(block, "Departemen di AD")).toHaveTextContent(/^Keuangan$/);
    // Dari OU paling luar ke paling dalam, seperti di layar peminta.
    expect(fact(block, "Lokasi di Active Directory")).toHaveTextContent(/^Jakarta › Keuangan$/);

    const status = within(block).getByTestId("join-ad-status");
    expect(status).not.toHaveAttribute("aria-live");
    expect(status).toHaveTextContent("Memeriksa ke AD...");
    // Kalimat batas: teks biasa tepat di bawah baris status.
    const limit = within(block).getByText(/bukan bahwa peminta adalah pemilik akun itu/);
    expect(limit).toHaveClass("req-ad-limit");
    expect(limit).not.toHaveClass("hint");
    expect(limit.previousElementSibling).toContainElement(status);

    answer(adCheck());
    await waitFor(() => expect(status).toHaveTextContent("Akun ada dan aktif di AD, nama dan departemen sama"));
    expect(status).toHaveAttribute("data-status", "match");
    expect(status).toHaveClass("req-ad-ok");
    // Cek pertama saat kartu muncul tidak dibacakan.
    expect(within(block).getByTestId("join-ad-live")).toBeEmptyDOMElement();
    expect(calls("org_join_ad_check")).toEqual([{ requestId: "r1", refresh: false }]);
    // Fajar tanpa AD tidak memicu cek.
    expect(within(await card("Fajar")).queryByTestId("join-ad")).not.toBeInTheDocument();
  });

  it.each<[AdCheckStatus, string, string]>([
    ["match", "Akun ada dan aktif di AD, nama dan departemen sama", "ok"],
    ["mismatch", "Berbeda dengan AD", "neutral"],
    ["disabled", "Akun AD dinonaktifkan", "bad"],
    ["not_found", "Akun tidak ditemukan di AD", "bad"],
    ["unreachable", "AD tidak bisa dihubungi dari laptop ini", "neutral"],
    ["other_domain", "Laptop ini tidak tergabung di domain kantor-uji.test, jadi tidak bisa memeriksa", "neutral"],
    ["not_domain_machine", "Laptop ini tidak tergabung di domain, jadi tidak bisa memeriksa", "neutral"],
  ])("status %s tampil sebagai teks", async (status, text, tone) => {
    setup([RINA], adCheck({ status }));
    const rina = await card("Rina W.");
    const el = within(rina).getByTestId("join-ad-status");
    await waitFor(() => expect(el).toHaveTextContent(text));
    expect(el).toHaveAttribute("data-status", status);
    // Merah hanya untuk akun dinonaktifkan atau tidak ada.
    expect(el).toHaveClass(`req-ad-${tone}`);
  });

  it("galat command dibaca sama dengan AD tidak bisa dihubungi", async () => {
    setup([RINA], () => {
      throw { code: "internal", message: "gagal" };
    });
    const rina = await card("Rina W.");
    await waitFor(() =>
      expect(within(rina).getByTestId("join-ad-status")).toHaveTextContent("AD tidak bisa dihubungi dari laptop ini"),
    );
  });

  it("tidak cocok: menampilkan rincian nama dan departemen", async () => {
    setup(
      [RINA],
      adCheck({
        status: "mismatch",
        mismatches: [
          { field: "name", requested: "Rina W.", directory: "Rina Wijaya" },
          { field: "department", requested: "Desain", directory: "Keuangan" },
        ],
      }),
    );
    const rina = await card("Rina W.");
    expect(await within(rina).findByText("Nama di AD: Rina Wijaya, di permintaan: Rina W.")).toBeInTheDocument();
    expect(within(rina).getByText("Departemen di AD: Keuangan, di permintaan: Desain")).toBeInTheDocument();
    expect(within(rina).getByTestId("join-ad-status")).toHaveTextContent("Berbeda dengan AD");
    expect(within(rina).getByText(/Peminta boleh mengubah nama tampilan/)).toBeInTheDocument();
  });

  it("hanya departemen yang berbeda: tanpa catatan nama tampilan", async () => {
    setup(
      [RINA],
      adCheck({ status: "mismatch", mismatches: [{ field: "department", requested: "Desain", directory: "Keuangan" }] }),
    );
    const rina = await card("Rina W.");
    expect(await within(rina).findByText("Departemen di AD: Keuangan, di permintaan: Desain")).toBeInTheDocument();
    expect(within(rina).queryByText(/Peminta boleh mengubah nama tampilan/)).not.toBeInTheDocument();
  });

  it("Periksa lagi memanggil cek dengan refresh true", async () => {
    let n = 0;
    setup([RINA], () => (++n === 1 ? adCheck({ status: "unreachable" }) : adCheck({ status: "match" })));
    const user = userEvent.setup();
    const rina = await card("Rina W.");
    const status = within(rina).getByTestId("join-ad-status");
    await waitFor(() => expect(status).toHaveTextContent("AD tidak bisa dihubungi"));
    const live = within(rina).getByTestId("join-ad-live");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toBeEmptyDOMElement();
    const button = within(rina).getByRole("button", { name: "Periksa lagi akun AD Rina W." });
    await user.click(button);
    await waitFor(() => expect(status).toHaveTextContent("Akun ada dan aktif di AD, nama dan departemen sama"));
    // Hasil "Periksa lagi" dibacakan.
    expect(live).toHaveTextContent("Akun ada dan aktif di AD, nama dan departemen sama");
    expect(calls("org_join_ad_check")).toEqual([
      { requestId: "r1", refresh: false },
      { requestId: "r1", refresh: true },
    ]);
    expect(button).toHaveFocus();
  });

  it("departemen AD belum ada di Mira ditulis jelas", async () => {
    const req = joinRequest("r3", "Sari", {
      ad: joinAd({ department: "Pajak", departmentInMira: false, suggestedTeamId: null }),
    });
    setup([req], adCheck({ departmentInMira: false, directoryDepartment: "Pajak" }));
    const sari = await card("Sari");
    expect(fact(within(sari).getByTestId("join-ad"), "Departemen di AD")).toHaveTextContent("Pajak (belum ada di Mira)");
    await waitFor(() => expect(within(sari).getByTestId("join-ad-status")).toHaveAttribute("data-status", "match"));
    // Departemen AD yang belum ada di Mira hanya disebut sekali.
    expect(within(sari).getAllByText(/belum ada di Mira/)).toHaveLength(1);
  });

  it("data AD yang tidak dikirim tertulis Tidak dikirim", async () => {
    const req = joinRequest("r4", "Tono", { ad: joinAd({ name: null, department: null, ous: [], dn: null }) });
    setup([req]);
    const block = within(await card("Tono")).getByTestId("join-ad");
    expect(fact(block, "Nama di AD")).toHaveTextContent("Tidak dikirim");
    expect(fact(block, "Departemen di AD")).toHaveTextContent("Tidak dikirim");
    expect(fact(block, "Lokasi di Active Directory")).toHaveTextContent("Tidak dikirim");
  });
});

describe("Kartu permintaan dari Mira yang terlalu lama", () => {
  const state = appState() as AppState & { organization: OrgInfo };

  it("memperingatkan, Setujui tetap aktif, dan galat persetujuan tampil seperti biasa", async () => {
    const old = joinRequest("r5", "Wawan", { requesterOutdated: true });
    invoke.mockImplementation(
      router({
        org_overview: overview({ pendingJoinCount: 1 }),
        get_directory: directory(),
        org_fingerprint: "ABCD-EFGH",
        org_join_requests: [old],
        org_approve_join: () => {
          throw { code: "invalid_input", message: "Mira di laptop peminta perlu diperbarui dulu." };
        },
      }),
    );
    render(<OrgScreen state={state} onRefresh={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Permintaan bergabung/ }));
    const wawan = await card("Wawan");
    const notice = within(wawan).getByTestId("join-requester-outdated");
    expect(notice).toHaveTextContent("Mira di laptop peminta perlu diperbarui dulu");
    expect(notice).toHaveTextContent(/Minta Wawan memperbarui Mira/);
    const approve = within(wawan).getByRole("button", { name: "Setujui permintaan Wawan" });
    expect(approve).toBeEnabled();
    await user.click(approve);
    expect(await screen.findByText("Permintaan belum disetujui")).toBeInTheDocument();
    expect(screen.getAllByText("Mira di laptop peminta perlu diperbarui dulu.").length).toBeGreaterThan(0);
  });

  it("muat ulang daftar tidak memanggil cek AD lagi", async () => {
    let list = [RINA, FAJAR];
    invoke.mockImplementation(
      router({
        org_overview: overview({ pendingJoinCount: 2 }),
        get_directory: directory(),
        org_fingerprint: "ABCD-EFGH",
        org_join_requests: () => list,
        org_join_ad_check: () => adCheck(),
        org_approve_join: () => {
          list = [RINA];
          return null;
        },
      }),
    );
    render(<OrgScreen state={state} onRefresh={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Permintaan bergabung/ }));
    const rina = await card("Rina W.");
    await waitFor(() => expect(within(rina).getByTestId("join-ad-status")).toHaveAttribute("data-status", "match"));
    await user.click(screen.getByRole("button", { name: "Setujui permintaan Fajar" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Fajar" })).not.toBeInTheDocument());
    expect(calls("org_join_ad_check")).toHaveLength(1);
  });
});

describe("Blok AD dalam bahasa Inggris", () => {
  it("menulis label, status, rincian, dan peringatan dalam bahasa Inggris", async () => {
    const req = joinRequest("r6", "Rina W.", {
      ad: joinAd({ department: "Pajak", departmentInMira: false }),
      requesterOutdated: true,
    });
    invoke.mockImplementation(
      router({
        org_join_requests: [req],
        org_join_ad_check: adCheck({
          status: "mismatch",
          mismatches: [{ field: "name", requested: "Rina W.", directory: "Rina Wijaya" }],
        }),
      }),
    );
    renderInLang(() => <JoinRequestsPanel page={page()} />, "en");
    const rina = await card("Rina W.");
    const block = within(rina).getByTestId("join-ad");
    expect(fact(block, "Account")).toHaveTextContent("rina@kantor-uji.test");
    expect(fact(block, "Department in AD")).toHaveTextContent("Pajak (not in Mira yet)");
    expect(fact(block, "Location in Active Directory")).toHaveTextContent("Jakarta › Keuangan");
    await waitFor(() => expect(within(block).getByTestId("join-ad-status")).toHaveTextContent("Differs from AD"));
    expect(within(block).getByText("Name in AD: Rina Wijaya, in the request: Rina W.")).toBeInTheDocument();
    expect(within(block).getByText(/The requester is allowed to change their display name/)).toBeInTheDocument();
    expect(within(block).getByText(/not that the requester owns it/)).toHaveClass("req-ad-limit");
    expect(within(block).getByRole("button", { name: "Check Rina W.'s AD account again" })).toBeInTheDocument();
    expect(within(rina).getByTestId("join-requester-outdated")).toHaveTextContent(
      "Mira on the requesting laptop needs an update first",
    );
    expect(within(rina).queryByText(/Memeriksa|Periksa|belum ada di Mira|Tidak cocok/)).not.toBeInTheDocument();
  });

  it.each<[AdCheckStatus, string]>([
    ["match", "Account exists and is active in AD, name and department match"],
    ["disabled", "AD account is disabled"],
    ["not_found", "Account not found in AD"],
    ["unreachable", "Can't reach AD from this laptop"],
    ["other_domain", "This laptop isn't joined to the kantor-uji.test domain, so it can't check"],
    ["not_domain_machine", "This laptop isn't joined to a domain, so it can't check"],
  ])("status %s dalam bahasa Inggris", async (status, text) => {
    invoke.mockImplementation(router({ org_join_requests: [RINA], org_join_ad_check: adCheck({ status }) }));
    renderInLang(() => <JoinRequestsPanel page={page()} />, "en");
    const rina = await card("Rina W.");
    await waitFor(() => expect(within(rina).getByTestId("join-ad-status")).toHaveTextContent(text));
  });
});
