import type { Dict } from "./core";
import type id from "./status.id";

const en: Dict<typeof id> = {
  loading: "Opening Mira's data on this laptop...",
  nextLabel: "Next step: ",
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
  removed: {
    heading: (org: string) => `This laptop has been removed from ${org}`,
    cause:
      "New messages and changes from this organization no longer reach this laptop, and colleagues' laptops no longer accept connections from it.",
    kept: "Data already on this laptop stays here. Mira doesn't delete it.",
    next: "If this is a mistake, contact a superadmin of the organization. A removed laptop can't rejoin with an invite code in this version. Give them this laptop's fingerprint so they know it's really you:",
    recheck: "Check again",
  },
};

export default en;
