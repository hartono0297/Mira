import { plural, type Dict } from "./core";
import type id from "./sign-list.id";

const en: Dict<typeof id> = {
  title: "Signatures",
  subWaiting: (n: number) => `${n} ${plural(n, "document is", "documents are")} waiting for your signature`,
  subIdle: "PDFs signed on this laptop",
  loading: "Loading your signature and documents...",
  incompleteData: "The Mira core sent incomplete signature data.",
  loadErrorTitle: "Couldn't read the signature list",
  loadErrorFallback: "The Mira core didn't send any signature data.",
  retry: "Try again",
  staleData: (message: string) => `Couldn't read the latest data (${message}). Showing the last data loaded.`,

  waitingTitle: "Waiting for your signature",
  waitingHint: "Requests from colleagues that list you as a signer. Your turn comes first.",

  mine: {
    title: "My signature",
    savedSince: (when: string) => `Saved since ${when}, used with your PIN`,
    cooling: (when: string) =>
      `Usable from ${when}, 24 hours after the previous signature was deleted without a PIN.`,
    locked: (when: string) => `Locked until ${when} after several wrong PIN attempts.`,
    failed: (failed: number, left: number) =>
      `Wrong PIN ${failed} ${plural(failed, "time", "times")} since the last correct one. ${left} ${plural(left, "attempt", "attempts")} left before a temporary lock.`,
    noneTitle: "No saved signature yet",
    noneHint:
      "Draw with a mouse or pen, or use a photo of your signature. Mira stores the image locked, and it only works with your PIN.",
    delete: "Delete signature",
    create: "Create signature",
  },

  row: {
    menuLabel: (title: string) => `Actions for ${title}`,
    moreLabel: (title: string) => `More actions for ${title}`,
    requestedBy: (name: string) => `Requested by ${name}`,
    signedOf: (signed: number, total: number) => `${signed} of ${total} signed`,
    completedAt: (when: string) => `completed ${when}`,
    changedAt: (when: string) => `last changed ${when}`,
    downloadingAria: (title: string) => `Downloading file ${title}`,
    downloadAria: (title: string, size: string) => `Download file ${title}${size}`,
    downloading: "Downloading...",
  },

  docs: {
    title: "Documents",
    verify: "Check a PDF file",
    reading: "Reading PDF...",
    pick: "Choose a PDF to sign",
    guest:
      "As a guest, you can't request signatures, but you can sign documents from colleagues for projects you're allowed to open.",
    warnTitle: (n: number) => `${n === 1 ? "One document needs" : `${n} documents need`} checking`,
    warnBody: "Some files changed or went missing after signing. The rows with a warning have the details.",
    emptyOthers: "Other documents you send or have signed show up here.",
    emptyRequester:
      "No documents yet. Choose a PDF to sign yourself or with colleagues. Requests reach signers once their laptops connect.",
    emptySigner:
      "No documents for you to sign yet. Requests from colleagues show up here once the sender's laptop connects.",
  },

  feedback: {
    saved: "Signature saved. Mira asks for your PIN every time you use it.",
    deletedWithPin: "Saved signature deleted. You can create and use a new one right away.",
    deletedWithoutPin:
      "Saved signature deleted. You can create a new one now and use it 24 hours after this deletion.",
    pdfError: "Couldn't open the PDF",
    copying: (title: string) => `File ${title} is being copied. The list updates once it's done.`,
    downloaded: (title: string) => `File ${title} is now on this laptop.`,
    downloadError: "Couldn't download the file",
    exported: (title: string, path: string) => `Copy of ${title} saved to ${path}`,
    exportError: "Copy not saved",
    cancelled: (title: string) => `Request ${title} canceled.`,
  },

  pinDelete: {
    title: "Delete saved signature?",
    description:
      "Enter your signature PIN. Mira removes the signature image and its PIN from this laptop. Documents you already signed stay as they are. You can create and use a new signature right away.",
    submit: "Delete signature",
    forgot: "Forgot PIN?",
  },

  forgot: {
    title: "Delete signature without a PIN?",
    confirm: "Delete without PIN",
    busy: "Deleting...",
    errorTitle: "Signature not deleted",
    body1: "Mira removes the signature image and its PIN from this laptop. Documents you already signed stay as they are.",
    body2:
      "A new signature you create after this can only be used 24 hours after the deletion. The wait stops someone using your unlocked laptop from deleting your signature and signing with a PIN of their own.",
    body3: "The audit trail records this deletion.",
  },
};

export default en;
