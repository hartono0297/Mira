import { plural, type Dict } from "./core";
import type id from "./docs.id";

const en: Dict<typeof id> = {
  library: "Shared library",
  place: (label: string | null) => (label === null ? "the shared library" : `project ${label}`),
  addedCount: (n: number) => `${n} ${plural(n, "file", "files")}`,
  added: (what: string, place: string) => `Added ${what} to ${place}.`,
  emptyTitle: (label: string | null) =>
    label === null ? "The shared library is empty" : `No files in project ${label} yet`,
  visibility: (label: string | null) =>
    label === null
      ? "Files in the shared library are visible to everyone in the organization except guests."
      : `Files in project ${label} are visible only to that project's members.`,
  gone: (label: string) => `Project ${label} is no longer available to you.`,
  showing: (place: string) => `Showing ${place}.`,

  guestNoProjectTitle: "No projects you can open yet",
  guestNoProjectText:
    "As a guest, you only see files in the projects you're invited to. Ask a project manager to add you.",
  guestEmptyText: "Files that project members add show up here. Guests can open files but can't add them.",

  you: "You",
  youInline: "you",

  yesterdayAt: (time: string) => `yesterday ${time}`,
  dateAt: (date: string, time: string) => `${date} ${time}`,

  versionOne: (n: number | string) => `version ${n}`,
  versionTwo: (a: number, b: number) => `versions ${a} and ${b}`,
  versionMany: (head: string, last: number) => `versions ${head}, and ${last}`,

  fetch: {
    copying: "The content is being copied from a colleague's laptop.",
    waiting: "The content is copied automatically once the colleague's laptop that has it connects.",
    manual: "Files over 20 MB aren't copied automatically. Download it if you need to open it.",
  },
  downloadLabel: (size: string) => `Download from a colleague (${size})`,

  menuLabel: (name: string) => `Actions for ${name}`,
  menuButtonLabel: (name: string) => `More actions for ${name}`,
  openReadOnly: "Open read-only",
  history: "View version history",
  exportCopy: "Save a copy",
  copyName: "Copy name",
  waitReason: "Wait for the other action to finish",
  copyFailedTitle: "Couldn't copy the file name",
  clipboardMissing: "The clipboard isn't available in this window.",
  copied: (name: string) => `Copied the name ${name}.`,

  exportBlocked: {
    copying: "The content is still being copied from a colleague's laptop",
    waiting: "The content is waiting for a colleague's laptop to connect",
    manual: "Download the content from a colleague first",
  },

  status: {
    conflict: (list: string) => `Conflict: ${list} saved side by side`,
    mine: (app: string | null, since: string) => `You've been editing${app ? ` in ${app}` : ""} since ${since}`,
    rekan: (name: string, since: string) => `${name} has been editing since ${since}`,
    added: (n: number, who: string, when: string) => `Version ${n} · Added by ${who} ${when}`,
    edited: (n: number, who: string, when: string) => `Version ${n} · Edited by ${who} ${when}`,
    copying: (n: number) => `Version ${n} is being copied from a colleague's laptop`,
    waiting: (n: number) => `Version ${n} is waiting for a colleague's laptop to connect`,
    manual: (n: number, size: string) => `Version ${n} not downloaded yet (${size})`,
  },

  origin: {
    added: "Added",
    savedFrom: (app: string) => `Saved from ${app}`,
    saved: "Saved",
    restoredFrom: (n: number) => `Restored from version ${n}`,
    restoredOld: "Restored from an older version",
    resolved: "Conflict resolved",
  },

  notAvailable: "No colleague's laptop that has this file is connected right now.",

  errorTitle: {
    forbidden: "You don't have permission to do this",
    notFound: "This file or version no longer exists",
    download: "Couldn't download the file",
    add: "Couldn't add the file",
    edit: "Couldn't open the file for editing",
    finish: "Couldn't finish editing",
    open: "Couldn't open the file",
    restore: "Couldn't restore the version",
    resolve: "Couldn't resolve the conflict",
    export: "Couldn't save the copy",
  },

  errorHint: {
    finishEditing: "Close the file in Word or Excel first, then press Finish editing again.",
    editingRetry: "This file is being edited. Finish editing first, then try again.",
    editingWait: "This file is being edited. Wait until the editing is done.",
    notAvailable: "Try again when the colleague's laptop that has this version is on and connected to Mira.",
    notFound: "The file list has been reloaded. Check it again before you retry.",
    openFailed: "Make sure Microsoft Office, or an app for this file type, is installed on this laptop.",
  },

  screen: {
    title: "Documents",
    location: "Location",
    addFile: "Add files",
    adding: "Adding...",
    loadingProjects: "Loading projects...",
    projectsError: (message: string) => `Couldn't read the project list (${message}).`,
    libraryStillUsable: "You can still use the shared library.",
    retryProjects: "Load projects again",
    staleList: (message: string) => `Couldn't read the latest list (${message}). Showing the last list loaded.`,
    loadingDocs: "Loading documents...",
    listErrorTitle: "Couldn't read the document list",
    listMissing: "The Mira core didn't send a document list.",
    retryRead: "Try again",
    emptyBody:
      "Add Word, Excel, PDF, or any other files. Each time a Word or Excel file is saved, Mira records a new version, so you can still open and restore older ones.",
    listLabel: (place: string) => `Files in ${place}`,
  },

  done: {
    copyingNow: (n: number) => `Version ${n} is being copied. The list updates when it's done.`,
    downloaded: (n: number, name: string) => `Version ${n} of ${name} is now on this laptop.`,
    defaultApp: "the default app",
    editConflict: (n: number, app: string) =>
      `Opened version ${n} in ${app}. Merge the content, then save to resolve the conflict.`,
    editOpened: (name: string, app: string) =>
      `Opened ${name} in ${app}. Each time you save, Mira records a new version.`,
    finished: (name: string) => `Finished editing ${name}. Colleagues can edit it now.`,
    openedReadOnly: (name: string, n: number) => `Opened ${name} version ${n} read-only.`,
    exported: (n: number, destination: string) => `Saved a copy of version ${n} to ${destination}.`,
    resolved: (current: number, kept: number) =>
      `Conflict resolved. Version ${current} has the content of version ${kept}.`,
    restored: (from: number, to: number) => `Restored version ${from} as version ${to}.`,
  },

  restore: {
    titleOf: (n: number) => `Restore version ${n}?`,
    title: "Restore version",
    confirmOf: (n: number) => `Restore version ${n}`,
    confirm: "Restore",
    busy: "Restoring...",
    body: (n: number, name: string) =>
      `Mira creates a new version with the content of version ${n} of ${name}. All other versions stay in the history.`,
    conflict: "This also resolves the conflict on this file, because the new version replaces all the side-by-side versions.",
  },

  detail: {
    sub: (count: number, size: string) => `${count} ${plural(count, "version", "versions")} · ${size}`,
    conflictTitle: (n: number) => `${n === 2 ? "Two" : String(n)} versions saved side by side`,
    conflictBody: (list: string, canMerge: boolean) =>
      `${list} were made separately, for example while one laptop was offline, so Mira kept them all. Choose the version to use${canMerge ? ", or merge the content yourself" : ""}.`,
    headTitle: (n: number, who: string) => `Version ${n} by ${who}`,
    headPickLater: "You can choose this version once its content is on this laptop.",
    mergeNote: (app: string | null) =>
      `Merge manually opens that version in ${app ?? ""}. Copy what you need from the other versions, then save. Once you save, the conflict is resolved.`,
    noResolve: "You don't have permission to choose a version. Ask a colleague who can edit this file to choose one.",
    downloadAria: (n: number, size: string) => `Download version ${n} from a colleague, ${size}`,
    downloading: "Downloading...",
    useThis: "Use this version",
    useThisAria: (n: number) => `Use this version (version ${n})`,
    savingChoice: "Saving your choice...",
    mergeManual: "Merge manually",
    mergeAria: (n: number) => `Merge manually from version ${n}`,
    opening: "Opening...",
    open: "Open",
    openAria: (n: number) => `Open version ${n}`,
    version: (n: number) => `Version ${n}`,
    current: "Current",
    exportAria: (n: number) => `Save a copy of version ${n}`,
    saving: "Saving...",
    history: "Version history",
    restoreAfterFinish: "You can restore older versions after you press Finish editing.",
    loadingHistory: "Loading version history...",
    historyErrorTitle: "Couldn't read the version history",
    staleHistory: (message: string) =>
      `Couldn't read the latest history (${message}). Showing the last history loaded.`,
    historyLabel: (name: string) => `Version history of ${name}`,
  },

  row: {
    reopen: "Open again",
    finish: "Finish editing",
    finishing: "Finishing...",
    resolveConflict: "Resolve conflict",
    viewConflict: "View conflict",
    editIn: (app: string | null) => `Edit in ${app}`,
  },
};

export default en;
