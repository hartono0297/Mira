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
    contact: "Contact IT or a superadmin at your office. They can turn your account back on.",
    kept: "Nothing on this laptop is deleted while your account is deactivated.",
    fingerprintHint: "Read it out to IT so they know it's really you.",
    check: "Check again",
    checking: "Checking...",
    auto: "Mira also checks on its own every 20 seconds.",
    stillSuspended: (time: string) => `Checked at ${time}: still deactivated.`,
    active: (time: string) => `Checked at ${time}: your account is active again. Opening Mira...`,
    removed: (time: string) => `Checked at ${time}: this laptop has been removed from the office.`,
    notConnected: "No office laptop reached yet. Make sure this laptop is on the office network.",
    failed: (message: string) => `Couldn't check. ${message}`,
  },
  removed: {
    heading: (org: string) => `This laptop has been removed from ${org}`,
    cause:
      "A superadmin at your office removed this laptop for good. New messages and changes from the office no longer reach it.",
    kept: "Until you reset it, the old data stays here.",
    rejoin: "This laptop can't rejoin until it's reset. After the reset, you can ask to join again as a new laptop.",
    contact: "If this is a mistake, contact a superadmin at your office and give them this laptop's fingerprint.",
    reset: "Reset and start over",
    dialog: {
      title: "Reset this laptop?",
      data: "The old organization data on this laptop is deleted. Your language and theme stay as they are.",
      key: "This laptop gets a new key, so its fingerprint changes.",
      start: "Mira goes back to the start screen, where you can ask to join again.",
      admin: "Admins will see it as a new laptop.",
      confirm: "Delete data and reset",
      busy: "Resetting...",
      failed: (message: string) => `This laptop wasn't reset. ${message}`,
    },
  },
};

export default en;
