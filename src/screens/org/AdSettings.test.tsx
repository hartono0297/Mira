import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdSettingsView, OuMapping } from "../../api/org";
import { setLang } from "../../i18n/core";
import { router } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import { adSettings, department, overview, TEAM_1, TEAM_2, TEAM_3 } from "../../test/orgFixtures";
import { AD_MAX_ROWS, AdSettings, validateRows } from "./AdSettings";
import type { OrgPage } from "./context";
import { DepartmentsPanel } from "./DepartmentsPanel";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const DEPTS = [
  department(TEAM_1, "Desain"),
  department(TEAM_2, "Keuangan"),
  department(TEAM_3, "Lanskap", { archived: true, archivedAt: "2026-11-02T03:00:00Z" }),
];

function page(extra: Partial<OrgPage> = {}): OrgPage {
  return {
    overview: overview(),
    act: vi.fn(async () => true),
    pending: null,
    notify: vi.fn(),
    version: 0,
    refresh: vi.fn(),
    isMe: () => false,
    ...extra,
  };
}

function calls(cmd: string) {
  return invoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
}

function setup(view: AdSettingsView, extra: Record<string, unknown> = {}, p: OrgPage = page()) {
  invoke.mockImplementation(router({ org_ad_settings: () => view, ...(extra as Record<string, never>) }));
  render(<AdSettings page={p} departments={DEPTS} />);
  return { user: userEvent.setup(), page: p };
}

const ouInput = (n: number) => screen.getByRole("textbox", { name: `Nama OU baris ${n}` });
const deptSelect = (n: number) => screen.getByRole("combobox", { name: `Departemen baris ${n}` });

const MAP: OuMapping[] = [
  { ou: "Finance", team: TEAM_2 },
  { ou: "Studio", team: TEAM_1 },
];

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

afterEach(() => {
  setLang("id");
});

