import type { Dict } from "./core";
import { plural } from "./core";
import type id from "./kopi-board.id";

const en: Dict<typeof id> = {
  tab: "Coffee",
  title: "Coffee",
  intro:
    "Coffee is a thank-you. Colleagues give Coffee with a reason, and Coffee also arrives on its own when a task is finished well. There is no negative Coffee.",
  loading: "Loading Coffee...",
  loadErrorTitle: "Coffee data could not be read",
  loadErrorEmpty: "The Mira core sent no Coffee data.",
  badData: "The Mira core sent Coffee data that could not be read.",
  retry: "Try again",
  stale: (message: string) => `The latest Coffee data could not be read (${message}). Showing the last data.`,

  featureOffTitle: "Coffee is turned off",
  featureOffBody:
    "A superadmin turned Coffee off for the whole office. While it is off, nobody can give Coffee and the monthly board is hidden.",
  featureOffAdmin:
    "While it is off, nobody can give Coffee and the monthly board is hidden. Turn it back on with the Coffee switch.",
  boardOffTitle: "Monthly board is turned off",
  boardOffBody: "A superadmin turned the monthly board off. Coffee can still be given and still shows on each profile.",
  boardOffAdmin: "Other people will not see this board until the Monthly board switch is turned on again.",

  boardTitleNow: "Most helpful this month",
  boardTitle: (month: string) => `Most helpful in ${month}`,
  boardHint: "The ten highest scores that month, from colleague Coffee and work Coffee.",
  monthNav: "Choose month",
  prevMonth: "Previous month",
  nextMonth: "Next month",
  monthLoading: (month: string) => `Loading the ${month} board...`,
  monthErrorTitle: (month: string) => `The ${month} board could not be read`,
  emptyNow:
    "No Coffee yet this month. Give Coffee to a colleague who helped from the right-click menu on their message, or finish a task before its due date.",
  emptyPast: (month: string) => `No Coffee in ${month}.`,
  listLabel: (month: string) => `Ranking for ${month}`,
  rank: (n: number) => `Rank ${n}`,
  peer: "From colleagues",
  work: "From work",
  score: "Score",
  you: " (you)",

  howTitle: "How to earn Coffee",
  howPeer: (weight: number) =>
    `From colleagues: a colleague gives Coffee with a reason, from a chat message, a finished task, or a profile. One colleague Coffee is worth ${weight} score ${plural(weight, "point", "points")}.`,
  howWork: (weight: number) =>
    `From work: automatic when a task someone else assigned to you is finished, or when a task is finished on or before its due date. One work Coffee is worth ${weight} ${plural(weight, "point", "points")}.`,
  howLimit: (give: number, work: number) =>
    `Each person can give at most ${give} Coffee per day. Work Coffee counts at most ${work} per person per day.`,
  howGuest: "Guests can receive Coffee but cannot give it.",
  tiersTitle: "Tiers",
  tiersHint: "Tiers come from the all-time score, not just this month.",
  tierCol: "Tier",
  minCol: "Minimum score",
  tiers: {
    anak_baru: "Newcomer",
    andalan: "Go-to",
    senior: "Senior",
    legenda: "Legend",
  },

  settingsTitle: "Coffee settings",
  settingsHint: "Only superadmins see this part.",
  featureSwitch: "Coffee",
  featureSwitchHint: "For the whole office: giving Coffee, the Coffee mark next to names, and the board.",
  boardSwitch: "Monthly board",
  boardSwitchHint: "The Most helpful board on this tab.",
  boardSwitchNeedsFeature: "The board only shows when Coffee is also on.",
  on: "On",
  off: "Off",
  saving: "Saving...",
  saveFail: "Coffee settings were not saved",
  featureOnDone: "Coffee is on for the whole office.",
  featureOffDone: "Coffee is off for the whole office.",
  boardOnDone: "Monthly board turned on.",
  boardOffDone: "Monthly board turned off.",
  confirmTitle: "Turn Coffee off?",
  confirmBody:
    "While it is off, nobody can give Coffee, the Coffee mark next to names disappears, and the monthly board is hidden.",
  confirmKeep: "Existing Coffee is not deleted and shows again when Coffee is turned back on.",
  confirmBtn: "Turn Coffee off",
  confirmBusy: "Turning off...",
};

export default en;
