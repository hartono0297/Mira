import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, OrgInfo } from "../../api";
import type { OrgOverview, OtherOfficesView } from "../../api/org";
import { setLang } from "../../i18n/core";
import { appState, directory, router } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import { memberOverview, otherOffices, overview } from "../../test/orgFixtures";
import { OrgScreen } from "./OrgScreen";
import { OtherOfficesNotice } from "./OtherOfficesNotice";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("./UsersPanel", () => ({ UsersPanel: () => null }));
vi.mock("./PeoplePanel", () => ({ PeoplePanel: () => null }));
vi.mock("./DepartmentsPanel", () => ({ DepartmentsPanel: () => null }));
vi.mock("./LabelsPanel", () => ({ LabelsPanel: () => null }));
vi.mock("./JoinRequestsPanel", () => ({ JoinRequestsPanel: () => null }));

const OLDER = { name: "Kantor Pusat Uji", createdAt: "2026-10-01T03:00:00Z", fingerprint: "7KQ2-M9XD" };

function calls(cmd: string) {
  return invoke.mock.calls.filter(([c]) => c === cmd);
}

function mockOffices(answer: OtherOfficesView | (() => unknown)) {
  invoke.mockImplementation(router({ org_other_offices: typeof answer === "function" ? answer : () => answer }));
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

afterEach(() => {
  setLang("id");
});

describe("Pemberitahuan laptop di kantor Mira lain", () => {
  it("tidak tampil kalau tidak ada laptop dari kantor lain", async () => {
    mockOffices(otherOffices());
    const { container } = render(<OtherOfficesNotice superadmin={false} />);
    await waitFor(() => expect(calls("org_other_offices")).toHaveLength(1));
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it("menyebut jumlah laptop dan nama kantor, tanpa tombol", async () => {
    mockOffices(otherOffices({ laptops: 3, offices: 2, names: ["Kantor Cabang", "Gudang"] }));
    render(<OtherOfficesNotice superadmin={false} />);
    const box = await screen.findByTestId("org-other-offices");
    expect(box).toHaveTextContent("Ada 3 laptop di jaringan ini yang tergabung di kantor Mira lain.");
    expect(box).toHaveTextContent("Kantor yang terlihat: Kantor Cabang, Gudang.");
    expect(box).toHaveTextContent("Ini hanya petunjuk. Mira tidak menyatukan kantor secara otomatis.");
    expect(box).not.toHaveAttribute("data-same-domain");
    expect(within(box).queryByRole("button")).not.toBeInTheDocument();
    expect(calls("org_other_offices")).toHaveLength(1);
  });

  it("domain AD sama: menekankan kemungkinan kantor ganda", async () => {
    mockOffices(otherOffices({ laptops: 2, offices: 1, sameDomainLaptops: 2, names: [] }));
    render(<OtherOfficesNotice superadmin={false} />);
    const box = await screen.findByTestId("org-other-offices");
    expect(box).toHaveAttribute("data-same-domain", "true");
    expect(box).toHaveClass("notice");
    expect(box).toHaveTextContent(
      "2 di antaranya memakai domain AD yang sama dengan kantor ini, jadi kemungkinan ada kantor ganda.",
    );
    expect(box).toHaveTextContent(/Superadmin sebaiknya merapikannya/);
    expect(box).not.toHaveTextContent("Kantor yang terlihat");
  });

  it("galat diabaikan diam-diam", async () => {
    mockOffices(() => {
      throw { code: "internal", message: "gagal membaca jaringan" };
    });
    const { container } = render(<OtherOfficesNotice superadmin />);
    await waitFor(() => expect(calls("org_other_offices")).toHaveLength(1));
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/gagal/)).not.toBeInTheDocument();
  });

  it("kantor lebih dulu untuk domain yang sama: peringatan tegas untuk superadmin", async () => {
    mockOffices(otherOffices({ laptops: 4, offices: 1, sameDomainLaptops: 4, olderSameDomain: OLDER }));
    render(<OtherOfficesNotice superadmin />);
    const box = await screen.findByTestId("org-older-office");
    expect(box).toHaveClass("alert");
    expect(box).toHaveTextContent("Ada kantor lain untuk domain AD yang sama yang dibuat lebih dulu");
    expect(box).toHaveTextContent("Kantor Pusat Uji, dibuat 1 Oktober 2026.");
    expect(within(box).getByText("7KQ2-M9XD")).toHaveClass("mono");
    expect(box).toHaveTextContent(/dianggap kantor utama domain ini/);
    expect(box).toHaveTextContent(/tidak bisa digabung otomatis/);
    expect(within(box).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("org-other-offices")).not.toBeInTheDocument();
  });

  it("bukan superadmin: kantor lebih dulu tidak disebut, cukup pemberitahuan ringan", async () => {
    mockOffices(otherOffices({ laptops: 4, offices: 1, sameDomainLaptops: 4, olderSameDomain: OLDER }));
    render(<OtherOfficesNotice superadmin={false} />);
    expect(await screen.findByTestId("org-other-offices")).toHaveTextContent("Ada 4 laptop");
    expect(screen.queryByTestId("org-older-office")).not.toBeInTheDocument();
    expect(screen.queryByText(/Kantor Pusat Uji/)).not.toBeInTheDocument();
  });

  it("bahasa Inggris", async () => {
    mockOffices(otherOffices({ laptops: 1, offices: 1, sameDomainLaptops: 1, names: ["Branch"] }));
    renderInLang(() => <OtherOfficesNotice superadmin={false} />, "en");
    const box = await screen.findByTestId("org-other-offices");
    expect(box).toHaveTextContent("1 laptop on this network belongs to another Mira office.");
    expect(box).toHaveTextContent("Offices seen: Branch.");
    expect(box).toHaveTextContent("1 of them uses the same AD domain as this office");
    expect(box).toHaveTextContent("This is only a hint. Mira doesn't merge offices automatically.");
  });

  it("bahasa Inggris: peringatan kantor utama", async () => {
    mockOffices(otherOffices({ laptops: 1, offices: 1, sameDomainLaptops: 1, olderSameDomain: OLDER }));
    renderInLang(() => <OtherOfficesNotice superadmin />, "en");
    const box = await screen.findByTestId("org-older-office");
    expect(box).toHaveTextContent("Another office for the same AD domain was created earlier");
    expect(box).toHaveTextContent("Kantor Pusat Uji, created 1 October 2026.");
    expect(box).toHaveTextContent("That office's fingerprint: 7KQ2-M9XD");
    expect(box).toHaveTextContent(/main office for this domain/);
  });
});

describe("Pemberitahuan kantor lain di halaman Organisasi", () => {
  const state = appState() as AppState & { organization: OrgInfo };

  function setup(o: OrgOverview, offices: OtherOfficesView) {
    invoke.mockImplementation(
      router({
        org_overview: o,
        get_directory: directory({ superadminCount: 2 }),
        org_fingerprint: "ABCD-EFGH",
        org_other_offices: offices,
      }),
    );
    render(<OrgScreen state={state} onRefresh={vi.fn()} />);
  }

  it("anggota biasa juga melihat pemberitahuan ringan", async () => {
    setup(memberOverview(), otherOffices({ laptops: 2, offices: 1, olderSameDomain: OLDER }));
    expect(await screen.findByTestId("org-other-offices")).toHaveTextContent("Ada 2 laptop");
    expect(screen.queryByTestId("org-older-office")).not.toBeInTheDocument();
  });

  it("superadmin melihat peringatan kantor utama", async () => {
    setup(overview(), otherOffices({ laptops: 2, offices: 1, sameDomainLaptops: 2, olderSameDomain: OLDER }));
    expect(await screen.findByTestId("org-older-office")).toHaveTextContent("Kantor Pusat Uji");
    expect(calls("org_other_offices")).toHaveLength(1);
  });
});
