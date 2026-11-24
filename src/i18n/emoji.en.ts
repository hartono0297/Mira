import type { Dict } from "./core";
import type id from "./emoji.id";

const en: Dict<typeof id> = {
  dialog: "Choose an emoji",
  search: "Search emoji",
  searchPlaceholder: "Search, for example thumbs or coffee",
  categories: "Emoji categories",
  category: {
    recent: "Frequently used",
    office: "Office emotes",
    faces: "Faces",
    people: "Gestures and people",
    symbols: "Hearts and symbols",
    nature: "Animals and nature",
    food: "Food and drink",
    activity: "Activities and office",
    travel: "Travel and places",
    flags: "Flags",
  },
  results: (query: string) => `Results for "${query}"`,
  noResults: (query: string) => `No emoji match "${query}". Try another word, such as smile.`,
  emptyRecent: "Emoji you use will show up here.",
};

export default en;
