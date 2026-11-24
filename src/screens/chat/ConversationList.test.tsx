import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatOverview, ConversationSummary } from "../../api/chat";
import { renderInLang } from "../../test/i18n";
import { ConversationList } from "./ConversationList";
import { personView } from "./conversationTestData";
import { PeopleLabelsProvider } from "./PeopleLabels";
import { defaultConversation, groupConversations, sectionOf } from "./ListFormat";
// @ts-expect-error tanpa paket @types/node (lihat vite.config.ts)
import { readFileSync } from "node:fs";
// @ts-expect-error tanpa paket @types/node
import process from "node:process";
import { DM_B, GRUP, PROYEK, PROYEK_CHAT, REKAN_B, TIM, UMUM, overview, summary } from "./testData";

const chat = vi.hoisted(() => ({ setFolded: vi.fn() }));
const org = vi.hoisted(() => ({ people: vi.fn() }));

vi.mock("../../api/org", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/org")>()),
  orgApi: org,
}));

vi.mock("../../api/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/chat")>()),
  chatApi: chat,
}));

function renderList(data: ChatOverview = overview(), currentId: string | null = UMUM.id) {
  const props = {
    revealId: null as string | null,
    onRevealed: vi.fn(),
    staleError: null,
    onSelect: vi.fn(),
    onRequest: vi.fn(),
    onChanged: vi.fn(),
    onRemoved: vi.fn(),
    onRetry: vi.fn(),
    onNewChannel: vi.fn(),
    onNewGroup: vi.fn(),
    onNewDirect: vi.fn(),
    onNotify: vi.fn(),
  };
  const view = render(<ConversationList overview={data} currentId={currentId} {...props} />);
  // reveal: percakapan dari dialog (grup baru, pesan pribadi baru), seperti ChatScreen.adopt.
  const rerender = (next: ChatOverview, id: string | null, reveal: string | null = null) =>
    view.rerender(<ConversationList overview={next} currentId={id} {...props} revealId={reveal} />);
  return { ...view, rerender, props };
}

const list = () => screen.getByRole("navigation", { name: "Daftar percakapan" });
const section = (name: string) => within(list()).getByRole("region", { name });
const fold = (name: string) => {
  const button = section(name).querySelector<HTMLButtonElement>("h2 > .chat-fold");
  if (!button) throw new Error(`Tidak ada tombol lipat untuk ${name}`);
  return button;
};
const body = (name: string) => document.getElementById(fold(name).getAttribute("aria-controls") ?? "");
// Daftar terakhir yang dikirim ke inti, atau undefined kalau belum pernah disimpan.
const saved = () => chat.setFolded.mock.lastCall?.[0];

beforeEach(() => {
  chat.setFolded.mockReset();
  chat.setFolded.mockResolvedValue(null);
});

