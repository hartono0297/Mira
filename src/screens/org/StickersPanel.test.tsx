import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, OrgInfo } from "../../api";
import type { OfficeSticker, PickedSticker, StickerCatalog } from "../../api/chat";
import { appState, directory, router, rustError } from "../../test/fixtures";
import { adminOverview, overview } from "../../test/orgFixtures";
import { resetStickerCatalog } from "../chat/stickerCatalog";
import { clearStickerImageCache } from "../chat/StickerImage";
import { OrgScreen } from "./OrgScreen";
import { parseKeywords, suggestName } from "./StickersPanel";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const state = appState() as AppState & { organization: OrgInfo };
const S1 = "1".repeat(32);
const S2 = "2".repeat(32);
const S3 = "3".repeat(32);
const S4 = "4".repeat(32);
const IMG = "data:image/png;base64,AAAA";

function sticker(id: string, pack: string, name: string, extra: Partial<OfficeSticker> = {}): OfficeSticker {
  return {
    id,
    pack,
    name,
    keywords: [],
    hash: id.repeat(2),
    mime: "image/png",
    size: 20_000,
    state: "active",
    ready: true,
    nameTaken: false,
    ...extra,
  };
}

function office(): OfficeSticker[] {
  return [
    sticker(S1, "Kantor", "kopi", { keywords: ["kopi", "pagi"] }),
    sticker(S2, "Kantor", "rapat", { state: "hidden" }),
    sticker(S3, "Proyek", "kopi", { nameTaken: true }),
    sticker(S4, "Proyek", "selesai", { ready: false }),
  ];
}

const PICKED: PickedSticker = {
  path: "C:\\Users\\penguji\\Gambar\\Kopi Pagi!.gif",
  name: "Kopi Pagi!",
  size: 120 * 1024,
  mime: "image/gif",
  width: 256,
  height: 200,
  frames: 12,
};

let catalog: StickerCatalog;

function sortOffice(list: OfficeSticker[]) {
  return [...list].sort((a, b) => a.pack.localeCompare(b.pack) || a.name.localeCompare(b.name));
}

function table(extra: Record<string, unknown> = {}) {
  return router({
    org_overview: overview(),
    get_directory: directory(),
    org_fingerprint: "ABCD-EFGH",
    org_users: [],
    org_departments: [],
    org_join_requests: [],
    org_labels: [],
    org_people: [],
    chat_stickers: () => catalog,
    chat_sticker_image: IMG,
    chat_sticker_pick: PICKED,
    chat_office_sticker_add: (a?: Record<string, unknown>) => {
      const added = sticker("9".repeat(32), String(a?.pack), String(a?.name), { keywords: a?.keywords as string[] });
      catalog = { ...catalog, office: sortOffice([...catalog.office, added]) };
      return added;
    },
    chat_office_sticker_update: (a?: Record<string, unknown>) => {
      const id = String(a?.id);
      const next = catalog.office
        .filter((s) => !(s.id === id && a?.state === "deleted"))
        .map((s) =>
          s.id === id
            ? {
                ...s,
                pack: String(a?.pack),
                name: String(a?.name),
                keywords: a?.keywords as string[],
                state: a?.state as "active" | "hidden",
              }
            : s,
        );
      catalog = { ...catalog, office: sortOffice(next) };
      return null;
    },
    ...(extra as Record<string, never>),
  });
}

async function openStickers(extra: Record<string, unknown> = {}) {
  invoke.mockImplementation(table(extra));
  const user = userEvent.setup();
  render(<OrgScreen state={state} onRefresh={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "Sticker" }));
  return user;
}

function calls(cmd: string) {
  return invoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  catalog = { office: office(), mine: [], canManage: true, recentEmoji: [] };
  resetStickerCatalog(null);
  clearStickerImageCache();
});

