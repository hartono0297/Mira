import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadProgress } from "../../api/updater";
import { deferred, recentCheck, rejectWith, updateBackend, type UpdateBackendOptions } from "../../test/updateBackend";
import { UpdateProvider } from "../../updates/UpdateContext";
import { WhatsNewDialog } from "../../updates/WhatsNewDialog";
import { AboutSection } from "./AboutSection";

const { invoke, FakeChannel } = vi.hoisted(() => {
  class FakeChannel<T> {
    onmessage: (message: T) => void = () => {};
  }
  return { invoke: vi.fn(), FakeChannel };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: FakeChannel }));

const AVAILABLE = {
  available: true,
  currentVersion: "0.3.0",
  version: "0.3.1",
  notes: "## Perbaikan\n\n- Chat lebih cepat terbuka.",
  date: "2026-12-01T03:00:00Z",
};

function setup(opts: UpdateBackendOptions = {}) {
  const settings = updateBackend(invoke, {
    ...opts,
    settings: { ...recentCheck(), "whats_new.seen": "0.3.0", ...(opts.settings ?? {}) },
  });
  render(
    <UpdateProvider>
      <AboutSection />
      <WhatsNewDialog />
    </UpdateProvider>,
  );
  return settings;
}

const status = () => document.querySelector(".update-status") as HTMLElement;
const checkButton = () => screen.getByRole("button", { name: "Cek pembaruan" });

