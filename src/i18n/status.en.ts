import type { Dict } from "./core";
import type id from "./status.id";

const en: Dict<typeof id> = {
  loading: "Opening Mira's data on this laptop...",
  nextLabel: "Next step: ",
  fingerprintLabel: "This laptop's fingerprint",
  error: {
    heading: "Mira can't open yet",
    code: (code: string) => `Error code: ${code}`,
    retry: "Try again",
    next: {
      noTauriMac: "Close this page, then open Mira from the Applications folder or Launchpad.",
      noTauriWindows: "Close this page, then open Mira from its icon in the Start menu or on the desktop.",
      keystoreMac:
        "Mira keeps this laptop's key in the macOS Keychain. Try again. If macOS asks for Keychain access for Mira, choose Allow. If it still fails, restart the laptop and open Mira again.",
      keystoreWindows:
        "Mira keeps this laptop's key in Windows Credential Manager. Try again. If it still fails, restart the laptop and open Mira again.",
      keyMismatch: "Don't delete Mira's data folder. Contact your organization admin and give them the error code below.",
      database: "Close any other Mira window that may still be open, then try again.",
      other: "Try again. If it still fails, close Mira and open it again.",
    },
  },
  suspended: {
    heading: (org: string) => `Your account at ${org} is deactivated`,
    contact: "Contact IT, your department admin, or a superadmin at your office. They can reactivate your account.",
    kept: "Nothing on this laptop is deleted. Once your account is active again, Mira opens on its own with the same data.",
    fingerprintHint: "If IT asks, read this out so they know which laptop is yours.",
    check: "Check again",
    checking: "Checking...",
    auto: "Mira also checks on its own every 20 seconds.",
    stillSuspended: (time: string) => `Checked at ${time}: still deactivated.`,
    active: (time: string) => `Checked at ${time}: your account is active again. Opening Mira...`,
    removed: (time: string) => `Checked at ${time}: this laptop has been removed from the office.`,
    notConnected: "Not connected to any office laptop yet. Make sure this laptop is on the office network.",
    failed: (message: string) => `Couldn't check. ${message}`,
  },
  removed: {
    heading: (org: string) => `This laptop has been removed from ${org}`,
    cause:
      "A superadmin at your office removed this laptop for good. New messages and changes from the office no longer reach it.",
    kept: "Until you reset it, the old data stays here.",
    rejoin: "To join again, reset this laptop first. You can then ask to join as a new laptop.",
    contact: "If this is a mistake, contact a superadmin at your office and give them this laptop's fingerprint.",
    reset: "Reset and start over",
    dialog: {
      title: "Reset this laptop?",
      data:
        "Messages, chat files, documents, and signed documents from this office are deleted from this laptop. Signed PDFs you already exported stay. Your language and theme stay as they are.",
      key: "This laptop gets a new key, so its fingerprint changes.",
      start: "Mira goes back to the start screen, where you can ask to join again.",
      admin: "Admins will see it as a new laptop.",
      undo: "This can't be undone.",
      confirm: "Delete data and reset",
      busy: "Resetting...",
      failed: (message: string) => `This laptop wasn't reset. ${message}`,
    },
  },
};

export default en;
