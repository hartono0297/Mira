import type { Dict } from "./core";
import type id from "./components-menu.id";

const en: Dict<typeof id> = {
  label: "Text menu",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  selectAll: "Select all",
  noSelection: "No text selected yet",
  readOnly: "This field is read-only",
  secret: "Password fields can't be copied",
  empty: "This field is empty",
  failed: (action: string) => `${action} failed`,
};

export default en;
