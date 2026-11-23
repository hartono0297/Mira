import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary } from "../../api/chat";
import type { ConvRequest } from "./ChatActions";
import { ChatScreen } from "./ChatScreen";
import { ConversationHeader } from "./ConversationHeader";
import { channel, CH, GR, group, groupView, orgPeople } from "./conversationTestData";
import type { GroupState } from "./GroupMembers";
import {
  DM_B,
  GRUP,
  GRUP_ID,
  LAMA,
  PROYEK,
  PROYEK_CHAT,
  TIM_ID,
  UMUM,
  overview,
  summary,
} from "./testData";

const chat = vi.hoisted(() => ({
  overview: vi.fn(),
  setFolded: vi.fn(),
  setNotify: vi.fn(),
  openDm: vi.fn(),
  markRead: vi.fn(),
  setMuted: vi.fn(),
  setArchived: vi.fn(),
  setLocked: vi.fn(),
  deleteChannel: vi.fn(),
  groupLeave: vi.fn(),
  groupRename: vi.fn(),
  groupAdd: vi.fn(),
}));
const org = vi.hoisted(() => ({ people: vi.fn() }));

vi.mock("../../api/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/chat")>()),
  chatApi: chat,
  subscribeChat: () => () => {},
}));

vi.mock("../../api/org", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/org")>()),
  orgApi: org,
}));

// Panel percakapan diuji terpisah. Tiruan ini memperlihatkan permintaan dari menu sidebar.
vi.mock("./Conversation", () => ({
  Conversation: ({
    summary: s,
    request,
    onRequestDone,
  }: {
    summary: ConversationSummary;
    request: ConvRequest | null;
    onRequestDone: () => void;
  }) => (
    <section aria-label="Percakapan tiruan">
      <h2>{s.kind === "channel" ? `#${s.name}` : s.name}</h2>
      {request?.conv === s.id && <p>Permintaan {request.action}</p>}
      <button type="button" onClick={onRequestDone}>
        Selesai tiruan
      </button>
    </section>
  ),
}));

const list = () => screen.getByRole("navigation", { name: "Daftar percakapan" });
const row = (name: RegExp) => within(list()).getByRole("button", { name });
const panelHeading = async (name: string) =>
  within(await screen.findByRole("region", { name: "Percakapan tiruan" })).findByRole("heading", { name });
const itemNames = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitem")
    .map((m) => m.getAttribute("data-label"));

async function rightClick(user: ReturnType<typeof userEvent.setup>, target: HTMLElement) {
  await user.pointer({ keys: "[MouseRight]", target });
}

async function menuOf(user: ReturnType<typeof userEvent.setup>, rowName: RegExp, title: string) {
  await rightClick(user, row(rowName));
  return screen.getByRole("menu", { name: `Aksi untuk ${title}` });
}

async function renderScreen(conversations: ConversationSummary[] = overview().conversations) {
  chat.overview.mockResolvedValue(overview({ conversations }));
  const user = userEvent.setup();
  render(<ChatScreen />);
  await panelHeading("#umum");
  return user;
}

beforeEach(() => {
  for (const fn of Object.values(chat)) fn.mockReset();
  chat.setFolded.mockResolvedValue(null);
  chat.markRead.mockResolvedValue(null);
  chat.setMuted.mockResolvedValue(null);
  chat.setArchived.mockResolvedValue(null);
  chat.setLocked.mockResolvedValue(null);
  chat.deleteChannel.mockResolvedValue(null);
  chat.groupLeave.mockResolvedValue(null);
  chat.groupRename.mockResolvedValue(null);
  chat.groupAdd.mockResolvedValue(null);
  org.people.mockResolvedValue(orgPeople);
});

