import type { Dict } from "./core";
import { plural } from "./core";
import type id from "./board-subtask.id";
import { SUBTASK_MAX, SUBTASK_TITLE_MAX } from "./board-subtask.id";

const en: Dict<typeof id> = {
  heading: "Subtasks",
  progressLabel: "Subtasks done",
  progressText: (done: number, total: number) => `${done} of ${total} done`,
  progressShort: (done: number, total: number) => `${done}/${total}`,

  emptyEditable: "No subtasks yet. Break this task into small steps you can tick off.",
  emptyReadOnly: "No subtasks yet.",
  hint: "Enter saves the title, Escape cancels. Alt + up or down arrow moves a subtask. Shift + F10 on the checkbox opens the subtask actions menu.",

  addButton: "Add subtask",
  newLabel: "New subtask title",
  newPlaceholder: "Subtask title, then Enter",
  newHint: "Enter adds it and keeps the field open for the next subtask. Escape closes.",

  titleLabel: (pos: number, total: number) => `Subtask title ${pos} of ${total}`,
  checkLabel: (title: string) => `${title}`,
  deleteLabel: (title: string) => `Delete subtask ${title}`,
  whoEmptyLabel: (title: string) => `Assign subtask ${title}`,
  whoLabel: (title: string, name: string) => `Change assignee of subtask ${title} (now ${name})`,
  whoMenuLabel: (title: string) => `Assignee of subtask ${title}`,
  whoNone: "No assignee",
  whoStatic: (name: string) => `Assignee: ${name}`,
  dragHandle: "Drag to reorder",

  you: (name: string) => `${name} (you)`,
  former: (name: string, mine: boolean) =>
    mine ? `${name} (you, no longer a project member)` : `${name} (no longer a project member)`,

  errEmpty: "Write a subtask title first.",
  errTooLong: (len: number) =>
    `A subtask title can be at most ${SUBTASK_TITLE_MAX} characters. It's ${len} ${plural(len, "character", "characters")} now.`,
  errTooMany: `This task already has ${SUBTASK_MAX} subtasks, the maximum. Delete subtasks you don't use to add new ones.`,
  errTitleEmpty: "A subtask title can't be empty. The old title is back.",

  saidAdded: (title: string) => `Subtask ${title} added.`,
  saidSaved: "Subtask title saved.",
  saidReverted: "Title change cancelled.",
  saidDone: (done: number, total: number) => `Done. ${done} of ${total} subtasks done.`,
  saidReopened: (done: number, total: number) => `Reopened. ${done} of ${total} subtasks done.`,
  saidDeleted: (title: string) => `Subtask ${title} deleted.`,
  saidMoved: (title: string, pos: number, total: number) => `${title} moved to position ${pos} of ${total}.`,
  saidTop: "This subtask is already at the top.",
  saidBottom: "This subtask is already at the bottom.",
  saidAssigned: (title: string, name: string) => `Assignee of ${title}: ${name}.`,
  saidUnassigned: (title: string) => `${title} has no assignee.`,
  saidDragCancelled: "Drag cancelled.",
};

export default en;
