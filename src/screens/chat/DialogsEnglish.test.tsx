import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../../i18n/core";
import { renderInLang } from "../../test/i18n";
import { NewChannelDialog } from "./NewChannelDialog";
import { NewGroupDialog } from "./NewGroupDialog";
import { NotifySettings } from "./NotifySettings";
import { budi, dimas, group, orgPeople, sari, wulan } from "./conversationTestData";

const chat = vi.hoisted(() => ({ createGroup: vi.fn(), setNotify: vi.fn(), createChannel: vi.fn() }));
const org = vi.hoisted(() => ({ people: vi.fn() }));

vi.mock("../../api/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/chat")>()),
  chatApi: chat,
}));

vi.mock("../../api/org", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/org")>()),
  orgApi: org,
}));

beforeEach(() => {
  chat.createGroup.mockResolvedValue(group());
  chat.setNotify.mockResolvedValue(undefined);
  org.people.mockResolvedValue(orgPeople);
});

afterEach(() => {
  setLang("id");
});

describe("dialog chat dalam bahasa Inggris", () => {
  it("Grup baru: judul, pemilih orang, dan validasi dalam bahasa Inggris", async () => {
    const user = userEvent.setup();
    renderInLang(() => (
      <NewGroupDialog open onOpenChange={() => {}} people={[sari, budi, dimas, wulan]} onCreated={() => {}} />
    ));
    expect(screen.getByRole("dialog", { name: "New group" })).toBeInTheDocument();
    expect(screen.getByLabelText("Group name")).toBeInTheDocument();
    expect(screen.getByLabelText("Choose people")).toHaveAttribute("placeholder", "Search by name");
    expect(await screen.findByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Colleagues" })).toBeInTheDocument();
    expect(screen.getByText(/^Nobody selected yet\./)).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /Budi Uji/ }));
    expect(screen.getByText("1 person selected, plus you. Guests can't be added to groups.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Selected people" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Budi Uji from the selection" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create group" }));
    expect(screen.getByText("Enter a group name.")).toBeInTheDocument();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText(/Grup baru|Pilih orang|Tamu tidak bisa|Isi nama grup/)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("ganti bahasa saat dialog terbuka langsung mengganti teksnya", async () => {
    renderInLang(() => (
      <NewGroupDialog open onOpenChange={() => {}} people={[sari, budi]} onCreated={() => {}} />
    ));
    expect(screen.getByRole("dialog", { name: "New group" })).toBeInTheDocument();
    act(() => setLang("id"));
    expect(screen.getByRole("dialog", { name: "Grup baru" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buat grup" })).toBeInTheDocument();
  });

  it("Notifikasi chat: pilihan dan pesan tersimpan dalam bahasa Inggris", async () => {
    const user = userEvent.setup();
    renderInLang(() => <NotifySettings open onOpenChange={() => {}} mode="all" onSaved={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Chat notifications" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /All new messages/ })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /Only direct messages and mentions of me/ }));
    expect(await screen.findByText("Saved: Only direct messages and mentions of me.")).toBeInTheDocument();
    expect(screen.queryByText(/Tersimpan|Semua pesan baru/)).toBeNull();
  });

  it("Channel umum baru: petunjuk, pratinjau, dan validasi dalam bahasa Inggris", async () => {
    const user = userEvent.setup();
    renderInLang(() => <NewChannelDialog open onOpenChange={() => {}} onCreated={() => {}} />);
    expect(screen.getByRole("dialog", { name: "New general channel" })).toBeInTheDocument();
    expect(screen.getByText(/^Lowercase letters, numbers, and hyphens\./)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create channel" }));
    expect(screen.getByText("Enter a channel name first.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Channel name"), "Info Kantor");
    expect(screen.getByText("#info-kantor").closest("p")).toHaveTextContent("Shows as #info-kantor");
    expect(chat.createChannel).not.toHaveBeenCalled();
  });
});
