import { plural, type Dict } from "./core";
import type id from "./sign-dialogs.id";

const en: Dict<typeof id> = {
  newRequest: {
    title: "Request signatures",
    signersMax: (max: number) =>
      `Up to ${max} signers per request. Untick a name first to choose someone else.`,
    droppedGuest: (who: string) =>
      `Mira removed ${who} from the signers because guests can only sign documents in projects they're allowed to open.`,
    droppedProject: (who: string, _many: boolean) =>
      `Mira removed ${who} from the signers because they can't open this project.`,
    and: "and",
    oneSigner: "One signer",
    titleEmpty: "Enter a document title.",
    titleTooLong: (max: number) => `Titles can be up to ${max} characters.`,
    signersEmpty: "Choose at least one signer.",
    titleLabel: "Document title",
    titleHint: (max: number) => `Shown in the list and on the PDF's signature record page. Up to ${max} characters.`,
    projectLabel: "Project",
    noProject: "No project",
    projectHint: "You can only choose guests for projects they're allowed to open. Without a project, only members are listed.",
    projectsLoading: "Loading projects...",
    projectsError: (message: string) =>
      `Couldn't read the project list (${message}). You can still create the request without a project.`,
    projectsRetry: "Load projects again",
    signersLegend: "Signers",
    signersHint: (max: number, chosen: number) => `Up to ${max} people. ${chosen} chosen.`,
    membersLoading: "Loading members...",
    membersError: "Couldn't read the member list",
    retry: "Try again",
    noMembersProject: "No members can open this project yet.",
    noMembers: "No members in this laptop's directory yet.",
    me: (name: string) => `${name} (you)`,
    modeLegend: "Signing order",
    order: "Order",
    moveUp: "Move up",
    moveDown: "Move down",
    moveUpAria: (name: string) => `Move ${name} up`,
    moveDownAria: (name: string) => `Move ${name} down`,
    sendNote: "Sent to signers when their laptops connect. Until then, the request stays on this laptop.",
    saveError: "Request not created",
    cancel: "Cancel",
    creating: "Creating request...",
    create: "Create request",
  },

  verify: {
    title: "Check a PDF file",
    description:
      "Compare a PDF you received or saved with the signature records on this laptop. The file isn't stored.",
    notSigned: "Not signed yet",
    fileHash: "file fingerprint",
    finalTitle: "This file is authentic: it matches the fully signed document exactly",
    completed: (when: string) => `Completed ${when}`,
    versionTitle: "This file matches one of the recorded versions",
    versionCompleted: (when: string) =>
      `This document was fully signed ${when}, but this file is a version from before all signatures were in. The final version is in Mira.`,
    versionOpen:
      "Signing for this document isn't finished. This file only holds the signatures that existed when this version was made.",
    versionSigners: "Signed in this version:",
    versionNoSigners: "This version has no signatures yet.",
    changedTitle: "This file changed after it was signed in Mira",
    changedOriginal: (title: string) => `Original document: ${title}`,
    changedBody:
      "Its content doesn't match any recorded version. Don't use this file as proof. Use a copy saved from Mira.",
    unknownTitle: "Mira doesn't recognize this file",
    unknownBody:
      "This laptop has no records for this file. It may come from another laptop, may never have been signed in Mira, or may have changed beyond recognition.",
    checking: "Checking...",
    checkAnother: "Check another file",
    pick: "Choose a PDF file",
    errorTitle: "Couldn't check the file",
    openDoc: "Open document",
    close: "Close",
  },

  audit: {
    title: "Audit trail",
    count: (n: number) => `${n} ${plural(n, "entry", "entries")}`,
    invalid: (n: number) => `, ${n} ${plural(n, "doesn't", "don't")} match`,
    warnings: (n: number) => `, ${n} ${plural(n, "needs", "need")} attention`,
    empty: "No entries for this request yet.",
    noName: "No name",
    duringRequest: "This happened while the request was open. Make sure the signature's owner did it themselves.",
    hashBefore: "File fingerprint before",
    hashAfter: "File fingerprint after",
    hash: "File fingerprint",
    valid: "Valid entry",
    invalidRecord: "The entry's signature doesn't match. Someone may have changed it outside Mira.",
  },
};

export default en;
