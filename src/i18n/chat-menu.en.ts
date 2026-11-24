import type { Dict } from "./core";
import type id from "./chat-menu.id";

const LEAVE = "Leave group";

const en: Dict<typeof id> = {
  messageMenu: (author: string, time: string) => `Actions for message from ${author} at ${time}`,
  messageMore: (author: string, time: string) => `More actions for message from ${author} at ${time}`,
  reply: "Reply",
  copyText: "Copy text",
  mentionAuthor: (name: string) => `Mention ${name}`,
  readStatus: "View read status",
  deleteMessage: "Delete message",
  copied: "Message text copied.",
  copyFailed: "Couldn't copy the text. Select it and press Ctrl+C.",
  react: "Add reaction",
  saveSticker: "Save sticker",
  stickerSaved: "Sticker saved to your collection.",
  stickerSaveFailed: (detail: string) => `Sticker not saved. ${detail}`,
  deleteStickerBody: (title: string) =>
    `This sticker is deleted for everyone in ${title} and can't be restored. The conversation only shows "Message deleted".`,

  convMenu: (title: string) => `Actions for ${title}`,
  open: "Open",
  markRead: "Mark as read",
  mute: "Mute",
  unmute: "Unmute",
  renameGroup: "Rename",
  addPeople: "Add people",
  leaveGroup: LEAVE,
  leaveTitle: (name: string) => `Leave group ${name}?`,
  leaveBody:
    "You won't get new messages from this group. Old messages stay saved on this laptop. " +
    "To rejoin, a group member has to add you again.",
  leaveOwner: "You own this group, so ownership passes to the member who has been in it longest.",
  leaveOwnerMaybe: "If you own this group, ownership passes to the member who has been in it longest.",
  leaveConfirm: LEAVE,
  leaveBusy: "Leaving...",
  leaveFailed: `${LEAVE} failed`,
  lock: "Make read-only",
  unlock: "Open to everyone",
  archive: "Archive channel",
  unarchive: "Restore from archive",
  deleteChannel: "Delete channel",
  deleteChannelTitle: (title: string) => `Delete channel ${title}?`,
  deleteChannelBody: (title: string) =>
    `Every message in ${title} is deleted for all members. This can't be undone.`,
  deleteChannelConfirm: "Delete channel",
  deleteChannelBusy: "Deleting...",

  fileMenu: (name: string) => `Actions for ${name}`,
  fileMore: (name: string) => `More actions for ${name}`,
  openFile: "Open",
  saveCopy: "Save a copy",
  downloadFromPeer: (size: string) => `Download from colleague (${size})`,
  saveCopyFile: (name: string) => `Save a copy of ${name}`,
  copyFileName: "Copy file name",
  fileBusy: "Wait for the other action to finish",
  fileNameCopied: (name: string) => `File name ${name} copied.`,
  fileNameCopyFailed: "Couldn't copy the file name. Select it and press Ctrl+C.",

  personMenu: (name: string) => `Actions for ${name}`,
  sendDm: "Send direct message",
  mention: "Mention",
  profile: "View profile",
  removeFromGroup: "Remove from group",
  removeTitle: (name: string) => `Remove ${name} from the group?`,
  removeBody: (name: string) => `${name} won't get new messages; old messages stay on their laptop.`,
  removeConfirm: "Remove",
  removeBusy: "Removing...",
};

export default en;
