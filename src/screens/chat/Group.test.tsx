import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary } from "../../api/chat";
import { Conversation } from "./Conversation";
import { buildTimeline } from "./MessageList";
import {
  budi,
  channel,
  CH,
  event,
  GR,
  group,
  groupView,
  groupViewAsMember,
  ME,
  message,
  orgPeople,
  PK_B,
  PK_D,
  sari,
  today,
  view,
} from "./conversationTestData";

const chat = vi.hoisted(() => ({
  messages: vi.fn(),
  markRead: vi.fn(),
  setMuted: vi.fn(),
  setArchived: vi.fn(),
  deleteChannel: vi.fn(),
  setLocked: vi.fn(),
  group: vi.fn(),
  groupAdd: vi.fn(),
  groupRemove: vi.fn(),
  groupLeave: vi.fn(),
  groupRename: vi.fn(),
  send: vi.fn(),
  pickFiles: vi.fn(),
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

function renderConv(summary: ConversationSummary = group()) {
  const onChanged = vi.fn();
  const onGone = vi.fn();
  render(<Conversation summary={summary} me={ME} onChanged={onChanged} onGone={onGone} />);
  return { onChanged, onGone };
}

async function openMembers(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Grup · 3 anggota" }));
  return screen.findByRole("dialog", { name: "Anggota grup (3)" });
}

beforeEach(() => {
  chat.messages.mockResolvedValue(view([message({ conv: GR })], { conversation: group(), events: [event()] }));
  chat.markRead.mockResolvedValue(null);
  chat.setMuted.mockResolvedValue(null);
  chat.setLocked.mockResolvedValue(null);
  chat.group.mockResolvedValue(groupView());
  chat.groupAdd.mockResolvedValue(null);
  chat.groupRemove.mockResolvedValue(null);
  chat.groupLeave.mockResolvedValue(null);
  chat.groupRename.mockResolvedValue(null);
  chat.pickFiles.mockResolvedValue([]);
  org.people.mockResolvedValue(orgPeople);
});

describe("Grup: kepala dan daftar anggota", () => {
  it("kepala grup: nama, jumlah anggota, Tambah orang", async () => {
    renderConv();
    expect(screen.getByRole("heading", { name: "Persiapan pameran" })).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Grup · 3 anggota" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(await screen.findByRole("button", { name: "Tambah orang" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Pesan untuk Persiapan pameran" })).toBeInTheDocument();
  });

  it("pemilik: departemen, Pemilik grup, Keluarkan untuk orang lain", async () => {
    const user = userEvent.setup();
    renderConv();
    const panel = await openMembers(user);
    expect(screen.getByRole("button", { name: "Grup · 3 anggota" })).toHaveAttribute("aria-expanded", "true");
    const rows = within(panel).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Penguji (Anda)");
    expect(within(rows[0]).getByText("Pemilik grup")).toBeInTheDocument();
    expect(within(rows[0]).queryByRole("button")).toBeNull();
    await waitFor(() => expect(rows[1]).toHaveTextContent("Drafting"));
    expect(within(panel).getByRole("button", { name: "Keluarkan Sari Uji dari grup" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Keluarkan Budi Uji dari grup" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Keluar dari grup" })).toBeInTheDocument();
  });

  it("Keluarkan lewat konfirmasi memanggil groupRemove", async () => {
    const user = userEvent.setup();
    const { onChanged } = renderConv();
    const panel = await openMembers(user);
    await user.click(within(panel).getByRole("button", { name: "Keluarkan Sari Uji dari grup" }));
    const dlg = screen.getByRole("dialog", { name: "Keluarkan Sari Uji dari grup?" });
    expect(dlg).toHaveTextContent("Sari Uji tidak menerima pesan baru lagi; pesan lama tetap di laptopnya.");
    await user.click(within(dlg).getByRole("button", { name: "Keluarkan" }));
    await waitFor(() => expect(chat.groupRemove).toHaveBeenCalledWith(GR, PK_B));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: "Keluarkan Sari Uji dari grup?" })).toBeNull();
  });

  it("anggota biasa: tanpa Keluarkan, Keluar dari grup memanggil groupLeave lalu onGone", async () => {
    const user = userEvent.setup();
    chat.group.mockResolvedValue(groupViewAsMember());
    const { onChanged, onGone } = renderConv();
    const panel = await openMembers(user);
    await within(panel).findByText("Penguji (Anda)");
    expect(within(panel).queryByRole("button", { name: /^Keluarkan/ })).toBeNull();
    expect(within(panel).getAllByRole("listitem")[0]).toHaveTextContent("Pemilik grup");
    await user.click(within(panel).getByRole("button", { name: "Keluar dari grup" }));
    const dlg = screen.getByRole("dialog", { name: "Keluar dari grup Persiapan pameran?" });
    await user.click(within(dlg).getByRole("button", { name: "Keluar dari grup" }));
    await waitFor(() => expect(chat.groupLeave).toHaveBeenCalledWith(GR));
    await waitFor(() => expect(onGone).toHaveBeenCalled());
    expect(onChanged).toHaveBeenCalled();
    expect(chat.groupLeave.mock.invocationCallOrder[0]).toBeLessThan(onGone.mock.invocationCallOrder[0]);
  });

  it("error saat keluar tampil di konfirmasi, onGone tidak dipanggil", async () => {
    const user = userEvent.setup();
    chat.groupLeave.mockRejectedValue({ code: "x", message: "Laptop belum tersambung." });
    const { onGone } = renderConv();
    const panel = await openMembers(user);
    await user.click(within(panel).getByRole("button", { name: "Keluar dari grup" }));
    const dlg = screen.getByRole("dialog", { name: /^Keluar dari grup/ });
    await user.click(within(dlg).getByRole("button", { name: "Keluar dari grup" }));
    expect(await within(dlg).findByText("Laptop belum tersambung.")).toBeInTheDocument();
    expect(onGone).not.toHaveBeenCalled();
  });

  it("Escape menutup daftar anggota dan fokus kembali ke tombol", async () => {
    const user = userEvent.setup();
    renderConv();
    await openMembers(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Anggota grup (3)" })).toBeNull();
    expect(screen.getByRole("button", { name: "Grup · 3 anggota" })).toHaveFocus();
  });

  it("daftar anggota gagal dimuat: error dengan Coba lagi", async () => {
    const user = userEvent.setup();
    chat.group.mockRejectedValue({ code: "x", message: "Data grup rusak." });
    renderConv();
    const panel = await openMembers(user);
    expect(await within(panel).findByText("Daftar anggota belum bisa dimuat")).toBeInTheDocument();
    expect(within(panel).getByText("Data grup rusak.")).toBeInTheDocument();
    chat.group.mockResolvedValue(groupView());
    await user.click(within(panel).getByRole("button", { name: "Coba lagi" }));
    expect(await within(panel).findByText("Penguji (Anda)")).toBeInTheDocument();
    // Tanpa data grup, Tambah orang tidak tampil sampai data datang.
    expect(screen.getByRole("button", { name: "Tambah orang" })).toBeInTheDocument();
  });

  it("memuat daftar anggota", async () => {
    const user = userEvent.setup();
    chat.group.mockReturnValue(new Promise(() => {}));
    renderConv();
    const panel = await openMembers(user);
    expect(within(panel).getByRole("status")).toHaveTextContent("Memuat anggota...");
  });
});

