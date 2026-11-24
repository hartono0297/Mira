// 0.5.1 dalam bahasa Inggris: status nonaktif, dialog Nonaktifkan atau keluarkan,
// Aktifkan lagi, dan tombol di tab Anggota tanpa kata Indonesia.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, OrgInfo } from "../../api";
import { formatDate } from "../../api/format";
import type { PersonView, UserView } from "../../api/org";
import { setLang } from "../../i18n/core";
import { appState, directory, router } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import { adminOverview, department, ME, overview, person, PK_B, PK_C, TEAM_1, user } from "../../test/orgFixtures";
import { OrgScreen } from "./OrgScreen";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const state = appState() as AppState & { organization: OrgInfo };
const SUSPENDED_AT = "2026-11-23T03:00:00Z";

// Kata dan potongan kalimat Indonesia dari bagian ini yang tidak boleh tersisa.
const INDONESIAN =
  /Nonaktif|nonaktif|Aktifkan|Keluarkan|permanen|Dinonaktifkan|oleh|belum|sedang|laptop berikut|Batal|Pilih|versi belum|\bdan\b|\byang\b/;

function users(): UserView[] {
  return [
    user(ME, "Penguji", { role: "superadmin", isSuperadmin: true, lastIp: null }),
    user(PK_B, "Sari", {
      status: "suspended",
      departmentId: null,
      departmentName: null,
      departmentRole: null,
      online: false,
      suspendedAt: SUSPENDED_AT,
      suspendedByName: "Penguji",
      canReinstate: true,
      canRemove: true,
    }),
    user(PK_C, "Wulan", { canSuspend: true, canRemove: true }),
  ];
}

function answer(extra: Record<string, unknown> = {}) {
  invoke.mockImplementation(
    router({
      org_overview: overview(),
      get_directory: directory(),
      org_fingerprint: "ABCD-EFGH",
      org_users: users(),
      org_departments: [department(TEAM_1, "Desain")],
      org_labels: [],
      org_join_requests: [],
      org_suspend_gate: { allowed: false, outdated: [{ name: "Sari", appVersion: "0.5.0" }, { name: "Rudi", appVersion: null }] },
      ...(extra as Record<string, never>),
    }),
  );
}

function rowOf(name: string): HTMLElement {
  const row = screen.getAllByRole("row").find((r) => r.querySelector(".nwl-name")?.textContent?.startsWith(name));
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

afterEach(() => {
  setLang("id");
});

describe("Pengguna 0.5.1 dalam bahasa Inggris", () => {
  it("status, menu, dan dialog tanpa kata Indonesia", async () => {
    answer();
    const ue = userEvent.setup();
    renderInLang(() => <OrgScreen state={state} onRefresh={vi.fn()} />, "en");
    await ue.click(await screen.findByRole("button", { name: "Users" }));
    await screen.findByText("Wulan");

    expect(screen.getByRole("option", { name: "Active and deactivated" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Deactivated" })).toBeInTheDocument();
    const sari = rowOf("Sari");
    expect(within(sari).getByText("Deactivated")).toBeInTheDocument();
    expect(within(sari).getByText(`Deactivated ${formatDate(SUSPENDED_AT)} by Penguji`)).toBeInTheDocument();
    expect(sari.textContent ?? "").not.toMatch(INDONESIAN);

    await ue.click(screen.getByRole("button", { name: "Actions for Sari" }));
    expect(screen.getByRole("menuitem", { name: "Reactivate" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Remove for good" })).toBeInTheDocument();
    await ue.click(screen.getByRole("menuitem", { name: "Reactivate" }));
    let dialog = await screen.findByRole("dialog", { name: "Reactivate Sari?" });
    expect(within(dialog).getByRole("button", { name: "Reactivate Sari" })).toBeInTheDocument();
    expect(dialog.textContent ?? "").not.toMatch(INDONESIAN);
    await ue.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await ue.click(screen.getByRole("button", { name: "Actions for Sari" }));
    await ue.click(screen.getByRole("menuitem", { name: "Remove for good" }));
    dialog = await screen.findByRole("dialog", { name: "Remove Sari for good?" });
    expect(dialog).toHaveTextContent("This can't be undone.");
    expect(dialog.textContent ?? "").not.toMatch(INDONESIAN);
    await ue.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await ue.click(screen.getByRole("button", { name: "Actions for Wulan" }));
    await ue.click(screen.getByRole("menuitem", { name: "Deactivate or remove" }));
    dialog = await screen.findByRole("dialog", { name: "Deactivate or remove Wulan?" });
    expect(
      await within(dialog).findByText(
        "Not available yet. Update these laptops to Mira 0.5.1 first: Sari (Mira 0.5.0) and Rudi (version not reported).",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /^Deactivate/ })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Choose one first" })).toBeDisabled();
    await ue.click(within(dialog).getByRole("radio", { name: /^Remove for good/ }));
    expect(within(dialog).getByRole("button", { name: "Remove Wulan for good" })).toBeEnabled();
    expect(dialog.textContent ?? "").not.toMatch(INDONESIAN);
  });

  it("tab Anggota: tombol admin departemen dalam bahasa Inggris", async () => {
    const people: (PersonView & Record<string, unknown>)[] = [
      person(ME, "Penguji", { departmentRole: "admin" }),
      { ...person(PK_B, "Bayu"), status: "active", canSuspend: true },
      {
        ...person(PK_C, "Dewi"),
        status: "suspended",
        suspendedAt: SUSPENDED_AT,
        suspendedByName: "Penguji",
        canReinstate: true,
      },
    ];
    answer({ org_overview: adminOverview(), org_people: people, org_suspend_gate: { allowed: true, outdated: [] } });
    const ue = userEvent.setup();
    renderInLang(() => <OrgScreen state={state} onRefresh={vi.fn()} />, "en");
    await ue.click(await screen.findByRole("button", { name: "Members" }));
    await screen.findByText("Bayu");

    expect(screen.getByRole("button", { name: "Deactivate, Bayu" })).toHaveTextContent("Deactivate");
    expect(screen.getByRole("button", { name: "Reactivate, Dewi" })).toHaveTextContent("Reactivate");
    expect(screen.getByText(`Deactivated ${formatDate(SUSPENDED_AT)} by Penguji`)).toBeInTheDocument();

    await ue.click(screen.getByRole("button", { name: "Deactivate, Bayu" }));
    const dialog = await screen.findByRole("dialog", { name: "Deactivate Bayu?" });
    expect(await within(dialog).findByRole("button", { name: "Deactivate Bayu" })).toBeEnabled();
    expect(dialog.textContent ?? "").not.toMatch(INDONESIAN);
  });
});
