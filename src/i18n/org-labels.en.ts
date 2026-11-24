import type { Dict } from "./core";
import { plural } from "./core";
import type id from "./org-labels.id";

const people = (n: number) => `${n} ${plural(n, "person", "people")}`;

const en: Dict<typeof id> = {
  menu: {
    label: (name: string) => `Actions for label ${name}`,
    assign: "Choose people",
    rename: "Rename",
    remove: "Delete",
    restore: "Restore",
    busy: "Wait for the current change to save.",
  },
  badData: "The Mira core sent label data that couldn't be read.",
  nameEmpty: "Enter a label name first.",
  nameTooLong: (max: number, now: number) => `A label name can be at most ${max} characters (now ${now}).`,
  nameSame: "This is the same as the current name.",
  nameTaken: (name: string) => `Label ${name} already exists.`,
  nameTakenRemoved: (name: string) =>
    `Label ${name} is in the Deleted section. Restore it so the people who used it get it back too.`,
  restored: (name: string) => `Label ${name} restored. It's back next to the names of the people who had it.`,
  restoreFail: (name: string) => `Label ${name} not restored`,
  title: "Labels",
  intro: (max: number) =>
    `Labels show next to names in chat, the user list, and people pickers. Up to ${max} labels show next to one name. Only superadmins manage labels.`,
  newLabel: "New label",
  loading: "Loading labels...",
  loadErrorTitle: "Couldn't read the labels",
  loadErrorEmpty: "The Mira core didn't send the label list.",
  retry: "Try again",
  stale: (message: string) => `Couldn't read the latest labels (${message}). Showing the last data loaded.`,
  empty:
    "No labels yet. Create labels for skills or positions, such as Drafter or K3, with the New label button, then add them to people.",
  allRemoved: "All labels have been deleted. Restore one from the Deleted section below, or create one with the New label button.",
  activeList: "Active labels",
  removedFold: (n: number) => `Deleted (${n})`,
  removedHint: "Deleted labels don't show next to anyone's name. Restore a label to give it back to the people who had it.",
  removedList: "Deleted labels",
  unassigned: "Not given to anyone yet",
  people,
  srLabelComma: (name: string) => `, label ${name}`,
  srLabel: (name: string) => `label ${name}`,
  noneSaved: "No people saved",
  saved: (n: number) => `${people(n)} saved`,
  restoringBtn: "Restoring... ",
  restoreBtn: "Restore ",
  nameLabel: "Label name",
  nameHint: (max: number) => `1 to ${max} characters, such as Drafter, K3, or Senior.`,
  cancel: "Cancel",
  created: (name: string) => `Label ${name} created.`,
  assignTitle: (name: string) => `Choose people for label ${name}`,
  later: "Do it later",
  createdIntro: (name: string) =>
    `Label ${name} is ready. Tick the people who should have it and choose Save, or do it later with the Choose people button on its row.`,
  create: "Create label",
  creating: "Creating label...",
  createFail: "Label not created",
  renamed: (from: string, to: string) => `Label ${from} is now called ${to}.`,
  renameTitle: (name: string) => `Rename label ${name}`,
  saveName: "Save name",
  savingName: "Saving name...",
  renameFail: "Label not renamed",
  deleted: (name: string) => `Label ${name} deleted. You can restore it from the Deleted section.`,
  deleteTitle: (name: string) => `Delete label ${name}?`,
  deleteConfirm: (name: string) => `Delete ${name}`,
  deleting: "Deleting...",
  deleteFail: (name: string) => `Label ${name} not deleted`,
  deleteBodyCount: (name: string, n: number) =>
    `Label ${name} disappears from next to the names of ${people(n)} and can't be given to anyone again.`,
  deleteBody: (name: string) => `Label ${name} disappears from the list and can't be given to anyone again.`,
  deleteKeep:
    "The list of people who had it stays saved. If you restore this label later from the Deleted section, it goes back to the same people.",
  progress: (n: number, total: number) => `Saving change ${n} of ${total}...`,
  assignDone: (name: string, added: number, removed: number) => {
    const parts: string[] = [];
    if (added > 0) parts.push(`given to ${people(added)}`);
    if (removed > 0) parts.push(`removed from ${people(removed)}`);
    return `Label ${name} ${parts.join(" and ")}.`;
  },
  pickerList: (name: string) => `People for label ${name}`,
  unsaved: (n: number) => `, ${n} unsaved ${plural(n, "change", "changes")}`,
  tooMany: (others: number, max: number) =>
    `Already has ${others} other ${plural(others, "label", "labels")}. Only the first ${max} labels in alphabetical order show next to the name.`,
  stopAssign: (who: string) => `Stopped while giving the label to ${who}`,
  stopRemove: (who: string) => `Stopped while removing the label from ${who}`,
  noneStored: "No changes were saved.",
  someStored: (done: number, total: number) => `${done} of ${total} ${plural(total, "change", "changes")} saved.`,
  retryRest: "Choose Save to try the rest.",
  saving: "Saving...",
  save: "Save",
};

export default en;
