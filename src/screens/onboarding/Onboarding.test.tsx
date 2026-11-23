import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../../api";
import { appState, firewall, org, router, rustError } from "../../test/fixtures";
import { ThemeProvider } from "../../theme/ThemeProvider";
import { device, office, outgoing, searchResult } from "./joinFixtures";
import { Onboarding } from "./Onboarding";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const NEW_OFFICE = /Siapkan Mira untuk kantor baru/;

function fresh(displayName: string | null = "Penguji"): AppState {
  const base = appState({ organization: null, membership: "none" });
  return { ...base, identity: { ...base.identity, displayName } };
}

function setup(state: AppState = fresh()) {
  const onOrganization = vi.fn();
  const onIdentity = vi.fn();
  render(
    <ThemeProvider>
      <Onboarding state={state} onIdentity={onIdentity} onOrganization={onOrganization} onReload={vi.fn()} />
    </ThemeProvider>,
  );
  return { onOrganization, onIdentity };
}

function commands(table: Parameters<typeof router>[0]) {
  invoke.mockImplementation(
    router({ get_firewall_status: firewall({ rule: "allowed" }), join_device: device, ...table }),
  );
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function calls(cmd: string) {
  return invoke.mock.calls.filter(([c]) => c === cmd);
}

function user() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

// Langkah 1 (firewall), lalu mulai mencari.
async function startSearch(u: ReturnType<typeof user>) {
  expect(await screen.findByRole("heading", { name: "Izinkan Mira di jaringan kantor" })).toBeInTheDocument();
  expect(screen.getByText("Langkah 1 dari 3")).toBeInTheDocument();
  await u.click(await screen.findByRole("button", { name: "Cari kantor" }));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Onboarding: melanjutkan permintaan yang tersimpan", () => {
  it("permintaan menunggu: langsung ke layar menunggu tanpa langkah firewall", async () => {
    commands({ join_outgoing: outgoing(), join_poll: { status: "pending", request: outgoing() } });
    setup();

    expect(await screen.findByRole("heading", { name: "Menunggu persetujuan" })).toBeInTheDocument();
    expect(screen.getByText("Langkah 3 dari 3")).toBeInTheDocument();
    expect(screen.getByText("4F2A 91C0")).toBeInTheDocument();
    expect(screen.getByText("7KQ2-M9XD")).toBeInTheDocument();
    expect(await screen.findByText("LAPTOP-DESAIN-03")).toBeInTheDocument();
    expect(screen.getByText(/admin departemen Desain/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Izinkan Mira di jaringan kantor" })).not.toBeInTheDocument();
  });

  it("permintaan ditolak: nama penolak dan waktunya", async () => {
    commands({
      join_outgoing: outgoing({ status: "rejected", decidedByName: "Andi", decidedAt: "2026-11-23T12:00:00Z" }),
    });
    setup();

    expect(await screen.findByRole("heading", { name: "Permintaan ditolak" })).toBeInTheDocument();
    expect(screen.getByText(/Andi menolak permintaan Anda untuk bergabung ke Biro Contoh/)).toBeInTheDocument();
    expect(screen.getByText(/23 November 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/Langkah \d dari 3/)).not.toBeInTheDocument();
  });

  it("pesan pengiriman yang gagal tampil sebagai keterangan, bukan error", async () => {
    const req = outgoing({ lastSentAt: null, lastError: "Belum ada laptop anggota yang bisa dihubungi." });
    commands({ join_outgoing: req, join_poll: { status: "pending", request: req } });
    setup();

    expect(await screen.findByText("Belum ada laptop rekan yang menerima permintaan ini")).toBeInTheDocument();
    expect(screen.getByText("Belum ada laptop anggota yang bisa dihubungi.")).toBeInTheDocument();
    expect(document.querySelector(".alert")).toBeNull();
  });
});

describe("Onboarding: kantor ditemukan", () => {
  it("cari, isi departemen, kirim permintaan, lalu layar menunggu dengan kode cocok", async () => {
    const u = user();
    commands({
      join_search: searchResult({ offices: [office()] }),
      join_send_request: outgoing({ displayName: "Penguji" }),
      join_poll: { status: "pending", request: outgoing() },
    });
    setup();
    await startSearch(u);

    const heading = await screen.findByRole("heading", { name: "Kantor ditemukan: Biro Contoh" });
    expect(heading).toHaveFocus();
    expect(screen.getByText("Langkah 2 dari 3")).toBeInTheDocument();
    expect(screen.getByText("7KQ2-M9XD")).toBeInTheDocument();
    expect(screen.getByLabelText("Nama tampilan")).toHaveValue("Penguji");
    expect(screen.queryByText(NEW_OFFICE)).not.toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: "Minta bergabung" }));
    expect(await screen.findByText("Pilih departemen Anda dulu.")).toBeInTheDocument();
    expect(calls("join_send_request")).toHaveLength(0);

    await u.selectOptions(screen.getByLabelText("Departemen"), "Desain");
    await u.click(screen.getByRole("button", { name: "Minta bergabung" }));

    expect(await screen.findByRole("heading", { name: "Menunggu persetujuan" })).toHaveFocus();
    expect(invoke).toHaveBeenCalledWith("join_send_request", { officeKey: "org-biro:fp1", teamId: "t-des" });
    expect(calls("save_display_name")).toHaveLength(0);
    expect(screen.getByText("4F2A 91C0")).toBeInTheDocument();
    expect(screen.getByText("7KQ2-M9XD")).toBeInTheDocument();
    expect(screen.getByText("Langkah 3 dari 3")).toBeInTheDocument();
  });

  it("nama belum ada: disimpan dulu, baru permintaan dikirim", async () => {
    const u = user();
    const saved = { ...fresh().identity, displayName: "Rina" };
    commands({
      join_search: searchResult({ offices: [office()] }),
      save_display_name: saved,
      join_send_request: outgoing(),
    });
    const { onIdentity } = setup(fresh(null));
    await startSearch(u);

    await screen.findByRole("heading", { name: "Kantor ditemukan: Biro Contoh" });
    expect(screen.getByLabelText("Nama tampilan")).toHaveValue("");
    await u.selectOptions(screen.getByLabelText("Departemen"), "Desain");
    await u.click(screen.getByRole("button", { name: "Minta bergabung" }));
    expect(await screen.findByText("Isi nama tampilan dulu.")).toBeInTheDocument();
    expect(screen.getByLabelText("Nama tampilan")).toHaveFocus();

    await u.type(screen.getByLabelText("Nama tampilan"), "  Rina ");
    await u.click(screen.getByRole("button", { name: "Minta bergabung" }));

    await screen.findByRole("heading", { name: "Menunggu persetujuan" });
    const order = invoke.mock.calls.map(([c]) => c).filter((c) => c === "save_display_name" || c === "join_send_request");
    expect(order).toEqual(["save_display_name", "join_send_request"]);
    expect(invoke).toHaveBeenCalledWith("save_display_name", { name: "Rina" });
    expect(onIdentity).toHaveBeenCalledWith(saved);
  });

  it("disetujui: onOrganization dipanggil dari polling 5 detik", async () => {
    const u = user();
    let approved = false;
    commands({
      join_search: searchResult({ offices: [office()] }),
      join_send_request: outgoing(),
      join_poll: () => (approved ? { status: "approved", org } : { status: "pending", request: outgoing() }),
    });
    const { onOrganization } = setup();
    await startSearch(u);
    await screen.findByRole("heading", { name: "Kantor ditemukan: Biro Contoh" });
    await u.selectOptions(screen.getByLabelText("Departemen"), "Desain");
    await u.click(screen.getByRole("button", { name: "Minta bergabung" }));
    await screen.findByRole("heading", { name: "Menunggu persetujuan" });

    await advance(5000);
    expect(calls("join_poll")).toHaveLength(1);
    expect(onOrganization).not.toHaveBeenCalled();

    approved = true;
    await advance(5000);
    expect(onOrganization).toHaveBeenCalledWith(org);
  });

  it("ditolak lalu kirim lagi: layar menunggu dengan kode baru", async () => {
    const u = user();
    const rejected = outgoing({ status: "rejected", decidedByName: "Andi", decidedAt: "2026-11-23T12:00:00Z" });
    commands({
      join_outgoing: outgoing(),
      join_poll: { status: "rejected", request: rejected },
      join_resend: outgoing({ requestId: "req-2", code: "9ZZK 0B1T" }),
    });
    setup();
    await screen.findByRole("heading", { name: "Menunggu persetujuan" });

    await advance(5000);
    expect(await screen.findByRole("heading", { name: "Permintaan ditolak" })).toHaveFocus();
    expect(screen.getByText(/Andi menolak/)).toBeInTheDocument();

    invoke.mockImplementation(
      router({
        join_device: device,
        join_resend: outgoing({ requestId: "req-2", code: "9ZZK 0B1T" }),
        join_poll: { status: "pending", request: outgoing({ requestId: "req-2", code: "9ZZK 0B1T" }) },
      }),
    );
    await u.click(screen.getByRole("button", { name: "Kirim permintaan lagi" }));
    expect(await screen.findByRole("heading", { name: "Menunggu persetujuan" })).toBeInTheDocument();
    expect(screen.getByText("9ZZK 0B1T")).toBeInTheDocument();
    expect(screen.queryByText("4F2A 91C0")).not.toBeInTheDocument();
  });

  it("ditolak lalu cari kantor lain: permintaan dibatalkan dan pencarian mulai", async () => {
    const u = user();
    commands({
      join_outgoing: outgoing({ status: "rejected", decidedByName: "Andi" }),
      join_cancel: null,
      join_search: searchResult(),
    });
    setup();
    await u.click(await screen.findByRole("button", { name: "Cari kantor lain" }));
    expect(await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." })).toBeInTheDocument();
    expect(calls("join_cancel")).toHaveLength(1);
  });

  it("batalkan permintaan dari layar menunggu: kembali mencari", async () => {
    const u = user();
    commands({ join_outgoing: outgoing(), join_cancel: null, join_search: searchResult() });
    setup();
    await u.click(await screen.findByRole("button", { name: "Batalkan permintaan" }));
    expect(await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." })).toHaveFocus();
    expect(calls("join_cancel")).toHaveLength(1);
  });

  it("kantor kembar dengan identitas bentrok: peringatan dan tombol kirim mati", async () => {
    const u = user();
    commands({
      join_search: searchResult({
        offices: [
          office({ key: "a", fingerprint: "AAAA-1111", conflict: true }),
          office({ key: "b", fingerprint: "BBBB-2222", conflict: true }),
        ],
      }),
    });
    setup();
    await startSearch(u);

    expect(await screen.findByRole("heading", { name: "Beberapa kantor ditemukan" })).toBeInTheDocument();
    expect(screen.getByText("Ada dua kantor dengan nama atau identitas yang sama")).toBeInTheDocument();
    expect(screen.getByText("AAAA-1111")).toBeInTheDocument();
    expect(screen.getByText("BBBB-2222")).toBeInTheDocument();

    await u.click(screen.getAllByRole("radio")[0]);
    expect(screen.getByRole("button", { name: "Minta bergabung" })).toBeDisabled();
    expect(screen.getByText(/Permintaan ke kantor ini dimatikan/)).toBeInTheDocument();
  });

  it("beberapa kantor bernama sama: pilih kantor dulu, lalu kirim ke kantor itu", async () => {
    const u = user();
    commands({
      join_search: searchResult({
        offices: [office({ key: "a", sameName: true }), office({ key: "b", fingerprint: "ZZZZ-9999", sameName: true })],
      }),
      join_send_request: outgoing(),
    });
    setup();
    await startSearch(u);
    await screen.findByRole("heading", { name: "Beberapa kantor ditemukan" });
    expect(screen.getByText("Ada dua kantor dengan nama atau identitas yang sama")).toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: "Minta bergabung" }));
    expect(await screen.findByText("Pilih kantor Anda dulu.")).toBeInTheDocument();

    const second = screen.getAllByRole("radio")[1];
    await u.click(second);
    await u.selectOptions(screen.getByLabelText("Departemen"), "Administrasi");
    await u.click(screen.getByRole("button", { name: "Minta bergabung" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("join_send_request", { officeKey: "b", teamId: "t-adm" }));
  });

  it("kantor tanpa departemen: menjelaskan dan tidak bisa mengirim", async () => {
    const u = user();
    commands({ join_search: searchResult({ offices: [office({ departments: [] })] }) });
    setup();
    await startSearch(u);
    await screen.findByRole("heading", { name: "Kantor ditemukan: Biro Contoh" });
    expect(screen.getByText("Kantor ini belum punya departemen")).toBeInTheDocument();
    expect(screen.queryByLabelText("Departemen")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Minta bergabung" })).toBeDisabled();
  });

  it("kirim gagal: pesan dari inti tampil", async () => {
    const u = user();
    commands({
      join_search: searchResult({ offices: [office()] }),
      join_send_request: rustError("busy", "Laptop anggota sedang sibuk. Coba lagi sebentar lagi."),
    });
    setup();
    await startSearch(u);
    await screen.findByRole("heading", { name: "Kantor ditemukan: Biro Contoh" });
    await u.selectOptions(screen.getByLabelText("Departemen"), "Desain");
    await u.click(screen.getByRole("button", { name: "Minta bergabung" }));
    expect(await screen.findByText("Permintaan belum terkirim")).toBeInTheDocument();
    expect(screen.getByText(/sedang sibuk/)).toBeInTheDocument();
  });
});

describe("Onboarding: kantor belum ditemukan", () => {
  it("15 detik tanpa kantor dan tanpa pengumuman: cara lain plus tautan kantor baru", async () => {
    const u = user();
    let inflight = 0;
    let overlap = false;
    commands({
      join_search: async () => {
        inflight += 1;
        if (inflight > 1) overlap = true;
        await new Promise((r) => setTimeout(r, 300));
        inflight -= 1;
        return searchResult();
      },
    });
    setup();
    await startSearch(u);

    expect(await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." })).toHaveFocus();
    expect(screen.getByText("Pencarian berhenti sendiri setelah 15 detik.")).toBeInTheDocument();
    expect(await screen.findByText("LAPTOP-DESAIN-03")).toBeInTheDocument();
    expect(screen.getByText("192.168.1.23")).toBeInTheDocument();

    await advance(14_000);
    expect(screen.getByRole("heading", { name: "Mencari kantor di jaringan..." })).toBeInTheDocument();
    await advance(1_500);

    expect(await screen.findByRole("heading", { name: "Kantor belum ditemukan" })).toHaveFocus();
    expect(screen.getByText(/lewat VPN/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Siapkan Mira untuk kantor baru (khusus superadmin)" })).toBeInTheDocument();
    expect(screen.queryByText(/Langkah \d dari 3/)).not.toBeInTheDocument();
    expect(overlap).toBe(false);
    expect(calls("join_search").length).toBeGreaterThan(3);
  });

  it("ada pengumuman organisasi (orgSeen): tanpa tautan kantor baru", async () => {
    const u = user();
    commands({ join_search: searchResult({ orgSeen: true }) });
    setup();
    await startSearch(u);
    await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." });
    await advance(16_000);

    expect(await screen.findByRole("heading", { name: "Kantor belum ditemukan" })).toBeInTheDocument();
    expect(screen.queryByText(NEW_OFFICE)).not.toBeInTheDocument();
  });

  it("kantor pernah ditemukan: kantor baru tidak pernah muncul, juga setelah cari lagi", async () => {
    const u = user();
    let found = true;
    commands({ join_search: () => searchResult({ offices: found ? [office()] : [] }) });
    setup();
    await startSearch(u);
    await screen.findByRole("heading", { name: "Kantor ditemukan: Biro Contoh" });
    expect(screen.queryByText(NEW_OFFICE)).not.toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: "Cari dengan cara lain" }));
    expect(await screen.findByRole("heading", { name: "Cari kantor dengan cara lain" })).toBeInTheDocument();
    expect(screen.queryByText(NEW_OFFICE)).not.toBeInTheDocument();

    found = false;
    await u.click(screen.getByRole("button", { name: "Cari lagi" }));
    await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." });
    await advance(16_000);
    expect(await screen.findByRole("heading", { name: "Kantor belum ditemukan" })).toBeInTheDocument();
    expect(screen.queryByText(NEW_OFFICE)).not.toBeInTheDocument();
  });

  it("mDNS mati: langsung ke cara lain dan menyebut sebabnya", async () => {
    const u = user();
    commands({ join_search: searchResult({ mdnsOk: false, mdnsError: "mDNS dimatikan (MIRA_DISABLE_MDNS)." }) });
    setup();
    await startSearch(u);

    expect(await screen.findByRole("heading", { name: "Kantor belum ditemukan" })).toBeInTheDocument();
    expect(screen.getByText("Pencarian otomatis tidak berjalan di laptop ini")).toBeInTheDocument();
    expect(screen.getByText("mDNS dimatikan (MIRA_DISABLE_MDNS).")).toBeInTheDocument();
  });

  it("Batal saat mencari: cara lain tanpa tautan kantor baru", async () => {
    const u = user();
    commands({ join_search: searchResult() });
    setup();
    await startSearch(u);
    await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." });
    await u.click(screen.getByRole("button", { name: "Batal" }));

    expect(await screen.findByRole("heading", { name: "Cari kantor dengan cara lain" })).toHaveFocus();
    expect(screen.queryByText(NEW_OFFICE)).not.toBeInTheDocument();
    const before = calls("join_search").length;
    await advance(5_000);
    expect(calls("join_search")).toHaveLength(before);
  });

  it("alamat manual: kantor dari alamat itu tampil di layar kantor ditemukan", async () => {
    const u = user();
    commands({
      join_search: searchResult({ mdnsOk: false }),
      join_connect_address: (args) =>
        (args as { address: string }).address === "salah"
          ? (() => {
              throw { code: "invalid_address", message: "Alamat tidak dikenali." };
            })()
          : [office({ name: "Biro Lewat VPN" })],
    });
    setup();
    await startSearch(u);
    await screen.findByRole("heading", { name: "Kantor belum ditemukan" });

    await u.click(screen.getByRole("button", { name: "Hubungkan" }));
    expect(await screen.findByText(/Isi alamat laptop rekan dulu/)).toBeInTheDocument();

    await u.type(screen.getByLabelText("Masukkan alamat laptop rekan"), "salah");
    await u.click(screen.getByRole("button", { name: "Hubungkan" }));
    expect(await screen.findByText("Alamat tidak dikenali.")).toBeInTheDocument();
    expect(screen.getByLabelText("Masukkan alamat laptop rekan")).toHaveAttribute("aria-invalid", "true");

    await u.clear(screen.getByLabelText("Masukkan alamat laptop rekan"));
    await u.type(screen.getByLabelText("Masukkan alamat laptop rekan"), "10.8.0.5");
    await u.click(screen.getByRole("button", { name: "Hubungkan" }));
    expect(await screen.findByRole("heading", { name: "Kantor ditemukan: Biro Lewat VPN" })).toHaveFocus();
    expect(invoke).toHaveBeenCalledWith("join_connect_address", { address: "10.8.0.5" });
  });

  it("alamat manual tanpa kantor yang menjawab: keterangan di bawah isian", async () => {
    const u = user();
    commands({ join_search: searchResult({ mdnsOk: false }), join_connect_address: [] });
    setup();
    await startSearch(u);
    await screen.findByRole("heading", { name: "Kantor belum ditemukan" });
    await u.type(screen.getByLabelText("Masukkan alamat laptop rekan"), "192.168.1.20");
    await u.click(screen.getByRole("button", { name: "Hubungkan" }));
    expect(await screen.findByText(/Tidak ada kantor yang menjawab dari alamat itu/)).toBeInTheDocument();
  });
});

describe("Onboarding: kantor baru", () => {
  async function openNewOffice(u: ReturnType<typeof user>) {
    await startSearch(u);
    await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." });
    await advance(16_000);
    await u.click(await screen.findByRole("button", { name: NEW_OFFICE }));
    expect(await screen.findByRole("heading", { name: "Siapkan Mira untuk kantor baru" })).toHaveFocus();
  }

  it("menyimpan nama, membuat organisasi, departemen, lalu memindahkan diri sendiri", async () => {
    const u = user();
    const saved = { ...fresh().identity, displayName: "Andi" };
    commands({
      join_search: searchResult(),
      save_display_name: saved,
      create_organization: org,
      org_create_department: { id: "t-man", name: "Manajemen", createdAt: "", archived: false, archivedAt: null, memberCount: 0 },
      org_move_member: null,
    });
    const { onOrganization } = setup(fresh(null));
    await openNewOffice(u);

    expect(screen.getByText("Hanya untuk orang pertama di kantor")).toBeInTheDocument();
    expect(screen.getByText(/VPN atau Wi-Fi yang terpisah/)).toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: "Buat organisasi" }));
    expect(await screen.findByText("Isi nama organisasi dulu.")).toBeInTheDocument();
    expect(screen.getByLabelText("Nama organisasi")).toHaveFocus();
    expect(screen.getByText("Isi nama departemen dulu.")).toBeInTheDocument();
    expect(calls("create_organization")).toHaveLength(0);

    await u.type(screen.getByLabelText("Nama organisasi"), "Kantor Uji");
    await u.type(screen.getByLabelText("Nama Anda"), "Andi");
    await u.type(screen.getByLabelText("Departemen Anda"), "Manajemen");
    await u.click(screen.getByRole("button", { name: "Buat organisasi" }));

    await waitFor(() => expect(onOrganization).toHaveBeenCalledWith(org));
    const order = invoke.mock.calls
      .map(([c]) => c)
      .filter((c) => ["save_display_name", "create_organization", "org_create_department", "org_move_member"].includes(c));
    expect(order).toEqual(["save_display_name", "create_organization", "org_create_department", "org_move_member"]);
    expect(invoke).toHaveBeenCalledWith("create_organization", { name: "Kantor Uji" });
    expect(invoke).toHaveBeenCalledWith("org_create_department", { name: "Manajemen" });
    expect(invoke).toHaveBeenCalledWith("org_move_member", { publicKey: fresh().identity.publicKey, teamId: "t-man" });
  });

  it("departemen gagal dibuat: organisasi tetap jadi, lalu Buka Mira", async () => {
    const u = user();
    commands({
      join_search: searchResult(),
      create_organization: org,
      org_create_department: rustError("database", "Data tidak bisa disimpan."),
    });
    const { onOrganization } = setup();
    await openNewOffice(u);

    await u.type(screen.getByLabelText("Nama organisasi"), "Kantor Uji");
    await u.type(screen.getByLabelText("Departemen Anda"), "Manajemen");
    await u.click(screen.getByRole("button", { name: "Buat organisasi" }));

    expect(await screen.findByRole("heading", { name: "Organisasi Kantor Uji sudah dibuat" })).toHaveFocus();
    expect(screen.getByText("Departemen Manajemen belum selesai disiapkan")).toBeInTheDocument();
    expect(onOrganization).not.toHaveBeenCalled();
    await u.click(screen.getByRole("button", { name: "Buka Mira" }));
    expect(onOrganization).toHaveBeenCalledWith(org);
    expect(calls("save_display_name")).toHaveLength(0);
  });

  it("Kembali dari kantor baru ke cara lain", async () => {
    const u = user();
    commands({ join_search: searchResult() });
    setup();
    await openNewOffice(u);
    await u.click(screen.getByRole("button", { name: "Kembali" }));
    expect(await screen.findByRole("heading", { name: "Kantor belum ditemukan" })).toBeInTheDocument();
    expect(within(document.body).getByRole("button", { name: NEW_OFFICE })).toBeInTheDocument();
  });
});
