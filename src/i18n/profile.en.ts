import type { Dict } from "./core";
import type id from "./profile.id";

const en: Dict<typeof id> = {
  section: {
    loading: "Reading your profile photo...",
    loadErrorTitle: "Couldn't read your profile photo",
    retry: "Try reading again",
    change: "Change photo",
    remove: "Remove photo",
    noPhoto: "No photo yet. Colleagues see your initials.",
    visibleTo: "Your photo appears next to your name on every organization member's laptop, guests included.",
    processing: "Mira crops the photo to a 256-pixel square and strips location and camera data from the file.",
    removedTitle: "A superadmin removed your photo",
    removedBody: "Colleagues see your initials. You can set another photo with Change photo.",
    changeFailed: "Couldn't use this photo",
    saved: "Profile photo saved.",
    removed: "Profile photo removed.",
  },
  confirmRemove: {
    title: "Remove profile photo?",
    body: "Colleagues will see your initials again. Laptops that are offline update once they connect.",
    busy: "Removing...",
    failed: "Couldn't remove the photo",
  },
  members: {
    heading: "Member photos",
    intro: "Remove photos that aren't appropriate. The owner can still set another photo.",
    loading: "Reading member photos...",
    loadErrorTitle: "Couldn't read member photos",
    empty: "No other member has set a photo yet.",
    removeLabel: (name: string) => `Remove ${name}'s photo`,
    confirmTitle: (name: string) => `Remove ${name}'s photo?`,
    confirmBody: (name: string) =>
      `The photo disappears from every member's laptop. ${name} sees a note that a superadmin removed it and can set another photo.`,
    removed: (name: string) => `${name}'s photo removed.`,
  },
  menu: {
    label: "Your profile menu",
    change: "Change photo",
    remove: "Remove photo",
    open: "Open profile",
    dismiss: "Close",
  },
};

export default en;
