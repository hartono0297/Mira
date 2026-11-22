import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary } from "../../api/chat";
import { ChatScreen } from "./ChatScreen";
import { normalizeChannelName, unreadText } from "./ListFormat";
import { NO_SCOPE_NOTE } from "./NewChannelDialog";
import { DM_B, PK_C, REKAN_C, TEAM_1, TIM, TIM_ID, UMUM, guestOverview, overview, summary } from "./testData";

const chat = vi.hoisted(() => ({
  overview: vi.fn(),
  createChannel: vi.fn(),
  openDm: vi.fn(),
  setNotify: vi.fn(),
}));

vi.mock("../../api/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/chat")>()),
  chatApi: chat,
  subscribeChat: () => () => {},
}));

// Panel percakapan dibuat terpisah dan punya tes sendiri.
vi.mock("./Conversation", () => ({
  Conversation: ({
    summary: s,
    onChanged,
    onGone,
  }: {
    summary: ConversationSummary;
    onChanged: () => void;
    onGone: () => void;
  }) => (
    <section aria-label="Percakapan tiruan">
      <h2>{s.kind === "channel" ? `#${s.name}` : s.name}</h2>
      <button type="button" onClick={onChanged}>
        Ubah tiruan
      </button>
      <button type="button" onClick={onGone}>
        Hilang tiruan
      </button>
    </section>
  ),
}));

const panel = () => screen.getByRole("region", { name: "Percakapan tiruan" });
// Menunggu panel tampil (ringkasan selesai dimuat) dengan judul percakapan ini.
const panelHeading = async (name: string) =>
  within(await screen.findByRole("region", { name: "Percakapan tiruan" })).findByRole("heading", { name });
const list = () => screen.getByRole("navigation", { name: "Daftar percakapan" });
const row = (name: RegExp) => within(list()).getByRole("button", { name });

beforeEach(() => {
  chat.overview.mockResolvedValue(overview());
  chat.createChannel.mockReset();
  chat.openDm.mockReset();
  chat.setNotify.mockResolvedValue(null);
});

