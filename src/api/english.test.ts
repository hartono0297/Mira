import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n/core";
import { DELIVERY_LABELS } from "./chat";
import { relativeTime } from "./format";
import { INVITE_STATUS_LABELS, ROLE_LABELS, VALIDITY_LABELS } from "./index";
import { checkInviteCode } from "./inviteCode";
import { inviteErrorText, NET_STATE_TEXT, OFFLINE_HINT } from "./messages";
import { validateOrgName } from "./validation";

afterEach(() => setLang("id"));

describe("teks src/api dalam bahasa Inggris", () => {
  it("label yang sama berganti bahasa tanpa impor ulang", () => {
    expect(ROLE_LABELS.team_admin).toBe("Admin departemen");
    setLang("en");
    expect(ROLE_LABELS.team_admin).toBe("Department admin");
    expect(Object.values(ROLE_LABELS)).toEqual(["Superadmin", "Department admin", "Member", "Guest"]);
    expect(VALIDITY_LABELS.once).toBe("Single use");
    expect(INVITE_STATUS_LABELS.revoked).toBe("Revoked");
    expect(DELIVERY_LABELS.read).toBe("Read");
    expect(NET_STATE_TEXT.offline).toBe("Not connected to the office network");
    expect(OFFLINE_HINT).toBe("If you're out of the office, turn on the office VPN.");
    setLang("id");
    expect(OFFLINE_HINT).toBe("Kalau sedang di luar kantor, nyalakan VPN kantor.");
  });

  it("validasi, kode undangan, dan waktu relatif", () => {
    setLang("en");
    expect(validateOrgName("")).toBe("Enter an organization name first.");
    expect(checkInviteCode("ABCD")).toEqual({ ok: false, error: "An invite code has 20 letters and numbers. You entered 4." });
    const now = new Date("2026-11-22T12:00:00Z");
    expect(relativeTime("2026-11-22T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-11-22T11:59:00Z", now)).toBe("1 minute ago");
    expect(relativeTime("2026-11-22T09:00:00Z", now)).toBe("3 hours ago");
    expect(relativeTime("2026-11-21T10:00:00Z", now)).toBe("yesterday");
    expect(relativeTime("2026-11-18T12:00:00Z", now)).toBe("4 days ago");
    expect(relativeTime("2026-11-01T12:00:00Z", now)).toBe("1 November 2026");
  });

  it("penjelasan error kode undangan tanpa teks Indonesia", () => {
    setLang("en");
    const text = inviteErrorText({ code: "no_peer_found", message: "x" });
    expect(text.title).toBe("No colleague's laptop found yet");
    expect(text.steps).toHaveLength(4);
    expect([text.title, text.body, ...(text.steps ?? [])].join(" ")).not.toMatch(/\b(laptop rekan|Anda|kantor)\b/);
  });
});
