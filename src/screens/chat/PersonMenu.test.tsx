import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupView, Person } from "../../api/chat";
import { MenuButton } from "../../components/ContextMenu";
import {
  ChatActionsContext,
  ConversationActionsContext,
  usePersonMenu,
  type ChatActions,
  type ConversationActions,
} from "./ChatActions";
import { GroupMembers, type GroupState } from "./GroupMembers";
import { MENU } from "./menuText";
import { budi, GR, groupView, ME, orgPeople, penguji, PK_B, sari } from "./conversationTestData";

const chat = vi.hoisted(() => ({ groupRemove: vi.fn(), groupLeave: vi.fn() }));
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

function chatActions(extra: Partial<ChatActions> = {}): ChatActions {
  return {
    me: ME,
    canMessage: () => true,
    openDm: vi.fn().mockResolvedValue(undefined),
    showProfile: vi.fn(),
    ...extra,
  };
}

function convActions(extra: Partial<ConversationActions> = {}): ConversationActions {
  return {
    conv: GR,
    mention: vi.fn(),
    isMember: () => true,
    canRemove: () => false,
    removeFromGroup: vi.fn().mockResolvedValue(undefined),
    ...extra,
  };
}

function Providers({ chat: c, conv, children }: { chat: ChatActions | null; conv: ConversationActions | null; children: ReactNode }) {
  return (
    <ChatActionsContext.Provider value={c}>
      <ConversationActionsContext.Provider value={conv}>{children}</ConversationActionsContext.Provider>
    </ChatActionsContext.Provider>
  );
}

// Baris uji: nama sebagai tombol (elemen fokus di baris) dan tombol "..." yang memakai menu yang sama.
function Row({ person, onRemove }: { person: Person; onRemove?: () => void }) {
  const menu = usePersonMenu(person, onRemove ? { onRemove } : {});
  return (
    <ul>
      <li {...menu.triggerProps}>
        <button type="button">{person.name}</button>
        <MenuButton menu={menu} label={MENU.personMenu(person.name)} />
        {menu.element}
      </li>
    </ul>
  );
}

function renderRow(
  person: Person,
  { c = chatActions(), conv = convActions(), onRemove }: { c?: ChatActions | null; conv?: ConversationActions | null; onRemove?: () => void } = {},
) {
  render(
    <Providers chat={c} conv={conv}>
      <Row person={person} onRemove={onRemove} />
    </Providers>,
  );
  return { c, conv };
}

async function rightClick(user: ReturnType<typeof userEvent.setup>, target: Element) {
  await user.pointer({ keys: "[MouseRight]", target });
  return screen.findByRole("menu", { name: MENU.personMenu((target.textContent ?? "").trim()) });
}

function itemNames(menu: HTMLElement): string[] {
  return within(menu)
    .getAllByRole("menuitem")
    .map((el) => el.textContent ?? "");
}

beforeEach(() => {
  chat.groupRemove.mockReset().mockResolvedValue(null);
  chat.groupLeave.mockReset().mockResolvedValue(null);
  org.people.mockReset().mockResolvedValue(orgPeople);
});

