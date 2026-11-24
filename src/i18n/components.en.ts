import { plural, type Dict } from "./core";
import type id from "./components.id";

const en: Dict<typeof id> = {
  cancel: "Cancel",
  copy: {
    label: "Copy",
    copied: "Copied",
    copiedLive: "Copied to the clipboard.",
    failed: "Couldn't copy automatically. Select the text, then press Ctrl+C.",
  },
  labels: {
    prefix: (count: number) => `, ${plural(count, "label", "labels")} `,
    more: (count: number) => `, and ${count} more ${plural(count, "label", "labels")}`,
  },
  count: {
    more: (cap: number, meaning: string) => `more than ${cap} ${meaning}`,
  },
  people: {
    guest: "Guest",
    noDept: "No department yet",
    search: "Search names",
    dept: "Department",
    allDepts: "All departments",
    selected: (count: number) => `${count} selected`,
    empty: "No one is in this organization yet. New people join through a join request or an invite code.",
    filterName: (query: string) => `name "${query}"`,
    filterDept: (dept: string) => `the ${dept} filter`,
    filterJoin: " and ",
    noMatch: (filter: string) => `No one matches ${filter}.`,
    showAll: "Show everyone",
    me: " (you)",
  },
  platform: {
    macFirewall: "macOS Firewall",
    macKeyStore: "macOS Keychain",
  },
};

export default en;
