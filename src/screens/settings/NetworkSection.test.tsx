import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManualAddress } from "../../api";
import { firewall, network, peer, PK_B, router } from "../../test/fixtures";
import { NetworkProvider } from "../shell/NetworkContext";
import { NetworkSection, qrDataUrl } from "./NetworkSection";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function renderSection() {
  render(
    <NetworkProvider onRemoved={vi.fn()}>
      <NetworkSection />
    </NetworkProvider>,
  );
}

function manual(address: string, extra: Partial<ManualAddress> = {}): ManualAddress {
  return { address, addedAt: "2026-11-22T01:00:00Z", lastTriedAt: null, lastError: null, publicKey: null, ...extra };
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

describe("Pengaturan > Jaringan", () => {
  it("menampilkan status, alamat, QR sebagai gambar, dan tautan yang bisa disalin", async () => {
    const status = network();
    invoke.mockImplementation(router({ get_network_status: status, get_firewall_status: firewall({ rule: "allowed" }) }));
    renderSection();

    expect(await screen.findByText("Tersambung lewat LAN kantor")).toBeInTheDocument();
    expect(screen.getByText("192.168.1.10:47800")).toBeInTheDocument();
    const qr = screen.getByRole("img", { name: "Kode QR berisi tautan laptop ini" });
    expect(qr).toHaveAttribute("src", qrDataUrl(status.qrSvg));
    expect(qr.getAttribute("src")).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
    expect(document.querySelector('svg[viewBox="0 0 10 10"]')).toBeNull();
    expect(screen.getByText(status.shareLink)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salin tautan" })).toBeInTheDocument();
    expect(screen.getByText("Penemuan otomatis (mDNS)")).toBeInTheDocument();
    expect(await screen.findByText(/sudah mengizinkan Mira/)).toBeInTheDocument();
  });

  it("mDNS bermasalah ditampilkan dengan jalan lain", async () => {
    invoke.mockImplementation(
      router({ get_network_status: network({ mdns: { ok: false, error: "Port 5353 dipakai program lain." } }) }),
    );
    renderSection();
    expect(await screen.findByText(/Port 5353 dipakai program lain/)).toBeInTheDocument();
    expect(screen.getByText("Tidak aktif")).toBeInTheDocument();
  });

  it("menambah alamat manual lalu memuat ulang daftar", async () => {
    const user = userEvent.setup();
    let list: ManualAddress[] = [];
    invoke.mockImplementation(
      router({
        get_network_status: () => network({ manualAddresses: list }),
        add_manual_address: (args) => {
          const added = manual(String(args?.address));
          list = [added];
          return added;
        },
      }),
    );
    renderSection();
    expect(await screen.findByText("Belum ada alamat yang ditambahkan.")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Tambah alamat laptop rekan"), " 192.168.1.20 ");
    await user.click(screen.getByRole("button", { name: "Tambah alamat" }));

    expect(invoke).toHaveBeenCalledWith("add_manual_address", { address: "192.168.1.20" });
    expect(await screen.findByText(/Alamat 192.168.1.20 ditambahkan/)).toBeInTheDocument();
    expect(screen.getByText("Belum dicoba. Mira mencoba alamat ini secara berkala.")).toBeInTheDocument();
    expect(screen.getByLabelText("Tambah alamat laptop rekan")).toHaveValue("");
  });

  it("alamat yang ditolak Rust ditandai di isian", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(
      router({
        get_network_status: network(),
        add_manual_address: () => {
          throw { code: "invalid_address", message: "Alamat harus berupa IP, IP:port, atau tautan mira://." };
        },
      }),
    );
    renderSection();
    await screen.findByText("Tersambung lewat LAN kantor");
    await user.type(screen.getByLabelText("Tambah alamat laptop rekan"), "kantor.local");
    await user.click(screen.getByRole("button", { name: "Tambah alamat" }));

    expect(await screen.findByText("Alamat harus berupa IP, IP:port, atau tautan mira://.")).toBeInTheDocument();
    expect(screen.getByLabelText("Tambah alamat laptop rekan")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Tambah alamat laptop rekan")).toHaveValue("kantor.local");
  });

  it("isian kosong tidak dikirim", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(router({ get_network_status: network() }));
    renderSection();
    await screen.findByText("Tersambung lewat LAN kantor");
    await user.click(screen.getByRole("button", { name: "Tambah alamat" }));
    expect(await screen.findByText("Isi alamat laptop rekan dulu.")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("add_manual_address", expect.anything());
  });

  it("menampilkan hasil percobaan terakhir dan bisa menghapus alamat", async () => {
    const user = userEvent.setup();
    const recent = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    let list = [
      manual("10.8.0.5:47800", { lastTriedAt: recent, lastError: "Waktu habis menunggu jawaban." }),
      manual("10.8.0.6", { lastTriedAt: recent, publicKey: PK_B }),
      // Rust tetap menyimpan publicKey saat percobaan berikutnya gagal.
      manual("10.8.0.7", { lastTriedAt: recent, publicKey: PK_B, lastError: "Laptop rekan tidak menjawab." }),
    ];
    invoke.mockImplementation(
      router({
        get_network_status: () => network({ manualAddresses: list, peers: [peer(PK_B, "Budi")] }),
        remove_manual_address: (args) => {
          list = list.filter((m) => m.address !== args?.address);
          return null;
        },
      }),
    );
    renderSection();

    expect(await screen.findByText("Percobaan terakhir 2 menit lalu gagal: Waktu habis menunggu jawaban.")).toBeInTheDocument();
    expect(screen.getByText("Tersambung ke Budi, 2 menit lalu.")).toBeInTheDocument();
    expect(screen.getByText("Percobaan terakhir 2 menit lalu gagal: Laptop rekan tidak menjawab.")).toBeInTheDocument();
    expect(screen.queryAllByText(/^Tersambung ke Budi/)).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Hapus alamat 10.8.0.5:47800" }));
    expect(invoke).toHaveBeenCalledWith("remove_manual_address", { address: "10.8.0.5:47800" });
    expect(await screen.findByText("Alamat 10.8.0.5:47800 dihapus.")).toBeInTheDocument();
    const rows = document.querySelector(".manual-list") as HTMLElement;
    expect(within(rows).queryByText("10.8.0.5:47800")).not.toBeInTheDocument();
  });

  it("status gagal dibaca menampilkan error dan tombol coba lagi", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_network_status") throw { code: "network", message: "Jaringan belum dimulai." };
      return null;
    });
    renderSection();
    expect(await screen.findByText("Status jaringan belum terbaca")).toBeInTheDocument();
    expect(screen.getByText("Jaringan belum dimulai.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Coba baca lagi" })).toBeInTheDocument();
  });
});
