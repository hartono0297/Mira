import { plural, type Dict } from "./core";
import type id from "./chat-reaction.id";

const en: Dict<typeof id> = {
  bar: (author: string, time: string) => `Reactions to message from ${author} at ${time}`,
  chip: (emoji: string, count: number, names: string) => `${emoji} ${count}. ${names}.`,
  tip: (who: string, emoji: string) => `${who} reacted with ${emoji}`,
  tipReadOnly: "Reactions can't be changed in this conversation.",
  you: "You",
  joinTwo: (a: string, b: string) => `${a} and ${b}`,
  joinMany: (head: string, last: string) => `${head}, and ${last}`,
  others: (n: number) => `${n} ${plural(n, "other", "others")}`,
  people: (n: number) => `${n} ${plural(n, "person", "people")}`,
  add: (author: string, time: string) => `React to message from ${author} at ${time}`,

  quickGroup: (author: string, time: string) => `Quick reactions for message from ${author} at ${time}`,
  quick: (emoji: string) => `React with ${emoji}`,
  more: (author: string, time: string) => `More reactions for message from ${author} at ${time}`,
  moreShort: "More reactions",
  picker: (author: string, time: string) => `Choose a reaction for message from ${author} at ${time}`,

  added: (emoji: string) => `Reaction ${emoji} added.`,
  removed: (emoji: string) => `Reaction ${emoji} removed.`,
  failed: (detail: string) => `Reaction not saved. ${detail}`,

  sticker: "Sticker",
  stickerFetching: "Getting the sticker image from a colleague's laptop.",
  stickerMissing: "The sticker image appears once a colleague's laptop that has it comes online.",
};

export default en;
