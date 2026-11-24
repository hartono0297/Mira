import type { Dict } from "./core";
import type id from "./components-firewall.id";

const en: Dict<typeof id> = {
  categories: {
    public: "Public",
    private: "Private",
    domain: "Domain",
  },
  noStatus: "The Mira core didn't send a firewall status.",
  checking: (name: string) => `Checking ${name}...`,
  loadErrorTitle: (name: string) => `Couldn't read the ${name} status`,
  loadErrorBody: "You can still continue. If colleagues can't connect later, check again in Settings, under Network.",
  allowBusy: "Opening the permission window...",
  allow: "Allow through Windows Firewall",
  allowHint:
    "Windows will show an administrator permission window. If your account isn't an administrator, that window asks for an admin name and password.",
  started: "The Windows permission window is open. After you choose Yes there, press Check again.",
  notStartedTitle: "The Windows permission window didn't open",
  notStartedBody: "It may have been closed or cancelled. Try again, or send the command below to your IT team.",
  requestErrorTitle: "Couldn't ask for permission",
  noAdmin: "No administrator rights?",
  noAdminBody:
    "Send this command to your office IT team. It adds one Windows Firewall rule that lets Mira accept connections from colleagues' laptops.",
  copyCommand: "Copy command",
  recheckBusy: "Checking...",
  recheck: "Check again",
  win: {
    unsupported:
      "Firewall checks only work on Windows and macOS. If colleagues can't connect, allow Mira to accept UDP connections in this system's firewall.",
    allowed: "Windows Firewall allows Mira. Colleagues' laptops can connect to this laptop.",
    blocked: "Windows Firewall is blocking Mira. Colleagues' laptops can't connect to this laptop until that rule changes.",
    missing:
      "Windows Firewall has no rule for Mira yet. Without it, colleagues' laptops may not find or connect to this laptop.",
    unknown: "Mira couldn't read the Windows Firewall rules.",
    detail: (detail: string) => ` Details from Windows: ${detail}`,
    unknownTail: " You can still ask for permission below.",
  },
  mac: {
    allowed: "The macOS Firewall isn't blocking Mira. Colleagues' laptops can connect to this laptop.",
    blocked: "The macOS Firewall is blocking Mira, so colleagues' laptops can't connect to this laptop.",
    missing:
      "The macOS Firewall is on and Mira isn't in its list yet. When Mira starts accepting connections, macOS will ask whether Mira may accept incoming connections. Choose Allow.",
    unknown: "Mira couldn't read the macOS Firewall status.",
    unknownTail: " You can still follow the steps below.",
    stepsTitle: "If you missed the macOS prompt or chose Deny",
    // Menu names as they appear in English macOS.
    steps: [
      "Open System Settings > Network > Firewall, then click Options.",
      "Find Mira in the list. If it isn't there, click the add button (+), then choose the Mira app.",
      "Set Mira to Allow incoming connections, then click OK.",
      "Go back to Mira and press Check again.",
    ],
    adminHint: "Changing firewall settings asks for this Mac's admin password.",
    noAdmin: "No admin rights on this Mac?",
    noAdminBody:
      "Send this command to your office IT team. It runs in Terminal and lets Mira accept connections from colleagues' laptops through the macOS Firewall.",
  },
  profiles: {
    title: "Networks this laptop is using",
    none: "Windows didn't report any connected network. Check the LAN cable or Wi-Fi.",
    publicNote:
      "Windows is strictest on Public networks. VPN connections are often listed as Public, so Mira's rule also covers Public networks.",
  },
};

export default en;
