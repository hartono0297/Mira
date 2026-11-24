import type { Dict } from "./core";
import type id from "./chat.id";

const en: Dict<typeof id> = {
  title: "Chat",
  retry: "Try again",
  reloading: "Reloading...",
  close: "Close",
  cancel: "Cancel",

  screen: {
    loading: "Loading chat...",
    errorTitle: "Couldn't read the chat list",
    errorNoList: "The Mira core didn't send the chat list.",
    errorSafe: "Your messages are stored on this laptop and nothing is lost. Wait a moment, then try again.",
    dmError: "Couldn't open the direct message",
    emptyTitle: "No conversations yet",
    emptyGuest:
      "As a guest, you can only chat in projects you were invited to. Those project chats show up under " +
      "Projects once your laptop connects to a colleague's laptop at the office. If they still don't appear, " +
      "ask the project admin to check your invite.",
    emptyMember:
      "The #umum channel, department channels, and your project chats show up here once office data is copied " +
      "from a colleague's laptop. Meanwhile, you can start a group or send a direct message from the list on the left.",
  },

  list: {
    label: "Conversations",
    notify: "Chat notification settings",
    stale: "The chat list isn't up to date.",
    noOrgChannel: "No general channels yet.",
    newOrgChannel: "New general channel",
    orgChannelBySuperadmin: "General channels are created by a superadmin.",
    noDeptChannel: (department: string) => `No channels for Department ${department} yet.`,
    noDepartment: "No department yet.",
    noProjects: "You're not in any projects yet.",
    guestProjects: "As a guest, you only see chats for projects you're in.",
    otherProjects: "Other projects are hidden because you're not a member.",
    noGroups: "No groups yet.",
    newGroup: "New group",
    noDirect: "No direct messages yet.",
    newDirect: "New message",
    rowDirect: (name: string) => `Direct message with ${name}`,
    rowGroup: (name: string) => `Group ${name}`,
    rowProject: (name: string) => `Project chat ${name}`,
    rowChannel: (name: string) => `Channel ${name}`,
    readOnly: "read-only",
    muted: "muted",
  },

  state: {
    former: "No longer a member",
    archived: "Archived",
    readOnly: "Read-only",
    muted: "Muted",
  },

  actionErrors: {
    markRead: "Couldn't mark as read",
    mute: "Couldn't change notifications",
    archive: "Couldn't change the archive",
    lock: "Couldn't change read-only status",
  },

  header: {
    addPeople: "Add people",
    menu: (title: string) => `Menu for ${title}`,
    groupError: "Couldn't load group details",
    groupWait: {
      rename: "Rename opens once the group details load.",
      add: "Add people opens once the group details load.",
    },
  },

  conv: {
    newMessage: (author: string, preview: string) => `New message from ${author}: ${preview}`,
    loading: "Loading messages...",
    loadError: "Couldn't load messages",
    latestError: "Couldn't load the latest messages",
    emptyCanPost: (target: string) => `No messages in ${target} yet. Write the first one in the box below.`,
    empty: (target: string) => `No messages in ${target} yet.`,
    emptyAfterCanPost: "No messages yet. Write the first one in the box below.",
    emptyAfter: "No messages yet.",
    loadingOlder: "Loading...",
    loadOlder: "Load earlier messages",
    olderError: "Couldn't load earlier messages",
    region: (title: string) => `Messages in ${title}`,
    deleteTitle: "Delete this message?",
    deleteConfirm: "Delete message",
    deleteBusy: "Deleting...",
    deleteError: "Message not deleted",
    deleteBody: (title: string) =>
      `This message is deleted for everyone in ${title} and can't be restored. The conversation only shows "Message deleted".`,
  },

  message: {
    replyUnknown: "a message",
    replyJump: (author: string, text: string) => `Reply to ${author}: ${text}. Go to the original message`,
    replyTo: "Reply to ",
    mentionsYou: "Mentions you",
    files: "Attachments",
    actions: (author: string, time: string) => `Message actions for ${author} at ${time}`,
    replyLabel: (author: string, time: string) => `Reply to message from ${author} at ${time}`,
    deleteLabel: (author: string, time: string) => `Delete message from ${author} at ${time}`,
    delete: "Delete",
  },

  composer: {
    projectArchived: "This project chat is archived, so new messages can't be sent.",
    channelArchived: "This channel is archived. Restore it from the archive to send messages.",
    cannotPost: "You can't send messages in this conversation.",
    formerKept: "New messages no longer reach your laptop; old messages stay saved here.",
    formerGroup: "You're no longer in this group.",
    formerProject: "You're no longer a member of this project.",
    formerDepartment: "You've moved out of this department.",
    formerChannel: "You're no longer a member of this channel.",
    offline: (name: string) => `${name} is offline. Your message waits and is delivered once their laptop connects.`,
    replying: (name: string) => `Replying to ${name}`,
    cancelReply: "Cancel reply",
    attachments: "Files to send",
    removeAttachment: (name: string) => `Remove attachment ${name}`,
    sendError: "Message not sent",
    sendErrorKept: "Your text and attachments are still in the message box.",
    attachError: "Couldn't pick the file",
    attach: "Attach file",
    inputLabel: (target: string) => `Message to ${target}`,
    placeholder: (target: string) => `Message ${target}`,
    hint: "Enter to send, Shift+Enter for a new line, type @ to mention a colleague.",
    mentionList: "Mention a colleague",
    sending: "Sending...",
    send: "Send",
  },

  status: {
    button: (state: string) => `Status: ${state}. View details per person`,
    popLabel: "Message status per person",
    popTitle: "Message status",
    loading: "Loading status...",
    error: "Couldn't load the status.",
    empty: "No recipients yet.",
  },

  file: {
    openError: "Couldn't open the file",
    saveError: "File not saved",
    downloadError: "Couldn't download the file",
    downloading: "Downloading...",
    openLabel: (name: string) => `Open ${name}`,
    opening: "Opening...",
    open: "Open",
    saving: "Saving...",
    downloadLabel: (name: string) => `Download ${name}`,
    download: "Download",
    missing: "Not available yet. The file downloads automatically once the colleague's laptop that has it is online.",
    saved: (name: string) => `${name} saved.`,
  },
};

export default en;
