import type { Dict } from "./core";
import type id from "./chat-division.id";

const en: Dict<typeof id> = {
  row: (name: string) => `${name} division chat`,

  pinned: {
    label: "Pinned note",
    edit: "Edit",
    editLabel: "Edit pinned note",
    add: "Pin a note",
    more: "Show all",
    less: "Show less",
    announceOn: "Announcement mode on",
    saved: "Note saved.",
  },

  dialog: {
    title: "Note and announcement mode",
    descTeam: "Applies to this department channel. Everyone in the department sees the note above the chat.",
    descDivision: "Applies to this division chat. Everyone in the division sees the note above the chat.",
    note: "Pinned note",
    noteHint: "Leave it empty to remove the note. Line breaks stay as you type them.",
    count: (used: number, max: number) => `${used} of ${max} characters`,
    tooLong: (max: number) => `The note can be at most ${max} characters.`,
    announce: "Announcement mode",
    announceTeam: "Only department admins and superadmins can post.",
    announceDivision: "Only division heads, department admins, and superadmins can post.",
    cancel: "Cancel",
    save: "Save",
    saving: "Saving...",
    failed: "Chat settings weren't saved",
  },

  gate: {
    team: "Only department admins and superadmins can post in this channel. To respond, send one of them a direct message.",
    division:
      "Only division heads, department admins, and superadmins can post in this chat. To respond, send one of them a direct message.",
  },
};

export default en;
