import { plural, type Dict } from "./core";
import type id from "./chat-dialogs.id";

const colleagues = (n: number) => `${n} ${plural(n, "colleague", "colleagues")}`;
const people = (n: number) => `${n} ${plural(n, "person", "people")}`;

const en: Dict<typeof id> = {
  common: {
    cancel: "Cancel",
    close: "Close",
  },
  members: {
    loading: "Loading members...",
    loadFailed: "Couldn't load the member list",
    retry: "Try again",
    retrying: "Reloading...",
    stale: "Couldn't load the latest list. Showing the last one loaded.",
  },
  newChannel: {
    title: "New public channel",
    description: "Everyone in the office can read and post in a public channel, except Guests.",
    nameLabel: "Channel name",
    previewAs: "Shows as ",
    rules: (max: number) => `Lowercase letters, numbers, and hyphens. Spaces become hyphens. Up to ${max} characters.`,
    nameNoChars: "This name has no letters or numbers left. Use the letters a to z or numbers.",
    nameEmpty: "Enter a channel name first.",
    lockHint:
      "For an announcements channel, you can make it read-only from the channel menu after creating it. Then only superadmins can post there.",
    forbidden: "Only superadmins can create public channels",
    failed: "Channel not created",
    creating: "Creating channel...",
    create: "Create channel",
  },
  newDirect: {
    title: "New message",
    description: "Choose a colleague for a direct message. Only the two of you can read it.",
    noPeople:
      "There are no other colleagues in this office yet. Invite them from the Organization menu, then you can start a direct message.",
    searchLabel: "Search colleagues",
    count: colleagues,
    listLabel: "Colleagues",
    opening: "Opening...",
    noMatch: (query: string) => `No colleague named "${query}".`,
    failed: "Direct message didn't open",
  },
  newGroup: {
    title: "New group",
    description: "A conversation with colleagues from any department. Only group members receive its messages.",
    nameLabel: "Group name",
    nameEmpty: "Enter a group name.",
    nameTooLong: (max: number) => `Group names can be up to ${max} characters.`,
    pickTooMany: (max: number) => `You can pick up to ${max} people at a time.`,
    empty: "No other colleagues can be added to a group yet. Guests can't be added to groups.",
    hintNone:
      "Nobody selected yet. You can create the group with just yourself and add people later. Guests can't be added to groups.",
    hintSome: (n: number) => `${people(n)} selected, plus you. Guests can't be added to groups.`,
    failed: "Group not created",
    creating: "Creating group...",
    create: "Create group",
  },
  groupMembers: {
    button: (n: number) => `Group · ${n} ${plural(n, "member", "members")}`,
    panelTitle: (n: number) => `Group members (${n})`,
    empty: "No members are recorded in this group yet.",
    owner: "Group owner",
    remove: "Remove",
    removeLabel: (name: string) => `Remove ${name} from the group`,
    removeFailed: (name: string) => `${name} wasn't removed`,
  },
  addPeople: {
    title: (group: string) => `Add people to ${group}`,
    pickNone: "Select at least one person.",
    empty: "Everyone who can be added is already in this group. Guests can't be added to groups.",
    hintNone: "People you add can read earlier messages in this group.",
    hintSome: (n: number) => `${people(n)} selected. People you add can read earlier messages in this group.`,
    failed: "People not added",
    adding: "Adding...",
    add: "Add to group",
  },
  renameGroup: {
    title: "Rename group",
    description: "Everyone in the group will see the new name.",
    failed: "Group not renamed",
    saving: "Saving...",
    save: "Save name",
  },
  notify: {
    title: "Chat notifications",
    description: (system: string) =>
      `Notifications appear in ${system} when the Mira window isn't in front. This setting applies to this laptop only.`,
    legend: "Send notifications for",
    all: {
      label: "All new messages",
      desc: "Every message from colleagues, except in conversations you've muted.",
    },
    mentions: {
      label: "Only direct messages and mentions of me",
      desc: "Channel messages notify you only when someone mentions you with @.",
    },
    off: {
      label: "Off",
      desc: "No notifications. New messages still show in the chat list.",
    },
    saved: (label: string) => `Saved: ${label}.`,
    failed: "Notification setting not saved",
    reverted: "Your previous choice is back. Try choosing again.",
  },
  picker: {
    label: "Choose people",
    placeholder: "Search by name",
    shown: (n: number) => `${colleagues(n)} shown`,
    deptFilter: "Filter by department",
    allDepts: "All",
    listLabel: "Colleagues",
    chosenLabel: "Selected people",
    removeChip: (name: string) => `Remove ${name} from the selection`,
    noMatch: (query: string) => `No colleague named "${query}".`,
    noneInDept: "No colleagues in this department.",
  },
  projectMembers: {
    button: (n: number) => `Project · ${n} ${plural(n, "member", "members")}`,
    panelTitle: (n: number) => `Project members (${n})`,
    empty: "This project has no members on the Board yet.",
    manager: "Project manager",
    always: "This chat always has the same members as the project.",
    former: "You're no longer a member of this project, so new messages don't reach your laptop anymore.",
    canManage: "To add or remove people, open Project members on the Board.",
    managed: "The project managers choose its members on the Board.",
  },
};

export default en;
