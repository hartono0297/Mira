// Onboarding dengan Active Directory (docs/plans/onboarding-ad.md bagian 1, 6,
// dan 6.1): data akun Windows mengisi formulir, admin tetap menyetujui; satu
// domain satu kantor.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../../api";
import type { AdDeptSuggestion, LocalAd } from "../../api/join";
import { setLang } from "../../i18n/core";
import { appState, firewall, org, router, rustError } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import { ThemeProvider } from "../../theme/ThemeProvider";
import { device, office, outgoing, searchResult } from "./joinFixtures";
import { Onboarding } from "./Onboarding";
import { GRACE_MS, SETUP_SEARCH_MS } from "./SearchStep";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const DN = "CN=Rina Wijaya,OU=Keuangan,OU=Kantor Pusat,DC=macf,DC=co,DC=id";
const AD: LocalAd = {
  domain: "macf.co.id",
  user: "rina",
  dn: DN,
  displayName: "Rina Wijaya",
  department: "Keuangan",
  complete: true,
};
const DEPTS = [
  { id: "t-keu", name: "Keuangan" },
  { id: "t-dev", name: "IT Development" },
];
const MCF = office({
  key: "org-mcf:fp",
  orgId: "m".repeat(32),
  name: "MCF",
  fingerprint: "MCF1-0001",
  departments: DEPTS,
  adDomain: "macf.co.id",
  acceptsAd: true,
});
const OTHER = office({ key: "org-lain:fp", orgId: "l".repeat(32), name: "Kantor Lain", fingerprint: "LAIN-0002" });
const SUGGEST: AdDeptSuggestion = { teamId: "t-keu", source: "attribute", adDepartment: "Keuangan", inMira: true };
const AD_TEXT = /akun Windows|Domain kantor|Dari akun|Active Directory|Kantor utama|Kantor Anda ditemukan/;

function fresh(displayName: string | null = "Rina Wijaya"): AppState {
  const base = appState({ organization: null, membership: "none" });
  return { ...base, identity: { ...base.identity, displayName } };
}

function draw(state: AppState) {
  return (
    <ThemeProvider>
      <Onboarding state={state} onIdentity={vi.fn()} onOrganization={vi.fn()} onReload={vi.fn()} />
    </ThemeProvider>
  );
}

function setup(state: AppState = fresh()) {
  render(draw(state));
}

function commands(table: Parameters<typeof router>[0]) {
  invoke.mockImplementation(
    router({ get_firewall_status: firewall({ rule: "allowed" }), join_device: device, ...table }),
  );
}

function calls(cmd: string) {
  return invoke.mock.calls.filter(([c]) => c === cmd);
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function user() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

function officeRadios() {
  return within(screen.getByRole("main")).queryAllByRole("radio");
}

async function passName(u: ReturnType<typeof user>) {
  await screen.findByRole("heading", { name: "Siapa nama Anda?" });
  await u.click(screen.getByRole("button", { name: "Lanjut" }));
}

async function searchUntil(u: ReturnType<typeof user>, heading: string) {
  await passName(u);
  await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." });
  await advance(GRACE_MS + 500);
  return screen.findByRole("heading", { name: heading });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  setLang("id");
});

describe("Onboarding AD: tanpa profil", () => {
  it("profil null: tidak ada teks AD dan permintaan dikirim tanpa data AD", async () => {
    const u = user();
    commands({
      join_ad_profile: null,
      join_search: searchResult({ offices: [MCF] }),
      join_send_request: outgoing(),
    });
    setup(fresh(null));

    await screen.findByRole("heading", { name: "Siapa nama Anda?" });
    expect(screen.getByLabelText("Nama tampilan")).toHaveValue("");
    await u.type(screen.getByLabelText("Nama tampilan"), "Rina");
    commands({
      join_ad_profile: null,
      join_search: searchResult({ offices: [MCF] }),
      join_send_request: outgoing(),
      save_display_name: { ...fresh().identity, displayName: "Rina" },
    });
    await u.click(screen.getByRole("button", { name: "Lanjut" }));
    await advance(GRACE_MS + 500);
    await screen.findByRole("heading", { name: "Kantor ditemukan: MCF" });

    expect(document.body.textContent).not.toMatch(AD_TEXT);
    expect(screen.queryByTestId("onb-ad-box")).toBeNull();
    expect(screen.queryByTestId("onb-ad-skipped")).toBeNull();
    await u.selectOptions(screen.getByLabelText("Departemen"), "Keuangan");
    await u.click(screen.getByRole("button", { name: "Kirim permintaan" }));
    await waitFor(() => expect(calls("join_send_request")).toHaveLength(1));
    expect(calls("join_send_request")[0][1]).toMatchObject({ useAd: false });
    expect(calls("join_ad_suggest")).toHaveLength(0);
    expect(calls("join_ad_profile")).toHaveLength(1);
  });

  it("profil gagal dibaca: diam saja, langkah nama tetap kosong", async () => {
    commands({ join_ad_profile: rustError("internal", "x") });
    setup(fresh(null));
    await screen.findByRole("heading", { name: "Siapa nama Anda?" });
    await waitFor(() => expect(calls("join_ad_profile")).toHaveLength(1));
    expect(screen.getByLabelText("Nama tampilan")).toHaveValue("");
    expect(screen.queryByTestId("onb-ad-name-source")).toBeNull();
  });
});