describe("Grup: tambah orang dan ganti nama", () => {
  it("Tambah orang memakai kandidat dan memanggil groupAdd", async () => {
    const user = userEvent.setup();
    const { onChanged } = renderConv();
    await user.click(await screen.findByRole("button", { name: "Tambah orang" }));
    const dlg = screen.getByRole("dialog", { name: "Tambah orang ke Persiapan pameran" });
    expect(within(dlg).getByText("Orang yang ditambahkan bisa membaca pesan lama di grup ini.")).toBeInTheDocument();
    expect(within(dlg).queryByRole("checkbox", { name: /Sari Uji/ })).toBeNull();
    await user.click(within(dlg).getByRole("checkbox", { name: /Dimas Uji/ }));
    expect(
      within(dlg).getByText("1 orang dipilih. Orang yang ditambahkan bisa membaca pesan lama di grup ini."),
    ).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Tambah ke grup" }));
    await waitFor(() => expect(chat.groupAdd).toHaveBeenCalledWith(GR, [PK_D]));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: "Tambah orang ke Persiapan pameran" })).toBeNull();
  });

  it("tanpa hak menambah: tombol Tambah orang tidak ada", async () => {
    chat.group.mockResolvedValue(groupView({ canAdd: false }));
    renderConv();
    await waitFor(() => expect(chat.group).toHaveBeenCalled());
    await screen.findByText("Halo semua");
    expect(screen.queryByRole("button", { name: "Tambah orang" })).toBeNull();
  });

  it("Ganti nama grup dari menu kepala", async () => {
    const user = userEvent.setup();
    const { onChanged } = renderConv();
    await screen.findByRole("button", { name: "Tambah orang" });
    await user.click(screen.getByRole("button", { name: "Menu Persiapan pameran" }));
    await user.click(screen.getByRole("menuitem", { name: "Ganti nama grup" }));
    const input = screen.getByLabelText("Nama grup");
    expect(input).toHaveValue("Persiapan pameran");
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Simpan nama" }));
    expect(screen.getByText("Isi nama grup.")).toBeInTheDocument();
    await user.type(input, "Pameran   Desember");
    await user.click(screen.getByRole("button", { name: "Simpan nama" }));
    await waitFor(() => expect(chat.groupRename).toHaveBeenCalledWith(GR, "Pameran Desember"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});

describe("Channel Umum terkunci", () => {
  const umum = (extra: Partial<ConversationSummary> = {}) =>
    channel({
      section: "umum",
      name: "pengumuman",
      scope: { kind: "org", id: null, name: "Seluruh kantor" },
      canLock: true,
      ...extra,
    });

  beforeEach(() => {
    chat.messages.mockResolvedValue(view([message()]));
  });

  it("superadmin menjadikan hanya-baca dan membukanya lagi", async () => {
    const user = userEvent.setup();
    const { onChanged } = renderConv(umum());
    await user.click(await screen.findByRole("button", { name: "Menu #pengumuman" }));
    await user.click(screen.getByRole("menuitem", { name: "Jadikan hanya-baca" }));
    await waitFor(() => expect(chat.setLocked).toHaveBeenCalledWith(CH, true));
    expect(onChanged).toHaveBeenCalled();
  });

  it("channel terkunci: tanda Hanya-baca dan menu Buka untuk semua", async () => {
    const user = userEvent.setup();
    renderConv(umum({ locked: true }));
    expect(screen.getByText("Hanya-baca")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Menu #pengumuman" }));
    await user.click(screen.getByRole("menuitem", { name: "Buka untuk semua" }));
    await waitFor(() => expect(chat.setLocked).toHaveBeenCalledWith(CH, false));
  });

  it("bukan superadmin: tanpa menu kunci, alasan dari inti Rust di kolom pesan", async () => {
    const user = userEvent.setup();
    renderConv(
      umum({
        locked: true,
        canLock: false,
        canPost: false,
        postBlockedReason: "Hanya superadmin yang bisa menulis di channel ini.",
      }),
    );
    expect(screen.getByText("Hanya superadmin yang bisa menulis di channel ini.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Menu #pengumuman" }));
    expect(screen.queryByRole("menuitem", { name: /hanya-baca|Buka untuk semua/ })).toBeNull();
  });

  it("error setLocked tampil di bawah kepala", async () => {
    const user = userEvent.setup();
    chat.setLocked.mockRejectedValue({ code: "forbidden", message: "Hanya superadmin." });
    renderConv(umum());
    await user.click(await screen.findByRole("button", { name: "Menu #pengumuman" }));
    await user.click(screen.getByRole("menuitem", { name: "Jadikan hanya-baca" }));
    expect(await screen.findByText("Status hanya-baca belum bisa diubah")).toBeInTheDocument();
  });
});

describe("Bukan anggota lagi", () => {
  it("grup: catatan menggantikan kolom pesan, pesan lama tetap terbaca", async () => {
    renderConv(group({ former: true, canPost: false }));
    expect(
      screen.getByText(
        "Anda sudah tidak ada di grup ini. Pesan baru tidak dikirim lagi ke laptop Anda; pesan lama tetap tersimpan di sini.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(await screen.findByText("Halo semua")).toBeInTheDocument();
    expect(screen.getByText("Bukan anggota lagi")).toBeInTheDocument();
  });

  it("proyek dan departemen memakai kalimatnya sendiri", () => {
    chat.messages.mockResolvedValue(view([]));
    const { unmount } = render(
      <Conversation summary={channel({ former: true, canPost: false })} me={ME} onChanged={() => {}} onGone={() => {}} />,
    );
    expect(screen.getByText(/^Anda sudah bukan anggota proyek ini\. Pesan baru tidak dikirim lagi/)).toBeInTheDocument();
    unmount();
    render(
      <Conversation
        summary={channel({ former: true, canPost: false, section: "departemen", scope: { kind: "team", id: "t", name: "Desain" } })}
        me={ME}
        onChanged={() => {}}
        onGone={() => {}}
      />,
    );
    expect(screen.getByText(/^Anda sudah pindah dari departemen ini\./)).toBeInTheDocument();
  });
});

describe("Kejadian grup di percakapan", () => {
  it("diselipkan di antara pesan menurut waktu", async () => {
    chat.messages.mockResolvedValue(
      view(
        [
          message({ id: "m1", conv: GR, at: today(9, 5), text: "Panel dicetak minggu depan." }),
          message({ id: "m2", conv: GR, author: budi, at: today(9, 30), text: "Siap." }),
        ],
        {
          conversation: group(),
          events: [
            event({ id: "e2", at: today(9, 20), text: "Penguji menambahkan Dimas Uji." }),
            event({ id: "e1", at: today(9, 0) }),
          ],
        },
      ),
    );
    renderConv();
    await screen.findByText("Siap.");
    const list = document.querySelector(".conv-list")!;
    const order = Array.from(list.children).map((li) =>
      li.classList.contains("conv-day")
        ? `day:${li.textContent}`
        : li.classList.contains("conv-event")
          ? `event:${li.querySelector("p")!.firstChild!.textContent}`
          : `msg:${li.querySelector(".conv-text")!.textContent}`,
    );
    expect(order).toEqual([
      "day:Hari ini",
      "event:Penguji membuat grup ini dan menambahkan Sari Uji dan Budi Uji.",
      "msg:Panel dicetak minggu depan.",
      "event:Penguji menambahkan Dimas Uji.",
      "msg:Siap.",
    ]);
  });

  it("grup tanpa pesan menampilkan kejadian dan ajakan menulis", async () => {
    chat.messages.mockResolvedValue(view([], { conversation: group(), events: [event()] }));
    renderConv();
    expect(await screen.findByText(/Penguji membuat grup ini/)).toBeInTheDocument();
    expect(screen.getByText("Belum ada pesan. Tulis pesan pertama di kolom bawah.")).toBeInTheDocument();
  });

  it("kejadian tidak dibacakan saat dibuka", async () => {
    renderConv();
    await screen.findByText(/Penguji membuat grup ini/);
    const live = document.querySelector("p.sr-only[aria-live='polite']")!;
    expect(live.textContent).toBe("");
  });
});

describe("buildTimeline", () => {
  const now = new Date(2026, 10, 23, 12, 0);
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();

  it("pemisah hari tetap benar dengan kejadian di hari lain", () => {
    const items = buildTimeline(
      [message({ id: "m1", at: at(23, 9) }), message({ id: "m2", at: at(23, 9, 2) })],
      [event({ id: "e1", at: at(22, 16) })],
      now,
    );
    expect(items.map((i) => (i.kind === "day" ? i.label : i.kind))).toEqual([
      "Kemarin",
      "event",
      "Hari ini",
      "message",
      "message",
    ]);
  });

  it("kejadian memutus penggabungan pesan dari orang yang sama", () => {
    const items = buildTimeline(
      [message({ id: "m1", at: at(23, 9) }), message({ id: "m2", at: at(23, 9, 2) }), message({ id: "m3", at: at(23, 9, 3) })],
      [event({ id: "e1", at: at(23, 9, 1) })],
      now,
    );
    const grouped = items.flatMap((i) => (i.kind === "message" ? [`${i.message.id}:${i.grouped}`] : []));
    expect(grouped).toEqual(["m1:false", "m2:false", "m3:true"]);
  });

  it("kejadian dan pesan pada waktu yang sama: kejadian dulu", () => {
    const items = buildTimeline([message({ id: "m1", author: sari, at: at(23, 9) })], [event({ id: "e1", at: at(23, 9) })], now);
    expect(items.map((i) => i.kind)).toEqual(["day", "event", "message"]);
  });
});
