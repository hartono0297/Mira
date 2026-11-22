import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../../api";
import { appState, firewall, org, router, rustError } from "../../test/fixtures";
import { ThemeProvider } from "../../theme/ThemeProvider";
import { Onboarding } from "./Onboarding";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const CODE = "ABCD-EFGH-JKMN-PQRS-TVWX";

function named(): AppState {
  return appState({ organization: null, membership: "none" });
}

function setup(state: AppState = named()) {
  const onOrganization = vi.fn();
  render(
    <ThemeProvider>
      <Onboarding state={state} onIdentity={vi.fn()} onOrganization={onOrganization} onReload={vi.fn()} />
    </ThemeProvider>,
  );
  return { onOrganization };
}

async function openJoin(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Gabung dengan kode/ }));
  expect(await screen.findByRole("heading", { name: "Izinkan Mira di jaringan kantor" })).toBeInTheDocument();
  await user.click(await screen.findByRole("button", { name: /Lewati, atur nanti|Lanjut ke kode undangan/ }));
  expect(await screen.findByRole("heading", { name: "Gabung dengan kode undangan" })).toBeInTheDocument();
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

describe("Onboarding gabung dengan kode", () => {
  it("langkah firewall dulu, lalu kode; berhasil masuk ke organisasi", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(router({ get_firewall_status: firewall({ rule: "allowed" }), join_with_code: org }));
    const { onOrganization } = setup();

    await user.click(screen.getByRole("button", { name: /Gabung dengan kode/ }));
    expect(await screen.findByText(/sudah mengizinkan Mira/)).toBeInTheDocument();
    expect(screen.getByText("Langkah 2 dari 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Lanjut ke kode undangan" }));

    expect(screen.getByText("Langkah 3 dari 3")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Kode undangan"), "abcd efgh jkmn pqrs tvwx");
    expect(screen.getByLabelText("Kode undangan")).toHaveValue(CODE);
    await user.click(screen.getByRole("button", { name: "Gabung ke organisasi" }));

    await waitFor(() => expect(onOrganization).toHaveBeenCalledWith(org));
    expect(invoke).toHaveBeenCalledWith("join_with_code", { code: CODE, address: null });
  });

  it("menerima kode yang ditempel dengan spasi dan huruf kecil", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(router({ get_firewall_status: firewall(), join_with_code: org }));
    setup();
    await openJoin(user);

    await user.click(screen.getByLabelText("Kode undangan"));
    await user.paste("  abcd-efgh-jkmn-pqrs-tvwx ");
    expect(screen.getByLabelText("Kode undangan")).toHaveValue(CODE);
  });

  it("menolak kode yang terlalu pendek tanpa memanggil inti Rust", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(router({ get_firewall_status: firewall() }));
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
    invoke.mockImplementation(
      router({ get_firewall_status: firewall(), join_with_code: () => new Promise((r) => (finish = r)) }),
    );
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
    invoke.mockImplementation(router({ get_firewall_status: firewall(), join_with_code: rustError(code, "pesan Rust") }));
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
    invoke.mockImplementation(
      router({
        get_firewall_status: firewall(),
        join_with_code: (args) => {
          calls += 1;
          if (calls === 1) throw { code: "no_peer_found", message: "Tidak ada laptop Mira yang ditemukan." };
          expect(args).toEqual({ code: CODE, address: "192.168.1.20:47800" });
          return org;
        },
      }),
    );
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

  it("alamat yang salah ditandai di isian alamat", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(
      router({ get_firewall_status: firewall(), join_with_code: rustError("invalid_address", "Alamat tidak dikenali.") }),
    );
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
  it("setelah membuat organisasi, langkah firewall muncul sebelum masuk ke Mira", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(router({ create_organization: org, get_firewall_status: firewall({ rule: "missing" }) }));
    const { onOrganization } = setup();

    await user.click(screen.getByRole("button", { name: /Buat organisasi baru/ }));
    await user.type(screen.getByLabelText("Nama organisasi"), "Kantor Uji");
    await user.click(screen.getByRole("button", { name: "Buat organisasi" }));

    expect(await screen.findByRole("heading", { name: "Izinkan Mira di jaringan kantor" })).toBeInTheDocument();
    expect(onOrganization).not.toHaveBeenCalled();
    expect(await screen.findByText(/Belum ada aturan Windows Firewall/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Lewati, atur nanti" }));
    expect(onOrganization).toHaveBeenCalledWith(org);
  });

  it("meminta izin administrator dan menyediakan perintah untuk tim IT", async () => {
    const user = userEvent.setup();
    let rule: "missing" | "allowed" = "missing";
    invoke.mockImplementation(
      router({
        get_firewall_status: () =>
          firewall({ rule, profiles: [{ name: "VPN Kantor", category: "public", interfaceAlias: "WireGuard" }] }),
        request_firewall_rule: { started: true },
      }),
    );
    setup();
    await user.click(screen.getByRole("button", { name: /Gabung dengan kode/ }));

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
    expect(screen.getByRole("button", { name: "Lanjut ke kode undangan" })).toBeInTheDocument();
  });

  it("jendela izin tidak terbuka: menyarankan kirim perintah ke IT", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(
      router({ get_firewall_status: firewall({ rule: "blocked" }), request_firewall_rule: { started: false } }),
    );
    setup();
    await user.click(screen.getByRole("button", { name: /Gabung dengan kode/ }));

    expect(await screen.findByText(/memblokir Mira/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Izinkan lewat Windows Firewall" }));
    expect(await screen.findByText("Jendela izin Windows tidak terbuka")).toBeInTheDocument();
  });

  it("status tidak diketahui tetap menawarkan izin", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(router({ get_firewall_status: firewall({ rule: "unknown", detail: "Akses ditolak" }) }));
    setup();
    await user.click(screen.getByRole("button", { name: /Gabung dengan kode/ }));
    expect(await screen.findByText(/belum bisa membaca aturan Windows Firewall/)).toBeInTheDocument();
    expect(screen.getByText(/Akses ditolak/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Izinkan lewat Windows Firewall" })).toBeInTheDocument();
  });

  it("di luar Windows menjelaskan dan menawarkan lanjut", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(
      router({ get_firewall_status: firewall({ supported: false, rule: "unknown", profiles: [] }) }),
    );
    setup();
    await user.click(screen.getByRole("button", { name: /Gabung dengan kode/ }));
    expect(await screen.findByText(/hanya ada di Windows/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Izinkan lewat Windows Firewall" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lanjut ke kode undangan" })).toBeInTheDocument();
  });

  it("status firewall gagal dibaca: error jelas dan tetap bisa dilewati", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(
      router({ get_firewall_status: rustError("internal", "PowerShell tidak bisa dijalankan.") }),
    );
    setup();
    await user.click(screen.getByRole("button", { name: /Gabung dengan kode/ }));
    expect(await screen.findByText("Status Windows Firewall belum terbaca")).toBeInTheDocument();
    expect(screen.getByText("PowerShell tidak bisa dijalankan.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Lewati, atur nanti" }));
    expect(await screen.findByRole("heading", { name: "Gabung dengan kode undangan" })).toBeInTheDocument();
  });
});
