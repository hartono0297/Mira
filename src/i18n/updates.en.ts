import type { Dict } from "./core";
import type id from "./updates.id";

const en: Dict<typeof id> = {
  dotLabel: ", update available",
  whatsNewTitle: (version: string) => `What's new in Mira ${version}`,
  close: "Close",
};

export default en;
