import type { Dict } from "./core";
import type id from "./components-pdf.id";

const en: Dict<typeof id> = {
  toolbar: (label: string) => `View controls for ${label}`,
  prev: "Previous",
  prevTitle: "Previous page",
  next: "Next",
  nextTitle: "Next page",
  zoomOut: "Zoom out",
  zoomIn: "Zoom in",
  zoomValue: (percent: number) => `Zoom ${percent} percent`,
  fitWidth: "Fit width",
  loading: "Opening PDF...",
  empty: "This PDF has no pages, so there's nothing to show. Check the original file.",
  pageOf: (page: number, count: number) => `Page ${page} of ${count}`,
  drawing: (page: number) => `Showing page ${page}...`,
  pageErrorTitle: (page: number) => `Page ${page} couldn't be shown`,
  pageErrorBody: (detail: string) =>
    `This page's content couldn't be drawn${detail ? ` (${detail})` : ""}. Go to another page and come back, or open the file again.`,
  pageField: "Page",
  pageFieldOf: (count: string) => `of ${count}`,
  place: {
    role: "movable box",
    keyHint:
      "Arrow keys move the box, Shift and an arrow move it further. Alt and an arrow, or the plus and minus keys, change its size.",
    edge: "Already at the edge of the page.",
    largest: "Already the largest size on this page.",
    smallest: "Already the smallest size.",
  },
  errors: {
    empty: {
      title: "The PDF file is empty",
      detail: "This file is 0 bytes, so there's nothing to show. Get the original file again, then reopen it.",
    },
    invalid: {
      title: "This file isn't a PDF or is damaged",
      detail:
        "Mira couldn't find a readable PDF structure. Make sure the file ends in .pdf and opens in another app. If it doesn't, ask the sender to send it again.",
    },
    password: {
      title: "The PDF is password protected",
      detail:
        "Mira can't open locked PDFs yet. Unlock it in another PDF app, save it without a password, then open it here again.",
    },
    runtimeMac: {
      title: "The macOS display component needs an update",
      detail:
        "WebKit on this Mac is too old to show PDFs. Update macOS in System Settings > General > Software Update, then try again.",
    },
    runtimeWindows: {
      title: "The Windows display component needs an update",
      detail:
        "Microsoft Edge WebView2 on this computer is too old to show PDFs. Run Windows Update or reinstall Mira, then try again.",
    },
    unknownTitle: "The PDF couldn't be opened",
    unknownDetail: (detail: string) =>
      `Something went wrong while reading the file${detail ? ` (${detail})` : ""}. Close the file and open it again. If it still fails, the file is probably damaged.`,
  },
};

export default en;
