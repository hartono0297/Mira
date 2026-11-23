import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSection, ConversationSummary, Person } from "../../api/chat";
import { ChatScreen } from "./ChatScreen";
import { defaultConversation, normalizeChannelName, sectionOf, unreadText } from "./ListFormat";
import {
  BEKAS,
  DM_B,
  GRUP,
  LAMA,
  PENGUMUMAN,
  PK_C,
  PROYEK,
  REKAN_C,
  TIM,
  TIM_ID,
  UMUM,
  guestOverview,
  overview,
  summary,
} from "./testData";

const chat = vi.hoisted(() => ({
  overview: vi.fn(),
  createChannel: vi.fn(),
  openDm: vi.fn(),
  setNotify: vi.fn(),
  setFolded: vi.fn(),
}));

// Ringkasan yang dikembalikan dialog grup tiruan saat "Buat tiruan" ditekan.
const group = vi.hoisted(() => ({ created: null as ConversationSummary | null }));

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

// Dialog grup punya tes sendiri; di sini hanya sambungannya dengan layar.
vi.mock("./NewGroupDialog", () => ({
  NewGroupDialog: ({
    open,
    onOpenChange,
    people,
    onCreated,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    people: Person[];
    onCreated: (summary: ConversationSummary) => void;
  }) =>
    open ? (
      <div role="dialog" aria-label="Grup baru tiruan">
        <p>{people.map((p) => p.name).join(", ")}</p>
        <button type="button" onClick={() => group.created && onCreated(group.created)}>
          Buat tiruan
        </button>
        <button type="button" onClick={() => onOpenChange(false)}>
          Tutup tiruan
        </button>
      </div>
    ) : null,
}));

const panel = () => screen.getByRole("region", { name: "Percakapan tiruan" });
// Menunggu panel tampil (ringkasan selesai dimuat) dengan judul percakapan ini.
const panelHeading = async (name: string) =>
  within(await screen.findByRole("region", { name: "Percakapan tiruan" })).findByRole("heading", { name });
const list = () => screen.getByRole("navigation", { name: "Daftar percakapan" });
const row = (name: RegExp) => within(list()).getByRole("button", { name });
const section = (name: string) => within(list()).getByRole("region", { name });
// Tombol lipat di judul bagian.
const fold = (name: string) => {
  const button = section(name).querySelector<HTMLButtonElement>("h2 > .chat-fold");
  if (!button) throw new Error(`Tidak ada tombol lipat untuk ${name}`);
  return button;
};
const headings = () =>
  within(list())
    .getAllByRole("heading", { level: 2 })
    .map((h) => h.textContent);
const rowNames = (name: string) =>
  within(section(name))
    .queryAllByRole("button")
    .filter((b) => b.classList.contains("chat-row"))
    .map((b) => b.querySelector(".chat-row-name")?.textContent);

