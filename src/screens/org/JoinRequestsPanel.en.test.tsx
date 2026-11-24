import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JoinRequestView } from "../../api/org";
import { setLang } from "../../i18n/core";
import { router } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import { joinRequest, overview } from "../../test/orgFixtures";
import type { OrgPage } from "./context";
import { CARD_TEXT, JoinRequestsPanel } from "./JoinRequestsPanel";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

function page(): OrgPage {
  return {
    overview: overview(),
    act: vi.fn(async () => true),
    pending: null,
    notify: vi.fn(),
    version: 0,
    refresh: vi.fn(),
    isMe: () => false,
  };
}

const RINA = joinRequest("r1", "Rina", {
  teamName: "Desain",
  laptop: "LAPTOP-DESAIN-03",
  ip: "192.168.1.23",
  note: "Drafter baru di proyek Gedung B.",
  account: null,
});
const BAYU = joinRequest("r2", "Bayu", { teamName: "Desain", ip: "192.168.1.23", account: "bayu" });

function setup(requests: JoinRequestView[]) {
  invoke.mockImplementation(router({ org_join_requests: requests }));
  return renderInLang(() => <JoinRequestsPanel page={page()} />, "en");
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

afterEach(() => {
  setLang("id");
});

describe("Permintaan bergabung dalam bahasa Inggris", () => {
  it("menulis kartu, tombol, dan dialog tolak dalam bahasa Inggris", async () => {
    setup([RINA, BAYU]);
    const rina = (await screen.findByRole("heading", { name: "Rina" })).closest("li") as HTMLElement;

    expect(screen.getByRole("heading", { name: "Join requests" })).toBeInTheDocument();
    expect(within(rina).getByText("Note from the requester (not verified)")).toBeInTheDocument();
    expect(within(rina).getByText("Sign-in account (reported by the requesting laptop)")).toBeInTheDocument();
    expect(within(rina).getByText("Not sent")).toBeInTheDocument();
    expect(within(rina).getByRole("button", { name: "Approve Rina's request" })).toBeInTheDocument();
    expect(CARD_TEXT.codeLabel).toBe("Match code");
    // Data peminta tidak diterjemahkan.
    expect(within(rina).getByText("Drafter baru di proyek Gedung B.")).toBeInTheDocument();

    expect(screen.queryByText("Permintaan bergabung")).not.toBeInTheDocument();
    expect(screen.queryByText("Tidak dikirim")).not.toBeInTheDocument();
    expect(screen.queryByText(/Setujui/)).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(rina).getByRole("button", { name: "Decline all from 192.168.1.23 (2)" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Decline 2 requests from 192.168.1.23?")).toBeInTheDocument();
    expect(within(dialog).getByText("These requests came from the same address:")).toBeInTheDocument();
    expect(within(dialog).queryByText(/Tolak/)).not.toBeInTheDocument();
  });

  it("menulis keadaan kosong dalam bahasa Inggris", async () => {
    setup([]);
    expect(await screen.findByText("No requests waiting.")).toBeInTheDocument();
    expect(screen.queryByText(/Tidak ada permintaan/)).not.toBeInTheDocument();
  });

  it("kembali ke bahasa Indonesia saat bahasa diganti", async () => {
    setup([RINA]);
    await screen.findByRole("heading", { name: "Rina" });
    expect(screen.getByRole("button", { name: "Decline Rina's request" })).toBeInTheDocument();
    act(() => setLang("id"));
    expect(screen.getByRole("button", { name: "Tolak permintaan Rina" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Permintaan bergabung" })).toBeInTheDocument();
  });
});
