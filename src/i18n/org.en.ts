import type { Dict } from "./core";
import { plural } from "./core";
import type id from "./org.id";

const en: Dict<typeof id> = {
  retry: "Try again",
  you: " (you)",
  stale: (message: string) => `Couldn't read the latest data (${message}). Showing the last data loaded.`,
  lastSuperadminHint: "Make someone else a superadmin first, then give up this role.",
  screen: {
    title: "Organization",
    fingerprint: "fingerprint",
    notFoundHint: "This screen has been reloaded. Check the data again before you retry.",
    forbiddenHint: "Your role may have just changed. This screen has been reloaded.",
    tabs: {
      users: "Users",
      people: "Members",
      departments: "Departments",
      requests: "Join requests",
      labels: "Labels",
      invites: "Invites",
    },
    tabsAria: "Organization sections",
    waiting: (n: number) => `, ${n} waiting`,
    loading: "Loading organization data...",
    loadErrorTitle: "Couldn't read the organization data",
    loadErrorEmpty: "The Mira core didn't send the organization data.",
    oneSuperadminTitle: "This organization has only one superadmin",
    oneSuperadminBody:
      "If the superadmin's laptop breaks, goes missing, or its owner leaves, nobody can create departments, appoint admins, or remove people. Make one more person a superadmin with Change role.",
    openUsers: "Open the Users list",
    invitesLoading: "Loading invite codes...",
    invitesErrorTitle: "Couldn't read the invite codes",
    invitesErrorEmpty: "The Mira core didn't send the invite data.",
  },
  navWaiting: (n: number) => `, ${n} ${plural(n, "join request", "join requests")} waiting`,
  people: {
    superadminAndAdmin: "Superadmin, department admin",
    title: "Organization members",
    hint: "Everyone active in the organization, with their department and role.",
    loading: "Loading members...",
    loadErrorTitle: "Couldn't read the member list",
    loadErrorEmpty: "The Mira core didn't send the member list.",
    alone:
      "Nobody else is in this organization yet. Colleagues can join with an invite code from a department admin or superadmin, or by sending a join request from their laptop.",
    search: "Search",
    searchPlaceholder: "Name or label",
    count: (n: number) => `${n} ${plural(n, "person", "people")}`,
    noMatch: (query: string) => `Nobody matches "${query}"`,
    noMatchHint: "Search looks at names and labels.",
    clearSearch: "Clear search",
    guest: "Guest",
    noDepartment: "No department yet",
  },
  redeem: {
    forbiddenTitle: "You can't use this code",
    forbiddenBody:
      "Invite codes are only for people without a department. If you need to change departments, ask a superadmin to move you.",
    accepted: "Code accepted. You're now a member of the department named in the code.",
    title: "No department yet? Use an invite code",
    label: "Invite code",
    checking: "Checking code...",
    submit: "Use code",
    hintShort: "The code adds you to the department named in it.",
    hintLong: "The code adds you to the department named in it. Ask a department admin or superadmin for a code.",
  },
};

export default en;
