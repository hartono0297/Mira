import type { Dict } from "./core";
import type id from "./language.id";

const en: Dict<typeof id> = {
  legend: "Language",
  hint: "Takes effect right away on this laptop. Colleagues keep their own choice.",
  userText: "Messages, names, and anything your colleagues write stay as they wrote them.",
  saving: "Saving your language choice...",
  errorTitle: "Language not saved",
  errorBody: (message: string, kept: string) => `${message} Switched back to ${kept}. Try choosing again.`,
};

export default en;