describe("usePersonMenu: item sesuai konteks", () => {
  it("orang lain: Kirim pesan pribadi, Sebut, Lihat profil", async () => {
    const user = userEvent.setup();
    renderRow(sari);
    const menu = await rightClick(user, screen.getByRole("button", { name: "Sari Uji" }));
    expect(itemNames(menu)).toEqual([MENU.sendDm, MENU.mention, MENU.profile]);
  });

  it("diri sendiri: hanya Lihat profil", async () => {
    const user = userEvent.setup();
    renderRow(penguji, { conv: convActions({ canRemove: () => true }) });
    const menu = await rightClick(user, screen.getByRole("button", { name: "Penguji" }));
    expect(itemNames(menu)).toEqual([MENU.profile]);
  });

  it("canMessage false: tanpa Kirim pesan pribadi", async () => {
    const user = userEvent.setup();
    renderRow(sari, { c: chatActions({ canMessage: () => false }) });
    const menu = await rightClick(user, screen.getByRole("button", { name: "Sari Uji" }));
    expect(itemNames(menu)).toEqual([MENU.mention, MENU.profile]);
  });

  it("mention null (tidak bisa menulis): tanpa Sebut", async () => {
    const user = userEvent.setup();
    renderRow(sari, { conv: convActions({ mention: null }) });
    const menu = await rightClick(user, screen.getByRole("button", { name: "Sari Uji" }));
    expect(itemNames(menu)).toEqual([MENU.sendDm, MENU.profile]);
  });

  it("bukan anggota percakapan: tanpa Sebut", async () => {
    const user = userEvent.setup();
    renderRow(sari, { conv: convActions({ isMember: () => false }) });
    const menu = await rightClick(user, screen.getByRole("button", { name: "Sari Uji" }));
    expect(itemNames(menu)).toEqual([MENU.sendDm, MENU.profile]);
  });

  it("di luar percakapan: tanpa Sebut dan Keluarkan", async () => {
    const user = userEvent.setup();
    renderRow(sari, { conv: null });
    const menu = await rightClick(user, screen.getByRole("button", { name: "Sari Uji" }));
    expect(itemNames(menu)).toEqual([MENU.sendDm, MENU.profile]);
  });

  it("pemilik grup: Keluarkan dari grup lewat konfirmasi memanggil removeFromGroup", async () => {
    const user = userEvent.setup();
    const { conv } = renderRow(sari, { conv: convActions({ canRemove: () => true }) });
    const menu = await rightClick(user, screen.getByRole("button", { name: "Sari Uji" }));
    expect(itemNames(menu)).toEqual([MENU.sendDm, MENU.mention, MENU.profile, MENU.removeFromGroup]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(1);
    await user.click(within(menu).getByRole("menuitem", { name: MENU.removeFromGroup }));
    const dlg = screen.getByRole("dialog", { name: MENU.removeTitle("Sari Uji") });
    expect(dlg).toHaveTextContent(MENU.removeBody("Sari Uji"));
    expect(conv?.removeFromGroup).not.toHaveBeenCalled();
    await user.click(within(dlg).getByRole("button", { name: MENU.removeConfirm }));
    await waitFor(() => expect(conv?.removeFromGroup).toHaveBeenCalledWith(sari));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("onRemove: Keluarkan dari grup memanggil dialog milik layar, tanpa konfirmasi menu", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    const { conv } = renderRow(sari, { conv: convActions({ canRemove: () => true }), onRemove });
    const menu = await rightClick(user, screen.getByRole("button", { name: "Sari Uji" }));
    await user.click(within(menu).getByRole("menuitem", { name: MENU.removeFromGroup }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(conv?.removeFromGroup).not.toHaveBeenCalled();
  });

  it("item menjalankan aksinya: Kirim pesan pribadi, Sebut, Lihat profil", async () => {
    const user = userEvent.setup();
    const { c, conv } = renderRow(sari);
    const name = screen.getByRole("button", { name: "Sari Uji" });
    await user.click(within(await rightClick(user, name)).getByRole("menuitem", { name: MENU.sendDm }));
    expect(c?.openDm).toHaveBeenCalledWith(sari);
    await user.click(within(await rightClick(user, name)).getByRole("menuitem", { name: MENU.mention }));
    expect(conv?.mention).toHaveBeenCalledWith(sari);
    await user.click(within(await rightClick(user, name)).getByRole("menuitem", { name: MENU.profile }));
    expect(c?.showProfile).toHaveBeenCalledWith(sari);
  });
});

describe("usePersonMenu: keyboard", () => {
  it("Shift+F10 membuka, panah berpindah, Enter menjalankan", async () => {
    const user = userEvent.setup();
    const { c } = renderRow(sari);
    screen.getByRole("button", { name: "Sari Uji" }).focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const menu = await screen.findByRole("menu", { name: MENU.personMenu("Sari Uji") });
    expect(within(menu).getByRole("menuitem", { name: MENU.sendDm })).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(within(menu).getByRole("menuitem", { name: MENU.profile })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(within(menu).getByRole("menuitem", { name: MENU.sendDm })).toHaveFocus();
    await user.keyboard("{ArrowUp}{Enter}");
    expect(c?.showProfile).toHaveBeenCalledWith(sari);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Esc menutup dan fokus kembali ke elemen asal", async () => {
    const user = userEvent.setup();
    renderRow(sari);
    const name = screen.getByRole("button", { name: "Sari Uji" });
    name.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    await screen.findByRole("menu", { name: MENU.personMenu("Sari Uji") });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(name).toHaveFocus();
  });

  it("tombol ... membuka menu yang sama dan Esc kembali ke tombol", async () => {
    const user = userEvent.setup();
    renderRow(sari);
    const more = screen.getByRole("button", { name: MENU.personMenu("Sari Uji") });
    await user.click(more);
    const menu = await screen.findByRole("menu", { name: MENU.personMenu("Sari Uji") });
    expect(itemNames(menu)).toEqual([MENU.sendDm, MENU.mention, MENU.profile]);
    await user.keyboard("{Escape}");
    expect(more).toHaveFocus();
  });
});

// Panel daftar anggota grup dengan aksi percakapan dari data grup yang sama, seperti panel percakapan.
function MembersHarness({ group, c, conv }: { group: GroupView; c: ChatActions; conv?: Partial<ConversationActions> }) {
  const state: GroupState = { group, loading: false, error: null, reload: vi.fn().mockResolvedValue(undefined) };
  const actions = convActions({
    canRemove: (pk) => group.members.some((m) => m.person.publicKey === pk && m.canRemove),
    ...conv,
  });
  return (
    <Providers chat={c} conv={actions}>
      <GroupMembers memberCount={group.members.length} title={group.name} state={state} onChanged={vi.fn()} onGone={vi.fn()} />
    </Providers>
  );
}

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Grup · 3 anggota" }));
  return screen.findByRole("dialog", { name: "Anggota grup (3)" });
}

function rowOf(panel: HTMLElement, name: string): HTMLElement {
  const row = within(panel)
    .getAllByRole("listitem")
    .find((li) => li.querySelector(".nwl-name")?.textContent?.startsWith(name));
  if (!row) throw new Error(`baris ${name} tidak ada`);
  return row;
}

describe("Daftar anggota grup: menu orang", () => {
  it("klik kanan baris membuka menu di dalam panel, panel tetap terbuka", async () => {
    const user = userEvent.setup();
    render(<MembersHarness group={groupView()} c={chatActions()} />);
    const panel = await openPanel(user);
    await user.pointer({ keys: "[MouseRight]", target: within(rowOf(panel, "Sari Uji")).getByText("Sari Uji") });
    const menu = await screen.findByRole("menu", { name: MENU.personMenu("Sari Uji") });
    expect(panel).toContainElement(menu);
    expect(itemNames(menu)).toEqual([MENU.sendDm, MENU.mention, MENU.profile, MENU.removeFromGroup]);
    // Klik item tidak dianggap klik di luar panel: panel tetap ada di belakang konfirmasi.
    await user.click(within(menu).getByRole("menuitem", { name: MENU.removeFromGroup }));
    expect(screen.getByRole("dialog", { name: "Keluarkan Sari Uji dari grup?" })).toBeInTheDocument();
    expect(panel).toBeInTheDocument();
  });

  it("Keluarkan dari grup di menu membuka konfirmasi lama lalu memanggil groupRemove", async () => {
    const user = userEvent.setup();
    render(<MembersHarness group={groupView()} c={chatActions()} />);
    const panel = await openPanel(user);
    await user.click(within(rowOf(panel, "Sari Uji")).getByRole("button", { name: MENU.personMenu("Sari Uji") }));
    await user.click(await screen.findByRole("menuitem", { name: MENU.removeFromGroup }));
    const dlg = screen.getByRole("dialog", { name: "Keluarkan Sari Uji dari grup?" });
    expect(dlg).toHaveTextContent("Sari Uji tidak menerima pesan baru lagi; pesan lama tetap di laptopnya.");
    await user.click(within(dlg).getByRole("button", { name: "Keluarkan" }));
    await waitFor(() => expect(chat.groupRemove).toHaveBeenCalledWith(GR, PK_B));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keluarkan Sari Uji dari grup?" })).toBeNull());
    expect(panel).toBeInTheDocument();
  });

  it("Shift+F10 di tombol Keluarkan membuka menu orang di baris itu", async () => {
    const user = userEvent.setup();
    render(<MembersHarness group={groupView()} c={chatActions()} />);
    const panel = await openPanel(user);
    within(panel).getByRole("button", { name: "Keluarkan Budi Uji dari grup" }).focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(await screen.findByRole("menu", { name: MENU.personMenu(budi.name) })).toBeInTheDocument();
  });

  it("Lihat profil: panel ditutup, fokus ke tombol anggota, lalu showProfile", async () => {
    const user = userEvent.setup();
    const c = chatActions();
    render(<MembersHarness group={groupView()} c={c} />);
    const panel = await openPanel(user);
    await user.click(within(rowOf(panel, "Sari Uji")).getByRole("button", { name: MENU.personMenu("Sari Uji") }));
    await user.click(await screen.findByRole("menuitem", { name: MENU.profile }));
    expect(c.showProfile).toHaveBeenCalledWith(sari);
    expect(screen.queryByRole("dialog", { name: "Anggota grup (3)" })).toBeNull();
    expect(screen.getByRole("button", { name: "Grup · 3 anggota" })).toHaveFocus();
  });

  it("Kirim pesan pribadi dan Sebut dari panel juga menutup panel", async () => {
    const user = userEvent.setup();
    const c = chatActions();
    const mention = vi.fn();
    render(<MembersHarness group={groupView()} c={c} conv={{ mention }} />);
    let panel = await openPanel(user);
    await user.click(within(rowOf(panel, "Budi Uji")).getByRole("button", { name: MENU.personMenu("Budi Uji") }));
    await user.click(await screen.findByRole("menuitem", { name: MENU.sendDm }));
    expect(c.openDm).toHaveBeenCalledWith(budi);
    expect(screen.queryByRole("dialog", { name: "Anggota grup (3)" })).toBeNull();

    panel = await openPanel(user);
    await user.click(within(rowOf(panel, "Budi Uji")).getByRole("button", { name: MENU.personMenu("Budi Uji") }));
    await user.click(await screen.findByRole("menuitem", { name: MENU.mention }));
    expect(mention).toHaveBeenCalledWith(budi);
    expect(screen.queryByRole("dialog", { name: "Anggota grup (3)" })).toBeNull();
  });

  it("baris saya: menu hanya Lihat profil", async () => {
    const user = userEvent.setup();
    render(<MembersHarness group={groupView()} c={chatActions()} />);
    const panel = await openPanel(user);
    await user.click(within(rowOf(panel, "Penguji")).getByRole("button", { name: MENU.personMenu("Penguji") }));
    const menu = await screen.findByRole("menu", { name: MENU.personMenu("Penguji") });
    expect(itemNames(menu)).toEqual([MENU.profile]);
  });
});