beforeEach(() => {
  chat.overview.mockResolvedValue(overview());
  chat.createChannel.mockReset();
  chat.openDm.mockReset();
  chat.setNotify.mockResolvedValue(null);
  chat.setFolded.mockReset();
  chat.setFolded.mockResolvedValue(null);
  group.created = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ChatScreen: lima bagian", () => {
  it("menyusun daftar menjadi lima bagian berurutan dan membuka #umum lebih dulu", async () => {
    render(<ChatScreen />);
    expect(screen.getByRole("status")).toHaveTextContent("Memuat chat...");

    expect(await panelHeading("#umum")).toBeInTheDocument();
    expect(headings()).toEqual(["Umum", "Departemen", "Proyek", "Grup", "Pesan pribadi"]);
    // Urutan dari inti tidak urut bagian; yang diarsipkan tetap di akhir bagiannya.
    expect(rowNames("Umum")).toEqual(["umum", "acara-lama"]);
    expect(rowNames("Departemen")).toEqual(["tim-uji"]);
    expect(rowNames("Proyek")).toEqual(["proyek-alfa"]);
    expect(rowNames("Grup")).toEqual(["Persiapan pameran"]);
    expect(rowNames("Pesan pribadi")).toEqual(["Rekan Bayu"]);

    expect(row(/^Channel umum($|,)/)).toHaveAttribute("aria-current", "true");
    expect(row(/Channel tim-uji/)).not.toHaveAttribute("aria-current");
    // Grup memakai ikon orang, bukan "#"; pesan pribadi memakai inisial.
    expect(within(row(/^Grup Persiapan pameran/)).queryByText("#")).not.toBeInTheDocument();
    expect(row(/^Grup Persiapan pameran/).querySelector("svg")).not.toBeNull();
    expect(row(/Pesan pribadi dengan Rekan Bayu/)).toHaveTextContent("RB");
    // Tanpa petunjuk cakupan: bagiannya sudah menjelaskan.
    expect(row(/Channel tim-uji/)).not.toHaveTextContent("Departemen Uji");
  });

  it("berpindah percakapan saat baris lain diklik", async () => {
    const user = userEvent.setup();
    render(<ChatScreen />);
    await panelHeading("#umum");

    await user.click(row(/Channel tim-uji/));
    expect(within(panel()).getByRole("heading", { name: "#tim-uji" })).toBeInTheDocument();
    expect(row(/Channel tim-uji/)).toHaveAttribute("aria-current", "true");
    expect(row(/^Channel umum($|,)/)).not.toHaveAttribute("aria-current");

    await user.click(row(/^Grup Persiapan pameran/));
    expect(within(panel()).getByRole("heading", { name: "Persiapan pameran" })).toBeInTheDocument();

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

    const umum = row(/^Channel umum($|,)/);
    expect(umum).not.toHaveAccessibleName(/belum dibaca/);
    expect(umum).not.toHaveClass("chat-row-unread");
  });

  it("menghitung lencana, kalimat, dan bagian dengan benar", () => {
    expect(unreadText(0, 0)).toBe("");
    expect(unreadText(5, 0)).toBe("5 pesan belum dibaca");
    expect(unreadText(3, 1)).toBe("3 pesan belum dibaca, 1 menyebut Anda");
    expect(normalizeChannelName("  #Proyek A ")).toBe("proyek-a");
    expect(normalizeChannelName("Desain__Interior 2026")).toBe("desain-interior-2026");
    expect(normalizeChannelName("---")).toBe("");
    expect(normalizeChannelName("Kopi & Teh!")).toBe("kopi-teh");
    expect(normalizeChannelName("a".repeat(60))).toHaveLength(40);
    expect(normalizeChannelName(`${"a".repeat(39)} b`)).toBe("a".repeat(39));
    // Bagian yang tidak dikenal ditebak dari jenis dan cakupan.
    const odd = (extra: Partial<ConversationSummary>) =>
      sectionOf({ ...TIM, section: "lain" as ConversationSummary["section"], ...extra });
    expect(odd({})).toBe("departemen");
    expect(odd({ kind: "group" })).toBe("grup");
    expect(odd({ kind: "dm", scope: null })).toBe("pribadi");
    expect(odd({ scope: { kind: "project", id: "p", name: "P" } })).toBe("proyek");
    expect(odd({ scope: { kind: "org", id: null, name: "K" } })).toBe("umum");
  });

  it("percakapan awal: #umum, lalu yang aktif pertama menurut urutan bagian", () => {
    expect(defaultConversation([TIM, UMUM])?.id).toBe(UMUM.id);
    expect(defaultConversation([DM_B, BEKAS, TIM])?.id).toBe(TIM.id);
    expect(defaultConversation([LAMA, BEKAS])?.id).toBe(BEKAS.id);
    expect(defaultConversation([LAMA])?.id).toBe(LAMA.id);
    expect(defaultConversation([])).toBeNull();
  });
});