describe("Onboarding AD: langkah nama", () => {
  it("nama kosong diisi displayName AD dengan keterangan sumbernya, lalu bisa diubah", async () => {
    const u = user();
    commands({ join_ad_profile: AD });
    setup(fresh(null));

    const input = await screen.findByDisplayValue("Rina Wijaya");
    expect(screen.getByText("Diisi dari akun Windows Anda (macf.co.id). Ubah kalau perlu.")).toBeInTheDocument();
    expect(input.getAttribute("aria-describedby")).toContain(screen.getByTestId("onb-ad-name-source").id);

    await u.clear(input);
    await u.type(input, "Rina W.");
    expect(input).toHaveValue("Rina W.");
    expect(screen.queryByTestId("onb-ad-name-source")).toBeNull();
  });

  it("profil tiba setelah orangnya mengetik: ketikannya tidak ditimpa", async () => {
    const u = user();
    let answer: (v: LocalAd) => void = () => {};
    commands({ join_ad_profile: () => new Promise<LocalAd>((r) => (answer = r)) });
    setup(fresh(null));
    const input = await screen.findByLabelText("Nama tampilan");
    await u.type(input, "Rina");
    await act(async () => answer(AD));
    expect(input).toHaveValue("Rina");
    expect(screen.queryByTestId("onb-ad-name-source")).toBeNull();
  });

  it("nama yang sudah tersimpan tidak ditimpa nama dari AD", async () => {
    commands({ join_ad_profile: AD });
    setup(fresh("Bu Rina"));
    const input = await screen.findByLabelText("Nama tampilan");
    await waitFor(() => expect(calls("join_ad_profile")).toHaveLength(1));
    await advance(10);
    expect(input).toHaveValue("Bu Rina");
    expect(screen.queryByTestId("onb-ad-name-source")).toBeNull();
  });
});

