import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, OrgInfo } from "../../api";
import type { OfficeSticker, StickerCatalog } from "../../api/chat";
import { setLang } from "../../i18n/core";
import { appState, directory, router } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import { overview } from "../../test/orgFixtures";
import { resetStickerCatalog } from "../chat/stickerCatalog";
import { clearStickerImageCache } from "../chat/StickerImage";
import { OrgScreen } from "./OrgScreen";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const state = appState() as AppState & { organization: OrgInfo };

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

function answer(catalog: StickerCatalog) {
  invoke.mockImplementation(
    router({
      org_overview: overview(),
      get_directory: directory(),
      org_fingerprint: "ABCD-EFGH",
      org_users: [],
      org_departments: [],
      org_join_requests: [],
      org_labels: [],
      org_people: [],
      chat_stickers: catalog,
      chat_sticker_image: "data:image/png;base64,AAAA",
    }),
  );
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  resetStickerCatalog(null);
  clearStickerImageCache();
});

afterEach(() => {
  setLang("id");
});

describe("Tab Sticker dalam bahasa Inggris", () => {
  it("menulis daftar, status, peringatan, dan dialog hapus dalam bahasa Inggris", async () => {
    answer({
      office: [
        sticker("1".repeat(32), "Office", "coffee", { keywords: ["coffee", "morning"] }),
        sticker("2".repeat(32), "Office", "meeting", { state: "hidden", ready: false }),
        sticker("3".repeat(32), "Project", "coffee", { nameTaken: true }),
      ],
      mine: [],
      canManage: true,
      recentEmoji: [],
    });
    const user = userEvent.setup();
    renderInLang(() => <OrgScreen state={state} onRefresh={vi.fn()} />, "en");
    await user.click(await screen.findByRole("button", { name: "Stickers" }));

    expect(await screen.findByRole("heading", { name: "Office stickers", level: 2 })).toBeInTheDocument();
    expect(screen.getByText(/PNG, WebP, or GIF images, up to 512 KB/)).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Stickers in pack Office" });
    const [first, second] = within(list).getAllByRole("listitem");
    expect(first).toHaveTextContent("Keywords: coffee, morning");
    expect(first).toHaveTextContent("Active");
    expect(second).toHaveTextContent("Hidden");
    expect(second).toHaveTextContent("No keywords");
    expect(second).toHaveTextContent("The image hasn't reached this laptop yet");
    expect(screen.getByText("2 stickers, 1 hidden")).toBeInTheDocument();
    expect(screen.getByText(/Name used by another sticker/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide all, pack Office" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show all, pack Office" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show :meeting:" })).toBeInTheDocument();
    expect(screen.queryByText(/Sembunyikan|Disembunyikan|Aktif|Kata kunci|Hapus/)).not.toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "Delete :coffee:" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Delete sticker :coffee:?" });
    expect(
      within(dialog).getByText("The sticker disappears from everyone's picker. Messages already sent stay as they are."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Delete :coffee:" })).toBeInTheDocument();
  });

  it("keadaan kosong dalam bahasa Inggris", async () => {
    answer({ office: [], mine: [], canManage: true, recentEmoji: [] });
    const user = userEvent.setup();
    renderInLang(() => <OrgScreen state={state} onRefresh={vi.fn()} />, "en");
    await user.click(await screen.findByRole("button", { name: "Stickers" }));
    expect(await screen.findByText(/No office stickers yet\. Mira doesn't ship any stickers/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add sticker" })).toBeInTheDocument();
  });
});