describe("Sticker: tab dan keadaan", () => {
  it("superadmin melihat tab Sticker sesudah Label", async () => {
    invoke.mockImplementation(table());
    render(<OrgScreen state={state} onRefresh={vi.fn()} />);
    const nav = await screen.findByRole("navigation", { name: "Bagian organisasi" });
    const names = within(nav)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(names.indexOf("Sticker")).toBe(names.indexOf("Label") + 1);
  });

  it("bukan superadmin tidak melihat tab Sticker dan katalog tidak diminta", async () => {
    invoke.mockImplementation(table({ org_overview: adminOverview() }));
    render(<OrgScreen state={state} onRefresh={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Anggota" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sticker" })).not.toBeInTheDocument();
    expect(calls("chat_stickers")).toHaveLength(0);
  });

  it("menampilkan teks memuat selama katalog belum datang", async () => {
    // Katalog bersama hanya punya satu permintaan berjalan: dilepas di akhir supaya tes lain tidak tertahan.
    let held = true;
    const waiting: ((c: StickerCatalog) => void)[] = [];
    await openStickers({
      chat_stickers: () => (held ? new Promise<StickerCatalog>((r) => waiting.push(r)) : catalog),
    });
    expect(screen.getByText("Memuat sticker kantor...")).toBeInTheDocument();
    expect(screen.getByText(/Gambar PNG, WebP, atau GIF, paling besar 512 KB/)).toBeInTheDocument();
    held = false;
    for (const r of waiting) r(catalog);
    expect(await screen.findByRole("heading", { name: "Kantor" })).toBeInTheDocument();
  });

  it("error menampilkan pesan Rust, Coba lagi memuat ulang", async () => {
    let fail = true;
    const user = await openStickers({
      chat_stickers: () => {
        if (fail) throw { code: "io", message: "Basis data chat terkunci." };
        return catalog;
      },
    });
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Sticker kantor belum terbaca")).toBeInTheDocument();
    expect(within(alert).getByText("Basis data chat terkunci.")).toBeInTheDocument();
    fail = false;
    await user.click(within(alert).getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByRole("heading", { name: "Kantor" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("inti yang tidak mengirim katalog dianggap error, bukan memuat selamanya", async () => {
    await openStickers({ chat_stickers: null });
    expect(await screen.findByText("Inti Mira tidak mengirim daftar sticker.")).toBeInTheDocument();
  });

  it("kosong: tanpa paket bawaan, mengajak menambah sticker milik kantor", async () => {
    catalog = { ...catalog, office: [] };
    await openStickers();
    expect(await screen.findByText(/Belum ada sticker kantor\. Mira tidak membawa sticker bawaan/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tambah sticker" })).toBeEnabled();
  });

  it("katalog tanpa hak kelola: pemberitahuan, tanpa tombol tambah", async () => {
    catalog = { ...catalog, canManage: false };
    await openStickers();
    expect(await screen.findByText("Hanya superadmin yang bisa mengelola sticker kantor.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tambah sticker" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Kantor" })).not.toBeInTheDocument();
  });

  it("daftar per paket: nama, kata kunci, status, nama dipakai, gambar belum sampai", async () => {
    await openStickers();
    const kantor = await screen.findByRole("list", { name: "Sticker di paket Kantor" });
    const rows = within(kantor).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(":kopi:");
    expect(rows[0]).toHaveTextContent("Kata kunci: kopi, pagi");
    expect(rows[0]).toHaveTextContent("Aktif");
    expect(rows[1]).toHaveTextContent(":rapat:");
    expect(rows[1]).toHaveTextContent("Tanpa kata kunci");
    expect(rows[1]).toHaveTextContent("Disembunyikan");
    expect(screen.getByText("2 sticker, 1 disembunyikan")).toBeInTheDocument();

    const proyek = screen.getByRole("list", { name: "Sticker di paket Proyek" });
    const [taken, missing] = within(proyek).getAllByRole("listitem");
    expect(taken).toHaveTextContent("Nama dipakai sticker lain");
    expect(missing).toHaveTextContent("Gambar belum sampai di laptop ini");
    expect(rows[0]).not.toHaveTextContent("Nama dipakai sticker lain");
    expect(rows[0]).not.toHaveTextContent("Gambar belum sampai");

    // Gambar hanya diminta untuk sticker yang sudah ada di laptop ini.
    await waitFor(() => expect(calls("chat_sticker_image")).toHaveLength(3));
    expect(calls("chat_sticker_image")).not.toContainEqual({ hash: S4.repeat(2) });
  });
});

describe("Sticker: tambah", () => {
  it("pilih gambar, isi form, lalu memanggil addOfficeSticker dengan argumen benar", async () => {
    const user = await openStickers();
    const add = await screen.findByRole("button", { name: "Tambah sticker" });
    await user.click(add);

    const dialog = await screen.findByRole("dialog", { name: "Tambah sticker kantor" });
    expect(within(dialog).getByText("Kopi Pagi!.gif")).toBeInTheDocument();
    expect(within(dialog).getByText("120 KB, 256 x 200 piksel, animasi 12 frame")).toBeInTheDocument();
    const name = within(dialog).getByLabelText("Nama");
    expect(name).toHaveValue("kopi_pagi");
    expect(within(dialog).getByText("Ditulis di chat sebagai :kopi_pagi:")).toBeInTheDocument();
    const pack = within(dialog).getByLabelText("Paket");
    expect(pack).toHaveValue("Kantor");
    // Paket yang sudah ada ditawarkan sebagai pilihan.
    const options = [...document.querySelectorAll(`#${CSS.escape(pack.getAttribute("list") ?? "")} option`)].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(options).toEqual(["Kantor", "Proyek"]);

    await user.clear(pack);
    await user.type(pack, "  Maskot   kantor ");
    await user.type(within(dialog).getByLabelText("Kata kunci (boleh kosong)"), "Kopi, pagi kopi");
    await user.click(within(dialog).getByRole("button", { name: "Tambah sticker" }));

    expect(calls("chat_office_sticker_add")).toEqual([
      { path: PICKED.path, pack: "Maskot kantor", name: "kopi_pagi", keywords: ["kopi", "pagi"] },
    ]);
    expect(await screen.findByText("Sticker :kopi_pagi: ditambahkan ke paket Maskot kantor.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByRole("heading", { name: "Maskot kantor" })).toBeInTheDocument();
    await waitFor(() => expect(add).toHaveFocus());
  });

  it("pemilih dibatalkan: tidak ada dialog dan tidak ada panggilan tambah", async () => {
    const user = await openStickers({ chat_sticker_pick: null });
    await user.click(await screen.findByRole("button", { name: "Tambah sticker" }));
    await waitFor(() => expect(calls("chat_sticker_pick")).toHaveLength(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls("chat_office_sticker_add")).toHaveLength(0);
  });

  it("error pemilih gambar tampil di panel", async () => {
    const user = await openStickers({ chat_sticker_pick: rustError("bad_image", "File ini bukan PNG, WebP, atau GIF.") });
    await user.click(await screen.findByRole("button", { name: "Tambah sticker" }));
    expect(await screen.findByText("File ini bukan PNG, WebP, atau GIF.")).toBeInTheDocument();
    expect(screen.getByText("Gambar belum bisa dipilih")).toBeInTheDocument();
  });

  it("validasi nama, paket, dan kata kunci sebelum memanggil Rust", async () => {
    const user = await openStickers();
    await user.click(await screen.findByRole("button", { name: "Tambah sticker" }));
    const dialog = await screen.findByRole("dialog", { name: "Tambah sticker kantor" });
    const name = within(dialog).getByLabelText("Nama");
    const pack = within(dialog).getByLabelText("Paket");
    const words = within(dialog).getByLabelText("Kata kunci (boleh kosong)");
    const submit = within(dialog).getByRole("button", { name: "Tambah sticker" });

    await user.clear(name);
    await user.click(submit);
    expect(within(dialog).getByText("Isi nama sticker dulu.")).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveFocus();

    await user.type(name, "Kopi-Pagi");
    await user.click(submit);
    expect(within(dialog).getByText(/Nama hanya boleh huruf kecil a sampai z/)).toBeInTheDocument();

    await user.clear(name);
    await user.type(name, "rapat");
    await user.click(submit);
    expect(within(dialog).getByText("Nama :rapat: sudah dipakai sticker lain di paket Kantor.")).toBeInTheDocument();

    await user.clear(name);
    await user.type(name, "baru");
    await user.clear(pack);
    await user.click(submit);
    expect(within(dialog).getByText("Isi nama paket dulu.")).toBeInTheDocument();
    expect(pack).toHaveFocus();

    await user.type(pack, "a".repeat(31));
    await user.click(submit);
    expect(within(dialog).getByText("Nama paket paling banyak 30 karakter (sekarang 31).")).toBeInTheDocument();

    await user.clear(pack);
    await user.type(pack, "Kantor");
    await user.type(words, "a b c d e f g h i");
    await user.click(submit);
    expect(within(dialog).getByText("Kata kunci paling banyak 8 (sekarang 9).")).toBeInTheDocument();
    expect(words).toHaveFocus();

    expect(calls("chat_office_sticker_add")).toHaveLength(0);
  }, 20_000);

  it("error Rust saat menambah tampil di dialog", async () => {
    const user = await openStickers({ chat_office_sticker_add: rustError("forbidden", "Hanya superadmin yang boleh.") });
    await user.click(await screen.findByRole("button", { name: "Tambah sticker" }));
    const dialog = await screen.findByRole("dialog", { name: "Tambah sticker kantor" });
    await user.click(within(dialog).getByRole("button", { name: "Tambah sticker" }));
    expect(await within(dialog).findByText("Hanya superadmin yang boleh.")).toBeInTheDocument();
    expect(within(dialog).getByText("Sticker belum ditambahkan")).toBeInTheDocument();
  });
});

describe("Sticker: ubah, sembunyikan, tampilkan, hapus", () => {
  it("Sembunyikan dan Tampilkan memanggil update dengan state yang benar", async () => {
    const user = await openStickers();
    await user.click((await screen.findAllByRole("button", { name: "Sembunyikan :kopi:" }))[0]);
    await waitFor(() =>
      expect(calls("chat_office_sticker_update")).toEqual([
        { id: S1, pack: "Kantor", name: "kopi", keywords: ["kopi", "pagi"], state: "hidden" },
      ]),
    );
    expect(await screen.findByText("Sticker :kopi: disembunyikan dari pemilih semua anggota.")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Tampilkan :rapat:" }));
    await waitFor(() => expect(calls("chat_office_sticker_update")).toHaveLength(2));
    expect(calls("chat_office_sticker_update")[1]).toEqual({
      id: S2,
      pack: "Kantor",
      name: "rapat",
      keywords: [],
      state: "active",
    });
  });

  it("Sembunyikan semua memperbarui setiap sticker aktif di paket itu", async () => {
    const user = await openStickers();
    await user.click(await screen.findByRole("button", { name: "Sembunyikan semua, paket Proyek" }));
    await waitFor(() => expect(calls("chat_office_sticker_update")).toHaveLength(2));
    expect(calls("chat_office_sticker_update").map((a) => [a?.id, a?.state])).toEqual([
      [S3, "hidden"],
      [S4, "hidden"],
    ]);
    expect(await screen.findByText("2 sticker di paket Proyek disembunyikan.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Tampilkan semua, paket Proyek" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sembunyikan semua, paket Proyek" })).not.toBeInTheDocument();
  });

  it("Hapus meminta konfirmasi; Escape membatalkan dan fokus kembali", async () => {
    const user = await openStickers();
    const del = (await screen.findAllByRole("button", { name: "Hapus :kopi:" }))[0];
    await user.click(del);
    const dialog = screen.getByRole("dialog", { name: "Hapus sticker :kopi:?" });
    expect(
      within(dialog).getByText("Sticker hilang dari pemilih semua anggota. Pesan yang sudah terkirim tetap ada."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Batal" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls("chat_office_sticker_update")).toHaveLength(0);
    expect(del).toHaveFocus();
  });

  it("Hapus memanggil update dengan state deleted lalu fokus ke Tambah sticker", async () => {
    const user = await openStickers();
    await user.click((await screen.findAllByRole("button", { name: "Hapus :kopi:" }))[0]);
    const dialog = screen.getByRole("dialog", { name: "Hapus sticker :kopi:?" });
    await user.click(within(dialog).getByRole("button", { name: "Hapus :kopi:" }));
    expect(calls("chat_office_sticker_update")).toEqual([
      { id: S1, pack: "Kantor", name: "kopi", keywords: ["kopi", "pagi"], state: "deleted" },
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("Sticker :kopi: dihapus.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Tambah sticker" })).toHaveFocus());
    // :kopi: di paket Proyek (S3) masih ada.
    expect(screen.getAllByRole("button", { name: "Hapus :kopi:" })).toHaveLength(1);
  });

  it("Ubah menyimpan nama, paket, kata kunci dengan state yang sama, lalu fokus ke tombol Ubah", async () => {
    const user = await openStickers();
    await user.click(await screen.findByRole("button", { name: "Ubah :selesai:" }));
    const dialog = screen.getByRole("dialog", { name: "Ubah sticker :selesai:" });
    const pack = within(dialog).getByLabelText("Paket");
    expect(pack).toHaveValue("Proyek");
    await user.clear(pack);
    await user.type(pack, "Kantor");
    await user.type(within(dialog).getByLabelText("Kata kunci (boleh kosong)"), "beres");
    await user.click(within(dialog).getByRole("button", { name: "Simpan perubahan" }));

    expect(calls("chat_office_sticker_update")).toEqual([
      { id: S4, pack: "Kantor", name: "selesai", keywords: ["beres"], state: "active" },
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const kantor = screen.getByRole("list", { name: "Sticker di paket Kantor" });
    const button = within(kantor).getByRole("button", { name: "Ubah :selesai:" });
    await waitFor(() => expect(button).toHaveFocus());
  });

  it("Ubah tanpa perubahan menutup dialog tanpa memanggil Rust", async () => {
    const user = await openStickers();
    await user.click(await screen.findByRole("button", { name: "Ubah :rapat:" }));
    const dialog = screen.getByRole("dialog", { name: "Ubah sticker :rapat:" });
    await user.click(within(dialog).getByRole("button", { name: "Simpan perubahan" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls("chat_office_sticker_update")).toHaveLength(0);
  });
});

describe("Sticker: keyboard", () => {
  it("Tab berjalan dari Tambah sticker ke aksi paket lalu aksi baris", async () => {
    const user = await openStickers();
    const add = await screen.findByRole("button", { name: "Tambah sticker" });
    await screen.findByRole("heading", { name: "Kantor" });
    add.focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Sembunyikan semua, paket Kantor" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Tampilkan semua, paket Kantor" })).toHaveFocus();
    await user.tab();
    expect(screen.getAllByRole("button", { name: "Ubah :kopi:" })[0]).toHaveFocus();
    await user.tab();
    expect(screen.getAllByRole("button", { name: "Sembunyikan :kopi:" })[0]).toHaveFocus();
    await user.tab();
    expect(screen.getAllByRole("button", { name: "Hapus :kopi:" })[0]).toHaveFocus();

    // Enter membuka dialog Ubah; Escape menutupnya dan fokus kembali ke tombol itu.
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Ubah sticker :kopi:" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nama")).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: "Ubah :kopi:" })[0]).toHaveFocus();
  });
});

describe("Sticker: pembantu", () => {
  it("saran nama dari nama file", () => {
    expect(suggestName("Kopi Pagi!")).toBe("kopi_pagi");
    expect(suggestName("a")).toBe("");
    expect(suggestName("")).toBe("");
    expect(suggestName("x".repeat(40))).toHaveLength(32);
  });

  it("kata kunci dipisah koma atau spasi, huruf kecil, tanpa duplikat", () => {
    expect(parseKeywords(" Kopi,pagi  KOPI ,, ")).toEqual(["kopi", "pagi"]);
    expect(parseKeywords("")).toEqual([]);
  });
});