describe("Pengaturan Active Directory: memuat", () => {
  it("menampilkan domain, pemetaan, dan urutan pencocokan", async () => {
    setup(adSettings({ domain: "kantor-uji.test", ouMap: MAP }));
    expect(await screen.findByRole("textbox", { name: "Domain AD" })).toHaveValue("kantor-uji.test");
    expect(screen.getByRole("heading", { name: "Active Directory", level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pemetaan OU ke departemen", level: 4 })).toBeInTheDocument();
    expect(screen.getByText(/Mira memakai atribut department di AD lebih dulu/)).toBeInTheDocument();
    expect(screen.getByText(/Departemen tidak dibuat otomatis/)).toBeInTheDocument();
    expect(ouInput(1)).toHaveValue("Finance");
    expect(deptSelect(1)).toHaveValue(TEAM_2);
    expect(ouInput(2)).toHaveValue("Studio");
    expect(deptSelect(2)).toHaveValue(TEAM_1);
    // Pilihan hanya departemen terbuka.
    const options = within(deptSelect(1)).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Pilih departemen", "Desain", "Keuangan"]);
    expect(screen.queryByRole("button", { name: /Pakai domain laptop ini/ })).not.toBeInTheDocument();
  });

  it("memuat, lalu galat dengan Coba lagi", async () => {
    let fail = true;
    invoke.mockImplementation(
      router({
        org_ad_settings: () => {
          if (fail) throw { code: "db", message: "Basis data terkunci." };
          return adSettings({ domain: "kantor-uji.test" });
        },
      }),
    );
    render(<AdSettings page={page()} departments={DEPTS} />);
    expect(screen.getByText("Memuat pengaturan Active Directory...")).toBeInTheDocument();
    expect(await screen.findByText("Pengaturan Active Directory belum terbaca")).toBeInTheDocument();
    expect(screen.getByText("Basis data terkunci.")).toBeInTheDocument();
    fail = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByRole("textbox", { name: "Domain AD" })).toHaveValue("kantor-uji.test");
  });

  it("pemetaan ke departemen yang diarsipkan tetap terlihat sebagai diarsipkan", async () => {
    setup(adSettings({ ouMap: [{ ou: "Taman", team: TEAM_3 }] }));
    await screen.findByRole("textbox", { name: "Domain AD" });
    expect(deptSelect(1)).toHaveValue(TEAM_3);
    expect(within(deptSelect(1)).getByRole("option", { name: "Lanskap (diarsipkan)" })).toBeInTheDocument();
  });

  it("tanpa pemetaan menampilkan keterangan kosong", async () => {
    setup(adSettings());
    expect(await screen.findByText(/Belum ada pemetaan/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("tampil di tab Departemen untuk superadmin", async () => {
    invoke.mockImplementation(
      router({ org_departments: DEPTS, org_people: [], org_ad_settings: adSettings({ domain: "kantor-uji.test" }) }),
    );
    render(<DepartmentsPanel page={page()} />);
    const section = await screen.findByTestId("ad-settings");
    expect(await within(section).findByRole("textbox", { name: "Domain AD" })).toHaveValue("kantor-uji.test");
  });
});

describe("Pengaturan Active Directory: mengubah dan menyimpan", () => {
  it("ubah domain lalu simpan memanggil setAdSettings dengan argumen yang dirapikan", async () => {
    const { user, page: p } = setup(adSettings({ domain: "kantor-uji.test", ouMap: MAP }), { org_set_ad_settings: null });
    const domain = await screen.findByRole("textbox", { name: "Domain AD" });
    await user.clear(domain);
    await user.type(domain, "  cabang-uji.test ");
    await user.clear(ouInput(2));
    await user.type(ouInput(2), " Studio Baru ");
    await user.click(screen.getByRole("button", { name: "Simpan pengaturan AD" }));
    await waitFor(() =>
      expect(calls("org_set_ad_settings")).toEqual([
        {
          domain: "cabang-uji.test",
          ouMap: [
            { ou: "Finance", team: TEAM_2 },
            { ou: "Studio Baru", team: TEAM_1 },
          ],
        },
      ]),
    );
    expect(p.notify).toHaveBeenCalledWith("Pengaturan Active Directory disimpan.");
    expect(p.refresh).toHaveBeenCalled();
  });

  it("Pakai domain laptop ini mengisi domain dan memindahkan fokus ke isian", async () => {
    const { user } = setup(adSettings({ domain: null, machineDomain: "kantor-uji.test" }));
    const button = await screen.findByRole("button", { name: "Pakai domain laptop ini: kantor-uji.test" });
    await user.click(button);
    const domain = screen.getByRole("textbox", { name: "Domain AD" });
    expect(domain).toHaveValue("kantor-uji.test");
    expect(domain).toHaveFocus();
    expect(screen.queryByRole("button", { name: /Pakai domain laptop ini/ })).not.toBeInTheDocument();
  });

  it("tombol domain laptop tidak tampil kalau sama (tanpa beda huruf besar)", async () => {
    setup(adSettings({ domain: "kantor-uji.test", machineDomain: "KANTOR-UJI.test" }));
    await screen.findByRole("textbox", { name: "Domain AD" });
    expect(screen.queryByRole("button", { name: /Pakai domain laptop ini/ })).not.toBeInTheDocument();
  });

  it("Tambah baris memfokuskan isian OU baru; Hapus memindahkan fokus ke baris berikutnya", async () => {
    const { user } = setup(adSettings({ ouMap: MAP }), { org_set_ad_settings: null });
    await screen.findByRole("textbox", { name: "Domain AD" });
    await user.click(screen.getByRole("button", { name: "Tambah baris" }));
    expect(ouInput(3)).toHaveFocus();
    await user.type(ouInput(3), "Arsip");
    await user.selectOptions(deptSelect(3), "Desain");

    await user.click(screen.getByRole("button", { name: "Hapus baris 1" }));
    expect(ouInput(1)).toHaveValue("Studio");
    expect(ouInput(1)).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: "Nama OU baris 3" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Simpan pengaturan AD" }));
    await waitFor(() =>
      expect(calls("org_set_ad_settings")).toEqual([
        {
          domain: "",
          ouMap: [
            { ou: "Studio", team: TEAM_1 },
            { ou: "Arsip", team: TEAM_1 },
          ],
        },
      ]),
    );
  });

  it("menghapus baris terakhir memindahkan fokus ke Tambah baris", async () => {
    const { user } = setup(adSettings({ ouMap: [MAP[0]] }));
    await screen.findByRole("textbox", { name: "Domain AD" });
    await user.click(screen.getByRole("button", { name: "Hapus baris 1" }));
    expect(screen.getByRole("button", { name: "Tambah baris" })).toHaveFocus();
    expect(screen.getByText(/Belum ada pemetaan/)).toBeInTheDocument();
  });

  it("validasi: OU kosong, OU kembar tanpa beda huruf besar, departemen belum dipilih", async () => {
    const { user } = setup(adSettings({ ouMap: [MAP[0]] }), { org_set_ad_settings: null });
    await screen.findByRole("textbox", { name: "Domain AD" });
    await user.click(screen.getByRole("button", { name: "Tambah baris" }));
    await user.click(screen.getByRole("button", { name: "Tambah baris" }));
    await user.type(ouInput(3), "FINANCE");
    await user.click(screen.getByRole("button", { name: "Simpan pengaturan AD" }));

    expect(calls("org_set_ad_settings")).toHaveLength(0);
    expect(ouInput(2)).toHaveAttribute("aria-invalid", "true");
    expect(ouInput(2)).toHaveAccessibleDescription("Isi nama OU.");
    expect(ouInput(2)).toHaveFocus();
    expect(ouInput(3)).toHaveAccessibleDescription("OU ini sudah ada di baris 1.");
    expect(deptSelect(2)).toHaveAccessibleDescription("Pilih departemen.");
    expect(deptSelect(3)).toHaveAccessibleDescription("Pilih departemen.");
    expect(ouInput(1)).not.toHaveAttribute("aria-invalid");
    expect(screen.getByText("Periksa isian yang ditandai, lalu simpan lagi.")).toBeInTheDocument();

    // Pesan hilang setelah isian dibetulkan.
    await user.type(ouInput(2), "Gudang");
    expect(ouInput(2)).not.toHaveAttribute("aria-invalid");
  });

  it("validasi domain: pesan di bawah isian, fokus ke isian, tidak menyimpan", async () => {
    const { user } = setup(adSettings({ domain: "kantor-uji.test" }), { org_set_ad_settings: null });
    const domain = await screen.findByRole("textbox", { name: "Domain AD" });
    await user.clear(domain);
    await user.type(domain, "kantor uji/test");
    await user.click(screen.getByRole("button", { name: "Simpan pengaturan AD" }));
    expect(calls("org_set_ad_settings")).toHaveLength(0);
    expect(domain).toHaveAttribute("aria-invalid", "true");
    expect(domain).toHaveAccessibleDescription(/Tulis domain seperti kantor\.co\.id, tanpa spasi atau garis miring\./);
    expect(domain).toHaveFocus();

    // Dibetulkan: pesan hilang, domain dirapikan (huruf kecil, tanpa titik di akhir) sebelum dikirim.
    await user.clear(domain);
    expect(domain).not.toHaveAttribute("aria-invalid");
    await user.type(domain, "Kantor-Uji.TEST.");
    await user.click(screen.getByRole("button", { name: "Simpan pengaturan AD" }));
    await waitFor(() => expect(calls("org_set_ad_settings")).toEqual([{ domain: "kantor-uji.test", ouMap: [] }]));
  });

  it("domain kosong boleh: kantor tidak memakai AD", async () => {
    const { user } = setup(adSettings({ domain: "kantor-uji.test" }), { org_set_ad_settings: null });
    const domain = await screen.findByRole("textbox", { name: "Domain AD" });
    await user.clear(domain);
    await user.click(screen.getByRole("button", { name: "Simpan pengaturan AD" }));
    await waitFor(() => expect(calls("org_set_ad_settings")).toEqual([{ domain: "", ouMap: [] }]));
  });

  it("validateRows membandingkan OU tanpa beda huruf besar dan setelah dirapikan", () => {
    expect(
      validateRows([
        { ou: "Finance", team: TEAM_1 },
        { ou: " finance ", team: TEAM_1 },
        { ou: "  ", team: "" },
      ]),
    ).toEqual(
      new Map([
        [1, { ou: { kind: "duplicate", row: 1 } }],
        [2, { ou: { kind: "empty" }, team: true }],
      ]),
    );
  });

  it("galat dari inti Rust tampil di dekat tombol Simpan", async () => {
    const { user } = setup(adSettings({ domain: "kantor-uji.test" }), {
      org_set_ad_settings: () => {
        throw { code: "invalid_input", message: "Domain AD tidak sah." };
      },
    });
    await screen.findByRole("textbox", { name: "Domain AD" });
    await user.click(screen.getByRole("button", { name: "Simpan pengaturan AD" }));
    expect(await screen.findByText("Pengaturan AD belum disimpan")).toBeInTheDocument();
    expect(screen.getByText("Domain AD tidak sah.")).toBeInTheDocument();
  });

  it(`paling banyak ${AD_MAX_ROWS} baris`, async () => {
    const full = Array.from({ length: AD_MAX_ROWS }, (_, i) => ({ ou: `OU ${i}`, team: TEAM_1 }));
    setup(adSettings({ ouMap: full }));
    // Kueri peran di 100 baris lambat; cukup cari teks tombolnya.
    const add = (await screen.findByText("Tambah baris")).closest("button") as HTMLButtonElement;
    expect(screen.getAllByDisplayValue(/^OU \d+$/)).toHaveLength(AD_MAX_ROWS);
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription("Paling banyak 100 baris.");
  }, 15000);
});

describe("Pengaturan Active Directory: belum bisa diubah", () => {
  it("allowed false: form nonaktif dengan daftar laptop yang belum siap", async () => {
    setup(
      adSettings({
        domain: "kantor-uji.test",
        ouMap: MAP,
        allowed: false,
        machineDomain: "lain-uji.test",
        outdated: [
          { name: "Bayu", appVersion: "0.4.0" },
          { name: "Citra", appVersion: null },
        ],
      }),
    );
    const blocked = await screen.findByTestId("ad-settings-blocked");
    expect(blocked).toHaveTextContent("Pengaturan AD belum bisa diubah");
    const items = within(blocked).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["Bayu, versi 0.4.0", "Citra, versi belum dilaporkan"]);
    expect(screen.getByRole("textbox", { name: "Domain AD" })).toBeDisabled();
    expect(ouInput(1)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Simpan pengaturan AD" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Tambah baris" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Pakai domain laptop ini/ })).not.toBeInTheDocument();
  });

  it("bukan superadmin: hanya bisa dibaca", async () => {
    setup(adSettings({ domain: "kantor-uji.test", canEdit: false }));
    expect(await screen.findByText("Hanya superadmin yang bisa mengubah pengaturan ini.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Domain AD" })).toBeDisabled();
  });

  it("muat ulang berkala dengan isi sama tidak membuang ketikan", async () => {
    let view = adSettings({ domain: "kantor-uji.test", ouMap: MAP });
    invoke.mockImplementation(router({ org_ad_settings: () => view }));
    const { rerender } = render(<AdSettings page={page()} departments={DEPTS} />);
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Domain AD" });
    await user.type(ouInput(1), " Pusat");
    view = adSettings({ domain: "lain-uji.test", ouMap: [] });
    rerender(<AdSettings page={page({ version: 1 })} departments={DEPTS} />);
    await waitFor(() => expect(calls("org_ad_settings").length).toBeGreaterThan(1));
    expect(ouInput(1)).toHaveValue("Finance Pusat");
  });
});

describe("Pengaturan Active Directory dalam bahasa Inggris", () => {
  it("menulis judul, label, validasi, dan daftar laptop dalam bahasa Inggris", async () => {
    invoke.mockImplementation(
      router({
        org_ad_settings: adSettings({
          ouMap: [{ ou: "", team: "" }],
          machineDomain: "kantor-uji.test",
        }),
      }),
    );
    renderInLang(() => <AdSettings page={page()} departments={DEPTS} />, "en");
    const user = userEvent.setup();
    expect(await screen.findByRole("textbox", { name: "AD domain" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "OU to department mapping" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use this laptop's domain: kantor-uji.test" })).toBeInTheDocument();
    expect(screen.getByText(/Departments are never created automatically/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save AD settings" }));
    const ou = screen.getByRole("textbox", { name: "OU name, row 1" });
    expect(ou).toHaveAccessibleDescription("Enter an OU name.");
    expect(screen.getByRole("combobox", { name: "Department, row 1" })).toHaveAccessibleDescription(
      "Choose a department.",
    );
    expect(screen.getByRole("button", { name: "Remove row 1" })).toBeInTheDocument();
    expect(screen.queryByText(/Simpan|Pilih|baris|Tambah/)).not.toBeInTheDocument();
  });

  it("daftar laptop yang belum siap dalam bahasa Inggris", async () => {
    invoke.mockImplementation(
      router({ org_ad_settings: adSettings({ allowed: false, outdated: [{ name: "Bayu", appVersion: null }] }) }),
    );
    renderInLang(() => <AdSettings page={page()} departments={DEPTS} />, "en");
    const blocked = await screen.findByTestId("ad-settings-blocked");
    expect(blocked).toHaveTextContent("AD settings can't be changed yet");
    expect(blocked).toHaveTextContent("Bayu, version not reported yet");
  });
});