describe("Onboarding AD: kantor dan departemen", () => {
  it("tepat satu kantor dengan domain sama: langsung dipakai, Ubah membuka daftar dengan kantor itu di atas", async () => {
    const u = user();
    commands({
      join_ad_profile: { ...AD, domain: "MACF.co.id" },
      join_search: searchResult({ offices: [OTHER, MCF] }),
      join_ad_suggest: SUGGEST,
    });
    setup();

    expect(await searchUntil(u, "Kantor Anda ditemukan")).toHaveFocus();
    expect(officeRadios()).toHaveLength(0);
    // Nama kantor hanya di ringkasan, tidak diulang di judul.
    expect(screen.getAllByText(/MCF \(/)).toHaveLength(1);
    const summary = screen.getByTestId("onb-ad-office-summary");
    expect(summary).toHaveTextContent("Kantor: MCF (MACF.co.id)");
    expect(screen.getByText("MCF1-0001")).toBeInTheDocument();

    await u.click(within(summary).getByRole("button", { name: "Ubah kantor" }));
    const radios = officeRadios();
    expect(radios).toHaveLength(2);
    expect(radios[0]).toHaveAttribute("value", "org-mcf:fp");
    expect(radios[0]).toBeChecked();
    expect(radios[0]).toHaveFocus();
    expect(screen.getByText("Domain kantor Anda: MACF.co.id")).toBeInTheDocument();
    expect(screen.queryByTestId("onb-ad-office-summary")).toBeNull();
  });

  it("satu kantor saja dengan domain sama: ringkasan kantor tanpa tombol Ubah", async () => {
    const u = user();
    commands({ join_ad_profile: AD, join_search: searchResult({ offices: [MCF] }), join_ad_suggest: SUGGEST });
    setup();
    await searchUntil(u, "Kantor Anda ditemukan");
    const summary = screen.getByTestId("onb-ad-office-summary");
    expect(summary).toHaveTextContent("Kantor: MCF (macf.co.id)");
    expect(within(summary).queryByRole("button")).toBeNull();
    // Domain di pengumuman kantor tidak terverifikasi: sidiknya tetap tampil.
    expect(screen.getByText("Sidik organisasi")).toBeInTheDocument();
    expect(screen.getByText("MCF1-0001")).toBeInTheDocument();
  });

  it("beberapa kantor dengan domain sama: yang dibuat paling awal jadi kantor utama dan terpilih", async () => {
    const u = user();
    const newer = office({
      ...MCF,
      key: "org-mcf2:fp",
      orgId: "n".repeat(32),
      name: "MCF Cabang",
      fingerprint: "MCF2-0002",
      createdAt: "2026-06-01T08:00:00Z",
    });
    const older = { ...MCF, createdAt: "2026-02-01T08:00:00Z" };
    commands({ join_ad_profile: AD, join_search: searchResult({ offices: [OTHER, newer, older] }) });
    setup();
    await searchUntil(u, "Beberapa kantor ditemukan");

    const radios = officeRadios();
    expect(radios.map((r) => r.getAttribute("value"))).toEqual(["org-mcf:fp", "org-mcf2:fp", "org-lain:fp"]);
    expect(radios[0]).toBeChecked();
    expect(screen.getByTestId("onb-ad-office-primary")).toHaveTextContent(
      "Kantor utama untuk macf.co.id (dibuat paling awal menurut catatan kantor itu)",
    );
    expect(screen.getByTestId("onb-ad-office-later")).toHaveTextContent(
      "Domainnya sama, tapi menurut catatannya dibuat lebih baru. Pilih hanya kalau admin kantor memintanya, dan cocokkan sidiknya dulu.",
    );
    // Sidik tiap kantor tetap tampil untuk dicocokkan.
    expect(screen.getByText("MCF1-0001")).toBeInTheDocument();
    expect(screen.getByText("MCF2-0002")).toBeInTheDocument();
    expect(screen.queryByTestId("onb-ad-office-summary")).toBeNull();
    await u.click(radios[1]);
    expect(radios[1]).toBeChecked();
  });

  it("berlaku: departemen usulan terpilih, kotak yang dikirim, lalu sendRequest dengan useAd true", async () => {
    const u = user();
    commands({
      join_ad_profile: AD,
      join_search: searchResult({ offices: [MCF] }),
      join_ad_suggest: SUGGEST,
      join_send_request: outgoing({ ad: { domain: "macf.co.id", user: "rina", dn: DN, name: null, department: null } }),
    });
    setup();
    await searchUntil(u, "Kantor Anda ditemukan");

    await waitFor(() => expect(screen.getByLabelText("Departemen")).toHaveValue("t-keu"));
    expect(invoke).toHaveBeenCalledWith("join_ad_suggest", { officeKey: "org-mcf:fp" });
    expect(screen.getByText("Dari akun Windows Anda: Keuangan")).toBeInTheDocument();
    await u.type(screen.getByLabelText("Keterangan untuk admin (opsional)"), "NIK 2041");

    const box = screen.getByTestId("onb-ad-box");
    expect(within(box).getByText("Yang dilihat admin")).toBeInTheDocument();
    expect(within(box).getByText("Rina Wijaya")).toBeInTheDocument();
    expect(within(box).getByText("Keuangan")).toBeInTheDocument();
    expect(within(box).getByText("rina@macf.co.id")).toBeInTheDocument();
    expect(within(box).getByText("Lokasi di Active Directory")).toBeInTheDocument();
    expect(within(box).getByText("Kantor Pusat › Keuangan")).toBeInTheDocument();
    expect(within(box).getByText("NIK 2041")).toBeInTheDocument();
    expect(screen.queryByTestId("onb-ad-partial")).toBeNull();
    expect(within(box).getByTestId("onb-ad-stored")).toHaveTextContent(
      "Nama, departemen, akun Windows, dan lokasi di Active Directory ikut tersimpan di catatan kantor dan bisa dilihat anggota kantor.",
    );

    await u.click(screen.getByRole("button", { name: "Kirim permintaan" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("join_send_request", {
        officeKey: "org-mcf:fp",
        teamId: "t-keu",
        confirmFingerprint: null,
        note: "NIK 2041",
        useAd: true,
      }),
    );
    // Layar menunggu: admin melihat akun Windows.
    expect(await screen.findByRole("heading", { name: "Menunggu persetujuan" })).toBeInTheDocument();
    const waitingBox = screen.getByText("Yang dilihat admin").closest(".onb-box") as HTMLElement;
    expect(within(waitingBox).getByTestId("onb-ad-waiting-account")).toHaveTextContent("rina@macf.co.id");
    // Akun Windows menggantikan baris akun login, juga di luar kotak.
    expect(screen.queryByText("Akun login")).toBeNull();
    expect(screen.queryByText("Akun login laptop ini")).toBeNull();
    expect(screen.queryByText("desain03")).toBeNull();
  });

  it("pilihan departemen orangnya sendiri tidak ditimpa usulan AD", async () => {
    const u = user();
    let answer: (v: AdDeptSuggestion) => void = () => {};
    commands({
      join_ad_profile: AD,
      join_search: searchResult({ offices: [MCF] }),
      join_ad_suggest: () => new Promise<AdDeptSuggestion>((r) => (answer = r)),
    });
    setup();
    await searchUntil(u, "Kantor Anda ditemukan");
    await u.selectOptions(screen.getByLabelText("Departemen"), "IT Development");
    await act(async () => answer(SUGGEST));
    expect(screen.getByLabelText("Departemen")).toHaveValue("t-dev");
    expect(screen.getByText("Dari akun Windows Anda: Keuangan")).toBeInTheDocument();
  });

  it("usulan dari OU di AD", async () => {
    const u = user();
    commands({
      join_ad_profile: { ...AD, department: null },
      join_search: searchResult({ offices: [MCF] }),
      join_ad_suggest: { teamId: "t-dev", source: "ou_map", adDepartment: "IT-Development", inMira: true },
    });
    setup();
    await searchUntil(u, "Kantor Anda ditemukan");
    await waitFor(() => expect(screen.getByLabelText("Departemen")).toHaveValue("t-dev"));
    const caption = screen.getByTestId("onb-ad-dept");
    expect(caption).toHaveTextContent("Dari akun Windows Anda: IT-Development");
    expect(screen.getByLabelText("Departemen").getAttribute("aria-describedby")).toContain(caption.id);
  });

  it("departemen di AD belum ada di Mira: tidak ada yang terpilih dan tidak dibuat", async () => {
    const u = user();
    commands({
      join_ad_profile: AD,
      join_search: searchResult({ offices: [MCF] }),
      join_ad_suggest: { teamId: null, source: null, adDepartment: "Pajak", inMira: false },
    });
    setup();
    await searchUntil(u, "Kantor Anda ditemukan");
    expect(await screen.findByTestId("onb-ad-skipped")).toHaveTextContent(
      "Departemen Anda di akun Windows (Pajak) belum dicocokkan admin dengan departemen di Mira. Pilih departemen sendiri.",
    );
    expect(screen.getByLabelText("Departemen")).toHaveValue("");
    expect(within(screen.getByTestId("onb-ad-box")).getByText("Belum dipilih")).toBeInTheDocument();
    expect(calls("org_create_department")).toHaveLength(0);
  });

  it("data AD sebagian: kotak menyebut admin akan memeriksa ulang", async () => {
    const u = user();
    commands({
      join_ad_profile: { ...AD, dn: null, displayName: null, department: null, complete: false },
      join_search: searchResult({ offices: [MCF] }),
      join_send_request: outgoing(),
    });
    setup();
    await searchUntil(u, "Kantor Anda ditemukan");
    const box = screen.getByTestId("onb-ad-box");
    expect(within(box).getByText("rina@macf.co.id")).toBeInTheDocument();
    expect(within(box).queryByText("Lokasi di Active Directory")).toBeNull();
    expect(within(box).getByTestId("onb-ad-partial")).toHaveTextContent(
      "Sebagian data akun Windows tidak terbaca karena server kantor tidak terjangkau. Admin akan memeriksanya lagi.",
    );
    await u.selectOptions(screen.getByLabelText("Departemen"), "Keuangan");
    await u.click(screen.getByRole("button", { name: "Kirim permintaan" }));
    await waitFor(() => expect(calls("join_send_request")[0][1]).toMatchObject({ useAd: true }));
  });

});

// docs/plans/perbaikan-bergabung.md keputusan 9: satu baris alasan di bawah
// pilihan departemen kalau data akun Windows terbaca tapi tidak dipakai.
describe("Onboarding AD: alasan data akun Windows tidak dipakai", () => {
  // Kasus nyata 0.5.0: OU dengan spasi dan &, tanpa atribut department.
  const JULIUS_DN =
    "CN=Julius,OU=IT- BussinesAnalyst_AppSupport & MIS_QA,OU=IT-Department,OU=IT & CP Department,OU=HO,OU=Member Users,DC=macf,DC=co,DC=id";
  const JULIUS: LocalAd = {
    domain: "macf.co.id",
    user: "julius",
    dn: JULIUS_DN,
    displayName: "Julius",
    department: null,
    complete: true,
  };
  const JULIUS_OU = "IT- BussinesAnalyst_AppSupport & MIS_QA";

  async function sendWithoutAd(u: ReturnType<typeof user>) {
    await u.selectOptions(screen.getByLabelText("Departemen"), "Keuangan");
    await u.click(screen.getByRole("button", { name: "Kirim permintaan" }));
    await waitFor(() => expect(calls("join_send_request")).toHaveLength(1));
    expect(calls("join_send_request")[0][1]).toMatchObject({ useAd: false });
  }

  it("laptop lama tanpa jumlah (yang menjawab memakai Mira lama): tanpa angka, useAd false, tanpa usulan", async () => {
    const u = user();
    commands({
      join_ad_profile: JULIUS,
      join_search: searchResult({ offices: [{ ...MCF, acceptsAd: false, adOutdated: null }] }),
      join_ad_suggest: SUGGEST,
      join_send_request: outgoing(),
    });
    setup(fresh("Julius"));
    await searchUntil(u, "Kantor Anda ditemukan");
    const line = await screen.findByTestId("onb-ad-skipped");
    expect(line).toHaveTextContent(
      "Ada laptop di kantor ini yang belum diperbarui ke Mira 0.5, jadi data akun Windows Anda belum bisa dipakai. Pilih departemen sendiri.",
    );
    expect(line).toHaveAttribute("data-reason", "outdated");
    expect(screen.queryByTestId("onb-ad-box")).toBeNull();
    expect(screen.getByLabelText("Departemen")).toHaveValue("");
    await sendWithoutAd(u);
    expect(calls("join_ad_suggest")).toHaveLength(0);
  });

  it("laptop lama dengan jumlah: angkanya disebut", async () => {
    const u = user();
    commands({
      join_ad_profile: JULIUS,
      join_search: searchResult({ offices: [{ ...MCF, acceptsAd: false, adOutdated: 2 }] }),
    });
    setup(fresh("Julius"));
    await searchUntil(u, "Kantor Anda ditemukan");
    expect(await screen.findByTestId("onb-ad-skipped")).toHaveTextContent(
      "Ada 2 laptop di kantor ini yang belum diperbarui ke Mira 0.5, jadi data akun Windows Anda belum bisa dipakai. Pilih departemen sendiri.",
    );
  });

  it("laptop lama didahulukan dari domain kosong (Mira lama tidak melaporkan domain)", async () => {
    const u = user();
    commands({
      join_ad_profile: JULIUS,
      join_search: searchResult({ offices: [{ ...MCF, adDomain: null, acceptsAd: false, adOutdated: 1 }] }),
    });
    setup(fresh("Julius"));
    await searchUntil(u, "Kantor ditemukan: MCF");
    expect(await screen.findByTestId("onb-ad-skipped")).toHaveTextContent(
      "Ada 1 laptop di kantor ini yang belum diperbarui ke Mira 0.5",
    );
    expect(screen.getAllByTestId("onb-ad-skipped")).toHaveLength(1);
  });

  it("kantor belum mengatur domain (kasus Julius di 0.5.0): alasannya di bawah departemen, tanpa usulan", async () => {
    const u = user();
    commands({
      join_ad_profile: JULIUS,
      join_search: searchResult({ offices: [{ ...MCF, adDomain: null, acceptsAd: true }] }),
      join_ad_suggest: SUGGEST,
      join_send_request: outgoing(),
    });
    setup(fresh("Julius"));
    const heading = await searchUntil(u, "Kantor ditemukan: MCF");
    const line = await screen.findByTestId("onb-ad-skipped");
    expect(line).toHaveTextContent(
      "Domain kantor ini belum diatur, jadi data akun Windows Anda belum dipakai. Pilih departemen sendiri; admin bisa mengatur domainnya nanti.",
    );
    // Di dalam isian departemen dan dibacakan bersama pilihannya; fokus tetap di judul.
    const select = screen.getByLabelText("Departemen");
    expect(select.closest(".field")).toContainElement(line);
    expect(select.getAttribute("aria-describedby")).toContain(line.id);
    expect(line.closest("[aria-live='polite']")).not.toBeNull();
    expect(heading).toHaveFocus();
    await sendWithoutAd(u);
    expect(calls("join_ad_suggest")).toHaveLength(0);
  });

  it("domain kantor berbeda: kedua domain disebut dan didahulukan dari laptop lama; data AD tidak ikut", async () => {
    const u = user();
    commands({
      join_ad_profile: JULIUS,
      join_search: searchResult({
        offices: [{ ...MCF, adDomain: "kantorlain.co.id", acceptsAd: false, adOutdated: 3 }],
      }),
      join_send_request: outgoing(),
    });
    setup(fresh("Julius"));
    await searchUntil(u, "Kantor ditemukan: MCF");
    expect(await screen.findByTestId("onb-ad-skipped")).toHaveTextContent(
      "Domain kantor (kantorlain.co.id) berbeda dengan domain akun Anda (macf.co.id), jadi data akun Windows Anda tidak dipakai. Pilih departemen sendiri.",
    );
    expect(screen.queryByTestId("onb-ad-office-summary")).toBeNull();
    await sendWithoutAd(u);
    expect(calls("join_ad_suggest")).toHaveLength(0);
  });

  it("departemen belum dicocokkan: OU paling dalam Julius disebut, satu baris saja, data AD tetap ikut", async () => {
    const u = user();
    commands({
      join_ad_profile: JULIUS,
      join_search: searchResult({ offices: [MCF] }),
      join_ad_suggest: { teamId: null, source: null, adDepartment: JULIUS_OU, inMira: false },
      join_send_request: outgoing(),
    });
    setup(fresh("Julius"));
    await searchUntil(u, "Kantor Anda ditemukan");
    expect(await screen.findByTestId("onb-ad-skipped")).toHaveTextContent(
      `Departemen Anda di akun Windows (${JULIUS_OU}) belum dicocokkan admin dengan departemen di Mira. Pilih departemen sendiri.`,
    );
    expect(screen.getAllByTestId("onb-ad-skipped")).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/belum ada di Mira/);
    expect(screen.queryByTestId("onb-ad-dept")).toBeNull();
    expect(screen.getByLabelText("Departemen")).toHaveValue("");
    // Lokasi OU tetap terbaca utuh di kotak yang dilihat admin.
    expect(
      within(screen.getByTestId("onb-ad-box")).getByText(
        `Member Users › HO › IT & CP Department › IT-Department › ${JULIUS_OU}`,
      ),
    ).toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText("Departemen"), "IT Development");
    await u.click(screen.getByRole("button", { name: "Kirim permintaan" }));
    await waitFor(() => expect(calls("join_send_request")[0][1]).toMatchObject({ useAd: true }));
  });

  it("tanpa usulan dari inti Rust: OU paling dalam dari DN dipakai", async () => {
    const u = user();
    commands({ join_ad_profile: JULIUS, join_search: searchResult({ offices: [MCF] }), join_ad_suggest: null });
    setup(fresh("Julius"));
    await searchUntil(u, "Kantor Anda ditemukan");
    expect(await screen.findByTestId("onb-ad-skipped")).toHaveTextContent(`(${JULIUS_OU})`);
  });

  it("usulan gagal dijawab: tidak menulis belum dicocokkan", async () => {
    const u = user();
    commands({
      join_ad_profile: JULIUS,
      join_search: searchResult({ offices: [MCF] }),
      join_ad_suggest: rustError("internal", "x"),
    });
    setup(fresh("Julius"));
    await searchUntil(u, "Kantor Anda ditemukan");
    await waitFor(() => expect(calls("join_ad_suggest")).toHaveLength(1));
    await advance(10);
    expect(screen.queryByTestId("onb-ad-skipped")).toBeNull();
    expect(screen.getByTestId("onb-ad-box")).toBeInTheDocument();
  });

  it("baris yang sama tidak dipasang ulang saat orangnya mengisi formulir (diumumkan sekali)", async () => {
    const u = user();
    commands({
      join_ad_profile: JULIUS,
      join_search: searchResult({ offices: [{ ...MCF, acceptsAd: false, adOutdated: 2 }] }),
    });
    setup(fresh("Julius"));
    await searchUntil(u, "Kantor Anda ditemukan");
    const line = await screen.findByTestId("onb-ad-skipped");
    await u.type(screen.getByLabelText("Keterangan untuk admin (opsional)"), "NIK 2041");
    await u.selectOptions(screen.getByLabelText("Departemen"), "Keuangan");
    expect(screen.getByTestId("onb-ad-skipped")).toBe(line);
  });

  it("AD tidak terbaca (akun lokal, Mac): diam, walau kantor punya laptop lama", async () => {
    const u = user();
    commands({
      join_ad_profile: null,
      join_search: searchResult({ offices: [{ ...MCF, acceptsAd: false, adOutdated: 2 }] }),
    });
    setup(fresh("Julius"));
    await searchUntil(u, "Kantor ditemukan: MCF");
    await advance(10);
    expect(screen.queryByTestId("onb-ad-skipped")).toBeNull();
    expect(document.body.textContent).not.toMatch(AD_TEXT);
  });

  it("bahasa Inggris: jumlah laptop lama", async () => {
    const u = user();
    commands({
      join_outgoing: null,
      join_ad_profile: JULIUS,
      join_search: searchResult({ offices: [{ ...MCF, acceptsAd: false, adOutdated: 1 }] }),
    });
    renderInLang(() => draw(fresh("Julius")), "en");
    await screen.findByRole("heading", { name: "What's your name?" });
    await u.click(screen.getByRole("button", { name: "Continue" }));
    await advance(GRACE_MS + 500);
    await screen.findByRole("heading", { name: "Your office was found" });
    expect(await screen.findByTestId("onb-ad-skipped")).toHaveTextContent(
      "1 laptop in this office hasn't been updated to Mira 0.5 yet, so your Windows account details can't be used. Choose a department yourself.",
    );
    expect(document.body.textContent).not.toMatch(/belum|Pilih departemen/);
  });
});

describe("Onboarding: satu domain, satu kantor", () => {
  it("hanya kantor versi lama terlihat: tidak menulis belum ditemukan, dengan langkah memperbarui", async () => {
    const u = user();
    commands({
      join_search: searchResult({
        orgSeen: true,
        legacyOffices: [
          { orgId: "x".repeat(32), name: "Biro Lama", peerCount: 2 },
          { orgId: "y".repeat(32), name: null, peerCount: 1 },
        ],
      }),
    });
    setup();
    await passName(u);
    await advance(16_000);

    expect(
      await screen.findByRole("heading", { name: "Kantor ditemukan, tapi belum bisa menerima permintaan" }),
    ).toBeInTheDocument();
    // "Versi lama" hanya sekali, di judul catatan.
    expect(within(screen.getByRole("main")).getAllByText(/versi lama/)).toHaveLength(1);
    expect(screen.queryByText("Kantor belum ditemukan")).toBeNull();
    const legacy = screen.getByTestId("onb-legacy-offices");
    expect(within(legacy).getByText("Kantor dengan Mira versi lama")).toBeInTheDocument();
    expect(within(legacy).getByText("Biro Lama (2 laptop)")).toBeInTheDocument();
    expect(within(legacy).getByText("Kantor tanpa nama (1 laptop)")).toBeInTheDocument();
    expect(within(legacy).getByText(/menjalankan lagi perintah pasang Mira/)).toBeInTheDocument();
    expect(within(legacy).getByText(/minta kode undangan ke admin kantor/)).toBeInTheDocument();

    await u.click(screen.getByText("Untuk admin IT"));
    expect(screen.getByText(/Kantor yang terlihat: Biro Lama, Kantor tanpa nama\./)).toBeVisible();
    expect(screen.getByRole("button", { name: "Tetap siapkan kantor baru" })).toBeInTheDocument();
  });

  it("domain laptop sama dengan kantor yang terlihat: tanpa pilihan kantor baru, diarahkan ke kantor itu", async () => {
    const u = user();
    commands({ machine_ad_domain: "macf.co.id", join_search: searchResult({ offices: [MCF] }) });
    setup();
    await searchUntil(u, "Kantor ditemukan: MCF");
    await u.click(screen.getByRole("button", { name: "Cari dengan cara lain" }));
    await screen.findByRole("heading", { name: "Cari kantor dengan cara lain" });
    await u.click(screen.getByText("Untuk admin IT"));

    const same = screen.getByTestId("onb-same-domain");
    expect(same).toHaveTextContent(
      "Laptop ini memakai domain macf.co.id, sama dengan kantor MCF. Satu domain kantor hanya untuk satu kantor Mira, jadi minta bergabung ke kantor itu.",
    );
    expect(screen.queryByRole("button", { name: "Tetap siapkan kantor baru" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Siapkan Mira untuk kantor baru/ })).toBeNull();
    await u.click(within(same).getByRole("button", { name: "Minta bergabung ke kantor itu" }));
    expect(await screen.findByRole("heading", { name: "Kantor ditemukan: MCF" })).toHaveFocus();
  });

  it("--siapkan-kantor menemukan kantor: peringatan dulu, bergabung atau konfirmasi kantor baru", async () => {
    const u = user();
    commands({ join_setup_mode: true, join_search: searchResult({ offices: [office()] }) });
    setup();
    await passName(u);
    await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." });
    await advance(GRACE_MS + 500);

    expect(
      await screen.findByRole("heading", { name: "Periksa dulu sebelum menyiapkan kantor baru" }),
    ).toHaveFocus();
    expect(screen.getByText(/Kantor yang terlihat: Biro Contoh\./)).toBeInTheDocument();
    await u.type(screen.getByLabelText(/Ketik "kantor baru" untuk melanjutkan/), "kantor baru");
    await u.click(screen.getByRole("button", { name: "Tetap siapkan kantor baru" }));
    expect(await screen.findByRole("heading", { name: "Siapkan Mira untuk kantor baru" })).toHaveFocus();
  });

  it("--siapkan-kantor dengan kantor terlihat: Minta bergabung membuka formulir kantor", async () => {
    const u = user();
    commands({ join_setup_mode: true, join_search: searchResult({ offices: [office()] }) });
    setup();
    await passName(u);
    await advance(GRACE_MS + 500);
    await screen.findByRole("heading", { name: "Periksa dulu sebelum menyiapkan kantor baru" });
    await u.click(screen.getByRole("button", { name: "Minta bergabung ke kantor itu" }));
    expect(await screen.findByRole("heading", { name: "Kantor ditemukan: Biro Contoh" })).toHaveFocus();
  });

  it("--siapkan-kantor dengan kantor versi lama saja: daftar kantor lama dan peringatan", async () => {
    const u = user();
    commands({
      join_setup_mode: true,
      join_search: searchResult({ orgSeen: true, legacyOffices: [{ orgId: "x".repeat(32), name: "Biro Lama", peerCount: 1 }] }),
    });
    setup();
    await passName(u);
    await advance(SETUP_SEARCH_MS + 500);
    await screen.findByRole("heading", { name: "Periksa dulu sebelum menyiapkan kantor baru" });
    expect(screen.getByTestId("onb-legacy-offices")).toHaveTextContent("Biro Lama (1 laptop)");
    expect(screen.queryByRole("button", { name: "Minta bergabung ke kantor itu" })).toBeNull();
    await u.click(screen.getByRole("button", { name: "Cari dengan cara lain" }));
    expect(await screen.findByRole("heading", { name: "Cari kantor dengan cara lain" })).toBeInTheDocument();
  });
});

describe("Onboarding AD: kantor baru", () => {
  async function openNewOffice(u: ReturnType<typeof user>) {
    await passName(u);
    await advance(16_000);
    await screen.findByRole("heading", { name: "Kantor belum ditemukan" });
    await u.click(screen.getByText("Untuk admin IT"));
    await u.click(screen.getByRole("button", { name: "Siapkan Mira untuk kantor baru" }));
    await screen.findByRole("heading", { name: "Siapkan Mira untuk kantor baru" });
  }

  it("domain PC mengisi nama organisasi dan domain AD, lalu diteruskan ke create_organization", async () => {
    const u = user();
    commands({
      machine_ad_domain: "MACF.co.id",
      join_search: searchResult(),
      create_organization: org,
      org_create_department: { id: "t-man", name: "Manajemen", createdAt: "", archived: false, archivedAt: null, memberCount: 0 },
      org_move_member: null,
    });
    setup();
    await openNewOffice(u);

    const domain = screen.getByLabelText("Domain Active Directory (opsional)");
    await waitFor(() => expect(domain).toHaveValue("macf.co.id"));
    expect(screen.getByLabelText("Nama organisasi")).toHaveValue("macf.co.id");
    expect(screen.getByTestId("onb-new-office-domain-source")).toHaveTextContent(
      "Diisi dari domain kantor. Ganti dengan nama yang dikenal rekan, misalnya MACF.",
    );
    expect(screen.getByText(/mengenali laptop kantor dan mengisi nama serta departemen orang baru/)).toBeInTheDocument();

    await u.clear(screen.getByLabelText("Nama organisasi"));
    await u.type(screen.getByLabelText("Nama organisasi"), "MCF");
    expect(screen.queryByTestId("onb-new-office-domain-source")).toBeNull();
    await u.type(screen.getByLabelText("Departemen Anda"), "Manajemen");
    await u.type(screen.getByLabelText("Ketik ulang nama organisasi"), "MCF");
    await u.click(screen.getByRole("button", { name: "Buat organisasi" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_organization", { name: "MCF", adDomain: "macf.co.id" }));
  });

  it("domain dari akun Windows dipakai, domain yang salah ditolak, kosong berarti null", async () => {
    const u = user();
    commands({ join_ad_profile: AD, join_search: searchResult(), create_organization: org });
    setup();
    await openNewOffice(u);
    const domain = screen.getByLabelText("Domain Active Directory (opsional)");
    expect(domain).toHaveValue("macf.co.id");
    expect(screen.getByLabelText("Nama organisasi")).toHaveValue("macf.co.id");

    await u.clear(domain);
    await u.type(domain, "macf\\rina");
    await u.type(screen.getByLabelText("Departemen Anda"), "Manajemen");
    await u.type(screen.getByLabelText("Ketik ulang nama organisasi"), "macf.co.id");
    await u.click(screen.getByRole("button", { name: "Buat organisasi" }));
    expect(await screen.findByText("Tulis domain seperti kantor.co.id, tanpa spasi atau garis miring.")).toBeInTheDocument();
    expect(domain).toHaveFocus();
    expect(calls("create_organization")).toHaveLength(0);

    await u.clear(domain);
    await u.click(screen.getByRole("button", { name: "Buat organisasi" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("create_organization", { name: "macf.co.id", adDomain: null }),
    );
  });

  it("Rust menolak kantor kedua untuk domain yang sama: pesannya tampil", async () => {
    const u = user();
    commands({
      join_search: searchResult(),
      create_organization: rustError("invalid_input", "Sudah ada kantor Mira untuk domain macf.co.id."),
    });
    setup();
    await openNewOffice(u);
    await u.type(screen.getByLabelText("Nama organisasi"), "MCF");
    await u.type(screen.getByLabelText("Departemen Anda"), "Manajemen");
    await u.type(screen.getByLabelText("Ketik ulang nama organisasi"), "MCF");
    await u.click(screen.getByRole("button", { name: "Buat organisasi" }));
    expect(await screen.findByText("Organisasi belum dibuat")).toBeInTheDocument();
    expect(screen.getByText("Sudah ada kantor Mira untuk domain macf.co.id.")).toBeInTheDocument();
  });
});

describe("Onboarding AD: bahasa Inggris", () => {
  it("nama, kantor, departemen, dan kotak yang dikirim dalam bahasa Inggris", async () => {
    const u = user();
    commands({
      join_outgoing: null,
      join_ad_profile: { ...AD, complete: false },
      join_search: searchResult({ offices: [OTHER, MCF] }),
      join_ad_suggest: SUGGEST,
    });
    renderInLang(() => draw(fresh(null)), "en");

    expect(await screen.findByText("Filled in from your Windows account (macf.co.id). Change it if needed.")).toBeInTheDocument();
    commands({
      join_outgoing: null,
      join_ad_profile: { ...AD, complete: false },
      join_search: searchResult({ offices: [OTHER, MCF] }),
      join_ad_suggest: SUGGEST,
      save_display_name: { ...fresh().identity, displayName: "Rina Wijaya" },
    });
    await u.click(screen.getByRole("button", { name: "Continue" }));
    await advance(GRACE_MS + 500);
    await screen.findByRole("heading", { name: "Your office was found" });

    expect(screen.getByTestId("onb-ad-office-summary")).toHaveTextContent("Office: MCF (macf.co.id)");
    expect(screen.getByRole("button", { name: "Change office" })).toBeInTheDocument();
    expect(await screen.findByText("From your Windows account: Keuangan")).toBeInTheDocument();
    const box = screen.getByTestId("onb-ad-box");
    expect(within(box).getByText("What the admin sees")).toBeInTheDocument();
    expect(within(box).getByText("Windows account")).toBeInTheDocument();
    expect(within(box).getByText("Location in Active Directory")).toBeInTheDocument();
    expect(within(box).getByTestId("onb-ad-partial")).toHaveTextContent(
      "Some Windows account details couldn't be read because the office server is out of reach. The admin will check them again.",
    );
    expect(document.body.textContent).not.toMatch(/Diisi dari|Yang dilihat|Akun Windows|Lokasi di|Dari akun/);
  });
});