describe("Menu baris percakapan: isi sesuai jenis dan hak", () => {
  it("channel dengan pesan belum dibaca, boleh arsip dan hapus", async () => {
    const user = await renderScreen();
    const menu = await menuOf(user, /^Channel tim-uji/, "#tim-uji");
    expect(itemNames(menu)).toEqual(["Buka", "Tandai sudah dibaca", "Bisukan", "Arsipkan channel", "Hapus channel"]);
    expect(within(menu).getByRole("menuitem", { name: "Hapus channel" })).toHaveClass("cmenu-danger");
  });

  it("#umum: tanpa arsip dan hapus; channel diarsipkan: Kembalikan dari arsip", async () => {
    const user = await renderScreen();
    expect(itemNames(await menuOf(user, /^Channel umum($|,)/, "#umum"))).toEqual(["Buka", "Bisukan"]);
    await user.keyboard("{Escape}");
    expect(itemNames(await menuOf(user, /^Channel acara-lama/, "#acara-lama"))).toEqual([
      "Buka",
      "Bisukan",
      "Kembalikan dari arsip",
      "Hapus channel",
    ]);
  });

  it("superadmin: Jadikan hanya-baca dan Buka untuk semua; dibisukan: Bunyikan", async () => {
    const pengumuman = summary(TIM_ID, "pengumuman", { canLock: true, canArchive: false, canDelete: false });
    const user = await renderScreen([UMUM, pengumuman, PROYEK]);
    expect(itemNames(await menuOf(user, /^Channel pengumuman/, "#pengumuman"))).toEqual([
      "Buka",
      "Bisukan",
      "Jadikan hanya-baca",
    ]);
    await user.keyboard("{Escape}");
    expect(itemNames(await menuOf(user, /^Channel proyek-alfa/, "#proyek-alfa"))).toEqual([
      "Buka",
      "Tandai sudah dibaca",
      "Bunyikan",
      "Arsipkan channel",
      "Hapus channel",
    ]);
    await user.keyboard("{Escape}");
    const locked = summary(TIM_ID, "pengumuman", { canLock: true, locked: true, canArchive: false, canDelete: false });
    chat.overview.mockResolvedValue(overview({ conversations: [UMUM, locked] }));
    await user.click(within(await menuOf(user, /^Channel pengumuman/, "#pengumuman")).getByRole("menuitem", { name: "Jadikan hanya-baca" }));
    expect(chat.setLocked).toHaveBeenCalledWith(TIM_ID, true);
    await waitFor(() => expect(row(/^Channel pengumuman, hanya-baca/)).toBeInTheDocument());
    expect(itemNames(await menuOf(user, /^Channel pengumuman/, "#pengumuman"))).toContain("Buka untuk semua");
  });

  it("grup: Ganti nama, Tambah orang, Keluar dari grup; grup lama hanya Bisukan", async () => {
    const former = summary(`gr:${"6".repeat(32)}`, "Grup lama", { former: true, canArchive: false, canDelete: false });
    const user = await renderScreen([UMUM, GRUP, former]);
    expect(itemNames(await menuOf(user, /^Grup Persiapan pameran/, "Persiapan pameran"))).toEqual([
      "Buka",
      "Bisukan",
      "Ganti nama",
      "Tambah orang",
      "Keluar dari grup",
    ]);
    await user.keyboard("{Escape}");
    expect(itemNames(await menuOf(user, /^Grup Grup lama/, "Grup lama"))).toEqual(["Buka", "Bisukan"]);
  });

  it("chat proyek tanpa arsip dan hapus, kecuali arsip lama; pesan pribadi tanpa hapus", async () => {
    const oldArchive = summary(`ch:${"e".repeat(32)}`, "Gudang Lama", {
      kind: "project",
      section: "proyek",
      archived: true,
      canArchive: true,
      canDelete: true,
    });
    const user = await renderScreen([UMUM, { ...PROYEK_CHAT, canArchive: true, canDelete: true }, oldArchive, DM_B]);
    expect(itemNames(await menuOf(user, /^Chat proyek Gudang Baru/, "Gudang Baru"))).toEqual(["Buka", "Bisukan"]);
    await user.keyboard("{Escape}");
    expect(itemNames(await menuOf(user, /^Chat proyek Gudang Lama/, "Gudang Lama"))).toEqual([
      "Buka",
      "Bisukan",
      "Kembalikan dari arsip",
    ]);
    await user.keyboard("{Escape}");
    expect(itemNames(await menuOf(user, /^Pesan pribadi dengan Rekan Bayu/, "Rekan Bayu"))).toEqual([
      "Buka",
      "Tandai sudah dibaca",
      "Bisukan",
    ]);
  });
});