describe("ConversationList: melipat bagian", () => {
  it("melipat menyembunyikan semua baris bagian itu", async () => {
    const user = userEvent.setup();
    renderList();
    expect(body("Departemen")).not.toHaveAttribute("hidden");

    await user.click(fold("Departemen"));
    expect(fold("Departemen")).toHaveAttribute("aria-expanded", "false");
    expect(body("Departemen")).toHaveAttribute("hidden");
    expect(within(list()).queryByRole("button", { name: /Channel tim-uji/ })).toBeNull();
    expect(chat.setFolded).toHaveBeenCalledTimes(1);
    expect(saved()).toEqual(["departemen"]);
  });

  it("bagian yang berisi percakapan terbuka tetap bisa dilipat", async () => {
    const user = userEvent.setup();
    renderList(overview(), UMUM.id);
    const umum = fold("Umum");
    expect(umum).not.toHaveAttribute("aria-disabled");
    expect(umum).not.toHaveAttribute("title");

    await user.click(umum);
    expect(umum).toHaveAttribute("aria-expanded", "false");
    expect(body("Umum")).toHaveAttribute("hidden");
    expect(within(list()).queryByRole("button", { name: /^Channel umum($|,)/ })).toBeNull();
    expect(saved()).toEqual(["umum"]);

    await user.click(umum);
    expect(saved()).toEqual([]);
    expect(within(list()).getByRole("button", { name: /^Channel umum($|,)/ })).toHaveAttribute("aria-current", "true");
  });

  it("lipatan dari ringkasan dihormati saat dipasang, juga untuk bagian percakapan terbuka", () => {
    renderList(overview({ folded: ["umum", "grup"] }), UMUM.id);
    expect(fold("Umum")).toHaveAttribute("aria-expanded", "false");
    expect(body("Umum")).toHaveAttribute("hidden");
    expect(fold("Grup")).toHaveAttribute("aria-expanded", "false");
    expect(fold("Departemen")).toHaveAttribute("aria-expanded", "true");
    expect(chat.setFolded).not.toHaveBeenCalled();
  });

  it("dibaca sekali saat dipasang: ringkasan baru tidak menimpa lipatan di layar", async () => {
    const user = userEvent.setup();
    const { rerender } = renderList(overview({ folded: ["grup"] }), UMUM.id);
    await user.click(fold("Departemen"));
    expect(saved()).toEqual(["departemen", "grup"]);

    rerender(overview({ folded: [] }), UMUM.id);
    expect(fold("Departemen")).toHaveAttribute("aria-expanded", "false");
    expect(fold("Grup")).toHaveAttribute("aria-expanded", "false");
  });

  it("gagal menyimpan: bagian tetap terlipat di layar", async () => {
    const user = userEvent.setup();
    chat.setFolded.mockRejectedValue({ code: "internal", message: "database terkunci" });
    renderList();

    await user.click(fold("Grup"));
    await waitFor(() => expect(chat.setFolded).toHaveBeenCalledWith(["grup"]));
    expect(fold("Grup")).toHaveAttribute("aria-expanded", "false");
    expect(body("Grup")).toHaveAttribute("hidden");

    await user.click(fold("Proyek"));
    expect(saved()).toEqual(["proyek", "grup"]);
    expect(fold("Grup")).toHaveAttribute("aria-expanded", "false");
  });

  it("pindah otomatis ke percakapan di bagian terlipat tidak membuka bagian itu", () => {
    const { rerender, props } = renderList(overview({ folded: ["umum"] }), GRUP.id);
    // Misalnya grup terbuka dihapus dan layar kembali ke #umum.
    rerender(overview(), UMUM.id);
    expect(fold("Umum")).toHaveAttribute("aria-expanded", "false");
    expect(chat.setFolded).not.toHaveBeenCalled();
    expect(props.onRevealed).not.toHaveBeenCalled();
  });

  it("percakapan dari dialog di bagian terlipat: bagian itu dibuka dan disimpan", () => {
    const { rerender, props } = renderList(overview({ folded: ["departemen", "grup"] }), UMUM.id);
    expect(fold("Grup")).toHaveAttribute("aria-expanded", "false");

    rerender(overview(), GRUP.id, GRUP.id);
    expect(props.onRevealed).toHaveBeenCalledTimes(1);
    expect(fold("Grup")).toHaveAttribute("aria-expanded", "true");
    expect(body("Grup")).not.toHaveAttribute("hidden");
    expect(within(list()).getByRole("button", { name: /^Grup Persiapan pameran/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(fold("Departemen")).toHaveAttribute("aria-expanded", "false");
    expect(saved()).toEqual(["departemen"]);

    // Setelah itu bagian tersebut tetap bisa dilipat lagi tanpa langsung terbuka sendiri.
    rerender({ ...overview(), conversations: [...overview().conversations] }, GRUP.id);
    expect(fold("Grup")).toHaveAttribute("aria-expanded", "true");
  });

  it("percakapan baru yang belum ada di daftar: bagian dibuka begitu percakapannya muncul", () => {
    const created = summary(`gr:${"6".repeat(32)}`, "Makan siang Jumat");
    const { rerender } = renderList(overview({ folded: ["grup"] }), UMUM.id);

    rerender(overview(), created.id, created.id);
    expect(fold("Grup")).toHaveAttribute("aria-expanded", "false");
    expect(chat.setFolded).not.toHaveBeenCalled();

    rerender(overview({ conversations: [...overview().conversations, created] }), created.id, created.id);
    expect(fold("Grup")).toHaveAttribute("aria-expanded", "true");
    expect(saved()).toEqual([]);
  });

  it("chat.css menyembunyikan badan bagian yang terlipat", () => {
    // jsdom tidak menerapkan CSS. `.chat-sec-body { display: flex }` menimpa `[hidden]` bawaan
    // browser, jadi aturan [hidden] harus ditulis sendiri.
    const css = (readFileSync(`${process.cwd()}/src/screens/chat/chat.css`, "utf8") as string).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.chat-sec-body\[hidden\]\s*\{[^}]*display:\s*none\s*(;|\})/);
  });
});

describe("ConversationList: chat proyek", () => {
  const data = overview({ conversations: [UMUM, TIM, PROYEK, PROYEK_CHAT, GRUP] });

  it("tampil di bagian Proyek seperti grup: ikon orang, tanpa #, label Chat proyek", () => {
    renderList(data, UMUM.id);
    const row = within(section("Proyek")).getByRole("button", { name: /^Chat proyek Gudang Baru/ });
    expect(row).toHaveAccessibleName("Chat proyek Gudang Baru");
    expect(row.querySelector(".chat-row-name")).toHaveTextContent(/^Gudang Baru$/);
    expect(within(row).queryByText("#")).toBeNull();
    expect(row.querySelector("svg.chat-kind")).not.toBeNull();
    expect(row).toHaveAttribute("title", "Gudang Baru");
    expect(within(section("Umum")).queryByRole("button", { name: /Gudang Baru/ })).toBeNull();
  });

  it("selalu masuk Proyek, walau bagian dari inti hilang atau tidak dikenal", () => {
    const odd = (extra: Partial<ConversationSummary>) => sectionOf({ ...PROYEK_CHAT, ...extra });
    expect(odd({})).toBe("proyek");
    expect(odd({ section: "lain" as ConversationSummary["section"] })).toBe("proyek");
    expect(odd({ section: undefined as unknown as ConversationSummary["section"] })).toBe("proyek");
    expect(odd({ section: "umum", scope: null })).toBe("proyek");
    expect(odd({ section: "lain" as ConversationSummary["section"], scope: { kind: "org", id: null, name: "K" } })).toBe(
      "proyek",
    );
    expect(groupConversations([PROYEK_CHAT]).proyek).toEqual([PROYEK_CHAT]);
    expect(defaultConversation([PROYEK_CHAT, UMUM])?.id).toBe(UMUM.id);
  });
});

describe("ConversationList: label rekan di baris pesan pribadi", () => {
  const LABELS = ["Arsitek", "Drafter", "Surveyor", "Pengawas lapangan", "Koordinator K3"].map((name, i) => ({
    id: String(i).repeat(32),
    name,
  }));
  const props = {
    revealId: null,
    onRevealed: vi.fn(),
    staleError: null,
    onSelect: vi.fn(),
    onRequest: vi.fn(),
    onChanged: vi.fn(),
    onRemoved: vi.fn(),
    onRetry: vi.fn(),
    onNewChannel: vi.fn(),
    onNewGroup: vi.fn(),
    onNewDirect: vi.fn(),
    onNotify: vi.fn(),
  };
  const draw = (currentId: string | null = UMUM.id) => (
    <PeopleLabelsProvider>
      <ConversationList overview={overview({ conversations: [UMUM, DM_B, GRUP] })} currentId={currentId} {...props} />
    </PeopleLabelsProvider>
  );

  beforeEach(() => {
    org.people.mockReset().mockResolvedValue([{ ...personView(REKAN_B, "Desain"), labels: LABELS }]);
  });

  it("ringkas: dua label dan +3 yang hanya tampilan; nama tombol dan tooltip menyebut semua", async () => {
    render(draw());
    const row = await vi.waitFor(() => {
      const button = within(section("Pesan pribadi")).getByRole("button", { name: /^Pesan pribadi dengan Rekan Bayu/ });
      expect(button.querySelector(".chat-row-labels")).not.toBeNull();
      return button;
    });
    const all = LABELS.map((l) => l.name).join(", ");
    expect(row).toHaveAccessibleName(`Pesan pribadi dengan Rekan Bayu, label ${all}, 1 pesan belum dibaca`);
    expect(row).toHaveAttribute("title", `Rekan Bayu, label ${all}`);
    const chips = [...row.querySelectorAll(".chat-row-labels .lab:not(.lab-more)")].map((el) => el.firstChild?.textContent);
    expect(chips).toEqual(["Arsitek", "Drafter"]);
    expect(row.querySelector(".lab-more [aria-hidden='true']")?.textContent).toBe("+3");
    // Tidak ada tombol di dalam tombol baris.
    expect(row.querySelector("button")).toBeNull();
    // Grup dan channel tidak berlabel.
    expect(within(section("Grup")).getByRole("button", { name: /^Grup Persiapan pameran/ }).querySelector(".chat-row-labels")).toBeNull();
  });

  it("tanpa label: baris pesan pribadi tetap seperti biasa", async () => {
    org.people.mockResolvedValue([]);
    render(draw());
    await vi.waitFor(() => expect(org.people).toHaveBeenCalled());
    const row = within(section("Pesan pribadi")).getByRole("button", { name: /^Pesan pribadi dengan Rekan Bayu/ });
    expect(row.querySelector(".chat-row-labels")).toBeNull();
    expect(row).toHaveAttribute("title", "Rekan Bayu");
  });

  it("bahasa Inggris", async () => {
    renderInLang(() => draw());
    const row = await screen.findByRole("button", { name: /^Direct message with Rekan Bayu, labels Arsitek/ });
    expect(row).toHaveAccessibleName(
      `Direct message with Rekan Bayu, labels ${LABELS.map((l) => l.name).join(", ")}, 1 unread message`,
    );
  });
});
