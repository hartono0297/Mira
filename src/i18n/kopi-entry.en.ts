import type { Dict } from "./core";
import type id from "./kopi-entry.id";

const en: Dict<typeof id> = {
  give: "Give coffee",
  givenMessage: "Coffee already given",
  limitShort: "No coffee left today",

  thank: (name: string) => `Thank ${name}`,
  givenTask: (name: string) => `You already gave ${name} a coffee for this task.`,
  limitLong: (limit: number) => `You've given all of today's coffee (${limit} a day). You can give more tomorrow.`,
};

export default en;