async function clickCheck() {
  const user = userEvent.setup();
  await screen.findByText("Mira 0.3.0");
  await user.click(checkButton());
  return user;
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

describe("Pengaturan > Tentang dan pembaruan", () => {
  it("menampilkan versi terpasang dan wilayah status yang sopan", async () => {
    setup();
    expect(await screen.findByText("Mira 0.3.0")).toBeInTheDocument();
    expect(status()).toHaveAttribute("aria-live", "polite");
    expect(status()).toBeEmptyDOMElement();
    expect(checkButton()).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "Cek pembaruan otomatis saat Mira dibuka" })).toBeChecked();
    expect(screen.getByText(/hanya menghubungi GitHub/)).toBeInTheDocument();
    expect(screen.getByText(/Data dan kunci laptop ini tidak tersentuh/)).toBeInTheDocument();
  });

  it("sedang mengecek", async () => {
    const pending = deferred<unknown>();
    setup({ commands: { update_check: () => pending.promise } });
    await clickCheck();
    expect(within(status()).getByText("Sedang mengecek pembaruan...")).toBeInTheDocument();
    expect(checkButton()).toHaveAttribute("aria-busy", "true");
    expect(checkButton()).toHaveAttribute("aria-disabled", "true");
  });

  it("sudah versi terbaru", async () => {
    setup({ commands: { update_check: () => ({ available: false, currentVersion: "0.3.0" }) } });
    await clickCheck();
    expect(await within(status()).findByText("Mira sudah versi terbaru.")).toBeInTheDocument();
  });

  it("versi baru tersedia dengan catatan rilis", async () => {
    setup({ commands: { update_check: () => AVAILABLE } });
    await clickCheck();
    expect(await within(status()).findByText("Versi baru tersedia: Mira 0.3.1.")).toBeInTheDocument();
    expect(screen.getByText(/Dirilis 1 Desember 2026/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Perbaikan" })).toBeInTheDocument();
    expect(screen.getByText("Chat lebih cepat terbuka.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Perbarui sekarang" })).toBeInTheDocument();
  });

  it("mengunduh dengan persen, lalu siap dipasang, lalu memasang", async () => {
    const download = deferred<{ version: string }>();
    let channel: { onmessage: (p: DownloadProgress) => void } | null = null;
    const install = deferred<null>();
    setup({
      commands: {
        update_check: () => AVAILABLE,
        update_download: (args) => {
          channel = args?.onEvent as typeof channel;
          return download.promise;
        },
        update_install: () => install.promise,
      },
    });
    const user = await clickCheck();
    await user.click(await screen.findByRole("button", { name: "Perbarui sekarang" }));
    expect(invoke).toHaveBeenCalledWith("update_download", { onEvent: expect.any(FakeChannel) });
    expect(within(status()).getByText("Mengunduh pembaruan...")).toBeInTheDocument();

    act(() => channel?.onmessage({ downloaded: 42, total: 100 }));
    expect(within(status()).getByText("Mengunduh pembaruan... 42%")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Kemajuan unduhan pembaruan" });
    expect(bar).toHaveAttribute("value", "42");
    // Tombol yang sama tetap di tempat supaya fokus keyboard tidak hilang.
    const action = screen.getByRole("button", { name: "Mengunduh..." });
    expect(action).toHaveFocus();
    expect(action).toHaveAttribute("aria-disabled", "true");

    await act(async () => download.resolve({ version: "0.3.1" }));
    expect(
      within(status()).getByText("Pembaruan siap dipasang. Mira akan tertutup sebentar lalu terbuka lagi."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    const restart = screen.getByRole("button", { name: "Mulai ulang Mira" });
    expect(restart).toHaveFocus();

    await user.click(restart);
    expect(invoke).toHaveBeenCalledWith("update_install", undefined);
    expect(within(status()).getByText("Memasang pembaruan...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Memasang..." })).toHaveAttribute("aria-busy", "true");
  });

  it("offline ditampilkan tenang, tanpa kotak error", async () => {
    setup({
      commands: {
        update_check: rejectWith(
          "update_offline",
          "Tidak bisa menghubungi GitHub. Coba lagi saat laptop tersambung ke internet.",
        ),
      },
    });
    await clickCheck();
    expect(
      await within(status()).findByText(
        "Tidak bisa menghubungi GitHub. Coba lagi saat laptop tersambung ke internet.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(document.querySelector(".alert")).toBeNull();
    expect(checkButton()).toBeEnabled();
    expect(checkButton()).not.toHaveAttribute("aria-disabled");
  });

  it("belum disiapkan: kalimat tenang dan tombol cek nonaktif", async () => {
    setup({ configured: false });
    expect(await within(status()).findByText(/belum disiapkan untuk pembaruan dari dalam aplikasi/)).toBeInTheDocument();
    expect(checkButton()).toBeDisabled();
    expect(document.querySelector(".alert")).toBeNull();
  });

  it("cek gagal menampilkan pesan dan jalan untuk mencoba lagi", async () => {
    let fail = true;
    setup({
      commands: {
        update_check: () =>
          fail
            ? Promise.reject({ code: "update_failed", message: "Jawaban GitHub tidak bisa dibaca." })
            : { available: false, currentVersion: "0.3.0" },
      },
    });
    const user = await clickCheck();
    expect(await screen.findByText("Pengecekan pembaruan gagal")).toBeInTheDocument();
    expect(screen.getByText("Jawaban GitHub tidak bisa dibaca.")).toBeInTheDocument();
    expect(screen.getByText("Coba lagi dengan tombol Cek pembaruan.")).toBeInTheDocument();

    fail = false;
    await user.click(checkButton());
    expect(await within(status()).findByText("Mira sudah versi terbaru.")).toBeInTheDocument();
  });

  it("tanda tangan tidak cocok saat unduh bisa diunduh lagi", async () => {
    let attempt = 0;
    setup({
      commands: {
        update_check: () => AVAILABLE,
        update_download: () => {
          attempt += 1;
          return attempt === 1
            ? Promise.reject({ code: "update_bad_signature", message: "Tanda tangan pembaruan tidak cocok." })
            : { version: "0.3.1" };
        },
      },
    });
    const user = await clickCheck();
    await user.click(await screen.findByRole("button", { name: "Perbarui sekarang" }));
    expect(await screen.findByText("Unduhan pembaruan gagal")).toBeInTheDocument();
    expect(screen.getByText("Tanda tangan pembaruan tidak cocok.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Unduh lagi" }));
    expect(await screen.findByRole("button", { name: "Mulai ulang Mira" })).toBeInTheDocument();
    expect(attempt).toBe(2);
  });

  it("pemasangan gagal bisa dicoba lagi", async () => {
    setup({
      commands: {
        update_check: () => AVAILABLE,
        update_download: () => ({ version: "0.3.1" }),
        update_install: rejectWith("update_failed", "Installer tidak bisa dijalankan."),
      },
    });
    const user = await clickCheck();
    await user.click(await screen.findByRole("button", { name: "Perbarui sekarang" }));
    await user.click(await screen.findByRole("button", { name: "Mulai ulang Mira" }));
    expect(await screen.findByText("Pembaruan belum terpasang")).toBeInTheDocument();
    expect(screen.getByText("Installer tidak bisa dijalankan.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pasang lagi" })).toBeInTheDocument();
  });

  it("kotak centang menyimpan update.auto_check", async () => {
    const user = userEvent.setup();
    const settings = setup();
    const box = await screen.findByRole("checkbox", { name: "Cek pembaruan otomatis saat Mira dibuka" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_setting", { key: "update.auto_check" }));
    await user.click(box);
    expect(box).not.toBeChecked();
    expect(settings["update.auto_check"]).toBe("off");
    await user.click(box);
    expect(settings["update.auto_check"]).toBe("on");
  });

  it("kotak centang kembali kalau gagal tersimpan", async () => {
    const user = userEvent.setup();
    setup({ commands: { set_setting: rejectWith("database", "Database terkunci.") } });
    const box = await screen.findByRole("checkbox", { name: "Cek pembaruan otomatis saat Mira dibuka" });
    await user.click(box);
    expect(await screen.findByText("Pilihan belum tersimpan: Database terkunci.")).toBeInTheDocument();
    expect(box).toBeChecked();
  });

  it("Lihat yang baru membuka dialog versi ini, dan disembunyikan tanpa catatan", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole("button", { name: "Lihat yang baru" }));
    const dialog = await screen.findByRole("dialog", { name: "Yang baru di Mira 0.3.0" });
    await user.click(within(dialog).getByRole("button", { name: "Tutup" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Sudah dilihat: menutup dari Pengaturan tidak menulis ulang.
    expect(invoke).not.toHaveBeenCalledWith("set_setting", expect.objectContaining({ key: "whats_new.seen" }));
  });

  it("tombol Lihat yang baru tidak ada kalau versi ini tidak punya catatan", async () => {
    setup({ version: "0.2.9", settings: { "whats_new.seen": "0.2.9" } });
    expect(await screen.findByText("Mira 0.2.9")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Lihat yang baru" })).not.toBeInTheDocument();
  });
});
