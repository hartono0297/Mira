import type { Dict } from "./core";
import type id from "./chat-profile.id";

const en: Dict<typeof id> = {
  title: (name: string) => `${name}'s profile`,
  me: " (you)",
  loading: "Loading profile...",
  loadFailed: "Couldn't load the profile",
  retry: "Try again",
  retrying: "Reloading...",
  notFound: (name: string) =>
    `The organization data on this laptop doesn't include ${name} yet, so their role, department, and key fingerprint can't be shown.`,
  role: "Role",
  department: "Department",
  noDepartment: "No department yet",
  deptAdmin: "department admin",
  fingerprint: "Key fingerprint",
  fingerprintNote: (name: string) =>
    `To make sure this really is ${name}, ask them to open This laptop in Settings and compare the fingerprint.`,
  fingerprintNoteMe: "This laptop's key fingerprint. Colleagues can compare it with the one shown in your Settings.",
  sendDm: "Send direct message",
  opening: "Opening chat...",
  close: "Close",
};

export default en;
