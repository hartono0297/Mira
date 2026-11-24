import { plural, type Dict } from "./core";
import type id from "./shell.id";

const en: Dict<typeof id> = {
  nav: {
    chat: "Chat",
    board: "Board",
    docs: "Documents",
    sign: "Signatures",
    org: "Organization",
    settings: "Settings",
  },
  mainMenu: "Main menu",
  countMeaning: {
    chat: (_n: number) => "unread",
    board: (n: number) => plural(n, "task due today or overdue", "tasks due today or overdue"),
    sign: (_n: number) => "waiting for your signature",
    org: (n: number) => plural(n, "join request waiting", "join requests waiting"),
  },
  roleLabel: ", role ",
  net: {
    region: "Office network",
    checking: "Checking the network...",
    unreadable: "Couldn't read network status",
    stale: "Couldn't update. Showing the last known status.",
    retry: "Try reading again",
    onNetwork: "On the network",
    emptyBefore: "No colleagues in the organization yet. Invite them from the",
    emptyAfter: " menu.",
    viaVpn: "over VPN",
    local: "on this computer",
    online: ", online",
    offline: ", offline",
    lastSeen: (when: string) => `Last seen ${when}`,
    neverSeen: "Never seen",
  },
};

export default en;