describe("Menu baris percakapan: keyboard", () => {
  it("Shift+F10 membuka menu, panah dan Enter menjalankan, Esc mengembalikan fokus ke baris", async () => {
    const user = await renderScreen();
    const tim = row(/^Channel tim-uji/);
    tim.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const menu = screen.getByRole("menu", { name: "Aksi untuk #tim-uji" });
    expect(within(menu).getByRole("menuitem", { name: "Buka" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(tim).toHaveFocus();

    await user.keyboard("{Shift>}{F10}{/Shift}");
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Tandai sudah dibaca" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(chat.markRead).toHaveBeenCalledWith(TIM_ID);
    expect(tim).toHaveFocus();
    await waitFor(() => expect(chat.overview).toHaveBeenCalledTimes(2));
  });

  it("panah atas dan bawah tetap berpindah antarbaris", async () => {
    const user = await renderScreen();
    row(/^Channel umum($|,)/).focus();
    await user.keyboard("{ArrowDown}");
    expect(row(/^Channel acara-lama/)).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(row(/^Channel tim-uji/)).toHaveFocus();
  });

  it("Buka memilih percakapan", async () => {
    const user = await renderScreen();
    await user.click(within(await menuOf(user, /^Grup Persiapan pameran/, "Persiapan pameran")).getByRole("menuitem", { name: "Buka" }));
    expect(await panelHeading("Persiapan pameran")).toBeInTheDocument();
  });
});

describe("Menu baris percakapan: aksi", () => {
  it("Bisukan memanggil setMuted lalu memuat ulang daftar", async () => {
    const user = await renderScreen();
    await user.click(within(await menuOf(user, /^Grup Persiapan pameran/, "Persiapan pameran")).getByRole("menuitem", { name: "Bisukan" }));
    expect(chat.setMuted).toHaveBeenCalledWith(GRUP_ID, true);
    await waitFor(() => expect(chat.overview).toHaveBeenCalledTimes(2));
  });

  it("Bunyikan dan Kembalikan dari arsip memanggil kebalikannya", async () => {
    const user = await renderScreen();
    await user.click(within(await menuOf(user, /^Channel proyek-alfa/, "#proyek-alfa")).getByRole("menuitem", { name: "Bunyikan" }));
    expect(chat.setMuted).toHaveBeenCalledWith(PROYEK.id, false);
    await user.click(
      within(await menuOf(user, /^Channel acara-lama/, "#acara-lama")).getByRole("menuitem", { name: "Kembalikan dari arsip" }),
    );
    expect(chat.setArchived).toHaveBeenCalledWith(LAMA.id, false);
  });

  it("error aksi langsung tampil di atas daftar dan bisa ditutup", async () => {
    chat.setArchived.mockRejectedValue({ code: "forbidden", message: "Hanya admin yang bisa mengarsipkan." });
    const user = await renderScreen();
    await user.click(within(await menuOf(user, /^Channel tim-uji/, "#tim-uji")).getByRole("menuitem", { name: "Arsipkan channel" }));
    expect(await within(list()).findByText("Arsip belum bisa diubah")).toBeInTheDocument();
    expect(within(list()).getByText("#tim-uji: Hanya admin yang bisa mengarsipkan.")).toBeInTheDocument();
    expect(chat.overview).toHaveBeenCalledTimes(1);
    await user.click(within(list()).getByRole("button", { name: "Tutup" }));
    expect(within(list()).queryByText("Arsip belum bisa diubah")).toBeNull();
  });

  it("Keluar dari grup meminta konfirmasi, lalu groupLeave dan kembali ke #umum", async () => {
    const user = await renderScreen();
    await user.click(row(/^Grup Persiapan pameran/));
    await panelHeading("Persiapan pameran");
    await user.click(
      within(await menuOf(user, /^Grup Persiapan pameran/, "Persiapan pameran")).getByRole("menuitem", { name: "Keluar dari grup" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Keluar dari grup Persiapan pameran?" });
    expect(dialog).toHaveTextContent("Pesan lama tetap tersimpan di laptop ini.");
    expect(dialog).toHaveTextContent("Kalau Anda pemilik grup, peran pemilik pindah ke anggota yang paling lama di grup.");
    expect(chat.groupLeave).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Keluar dari grup" }));
    expect(chat.groupLeave).toHaveBeenCalledWith(GRUP_ID);
    expect(await panelHeading("#umum")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Hapus channel meminta konfirmasi lalu deleteChannel; error tampil di dialog", async () => {
    chat.deleteChannel.mockRejectedValueOnce({ code: "forbidden", message: "Hanya admin." });
    const user = await renderScreen();
    await user.click(row(/^Channel tim-uji/));
    await panelHeading("#tim-uji");
    await user.click(within(await menuOf(user, /^Channel tim-uji/, "#tim-uji")).getByRole("menuitem", { name: "Hapus channel" }));
    const dialog = await screen.findByRole("dialog", { name: "Hapus channel #tim-uji?" });
    expect(dialog).toHaveTextContent("Semua pesan di #tim-uji dihapus untuk semua anggota.");
    await user.click(within(dialog).getByRole("button", { name: "Hapus channel" }));
    expect(await within(dialog).findByText("Hanya admin.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Hapus channel" }));
    expect(chat.deleteChannel).toHaveBeenLastCalledWith(TIM_ID);
    expect(await panelHeading("#umum")).toBeInTheDocument();
  });

  it("Ganti nama dan Tambah orang membuka percakapan dan meneruskan permintaannya", async () => {
    const user = await renderScreen();
    await user.click(
      within(await menuOf(user, /^Grup Persiapan pameran/, "Persiapan pameran")).getByRole("menuitem", { name: "Ganti nama" }),
    );
    expect(await panelHeading("Persiapan pameran")).toBeInTheDocument();
    expect(screen.getByText("Permintaan rename")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Selesai tiruan" }));
    expect(screen.queryByText(/Permintaan/)).toBeNull();
    await user.click(
      within(await menuOf(user, /^Grup Persiapan pameran/, "Persiapan pameran")).getByRole("menuitem", { name: "Tambah orang" }),
    );
    expect(screen.getByText("Permintaan add")).toBeInTheDocument();
  });
});

function groupState(extra: Partial<GroupState> = {}): GroupState {
  return { group: groupView(), loading: false, error: null, reload: vi.fn().mockResolvedValue(undefined), ...extra };
}

function renderHeader(s: ConversationSummary, state: GroupState = groupState({ group: null }), request: ConvRequest | null = null) {
  const props = { onChanged: vi.fn(), onGone: vi.fn(), onRequestDone: vi.fn() };
  const view = render(<ConversationHeader summary={s} groupState={state} request={request} {...props} />);
  const rerender = (next: GroupState, req: ConvRequest | null = request) =>
    view.rerender(<ConversationHeader summary={s} groupState={next} request={req} {...props} />);
  return { ...props, rerender };
}

describe("Menu kepala percakapan", () => {
  it("berisi aksi yang sama dengan menu baris, tanpa Buka dan Tandai sudah dibaca", async () => {
    const user = userEvent.setup();
    renderHeader(channel({ unread: 4 }));
    await user.click(screen.getByRole("button", { name: "Menu #proyek-a" }));
    expect(itemNames(screen.getByRole("menu", { name: "Aksi untuk #proyek-a" }))).toEqual([
      "Bisukan",
      "Arsipkan channel",
      "Hapus channel",
    ]);
  });

  it("grup: Bisukan, Ganti nama, Tambah orang, Keluar dari grup", async () => {
    const user = userEvent.setup();
    const { onChanged, onGone } = renderHeader(group(), groupState());
    await user.click(screen.getByRole("button", { name: "Menu Persiapan pameran" }));
    const menu = screen.getByRole("menu", { name: "Aksi untuk Persiapan pameran" });
    expect(itemNames(menu)).toEqual(["Bisukan", "Ganti nama", "Tambah orang", "Keluar dari grup"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Keluar dari grup" }));
    const dialog = await screen.findByRole("dialog", { name: "Keluar dari grup Persiapan pameran?" });
    await user.click(within(dialog).getByRole("button", { name: "Keluar dari grup" }));
    expect(chat.groupLeave).toHaveBeenCalledWith(GR);
    await waitFor(() => expect(onGone).toHaveBeenCalledTimes(1));
    expect(onChanged).toHaveBeenCalled();
  });

  it("klik kanan di judul membuka menu yang sama", async () => {
    const user = userEvent.setup();
    renderHeader(channel());
    await rightClick(user, screen.getByRole("heading", { name: "#proyek-a" }));
    expect(itemNames(screen.getByRole("menu", { name: "Aksi untuk #proyek-a" }))).toEqual([
      "Bisukan",
      "Arsipkan channel",
      "Hapus channel",
    ]);
  });

  it("Bisukan dari kepala memanggil setMuted; error tampil di bawah kepala", async () => {
    const user = userEvent.setup();
    chat.setMuted.mockRejectedValueOnce({ code: "io", message: "Disk penuh." });
    const { onChanged } = renderHeader(channel());
    await user.click(screen.getByRole("button", { name: "Menu #proyek-a" }));
    await user.click(screen.getByRole("menuitem", { name: "Bisukan" }));
    expect(chat.setMuted).toHaveBeenCalledWith(CH, true);
    expect(await screen.findByText("Notifikasi belum bisa diubah")).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("permintaan Ganti nama dari sidebar membuka dialog begitu data grup siap", async () => {
    const request: ConvRequest = { conv: GR, action: "rename", n: 1 };
    const { onRequestDone, rerender } = renderHeader(group(), groupState({ group: null, loading: true }), request);
    expect(onRequestDone).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(groupState(), null);
    const dialog = await screen.findByRole("dialog", { name: "Ganti nama grup" });
    expect(within(dialog).getByLabelText("Nama grup")).toHaveValue("Persiapan pameran");
  });

  it("permintaan Tambah orang membuka dialog tambah orang", async () => {
    renderHeader(group(), groupState(), { conv: GR, action: "add", n: 2 });
    expect(await screen.findByRole("dialog", { name: "Tambah orang ke Persiapan pameran" })).toBeInTheDocument();
  });

  it("data grup gagal dimuat: error tampil di bawah kepala, Coba lagi membuka dialog yang diminta", async () => {
    const user = userEvent.setup();
    const reload = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHeader(group(), groupState({ group: null, loading: true, reload }), {
      conv: GR,
      action: "rename",
      n: 3,
    });
    rerender(groupState({ group: null, error: { code: "io", message: "Berkas grup terkunci." }, reload }), null);

    expect(await screen.findByText("Data grup belum bisa dimuat")).toBeInTheDocument();
    expect(screen.getByText("Berkas grup terkunci.")).toBeInTheDocument();
    expect(screen.getByText("Ganti nama terbuka begitu data grup termuat.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();

    // Muat ulang masih gagal: permintaan tetap disimpan.
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Data grup belum bisa dimuat")).toBeInTheDocument();

    rerender(groupState({ reload }), null);
    const dialog = await screen.findByRole("dialog", { name: "Ganti nama grup" });
    expect(within(dialog).getByLabelText("Nama grup")).toHaveValue("Persiapan pameran");
    expect(screen.queryByText("Data grup belum bisa dimuat")).toBeNull();
  });

  it("data grup gagal dimuat: Tambah orang dari menu kepala menampilkan error; Batal membuang permintaan", async () => {
    const user = userEvent.setup();
    const failed = groupState({ group: null, error: { code: "io", message: "Berkas grup terkunci." } });
    const { rerender } = renderHeader(group(), failed);
    const menuButton = screen.getByRole("button", { name: "Menu Persiapan pameran" });
    await user.click(menuButton);
    await user.click(screen.getByRole("menuitem", { name: "Tambah orang" }));

    expect(await screen.findByText("Tambah orang terbuka begitu data grup termuat.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Batal" }));
    expect(screen.queryByText("Data grup belum bisa dimuat")).toBeNull();
    expect(menuButton).toHaveFocus();

    // Permintaan sudah dibuang: data grup yang datang kemudian tidak membuka dialog.
    rerender(groupState(), null);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
