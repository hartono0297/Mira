import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InviteView } from "../../api";
import { setLang } from "../../i18n/core";
import { directory, ME, router, TEAM_1 } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import { department } from "../../test/orgFixtures";
import { makeCtx } from "./context";
import { InvitesPanel } from "./InvitesPanel";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

function invite(extra: Partial<InviteView> = {}): InviteView {
  return {
    id: "7".repeat(32),
    teamId: TEAM_1,
    teamName: "Desain",
    role: "member",
    projectIds: [],
    validity: "24h",
    expiresAt: "2026-11-23T03:00:00Z",
    createdBy: ME,
    createdAt: "2026-11-22T03:00:00Z",
    status: "active",
    usedBy: [],
    ...extra,
  };
}

function setup(invites: InviteView[]) {
  invoke.mockImplementation(router({ org_departments: [department(TEAM_1, "Desain")] }));
  const dir = directory({ invites });
  const ctx = makeCtx(dir, vi.fn(async () => true), null, vi.fn(async () => {}), vi.fn());
  return renderInLang(() => <InvitesPanel ctx={ctx} canRedeem={false} />, "en");
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

afterEach(() => {
  setLang("id");
});

describe("Kode undangan dalam bahasa Inggris", () => {
  it("menulis daftar kode dan dialog cabut dalam bahasa Inggris", async () => {
    setup([invite()]);
    expect(screen.getByRole("heading", { name: "Invite codes" })).toBeInTheDocument();
    expect(screen.getByText(/Created by Penguji/)).toBeInTheDocument();
    expect(screen.getByText(/Valid until/)).toBeInTheDocument();
    expect(screen.queryByText(/Dibuat oleh/)).not.toBeInTheDocument();
    expect(screen.queryByText("Kode undangan")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Revoke invite code Desain/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Revoke code" })).toBeInTheDocument();
    expect(within(dialog).getByText(/Revoking can't be undone/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Pencabutan/)).not.toBeInTheDocument();
  });

  it("menulis dialog buat kode dalam bahasa Inggris", async () => {
    setup([]);
    expect(screen.getByText("No invite codes yet. Create a code to invite someone new to a department.")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Create invite code" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Invite to a department")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Code valid for")).toBeInTheDocument();
    expect(within(dialog).getByRole("option", { name: "Single use" })).toBeInTheDocument();
    expect(within(dialog).getByText("Several people can use it for 24 hours after it's created.")).toBeInTheDocument();
    expect(within(dialog).getByText(/Chats in this department/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(dialog).queryByText("Kode berlaku selama")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Batal")).not.toBeInTheDocument();
  });
});
