import type { Dict } from "./core";
import type id from "./board-time.id";

const en: Dict<typeof id> = {
  tw: {
    heading: "Time",
    total: "Total",
    totalTask: "Task total",
    perPerson: "Per person",
    perStatus: "Per status",
    you: "You",
    running: "running",
    now: "now",
    never: "never",
    nobody: "No time logged yet.",
    notDone: "Not done yet",
    forgot: "Forgot to pause it?",
    manual: "manual",

    clockNote:
      "The clocks on some laptops don't seem to match, so time per status may be off. Timers and manual entries aren't affected, because their start and stop are recorded on the same laptop.",

    // Timer
    timerGroup: "Your timer",
    start: "Start timer",
    pause: "Pause",
    resume: "Resume",
    paused: "Paused",
    pausedTag: "paused",
    yourTotal: "Your total",
    startHint: "If your timer is running on another task, it will be paused.",
    notePlaceholder: "What you worked on",

    // Catat manual
    logOpen: "Log time manually",
    logDuration: "Duration",
    logDurationHint: "For example: 45m, 1h 30m, 1:30, or 90 (minutes). Up to 24 hours.",
    logNote: "Note (optional)",
    logSave: "Save entry",
    cancel: "Cancel",

    // Riwayat
    confirmDelete: "Delete this entry?",
    delete: "Delete",
  },
  kalimat: {
    runningSinceSr: (when: string) => `Your timer has been running since ${when}.`,
    earlierSr: (long: string) => `Logged earlier: ${long}.`,
    pausedSr: (long: string) => `Paused, your total on this task is ${long}.`,
    cycleDone: (short: string) => `Done in ${short} since it was created`,
    historySummary: (n: number) => `Time entry history (${n})`,
    // "Delete entry 1 hour 30 minutes, 23 Nov, 09:12".
    deleteEntryLabel: (what: string, when: string) => `Delete entry ${what}, ${when}`,
    startedAt: (when: string) => `started ${when}`,
  },
  say: {
    started: "Timer running.",
    resumed: "Timer running again.",
    paused: (long: string) => `Timer paused. Your total on this task is ${long}.`,
    logged: (long: string) => `Logged ${long}.`,
    deleted: "Time entry deleted.",
  },
  notice: {
    region: "Timer paused automatically",
    dismiss: "Dismiss notice",
    dismissAll: "Dismiss all",
    switched: (code: string, title: string, startedCode: string) =>
      `Your timer on ${code} (${title}) is paused because you started a timer on ${startedCode}.`,
    done: (code: string, title: string) => `Your timer on ${code} (${title}) is paused because the task moved to Done.`,
    deleted: (code: string, title: string) => `Your timer on ${code} (${title}) is paused because the task was deleted.`,
    idle: (code: string, title: string, time: string) =>
      `Your timer on ${code} (${title}) was paused at ${time}, when Mira was last active. Time after that isn't counted.`,
  },
};

export default en;
