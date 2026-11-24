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
    forgot: "Forgot to stop it?",
    manual: "manual",

    clockNote:
      "The clocks on some laptops don't seem to match, so time per status may be off. Timers and manual entries aren't affected, because their start and stop are recorded on the same laptop.",

    // Timer
    timerGroup: "Your timer",
    start: "Start timer",
    startHint: "Your timer still running on another task in this project will be stopped.",
    stop: "Stop timer",
    stopDialog: "Stop timer",
    stopAt: "Stop at",
    stopNoteLabel: "Note for this session (optional)",
    stopHint: "Enter saves and stops the timer. Escape closes this box and the timer keeps running.",
    stopWithNote: "Save and stop",
    stopWithoutNote: "Stop without a note",
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
    stopTitleSr: (when: string) => `Stop the timer running since ${when}.`,
    cycleDone: (short: string) => `Done in ${short} since it was created`,
    historySummary: (n: number) => `Time entry history (${n})`,
    // "Delete entry 1 hour 30 minutes, 23 Nov, 09:12".
    deleteEntryLabel: (what: string, when: string) => `Delete entry ${what}, ${when}`,
    startedAt: (when: string) => `started ${when}`,
  },
  say: {
    started: "Timer running.",
    stopped: (long: string) => `Timer stopped. ${long} logged.`,
    stoppedPlain: "Timer stopped.",
    logged: (long: string) => `Entry of ${long} saved.`,
    deleted: "Time entry deleted.",
  },
};

export default en;
