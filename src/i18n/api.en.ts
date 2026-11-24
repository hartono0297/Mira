import type { Dict } from "./core";
import { plural } from "./core";
import type id from "./api.id";

const en: Dict<typeof id> = {
  roles: {
    superadmin: "Superadmin",
    team_admin: "Department admin",
    member: "Member",
    guest: "Guest",
  },
  teamRoles: {
    admin: "Department admin",
    member: "Member",
  },
  inviteRoles: {
    team_admin: "Department admin",
    member: "Member",
    guest: "Guest",
  },
  validity: {
    "24h": "24 hours",
    "7d": "7 days",
    once: "Single use",
  },
  inviteStatus: {
    active: "Active",
    used: "Used",
    expired: "Expired",
    revoked: "Revoked",
  },
  delivery: {
    pending: "Waiting",
    deposited: "Held by a colleague",
    delivered: "Delivered to their laptop",
    read: "Read",
  },
  netState: {
    starting: "Looking for colleagues' laptops...",
    no_org: "Not in an organization yet",
    alone: "No colleagues in the organization yet",
    lan: "Connected over the office LAN",
    vpn: "Connected over VPN",
    offline: "Not connected to the office network",
    removed: "This laptop has been removed from the organization",
  },
  offlineHint: "If you're out of the office, turn on the office VPN.",
  inviteError: {
    invalidTitle: "Invalid invite code",
    notFoundTitle: "Code not recognized",
    notFoundBody:
      "The colleague's laptop that Mira found doesn't know this code. Check the code letter by letter, or ask a department admin for a new one.",
    expiredTitle: "Code expired",
    expiredBody: "This code is past its validity period. Ask the department admin who invited you for a new one.",
    usedTitle: "Code already used",
    usedBody: "This single-use code has already been used to join. Ask a department admin for a new one.",
    revokedTitle: "Code revoked",
    revokedBody: "An admin revoked this code. Ask a department admin for a new one.",
    noPeerTitle: "No colleague's laptop found yet",
    noPeerBody:
      "Only an organization member's laptop with Mira open can check the code. Try these steps, then press Join again:",
    noPeerSteps: [
      "Connect this laptop to the same office Wi-Fi or LAN cable as your colleagues. Guest Wi-Fi usually keeps laptops apart.",
      "If you're out of the office, turn on the office VPN.",
      "Make sure the firewall on this laptop and on your colleague's laptop allows Mira (Windows Firewall on Windows, macOS Firewall on a MacBook).",
      "Ask a colleague to open Settings > Network in Mira, then enter the laptop address under Colleague laptop addresses.",
    ],
    peerUnreachableTitle: "Colleague's laptop couldn't check the code",
    peerUnreachableBody: (message: string) =>
      `${message} Try again in a moment. If it still fails, ask a department admin for a new code.`,
    nameRequiredTitle: "Display name not saved yet",
    nameRequiredBody: "This laptop has no display name yet. Reload this laptop's data, then enter a name before joining.",
    alreadyInOrgTitle: "This laptop is already in an organization",
    alreadyInOrgBody: "Reload this laptop's data to open its organization.",
    removedTitle: "This laptop has been removed from the organization",
    removedBody:
      "A removed laptop can't join again, not even with a new invite code. If this is a mistake, contact the organization's superadmin.",
    networkTitle: "Network problem",
    defaultTitle: "Code can't be used yet",
  },
  forbiddenTitle: "You don't have permission for this",
  lastSuperadminTitle: "The organization needs at least one superadmin",
  notFoundTitle: "The data has changed",
  validation: {
    displayNameEmpty: "Enter a display name first.",
    displayNameMax: (max: number) => `Display name can be at most ${max} characters.`,
    orgNameEmpty: "Enter an organization name first.",
    orgNameMin: (min: number) => `Organization name needs at least ${min} characters.`,
    orgNameMax: (max: number) => `Organization name can be at most ${max} characters.`,
    teamNameEmpty: "Enter a department name first.",
    teamNameMin: (min: number) => `Department name needs at least ${min} characters.`,
    teamNameMax: (max: number) => `Department name can be at most ${max} characters.`,
  },
  inviteCode: {
    empty: "Enter the invite code first.",
    badChar: (ch: string) =>
      `"${ch}" isn't part of invite codes. Codes only use letters and numbers, without the letter U.`,
    wrongLength: (expected: number, got: number) =>
      `An invite code has ${expected} letters and numbers. You entered ${got}.`,
  },
  relative: {
    justNow: "just now",
    minutesAgo: (n: number) => `${n} ${plural(n, "minute", "minutes")} ago`,
    hoursAgo: (n: number) => `${n} ${plural(n, "hour", "hours")} ago`,
    yesterday: "yesterday",
    daysAgo: (n: number) => `${n} ${plural(n, "day", "days")} ago`,
  },
  pickFilesTitle: "Choose files for the library",
  saveCopyTitle: "Save a copy",
  notBytes: "The Mira core sent file content that isn't in byte form.",
};

export default en;
