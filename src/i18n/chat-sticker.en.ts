import { plural, type Dict } from "./core";
import type id from "./chat-sticker.id";

const en: Dict<typeof id> = {
  composer: {
    emoji: "Insert emoji",
    sticker: "Send a sticker",
    emojiList: "Emoji suggestions",
    emoteOption: (name: string) => `:${name}:, office emote`,
    emoteTag: "office",
    hint: "Type a colon and a name to insert an emoji.",
  },
  picker: {
    label: "Choose a sticker",
    tabs: "Sticker type",
    office: "Office",
    mine: "Mine",
    search: "Search stickers",
    searchPlaceholder: "Name or keyword",
    loading: "Loading stickers...",
    loadError: "Stickers could not be loaded",
    retry: "Try again",
    retrying: "Reloading...",
    emptyOffice: "There are no office stickers yet. A superadmin can add them in Organization, on the Stickers tab.",
    emptyMine:
      "You have no stickers of your own yet. Save one from a message through the message menu, or upload a PNG, WebP, or GIF image.",
    noMatch: (query: string) => `No sticker has the name or keyword ${query}.`,
    notReady: "The image has not reached this laptop yet, so it cannot be sent.",
    notReadyNote: "Stickers with a dashed outline have not reached this laptop yet and cannot be sent.",
    sending: "Sending sticker...",
    sendError: "The sticker was not sent",
    upload: "Upload a sticker",
    uploadHint: "PNG, WebP, or GIF, up to 512 KB and 1024 x 1024 pixels.",
    pickError: "The image could not be chosen",
    remove: (name: string) => `Remove :${name}: from my stickers`,
    removeHint: "Press Delete to remove the selected sticker.",
    removeTitle: "Remove this sticker?",
    removeBody: (name: string) =>
      `:${name}: is removed from your collection on this laptop. Messages already sent still show it.`,
    removeConfirm: "Remove sticker",
    removing: "Removing...",
    removeError: "The sticker was not removed",
  },
  form: {
    title: "New sticker",
    details: (size: string, width: number, height: number) => `${size}, ${width} x ${height} pixels`,
    frames: (count: number) => `animated, ${count} ${plural(count, "frame", "frames")}`,
    name: "Name",
    nameHint: "Used as :name:. Lowercase letters, digits, and underscores, 2 to 32 characters.",
    nameInvalid: "Use only lowercase letters a to z, digits, and underscores, 2 to 32 characters.",
    keywords: "Keywords (optional)",
    keywordsHint: (max: number) => `Used for search. Separate them with commas or spaces, up to ${max}.`,
    tooManyKeywords: (max: number) => `Up to ${max} keywords.`,
    keywordTooLong: (word: string) => `The keyword ${word} is too long. Use 24 characters at most.`,
    save: "Save sticker",
    saving: "Saving...",
    cancel: "Cancel",
    saveError: "The sticker was not saved",
  },
};

export default en;
