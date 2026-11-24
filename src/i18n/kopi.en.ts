import type { Dict } from "./core";
import { plural } from "./core";
import type id from "./kopi.id";

const coffees = (n: number) => `${n} ${plural(n, "coffee", "coffees")}`;

const en: Dict<typeof id> = {
  tier: {
    anak_baru: "Newcomer",
    andalan: "Go-to",
    senior: "Senior",
    legenda: "Legend",
  },
  mark: {
    label: (tier: string, n: number) => `${tier}, ${coffees(n)}`,
  },
  give: {
    title: (name: string) => `Give ${name} a coffee`,
    forMessage: "For this message",
    forTask: "For this task",
    reasonLabel: "Reason",
    reasonHint: "One sentence is enough, for example for helping check the working drawings.",
    publicNote: "Everyone in the office can see the reason.",
    counter: (n: number, max: number) => `${n} of ${max} characters`,
    reasonEmpty: "Write the reason first.",
    reasonTooLong: (max: number, now: number) => `The reason can be at most ${max} characters (now ${now}).`,
    left: (n: number, limit: number) => `Left today: ${n} of ${coffees(limit)}.`,
    noneLeft: (limit: number) => `You've given all ${coffees(limit)} for today. You can give again tomorrow.`,
    already: "You've already given a coffee for this.",
    cannotGive: "Only office members can give coffee, and only while the Coffee feature is on.",
    send: "Send coffee",
    sending: "Sending coffee...",
    cancel: "Cancel",
    failTitle: "Coffee not sent",
  },
  profile: {
    title: "Coffee",
    loading: "Loading coffee...",
    loadFail: "Couldn't read this person's coffee",
    retry: "Try again",
    stale: (message: string) => `Couldn't read the latest coffee data (${message}). Showing the last data loaded.`,
    featureOff: "The Coffee feature is off. A superadmin can turn it on in Organization, under Coffee.",
    fromPeers: "From colleagues",
    fromWork: "From work",
    tierLabel: "Level",
    progressLabel: (next: string) => `Toward ${next}`,
    progressText: (score: number, need: number, next: string) =>
      `Score ${score}. ${need} more to become ${next}.`,
    top: (score: number) => `Score ${score}. This is the highest level.`,
    scoreHint: (peer: number, work: number) =>
      `A coffee from a colleague counts ${peer} points, a coffee from work counts ${work}.`,
    giveBtn: "Give coffee",
    givenToday: "You've already given a coffee from this profile today.",
    noneLeft: (limit: number) => `You've given all ${coffees(limit)} for today.`,
    historyTitle: "Who gave it, and why",
    empty: "No coffee yet. Coffee comes from colleagues saying thanks and from finished tasks.",
    viaMessage: "for a message",
    viaTask: "for a task",
    viaProfile: "from the profile",
    workLabel: "Coffee from work",
    otherProject: "Task in another project",
    whyAssigned: "Finished a task a colleague assigned",
    whyOnTime: "Finished on time",
    showAll: (n: number) => `Show all (${n})`,
    showLess: "Show fewer",
    hiddenChip: "Hidden",
    hide: "Hide",
    hideFor: (name: string) => `Hide the coffee from ${name}`,
    unhide: "Show again",
    unhideFor: (name: string) => `Show the coffee from ${name} again`,
    hideFail: "Change not saved",
  },
};

export default en;
