import type { Dict } from "./core";
import { plural } from "./core";
import type id from "./kopi-board.id";

// "Coffee" is the feature name (tab, settings); in sentences the unit is
// lowercase: "give coffee", "3 coffees".
const coffees = (n: number) => `${n} ${plural(n, "coffee", "coffees")}`;
const points = (n: number) => `${n} ${plural(n, "point", "points")}`;

const en: Dict<typeof id> = {
  tab: "Coffee",
  title: "Coffee",
  intro:
    "A coffee is a thank-you, and the count can only go up. Colleagues give coffee with a reason, and coffee also comes on its own when a task is finished on time or when a task from a colleague is finished.",
  loading: "Loading coffee...",
  loadErrorTitle: "Coffee data could not be read",
  loadErrorEmpty: "The Mira core sent no coffee data.",
  badData: "The Mira core sent coffee data that could not be read.",
  retry: "Try again",
  stale: (message: string) => `The latest coffee data could not be read (${message}). Showing the last data.`,

  featureOffTitle: "Coffee is turned off",
  featureOffBody:
    "A superadmin turned Coffee off for the whole office. While it is off, nobody can give coffee and the monthly board is hidden.",
  featureOffAdmin:
    "While it is off, nobody can give coffee and the monthly board is hidden. Turn it back on by checking Coffee under Coffee settings.",
  boardOffTitle: "Monthly board is turned off",
  boardOffBody: "A superadmin turned the monthly board off. Coffee can still be given and still shows on each profile.",
  boardOffAdmin: "Other people won't see this board until Monthly board is checked again.",

  boardTitleNow: "Most helpful this month",
  boardTitle: (month: string) => `Most helpful in ${month}`,
  boardHint: "The ten highest scores for the month, counting coffee from colleagues and from work.",
  monthNav: "Choose month",
  prevMonth: "Previous month",
  nextMonth: "Next month",
  monthLoading: (month: string) => `Loading the ${month} board...`,
  monthErrorTitle: (month: string) => `The ${month} board could not be read`,
  emptyNow:
    "No coffee yet this month. Give coffee to a colleague who helped from the right-click menu on their message, or finish a task by its due date.",
  emptyPast: (month: string) => `No coffee in ${month}.`,
  listLabel: (month: string) => `Ranking for ${month}`,
  rank: (n: number) => `Rank ${n}`,
  peer: "From colleagues",
  work: "From work",
  score: "Score",
  you: " (you)",

  howTitle: "How to earn coffee",
  howPeer: (weight: number) =>
    `From colleagues: a colleague gives coffee with a reason, from a chat message, a finished task, or a profile. One coffee from a colleague is worth ${weight} score ${plural(weight, "point", "points")}.`,
  howWork: (weight: number) =>
    `From work: comes on its own when a task someone else assigned to you is finished, or when a task is finished on or before its due date. One coffee from work is worth ${points(weight)}.`,
  howLimit: (give: number, work: number) =>
    `Each person can give up to ${coffees(give)} a day. Coffee from work counts for at most ${work} a day per person.`,
  howGuest: "Guests can receive coffee but cannot give it.",
  tiersTitle: "Levels",
  tiersHint: "Levels come from the all-time score, not just this month.",
  tierCol: "Level",
  minCol: "Minimum score",

  settingsTitle: "Coffee settings",
  settingsHint: "Only superadmins see this part.",
  featureSwitch: "Coffee",
  featureSwitchHint: "For the whole office: giving coffee, the coffee mark next to names, and the board.",
  boardSwitch: "Monthly board",
  boardSwitchHint: "Shows the monthly ranking on this tab.",
  boardSwitchNeedsFeature: "The board only shows when Coffee is also on.",
  saving: "Saving...",
  saveFail: "Coffee settings were not saved",
  featureOnDone: "Coffee is on for the whole office.",
  featureOffDone: "Coffee is off for the whole office.",
  boardOnDone: "Monthly board turned on.",
  boardOffDone: "Monthly board turned off.",
  confirmTitle: "Turn Coffee off?",
  confirmBody:
    "While it is off, nobody can give coffee, the coffee mark next to names disappears, and the monthly board is hidden.",
  confirmKeep: "Coffee already given is not deleted and shows again when Coffee is turned back on.",
  confirmBtn: "Turn Coffee off",
  confirmBusy: "Turning off...",
};

export default en;