describe("ChatScreen", () => {
  it("menampilkan daftar dari ringkasan dan membuka #umum lebih dulu", async () => {
    render(<ChatScreen />);
    expect(screen.getByRole("status")).toHaveTextContent("Memuat chat...");

    expect(await panelHeading("#umum")).toBeInTheDocument();
    const channels = within(list()).getByRole("region", { name: "Channel" });
    expect(
      within(channels)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      expect.stringContaining("tim-uji"),
      expect.stringContaining("umum"),
      expect.stringContaining("proyek-alfa"),
    ]);
    expect(row(/Channel umum/)).toHaveAttribute("aria-current", "true");
    expect(row(/Channel tim-uji/)).not.toHaveAttribute("aria-current");
    // Petunjuk cakupan hanya untuk channel tim dan proyek.
    expect(row(/Channel tim-uji/)).toHaveTextContent("Tim Uji");
    expect(row(/Channel proyek-alfa/)).toHaveTextContent("Proyek Alfa");
    expect(row(/Channel umum/)).not.toHaveTextContent("Seluruh kantor");
    const dms = within(list()).getByRole("region", { name: "Pesan pribadi" });
    expect(within(dms).getByRole("button", { name: /Pesan pribadi dengan Rekan Bayu/ })).toHaveTextContent("RB");
  });

  it("berpindah percakapan saat baris lain diklik", async () => {
    const user = userEvent.setup();
    render(<ChatScreen />);
    await panelHeading("#umum");

    await user.click(row(/Channel tim-uji/));
    expect(within(panel()).getByRole("heading", { name: "#tim-uji" })).toBeInTheDocument();
    expect(row(/Channel tim-uji/)).toHaveAttribute("aria-current", "true");
    expect(row(/Channel umum/)).not.toHaveAttribute("aria-current");

    await user.click(row(/Pesan pribadi dengan Rekan Bayu/));
    expect(within(panel()).getByRole("heading", { name: "Rekan Bayu" })).toBeInTheDocument();
  });

  it("lencana belum dibaca dan mention terbaca oleh pembaca layar", async () => {
    render(<ChatScreen />);
    await panelHeading("#umum");

    const tim = row(/Channel tim-uji/);
    expect(tim).toHaveAccessibleName(/3 pesan belum dibaca, 1 menyebut Anda/);
    expect(tim).toHaveClass("chat-row-unread");
    expect(within(tim).getByText("3")).toHaveClass("chat-badge");
    expect(within(tim).getByText("@")).toHaveClass("chat-at");

    const proyek = row(/Channel proyek-alfa/);
    expect(proyek).toHaveAccessibleName(/dibisukan, 2 pesan belum dibaca$/);
    expect(proyek).toHaveClass("chat-row-muted");
    expect(within(proyek).queryByText("@")).not.toBeInTheDocument();

    const umum = row(/Channel umum/);
    expect(umum).not.toHaveAccessibleName(/belum dibaca/);
    expect(umum).not.toHaveClass("chat-row-unread");
  });

  it("menghitung lencana dan kalimatnya dengan benar", () => {
    expect(unreadText(0, 0)).toBe("");
    expect(unreadText(5, 0)).toBe("5 pesan belum dibaca");
    expect(unreadText(3, 1)).toBe("3 pesan belum dibaca, 1 menyebut Anda");
    expect(normalizeChannelName("  #Proyek A ")).toBe("proyek-a");
    expect(normalizeChannelName("Desain__Interior 2026")).toBe("desain-interior-2026");
    expect(normalizeChannelName("---")).toBe("");
    expect(normalizeChannelName("Kopi & Teh!")).toBe("kopi-teh");
    expect(normalizeChannelName("a".repeat(60))).toHaveLength(40);
    expect(normalizeChannelName(`${"a".repeat(39)} b`)).toBe("a".repeat(39));
  });

  it("bagian Diarsipkan terlipat dan bisa dibuka", async () => {
    const user = userEvent.setup();
    render(<ChatScreen />);
    await panelHeading("#umum");

    const toggle = within(list()).getByRole("button", { name: "Diarsipkan, 1 percakapan" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(list()).queryByRole("button", { name: /Channel acara-lama/ })).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(row(/Channel acara-lama/));
    expect(within(panel()).getByRole("heading", { name: "#acara-lama" })).toBeInTheDocument();

    // Selama percakapan arsip terbuka, bagiannya tetap terbuka.
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("Tamu tanpa channel proyek: tanpa tombol buat dan dengan penjelasan", async () => {
    chat.overview.mockResolvedValue(guestOverview());
    render(<ChatScreen />);

    expect(await screen.findByRole("heading", { name: "Belum ada percakapan" })).toBeInTheDocument();
    expect(screen.getByText(/Sebagai Tamu, Anda hanya bisa chat di channel proyek/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Channel baru/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pesan baru/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Tamu tidak punya chat pribadi/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pengaturan notifikasi chat" })).toBeInTheDocument();
  });

  it("Tamu dengan channel proyek melihat channel itu", async () => {
    const proyek = summary(`ch:${"2".repeat(32)}`, "proyek-alfa", {
      scope: { kind: "project", id: "2".repeat(32), name: "Alfa" },
    });
    chat.overview.mockResolvedValue(guestOverview({ conversations: [proyek] }));
    render(<ChatScreen />);
    expect(await panelHeading("#proyek-alfa")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pesan baru/ })).not.toBeInTheDocument();
  });

  it("membuat channel baru lalu langsung membukanya", async () => {
    const user = userEvent.setup();
    const created = summary(`ch:${"7".repeat(32)}`, "desain-interior-2026", {
      scope: { kind: "team", id: TEAM_1, name: "Uji" },
    });
    chat.createChannel.mockResolvedValue(created);
    render(<ChatScreen />);
    await panelHeading("#umum");

    await user.click(screen.getByRole("button", { name: /Channel baru/ }));
    const dialog = screen.getByRole("dialog", { name: "Channel baru" });
    await user.type(within(dialog).getByLabelText("Nama channel"), "Desain Interior 2026");
    expect(within(dialog).getByText("#desain-interior-2026")).toBeInTheDocument();

    const scope = within(dialog).getByLabelText("Untuk siapa");
    expect(
      within(scope)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Seluruh kantor", "Tim Uji", "Proyek Alfa"]);
    await user.selectOptions(scope, "Tim Uji");

    // Muat ulang setelah dibuat sudah memuat channel baru.
    chat.overview.mockResolvedValue(overview({ conversations: [created, ...overview().conversations] }));
    await user.click(within(dialog).getByRole("button", { name: "Buat channel" }));

    expect(chat.createChannel).toHaveBeenCalledWith("desain-interior-2026", { kind: "team", id: TEAM_1 });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(within(panel()).getByRole("heading", { name: "#desain-interior-2026" })).toBeInTheDocument();
    expect(row(/Channel desain-interior-2026/)).toHaveAttribute("aria-current", "true");
  });

  it("anggota biasa tidak bisa memilih Seluruh kantor; cakupan awal tim pertamanya", async () => {
    const user = userEvent.setup();
    chat.overview.mockResolvedValue(overview({ canCreateOrgChannel: false }));
    chat.createChannel.mockResolvedValue(summary(`ch:${"6".repeat(32)}`, "rapat"));
    render(<ChatScreen />);
    await panelHeading("#umum");

    await user.click(screen.getByRole("button", { name: /Channel baru/ }));
    const dialog = screen.getByRole("dialog", { name: "Channel baru" });
    const scope = within(dialog).getByLabelText("Untuk siapa");
    expect(
      within(scope)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Tim Uji", "Proyek Alfa"]);
    expect(scope).toHaveDisplayValue("Tim Uji");

    await user.type(within(dialog).getByLabelText("Nama channel"), "rapat");
    await user.click(within(dialog).getByRole("button", { name: "Buat channel" }));
    expect(chat.createChannel).toHaveBeenCalledWith("rapat", { kind: "team", id: TEAM_1 });
  });

  it("anggota tanpa tim dan proyek melihat alasan, tanpa tombol Channel baru", async () => {
    chat.overview.mockResolvedValue(
      overview({ canCreateChannel: false, canCreateOrgChannel: false, teams: [], projects: [] }),
    );
    render(<ChatScreen />);
    await panelHeading("#umum");

    expect(screen.queryByRole("button", { name: /Channel baru/ })).not.toBeInTheDocument();
    expect(within(list()).getByText(NO_SCOPE_NOTE)).toBeInTheDocument();
    // Pesan pribadi tetap bisa.
    expect(screen.getByRole("button", { name: /Pesan baru/ })).toBeInTheDocument();
  });

  it("error saat membuat channel tampil di dialog dan isian tetap ada", async () => {
    const user = userEvent.setup();
    chat.createChannel.mockRejectedValueOnce({ code: "invalid_input", message: "Nama channel sudah dipakai." });
    chat.createChannel.mockRejectedValueOnce({ code: "forbidden", message: "Hanya anggota tim yang bisa." });
    render(<ChatScreen />);
    await panelHeading("#umum");

    await user.click(screen.getByRole("button", { name: /Channel baru/ }));
    const dialog = screen.getByRole("dialog", { name: "Channel baru" });
    const name = within(dialog).getByLabelText("Nama channel");

    // Kosong: dicegah sebelum dikirim.
    await user.click(within(dialog).getByRole("button", { name: "Buat channel" }));
    expect(within(dialog).getByText("Tulis nama channel dulu.")).toBeInTheDocument();
    expect(chat.createChannel).not.toHaveBeenCalled();

    await user.type(name, "umum2");
    await user.click(within(dialog).getByRole("button", { name: "Buat channel" }));
    expect(await within(dialog).findByText("Nama channel sudah dipakai.")).toBeInTheDocument();
    expect(name).toHaveValue("umum2");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Buat channel" }));
    expect(await within(dialog).findByText("Anda tidak punya izin membuat channel di sini")).toBeInTheDocument();
    expect(within(dialog).getByText("Hanya anggota tim yang bisa.")).toBeInTheDocument();
    expect(name).toHaveValue("umum2");
    expect(chat.createChannel).toHaveBeenCalledTimes(2);
  });

  it("membuka chat pribadi lewat Pesan baru", async () => {
    const user = userEvent.setup();
    const dm = summary(`dm:${"a".repeat(64)}:${PK_C}`, REKAN_C.name, { peer: REKAN_C });
    chat.openDm.mockResolvedValue(dm);
    render(<ChatScreen />);
    await panelHeading("#umum");

    await user.click(screen.getByRole("button", { name: /Pesan baru/ }));
    const dialog = screen.getByRole("dialog", { name: "Pesan baru" });
    const people = within(dialog).getByRole("list", { name: "Rekan" });
    expect(
      within(people)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([expect.stringContaining("Rekan Bayu"), expect.stringContaining("Rekan Citra")]);

    await user.type(within(dialog).getByLabelText("Cari rekan"), "cit");
    expect(within(people).getAllByRole("button")).toHaveLength(1);
    await user.type(within(dialog).getByLabelText("Cari rekan"), "xyz");
    expect(within(dialog).getByText('Tidak ada rekan bernama "citxyz".')).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("Cari rekan"));
    await user.type(within(dialog).getByLabelText("Cari rekan"), "citra");

    chat.overview.mockResolvedValue(overview({ conversations: [...overview().conversations, dm] }));
    await user.click(within(dialog).getByRole("button", { name: /Rekan Citra/ }));
    expect(chat.openDm).toHaveBeenCalledWith(PK_C);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(within(panel()).getByRole("heading", { name: "Rekan Citra" })).toBeInTheDocument();
  });

  it("mengubah pengaturan notifikasi", async () => {
    const user = userEvent.setup();
    render(<ChatScreen />);
    await panelHeading("#umum");

    await user.click(screen.getByRole("button", { name: "Pengaturan notifikasi chat" }));
    const dialog = screen.getByRole("dialog", { name: "Notifikasi chat" });
    expect(within(dialog).getByText(/muncul di Windows saat jendela Mira tidak sedang di depan/)).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /Semua pesan baru/ })).toBeChecked();

    await user.click(within(dialog).getByRole("radio", { name: /Hanya chat pribadi dan yang menyebut saya/ }));
    expect(chat.setNotify).toHaveBeenCalledWith("mentions");
    expect(await within(dialog).findByText(/Tersimpan: Hanya chat pribadi/)).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /Hanya chat pribadi/ })).toBeChecked();

    chat.setNotify.mockRejectedValueOnce({ code: "io", message: "Gagal menulis pengaturan." });
    await user.click(within(dialog).getByRole("radio", { name: /Mati/ }));
    expect(await within(dialog).findByText("Pengaturan notifikasi belum tersimpan")).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /Hanya chat pribadi/ })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /Mati/ })).not.toBeChecked();
  });

  it("error memuat: tampil pesan dan Coba lagi memuat ulang", async () => {
    const user = userEvent.setup();
    chat.overview.mockRejectedValueOnce({ code: "db", message: "Database terkunci." });
    render(<ChatScreen />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Daftar chat belum terbaca");
    expect(alert).toHaveTextContent("Database terkunci.");

    await user.click(within(alert).getByRole("button", { name: "Coba lagi" }));
    expect(await panelHeading("#umum")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("muat ulang yang gagal tetap menampilkan daftar lama dengan catatan", async () => {
    const user = userEvent.setup();
    render(<ChatScreen />);
    await panelHeading("#umum");

    chat.overview.mockRejectedValueOnce({ code: "db", message: "Database terkunci." });
    await user.click(within(panel()).getByRole("button", { name: "Ubah tiruan" }));
    expect(await within(list()).findByText(/Daftar chat belum diperbarui/)).toBeInTheDocument();
    expect(row(/Channel umum/)).toBeInTheDocument();

    await user.click(within(list()).getByRole("button", { name: "Coba lagi" }));
    await waitFor(() => expect(within(list()).queryByText(/belum diperbarui/)).not.toBeInTheDocument());
  });

  it("kembali ke #umum kalau percakapan terpilih hilang setelah muat ulang", async () => {
    const user = userEvent.setup();
    render(<ChatScreen />);
    await panelHeading("#umum");

    await user.click(row(/Channel tim-uji/));
    expect(within(panel()).getByRole("heading", { name: "#tim-uji" })).toBeInTheDocument();

    chat.overview.mockResolvedValue(overview({ conversations: [UMUM, DM_B] }));
    await user.click(within(panel()).getByRole("button", { name: "Ubah tiruan" }));
    expect(await panelHeading("#umum")).toBeInTheDocument();
    expect(within(list()).queryByRole("button", { name: /Channel tim-uji/ })).not.toBeInTheDocument();
    expect(row(/Channel umum/)).toHaveAttribute("aria-current", "true");
  });

  it("onGone dari panel langsung kembali ke #umum", async () => {
    const user = userEvent.setup();
    render(<ChatScreen />);
    await panelHeading("#umum");

    await user.click(row(/Channel tim-uji/));
    chat.overview.mockResolvedValue(overview({ conversations: [UMUM, DM_B] }));
    await user.click(within(panel()).getByRole("button", { name: "Hilang tiruan" }));
    expect(within(panel()).getByRole("heading", { name: "#umum" })).toBeInTheDocument();
    await waitFor(() => expect(chat.overview).toHaveBeenCalledTimes(2));
  });

  it("tanpa #umum, percakapan pertama yang dibuka", async () => {
    chat.overview.mockResolvedValue(overview({ conversations: [TIM, DM_B] }));
    render(<ChatScreen />);
    expect(await panelHeading("#tim-uji")).toBeInTheDocument();
    expect(row(/Channel tim-uji/)).toHaveAttribute("aria-current", "true");
    expect(TIM.id).toBe(TIM_ID);
  });
});
