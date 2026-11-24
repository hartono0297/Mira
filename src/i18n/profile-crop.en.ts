import type { Dict } from "./core";
import type id from "./profile-crop.id";

const en: Dict<typeof id> = {
  title: "Adjust profile photo",
  description: "What shows inside the circle becomes your profile photo.",
  area: "Photo position",
  areaHint:
    "Drag the photo or press the arrow keys to move it, and hold Shift to move it further. Press + or -, or turn the mouse wheel, to zoom in and out.",
  zoom: "Zoom",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  zoomValue: (percent: number) => `${percent}%`,
  announceZoom: (percent: number) => `Zoom ${percent}%`,
  announcePosition: (left: number, top: number) => `Position ${left}% from the left, ${top}% from the top`,
  save: "Save photo",
  saving: "Saving photo...",
  cancel: "Cancel",
  errorTitle: "Photo not saved",
};

export default en;
