import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../../api";
import { appState, firewall, org, router, rustError } from "../../test/fixtures";
import { ThemeProvider } from "../../theme/ThemeProvider";
import { device, searchResult } from "./joinFixtures";
import { Onboarding } from "./Onboarding";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const CODE = "ABCD-EFGH-JKMN-PQRS-TVWX";

function named(displayName: string | null = "Penguji"): AppState {
  const base = appState({ organization: null, membership: "none" });
  return { ...base, identity: { ...base.identity, displayName } };
}

function setup(state: AppState = named()) {
  const onOrganization = vi.fn();
  const onIdentity = vi.fn();
  render(
    <ThemeProvider>
      <Onboarding state={state} onIdentity={onIdentity} onOrganization={onOrganization} onReload={vi.fn()} />
    </ThemeProvider>,
  );
  return { onOrganization, onIdentity };
}

// Pencarian otomatis mati di uji ini, jadi layar cara lain langsung muncul.
function commands(table: Parameters<typeof router>[0]) {
  invoke.mockImplementation(
    router({ join_device: device, join_search: searchResult({ mdnsOk: false }), ...table }),
  );
}

// Langkah nama, lalu Lanjut.
async function passName(user: ReturnType<typeof userEvent.setup>) {
  expect(await screen.findByRole("heading", { name: "Siapa nama Anda?" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Lanjut" }));
}

// Nama, firewall kalau aturannya belum ada, cara lain, lalu kode undangan.
async function openJoin(user: ReturnType<typeof userEvent.setup>) {
  await passName(user);
  const next = await screen.findByRole("button", { name: /Lewati, atur nanti|Pakai kode undangan/ });
  if (next.textContent?.includes("Lewati")) await user.click(next);
  await user.click(await screen.findByRole("button", { name: /Pakai kode undangan/ }));
  expect(await screen.findByRole("heading", { name: "Gabung dengan kode undangan" })).toBeInTheDocument();
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

describe("Onboarding gabung dengan kode undangan", () => {
  it("dari cara lain ke kode undangan; berhasil masuk ke organisasi", async () => {
    const user = userEvent.setup();
    commands({ get_firewall_status: firewall({ rule: "allowed" }), join_with_code: org });
    const { onOrganization } = setup();

    await openJoin(user);
    expect(screen.queryByRole("heading", { name: "Izinkan Mira di jaringan kantor" })).not.toBeInTheDocument();

    expect(screen.queryByText(/Langkah \d dari 3/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Nama tampilan")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Kode undangan"), "abcd efgh jkmn pqrs tvwx");
    expect(screen.getByLabelText("Kode undangan")).toHaveValue(CODE);
    await user.click(screen.getByRole("button", { name: "Gabung ke organisasi" }));

    await waitFor(() => expect(onOrganization).toHaveBeenCalledWith(org));
    expect(invoke).toHaveBeenCalledWith("join_with_code", { code: CODE, address: null });
    expect(invoke).not.toHaveBeenCalledWith("save_display_name", expect.anything());
  });

  it("nama belum ada: disimpan di langkah 1, kode undangan tidak menanyakannya lagi", async () => {
    const user = userEvent.setup();
    const saved = { ...named().identity, displayName: "Rina" };
    commands({ get_firewall_status: firewall(), save_display_name: saved, join_with_code: org });
    const { onOrganization, onIdentity } = setup(named(null));
    await screen.findByRole("heading", { name: "Siapa nama Anda?" });
    await user.type(screen.getByLabelText("Nama tampilan"), " Rina ");
    await openJoin(user);

    expect(screen.queryByLabelText("Nama tampilan")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Kode undangan"), CODE);
    await user.click(screen.getByRole("button", { name: "Gabung ke organisasi" }));

    await waitFor(() => expect(onOrganization).toHaveBeenCalledWith(org));
    const order = invoke.mock.calls.map(([c]) => c).filter((c) => c === "save_display_name" || c === "join_with_code");
    expect(order).toEqual(["save_display_name", "join_with_code"]);
    expect(invoke).toHaveBeenCalledWith("save_display_name", { name: "Rina" });
    expect(onIdentity).toHaveBeenCalledWith(saved);
  });

  it("Kembali dari kode undangan ke cara lain", async () => {
    const user = userEvent.setup();
    commands({ get_firewall_status: firewall() });
    setup();
    await openJoin(user);
    await user.click(screen.getByRole("button", { name: "Kembali" }));
    expect(await screen.findByRole("heading", { name: "Kantor belum ditemukan" })).toHaveFocus();
  });

  it("menerima kode yang ditempel dengan spasi dan huruf kecil", async () => {
    const user = userEvent.setup();
    commands({ get_firewall_status: firewall(), join_with_code: org });
    setup();
    await openJoin(user);

    await user.click(screen.getByLabelText("Kode undangan"));
    await user.paste("  abcd-efgh-jkmn-pqrs-tvwx ");
    expect(screen.getByLabelText("Kode undangan")).toHaveValue(CODE);
  });

  it("menolak kode yang terlalu pendek tanpa memanggil inti Rust", async () => {
    const user = userEvent.setup();
    commands({ get_firewall_status: firewall() });
    setup();
    await openJoin(user);

    await user.type(screen.getByLabelText("Kode undangan"), "ABCD");
    await user.click(screen.getByRole("button", { name: "Gabung ke organisasi" }));
    expect(await screen.findByText(/Yang terisi 4/)).toBeInTheDocument();
    expect(screen.getByLabelText("Kode undangan")).toHaveAttribute("aria-invalid", "true");
    expect(invoke).not.toHaveBeenCalledWith("join_with_code", expect.anything());
  });

  it("menampilkan keadaan mencari selama inti Rust bekerja", async () => {
    const user = userEvent.setup();
    let finish: (v: unknown) => void = () => {};
    commands({ get_firewall_status: firewall(), join_with_code: () => new Promise((r) => (finish = r)) });
    const { onOrganization } = setup();
    await openJoin(user);

    await user.type(screen.getByLabelText("Kode undangan"), CODE);
    await user.click(screen.getByRole("button", { name: "Gabung ke organisasi" }));
    expect(await screen.findByText(/sampai 20 detik/)).toBeInTheDocument();
    expect(screen.getByLabelText("Kode undangan")).toBeDisabled();

    finish(org);
    await waitFor(() => expect(onOrganization).toHaveBeenCalledWith(org));
  });

  it.each([
    ["invite_not_found", "Kode tidak dikenali"],
    ["invite_expired", "Kode sudah kedaluwarsa"],
    ["invite_used", "Kode sudah dipakai"],
    ["invite_revoked", "Kode sudah dicabut"],
    ["peer_unreachable", "Laptop rekan tidak bisa memeriksa kode"],
    ["removed", "Laptop ini sudah dikeluarkan dari organisasi"],
  ])("menjelaskan error %s", async (code, title) => {
    const user = userEvent.setup();
    commands({ get_firewall_status: firewall(), join_with_code: rustError(code, "pesan Rust") });
    const { onOrganization } = setup();
    await openJoin(user);

    await user.type(screen.getByLabelText("Kode undangan"), CODE);
    await user.click(screen.getByRole("button", { name: "Gabung ke organisasi" }));
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(onOrganization).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Kode undangan")).not.toBeDisabled();
  });

  it("tidak ada rekan ditemukan: memberi langkah lanjut dan membuka isian alamat", async () => {
    const user = userEvent.setup();
    let calls = 0;
    commands({
      get_firewall_status: firewall(),
      join_with_code: (args) => {
        calls += 1;
        if (calls === 1) throw { code: "no_peer_found", message: "Tidak ada laptop Mira yang ditemukan." };
        expect(args).toEqual({ code: CODE, address: "192.168.1.20:47800" });
        return org;
      },
    });
    const { onOrganization } = setup();
    await openJoin(user);
    expect(screen.getByLabelText(/Alamat laptop rekan/)).not.toBeVisible();

    await user.type(screen.getByLabelText("Kode undangan"), CODE);
    await user.click(screen.getByRole("button", { name: "Gabung ke organisasi" }));

    expect(await screen.findByText("Belum ada laptop rekan yang ditemukan")).toBeInTheDocument();
    expect(screen.getByText(/nyalakan VPN kantor/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rekan tidak ditemukan otomatis?" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    await user.type(screen.getByLabelText(/Alamat laptop rekan/), "192.168.1.20:47800");
    await user.click(screen.getByRole("button", { name: "Gabung ke organisasi" }));
    await waitFor(() => expect(onOrganization).toHaveBeenCalledWith(org));
  });

  it("tidak ada rekan ditemukan: Periksa firewall lalu kembali ke kode undangan", async () => {
    const user = userEvent.setup();
    commands({
      get_firewall_status: firewall({ rule: "allowed" }),
      join_with_code: rustError("no_peer_found", "Tidak ada laptop Mira yang ditemukan."),
    });
    setup();
    await openJoin(user);
    await user.type(screen.getByLabelText("Kode undangan"), CODE);
    await user.click(screen.getByRole("button", { name: "Gabung ke organisasi" }));

    await user.click(await screen.findByRole("button", { name: "Periksa Windows Firewall" }));
    expect(await screen.findByRole("heading", { name: "Izinkan Mira di jaringan kantor" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Kembali ke kode undangan" }));
    expect(await screen.findByRole("heading", { name: "Gabung dengan kode undangan" })).toBeInTheDocument();
  });

  it("alamat yang salah ditandai di isian alamat", async () => {
    const user = userEvent.setup();
    commands({ get_firewall_status: firewall(), join_with_code: rustError("invalid_address", "Alamat tidak dikenali.") });
    setup();
    await openJoin(user);

    await user.type(screen.getByLabelText("Kode undangan"), CODE);
    await user.click(screen.getByRole("button", { name: "Rekan tidak ditemukan otomatis?" }));
    await user.type(screen.getByLabelText(/Alamat laptop rekan/), "bukan alamat");
    await user.click(screen.getByRole("button", { name: "Gabung ke organisasi" }));

    expect(await screen.findByText("Alamat tidak dikenali.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Alamat laptop rekan/)).toHaveAttribute("aria-invalid", "true");
  });
});

describe("Onboarding langkah firewall", () => {
  it("aturan belum ada: tampil setelah nama sebagai langkah 2, bisa dilewati lalu mencari", async () => {
    const user = userEvent.setup();
    commands({ get_firewall_status: firewall({ rule: "missing" }), join_search: searchResult() });
    setup();
    await passName(user);

    expect(await screen.findByRole("heading", { name: "Izinkan Mira di jaringan kantor" })).toHaveFocus();
    expect(screen.getByText("Langkah 2 dari 3")).toBeInTheDocument();
    expect(await screen.findByText(/Belum ada aturan Windows Firewall/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Lewati, atur nanti" }));
    expect(await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." })).toBeInTheDocument();
    expect(screen.getByText("Langkah 2 dari 3")).toBeInTheDocument();
  });

  it("aturan sudah ada: langkah firewall dilewati, langsung mencari", async () => {
    const user = userEvent.setup();
    commands({ get_firewall_status: firewall({ rule: "allowed" }), join_search: searchResult() });
    setup();
    await passName(user);
    expect(await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Izinkan Mira di jaringan kantor" })).not.toBeInTheDocument();
  });

  it("di luar Windows (tidak didukung): langkah firewall dilewati", async () => {
    const user = userEvent.setup();
    commands({
      get_firewall_status: firewall({ supported: false, rule: "unknown", profiles: [] }),
      join_search: searchResult(),
    });
    setup();
    await passName(user);
    expect(await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Izinkan Mira di jaringan kantor" })).not.toBeInTheDocument();
  });

  it("macOS sudah mengizinkan: langkah firewall dilewati", async () => {
    const user = userEvent.setup();
    commands({
      get_firewall_status: firewall({ platform: "macos", rule: "allowed", profiles: [] }),
      join_search: searchResult(),
    });
    setup();
    await passName(user);
    expect(await screen.findByRole("heading", { name: "Mencari kantor di jaringan..." })).toBeInTheDocument();
  });

  it("status firewall gagal dibaca: langsung mencari", async () => {
    const user = userEvent.setup();
    commands({ get_firewall_status: rustError("internal", "PowerShell tidak bisa dijalankan.") });
    setup();
    await passName(user);
    expect(await screen.findByRole("heading", { name: "Kantor belum ditemukan" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Izinkan Mira di jaringan kantor" })).not.toBeInTheDocument();
  });

  it("meminta izin administrator dan menyediakan perintah untuk tim IT", async () => {
    const user = userEvent.setup();
    let rule: "missing" | "allowed" = "missing";
    commands({
      get_firewall_status: () =>
        firewall({ rule, profiles: [{ name: "VPN Kantor", category: "public", interfaceAlias: "WireGuard" }] }),
      request_firewall_rule: { started: true },
    });
    setup();
    await passName(user);

    expect(await screen.findByText("VPN Kantor")).toBeInTheDocument();
    expect(screen.getByText("Publik")).toBeInTheDocument();
    expect(screen.getByText(/VPN sering tercatat sebagai Publik/)).toBeInTheDocument();
    expect(screen.getByText(/jendela izin administrator/)).toBeInTheDocument();
    expect(screen.getByText(/New-NetFirewallRule/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salin perintah" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Izinkan lewat Windows Firewall" }));
    expect(invoke).toHaveBeenCalledWith("request_firewall_rule", undefined);
    expect(await screen.findByText(/Setelah Anda memilih Ya/)).toBeInTheDocument();

    rule = "allowed";
    await user.click(screen.getByRole("button", { name: "Periksa lagi" }));
    expect(await screen.findByText(/sudah mengizinkan Mira/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Izinkan lewat Windows Firewall" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cari kantor" })).toBeInTheDocument();
  });

  it("jendela izin tidak terbuka: menyarankan kirim perintah ke IT", async () => {
    const user = userEvent.setup();
    commands({ get_firewall_status: firewall({ rule: "blocked" }), request_firewall_rule: { started: false } });
    setup();
    await passName(user);

    expect(await screen.findByText(/memblokir Mira/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Izinkan lewat Windows Firewall" }));
    expect(await screen.findByText("Jendela izin Windows tidak terbuka")).toBeInTheDocument();
  });

  it("status tidak diketahui tetap menawarkan izin", async () => {
    const user = userEvent.setup();
    commands({ get_firewall_status: firewall({ rule: "unknown", detail: "Akses ditolak" }) });
    setup();
    await passName(user);
    expect(await screen.findByText(/belum bisa membaca aturan Windows Firewall/)).toBeInTheDocument();
    expect(screen.getByText(/Akses ditolak/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Izinkan lewat Windows Firewall" })).toBeInTheDocument();
  });

  it("macOS: tanpa tombol izin Windows, ada langkah Pengaturan Sistem dan perintah Terminal", async () => {
    const user = userEvent.setup();
    const adminCommand =
      "sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add '/Applications/Mira.app' && sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp '/Applications/Mira.app'";
    commands({
      get_firewall_status: firewall({
        platform: "macos",
        rule: "missing",
        profiles: [],
        programPath: "/Applications/Mira.app",
        adminCommand,
      }),
    });
    setup();
    await passName(user);

    expect(await screen.findByText(/Mira belum ada di daftarnya/)).toBeInTheDocument();
    expect(screen.getByText(/Pilih Izinkan\./)).toBeInTheDocument();
    expect(screen.getByText(/Pengaturan Sistem > Jaringan > Firewall/)).toBeInTheDocument();
    expect(screen.getByText(adminCommand)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salin perintah" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Izinkan lewat Windows Firewall" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Jaringan yang sedang dipakai/)).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("request_firewall_rule", undefined);
  });

  it("macOS: firewall memblokir Mira, keterangan dari inti ikut tampil", async () => {
    const user = userEvent.setup();
    commands({
      get_firewall_status: firewall({
        platform: "macos",
        rule: "blocked",
        profiles: [],
        detail: "Firewall macOS sedang memblokir semua sambungan masuk, termasuk untuk Mira.",
      }),
    });
    setup();
    await passName(user);
    expect(await screen.findByText(/Firewall macOS memblokir Mira/)).toBeInTheDocument();
    expect(screen.getByText(/memblokir semua sambungan masuk/)).toBeInTheDocument();
    expect(screen.getByText(/Atur Mira ke Izinkan sambungan masuk/)).toBeInTheDocument();
  });

  it("permintaan lama tidak terbaca: tetap mulai dari langkah nama", async () => {
    commands({ get_firewall_status: firewall(), join_outgoing: rustError("database", "Data tidak terbaca.") });
    setup();
    expect(await screen.findByRole("heading", { name: "Siapa nama Anda?" })).toBeInTheDocument();
    expect(screen.getByText("Langkah 1 dari 3")).toBeInTheDocument();
  });
});