describe("ChatScreen: melipat bagian", () => {
  it("judul bagian melipat isinya, menampilkan jumlah belum dibaca, dan diingat per laptop", async () => {
    const user = userEvent.setup();
    // Inti menyimpan lipatan dan mengembalikannya di ringkasan berikutnya.
    chat.setFolded.mockImplementation(async (sections: ChatSection[]) => {
      chat.overview.mockResolvedValue(overview({ folded: sections }));
      return null;
    });
    const { unmount } = render(<ChatScreen />);
    await panelHeading("#umum");

    const dept = fold("Departemen");
    expect(dept).toHaveAttribute("aria-expanded", "true");
    expect(dept).toHaveAccessibleName("Departemen");
    const body = document.getElementById(dept.getAttribute("aria-controls") ?? "");
    expect(body).toContainElement(row(/Channel tim-uji/));

    await user.click(dept);
    expect(dept).toHaveAttribute("aria-expanded", "false");
    expect(within(list()).queryByRole("button", { name: /Channel tim-uji/ })).not.toBeInTheDocument();
    // Bagian terlipat tetap memberi tahu ada pesan belum dibaca.
    expect(dept).toHaveAccessibleName("Departemen, 3 pesan belum dibaca, 1 menyebut Anda");
    expect(within(dept).getByText("3")).toHaveClass("chat-badge");
    expect(within(dept).getByText("@")).toHaveClass("chat-at");
    expect(chat.setFolded).toHaveBeenLastCalledWith(["departemen"]);

    // Hanya percakapan dibisukan yang belum dibaca: lencananya netral.
    await user.click(fold("Proyek"));
    expect(fold("Proyek")).toHaveClass("chat-fold-quiet");
    expect(fold("Proyek")).toHaveAccessibleName("Proyek, 2 pesan belum dibaca");

    // Dibuka lagi setelah layar dipasang ulang: lipatan masih sama.
    unmount();
    render(<ChatScreen />);
    await panelHeading("#umum");
    expect(fold("Departemen")).toHaveAttribute("aria-expanded", "false");
    expect(fold("Proyek")).toHaveAttribute("aria-expanded", "false");
    expect(fold("Grup")).toHaveAttribute("aria-expanded", "true");

    await user.click(fold("Departemen"));
    expect(row(/Channel tim-uji/)).toBeInTheDocument();
    expect(chat.setFolded).toHaveBeenLastCalledWith(["proyek"]);
  });

  it("bagian yang berisi percakapan terbuka bisa dilipat, percakapannya tetap terbuka", async () => {
    const user = userEvent.setup();
    chat.overview.mockResolvedValue(overview({ folded: ["grup"] }));
    render(<ChatScreen />);
    await panelHeading("#umum");

    const umum = fold("Umum");
    expect(umum).toHaveAttribute("aria-expanded", "true");
    expect(umum).not.toHaveAttribute("aria-disabled");
    await user.click(umum);
    expect(umum).toHaveAttribute("aria-expanded", "false");
    expect(within(list()).queryByRole("button", { name: /^Channel umum/ })).not.toBeInTheDocument();
    expect(within(panel()).getByRole("heading", { name: "#umum" })).toBeInTheDocument();
    expect(fold("Grup")).toHaveAttribute("aria-expanded", "false");
    expect(chat.setFolded).toHaveBeenLastCalledWith(["umum", "grup"]);
  });

  it("grup baru dibuat saat bagian Grup terlipat: bagian Grup dibuka lagi", async () => {
    const user = userEvent.setup();
    const created = summary(`gr:${"6".repeat(32)}`, "Makan siang Jumat");
    group.created = created;
    render(<ChatScreen />);
    await panelHeading("#umum");

    await user.click(within(section("Grup")).getByRole("button", { name: "Grup baru" }));
    // Dialog tiruan tidak modal, jadi bagian Grup bisa dilipat selagi dialog terbuka.
    await user.click(fold("Grup"));
    expect(fold("Grup")).toHaveAttribute("aria-expanded", "false");
    chat.overview.mockResolvedValue(overview({ conversations: [...overview().conversations, created] }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Buat tiruan" }));

    expect(fold("Grup")).toHaveAttribute("aria-expanded", "true");
    expect(row(/^Grup Makan siang Jumat/)).toHaveAttribute("aria-current", "true");
    expect(chat.setFolded).toHaveBeenLastCalledWith([]);
  });

  it("tetap jalan kalau lipatan gagal disimpan", async () => {
    const user = userEvent.setup();
    chat.setFolded.mockRejectedValue({ code: "internal", message: "database terkunci" });
    render(<ChatScreen />);
    await panelHeading("#umum");

    await user.click(fold("Grup"));
    await waitFor(() => expect(chat.setFolded).toHaveBeenCalledWith(["grup"]));
    expect(fold("Grup")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("panah atas dan bawah berpindah antarbagian dan melewati bagian terlipat", async () => {
    const user = userEvent.setup();
    render(<ChatScreen />);
    await panelHeading("#umum");

    row(/^Channel umum($|,)/).focus();
    await user.keyboard("{ArrowDown}");
    expect(row(/Channel acara-lama/)).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(row(/Channel tim-uji/)).toHaveFocus();
    await user.keyboard("{End}");
    expect(row(/Pesan pribadi dengan Rekan Bayu/)).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(row(/^Grup Persiapan pameran/)).toHaveFocus();
    await user.keyboard("{Home}");
    expect(row(/^Channel umum($|,)/)).toHaveFocus();

    await user.click(fold("Departemen"));
    await user.click(fold("Proyek"));
    row(/Channel acara-lama/).focus();
    await user.keyboard("{ArrowDown}");
    expect(row(/^Grup Persiapan pameran/)).toHaveFocus();
  });
});

describe("ChatScreen: isi tiap bagian", () => {
  it("superadmin: tombol Channel umum baru, tanpa catatan", async () => {
    render(<ChatScreen />);
    await panelHeading("#umum");
    expect(within(section("Umum")).getByRole("button", { name: "Channel umum baru" })).toBeInTheDocument();
    expect(within(list()).queryByText("Channel umum dibuat oleh superadmin.")).not.toBeInTheDocument();
  });

  it("anggota biasa: catatan siapa yang membuat channel umum, tanpa tombol", async () => {
    chat.overview.mockResolvedValue(overview({ isSuperadmin: false, canCreateOrgChannel: false }));
    render(<ChatScreen />);
    await panelHeading("#umum");
    expect(within(section("Umum")).getByText("Channel umum dibuat oleh superadmin.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Channel umum baru/ })).not.toBeInTheDocument();
    // Grup dan pesan pribadi tetap bisa.
    expect(within(section("Grup")).getByRole("button", { name: "Grup baru" })).toBeInTheDocument();
    expect(within(section("Pesan pribadi")).getByRole("button", { name: "Pesan baru" })).toBeInTheDocument();
  });

  it("bagian kosong memberi catatan", async () => {
    chat.overview.mockResolvedValue(
      overview({ conversations: [UMUM], myDepartment: null, teams: [], projects: [], otherProjects: 3 }),
    );
    render(<ChatScreen />);
    await panelHeading("#umum");
    expect(within(section("Departemen")).getByText("Belum ada departemen.")).toBeInTheDocument();
    expect(within(section("Proyek")).getByText("Belum ada proyek yang Anda ikuti.")).toBeInTheDocument();
    expect(
      within(section("Proyek")).getByText("Proyek lain tidak tampil karena Anda bukan anggotanya."),
    ).toBeInTheDocument();
    expect(within(section("Grup")).getByText("Belum ada grup.")).toBeInTheDocument();
    expect(within(section("Pesan pribadi")).getByText("Belum ada pesan pribadi.")).toBeInTheDocument();
  });

  it("departemen ada tapi channelnya belum tersalin", async () => {
    chat.overview.mockResolvedValue(overview({ conversations: [UMUM] }));
    render(<ChatScreen />);
    await panelHeading("#umum");
    expect(within(section("Departemen")).getByText("Belum ada channel untuk Departemen Uji.")).toBeInTheDocument();
    // Tanpa proyek lain, catatannya tidak tampil.
    expect(within(list()).queryByText(/Proyek lain tidak tampil/)).not.toBeInTheDocument();
  });

  it("channel terkunci dan percakapan bukan anggota lagi", async () => {
    const user = userEvent.setup();
    chat.overview.mockResolvedValue(overview({ conversations: [UMUM, PENGUMUMAN, TIM, PROYEK, BEKAS, LAMA] }));
    render(<ChatScreen />);
    await panelHeading("#umum");

    const locked = row(/Channel pengumuman/);
    expect(locked).toHaveAccessibleName("Channel pengumuman, hanya-baca");
    expect(locked).toHaveAttribute("title", "#pengumuman, hanya-baca");
    expect(locked.querySelector(".chat-row-icon")).not.toBeNull();

    const former = row(/Channel proyek-lama/);
    expect(former).toHaveAccessibleName("Channel proyek-lama, bukan anggota lagi");
    expect(former).toHaveClass("chat-row-dim");
    expect(former).toHaveTextContent("Bukan anggota lagi");
    expect(rowNames("Proyek")).toEqual(["proyek-alfa", "proyek-lama"]);

    const archived = row(/Channel acara-lama/);
    expect(archived).toHaveAccessibleName("Channel acara-lama, diarsipkan");
    expect(archived).toHaveTextContent("Diarsipkan");
    expect(row(/^Channel umum($|,)/)).not.toHaveClass("chat-row-dim");

    // Tetap bisa dibuka untuk membaca pesan lama.
    await user.click(former);
    expect(within(panel()).getByRole("heading", { name: "#proyek-lama" })).toBeInTheDocument();
  });

  it("Tamu tanpa channel proyek: hanya bagian Proyek dan penjelasan", async () => {
    chat.overview.mockResolvedValue(guestOverview());
    render(<ChatScreen />);

    expect(await screen.findByRole("heading", { name: "Belum ada percakapan" })).toBeInTheDocument();
    expect(screen.getByText(/Sebagai Tamu, Anda hanya bisa chat di proyek/)).toBeInTheDocument();
    expect(headings()).toEqual(["Proyek"]);
    expect(within(section("Proyek")).getByText("Belum ada proyek yang Anda ikuti.")).toBeInTheDocument();
    expect(
      within(section("Proyek")).getByText("Sebagai Tamu, Anda hanya melihat chat proyek yang Anda ikuti."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /baru/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pengaturan notifikasi chat" })).toBeInTheDocument();
  });

  it("Tamu dengan channel proyek melihat channel itu", async () => {
    chat.overview.mockResolvedValue(guestOverview({ conversations: [PROYEK], otherProjects: 4 }));
    render(<ChatScreen />);
    expect(await panelHeading("#proyek-alfa")).toBeInTheDocument();
    expect(headings()).toEqual(["Proyek"]);
    expect(within(list()).queryByText(/Proyek lain tidak tampil/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pesan baru/ })).not.toBeInTheDocument();
  });

  it("anggota tanpa percakapan sama sekali melihat keadaan kosong", async () => {
    chat.overview.mockResolvedValue(overview({ conversations: [] }));
    render(<ChatScreen />);
    expect(await screen.findByRole("heading", { name: "Belum ada percakapan" })).toBeInTheDocument();
    expect(screen.getByText(/membuat grup atau mengirim pesan pribadi/)).toBeInTheDocument();
    expect(headings()).toEqual(["Umum", "Departemen", "Proyek", "Grup", "Pesan pribadi"]);
  });
});

describe("ChatScreen: membuat percakapan", () => {
  it("superadmin membuat channel umum lalu langsung membukanya", async () => {
    const user = userEvent.setup();
    const created = summary(`ch:${"7".repeat(32)}`, "desain-interior-2026");
    chat.createChannel.mockResolvedValue(created);
    render(<ChatScreen />);
    await panelHeading("#umum");

    await user.click(screen.getByRole("button", { name: "Channel umum baru" }));
    const dialog = screen.getByRole("dialog", { name: "Channel umum baru" });
    expect(dialog).toHaveAccessibleDescription(/kecuali Tamu/);
    expect(within(dialog).getByText(/hanya-baca lewat menu channel/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Untuk siapa")).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Nama channel"), "Desain Interior 2026");
    expect(within(dialog).getByText("#desain-interior-2026")).toBeInTheDocument();

    // Muat ulang setelah dibuat sudah memuat channel baru.
    chat.overview.mockResolvedValue(overview({ conversations: [created, ...overview().conversations] }));
    await user.click(within(dialog).getByRole("button", { name: "Buat channel" }));

    expect(chat.createChannel).toHaveBeenCalledWith("desain-interior-2026", { kind: "org", id: null });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(within(panel()).getByRole("heading", { name: "#desain-interior-2026" })).toBeInTheDocument();
    expect(row(/Channel desain-interior-2026/)).toHaveAttribute("aria-current", "true");
    expect(rowNames("Umum")).toContain("desain-interior-2026");
  });

  it("error saat membuat channel tampil di dialog dan isian tetap ada", async () => {
    const user = userEvent.setup();
    chat.createChannel.mockRejectedValueOnce({ code: "invalid_input", message: "Nama channel sudah dipakai." });
    chat.createChannel.mockRejectedValueOnce({ code: "forbidden", message: "Anda bukan superadmin lagi." });
    render(<ChatScreen />);
    await panelHeading("#umum");

    await user.click(screen.getByRole("button", { name: "Channel umum baru" }));
    const dialog = screen.getByRole("dialog", { name: "Channel umum baru" });
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
    expect(await within(dialog).findByText("Hanya superadmin yang bisa membuat channel umum")).toBeInTheDocument();
    expect(within(dialog).getByText("Anda bukan superadmin lagi.")).toBeInTheDocument();
    expect(name).toHaveValue("umum2");
    expect(chat.createChannel).toHaveBeenCalledTimes(2);
  });

  it("Grup baru membuka dialog grup, lalu grup baru langsung dibuka", async () => {
    const user = userEvent.setup();
    const created = summary(`gr:${"6".repeat(32)}`, "Makan siang Jumat");
    group.created = created;
    render(<ChatScreen />);
    await panelHeading("#umum");

    await user.click(within(section("Grup")).getByRole("button", { name: "Grup baru" }));
    const dialog = screen.getByRole("dialog", { name: "Grup baru tiruan" });
    expect(dialog).toHaveTextContent("Rekan Citra, Rekan Bayu");

    await user.click(within(dialog).getByRole("button", { name: "Tutup tiruan" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(within(section("Grup")).getByRole("button", { name: "Grup baru" }));
    chat.overview.mockResolvedValue(overview({ conversations: [...overview().conversations, created] }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Buat tiruan" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(panel()).getByRole("heading", { name: "Makan siang Jumat" })).toBeInTheDocument();
    expect(row(/^Grup Makan siang Jumat/)).toHaveAttribute("aria-current", "true");
    await waitFor(() => expect(rowNames("Grup")).toEqual(["Persiapan pameran", "Makan siang Jumat"]));
  });

  it("tanpa izin membuat grup, tombol Grup baru tidak ada", async () => {
    chat.overview.mockResolvedValue(overview({ canCreateGroup: false }));
    render(<ChatScreen />);
    await panelHeading("#umum");
    expect(screen.queryByRole("button", { name: "Grup baru" })).not.toBeInTheDocument();
  });

  it("membuka pesan pribadi lewat Pesan baru", async () => {
    const user = userEvent.setup();
    const dm = summary(`dm:${"a".repeat(64)}:${PK_C}`, REKAN_C.name, { peer: REKAN_C });
    chat.openDm.mockResolvedValue(dm);
    render(<ChatScreen />);
    await panelHeading("#umum");

    await user.click(within(section("Pesan pribadi")).getByRole("button", { name: "Pesan baru" }));
    const dialog = screen.getByRole("dialog");
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
});

describe("ChatScreen: notifikasi, error, dan pilihan yang hilang", () => {
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
    expect(row(/^Channel umum($|,)/)).toBeInTheDocument();

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
    expect(row(/^Channel umum($|,)/)).toHaveAttribute("aria-current", "true");
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

  it("tanpa #umum, percakapan aktif pertama yang dibuka", async () => {
    chat.overview.mockResolvedValue(overview({ conversations: [BEKAS, DM_B, TIM, GRUP] }));
    render(<ChatScreen />);
    expect(await panelHeading("#tim-uji")).toBeInTheDocument();
    expect(row(/Channel tim-uji/)).toHaveAttribute("aria-current", "true");
    expect(TIM.id).toBe(TIM_ID);
  });
});
