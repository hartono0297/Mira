import { plural, type Dict } from "./core";
import type id from "./sign.id";

const en: Dict<typeof id> = {
  myState: {
    your_turn: "Your turn",
    waiting_others: "Waiting for others",
    signed: "Signed by you",
    not_involved: "You are not a signer",
  },
  status: {
    in_progress: "In progress",
    completed: "Completed, locked",
    cancelled: "Cancelled",
  },
  requestState: {
    waitingFile: "Waiting for the file",
    waitingPeer: "Waiting for a colleague's signature",
    cannotSign: "Can't be signed",
    waitingSigners: "Waiting for signers",
  },
  headerProgress: (status: string, signed: number, total: number) => `${status}, ${signed} of ${total} signed`,
  sealInvalid: "Completed, lock not valid",
  mode: {
    sequential: "In order",
    parallel: "Any order",
  },
  modeHint: {
    sequential: "One at a time, in order. The next person can sign only after the previous one has signed.",
    parallel: "Anyone can sign first. The document is complete once everyone has signed.",
  },
  kind: {
    guest: "Guest",
    member: "Member",
  },
  events: {
    created: "Request created",
    signed: "Signed",
    completed: "All signed, document locked",
    cancelled: "Request cancelled",
    exported: "PDF copy saved outside Mira",
    signature_saved: "Created a new signature",
    signature_deleted: "Deleted a signature",
  },
  eventOther: (kind: string) => `Other entry (${kind})`,
  integrity: {
    intact: "File content intact",
    changed: "File content doesn't match Mira's record",
    missing: "File is missing from Mira's storage",
  },
  exportState: {
    intact: "Intact",
    changed: "Changed",
    missing: "Not found",
  },
  exportWarningMany: (count: number) => `${count} PDF copies saved outside Mira have changed`,
  exportWarningOne: "A PDF copy saved outside Mira has changed",
  fileNeed: {
    downloadingNewer: "Copying a colleague's latest signature to this laptop",
    downloading: "Copying the file from a colleague's laptop",
    autoNewer: "A colleague's latest signature is copied automatically when the laptop that has it connects.",
    auto: "The file is copied automatically when the colleague's laptop that has it connects.",
    whyUnknown: "Its size isn't known yet, so it isn't copied automatically.",
    whyLarge: "Files over 20 MB aren't copied automatically.",
    newer: (why: string) => `The latest signed version hasn't been downloaded. ${why}`,
    unknownSize: (why: string) => `This file hasn't been downloaded. ${why}`,
    sized: (size: string, why: string) => `This ${size} file hasn't been downloaded. ${why}`,
  },
  download: "Download file",
  downloadSized: (size: string) => `Download file (${size})`,
  cancelConfirm: {
    title: "Cancel this request?",
    confirmLabel: "Cancel request",
    busyLabel: "Cancelling...",
    body: "Signers who haven't signed yet won't be able to sign. Existing signatures stay in the audit trail. You can't undo a cancellation.",
  },
  rowMenu: {
    open: "Open",
    sign: "Sign",
    export: "Save a PDF copy",
    verify: "Check file authenticity",
    cancel: "Cancel request",
    notYourTurn: "Not your turn yet",
    fileAbsent: "The file isn't on this laptop yet",
    fileChanged: "File content doesn't match Mira's record",
    fileMissing: "Document file not found",
    waitingPeer: "Waiting for a colleague's latest signature",
    exporting: "Saving a copy",
    downloading: "Downloading",
    otherDownload: "Wait for the other download to finish",
  },
  signError: {
    version_not_prefix:
      "Mira rejected this signature because the previous version isn't fully contained in it. Signatures can only be added after the existing content. Try again. If it's still rejected, ask the requester to create a new request.",
    version_changes_content:
      "Mira rejected this signature because it changes the document beyond the signature stamp. Try again. If it's still rejected, ask the requester to create a new request.",
    not_available:
      "No connected colleague's laptop has this file yet. Try again when the laptop that has it is on and connected to Mira.",
  },
  reject: {
    version_changes_content: (n: string) =>
      `${n}'s version was rejected because it changes the document instead of only adding a signature.`,
    version_not_prefix: (n: string) =>
      `${n}'s version was rejected because the previous document content isn't fully contained in it. Signatures can only be added after the existing content.`,
    pdf_invalid: (n: string) => `${n}'s version was rejected because Mira can't read or check its PDF file.`,
    tag_missing: (n: string) => `${n}'s version was rejected because that file isn't for this document.`,
    skipped_concurrent: (n: string, other: string | null) =>
      `${n}'s version wasn't used because ${other ?? "another signer"} signed the same version first. ${n} needs to sign the latest version.`,
    on_rejected: (n: string) => `${n}'s version was rejected because it was signed on top of a version that was already rejected.`,
    outdated_version: (n: string) => `${n}'s version wasn't used because it was signed on top of an old version of the document.`,
    not_allowed: (n: string) => `${n}'s version was rejected because ${n} isn't a signer of this document.`,
    not_your_turn: (n: string) => `${n}'s version was rejected because it was made before ${n}'s turn.`,
    already_signed: (n: string) => `${n}'s version wasn't used because ${n} already signed another version of this document.`,
    request_closed: (n: string) => `${n}'s version wasn't used because the document had already been fully signed.`,
    invalid_record: (n: string) => `${n}'s version was rejected because its signature record is incomplete.`,
  },
  rejectFallback: (name: string) => `Mira didn't use ${name}'s version.`,
  colleague: "a colleague",
  exportNotice: (count: number) =>
    `${count > 1 ? `${count} copies` : "One copy"} saved outside Mira ${count > 1 ? "have" : "has"} changed. See the PDF copies section for details.`,
  cooling: (when: string) =>
    `Your new signature can be used from ${when}, because your previous signature was deleted without a PIN.`,
  size: {
    bytes: (n: number) => `${n} ${plural(n, "byte", "bytes")}`,
  },
  checkPdf: {
    notPdf: "This file isn't a PDF. Choose a file ending in .pdf.",
    empty: "This file is empty.",
    tooLarge: "The file is over 50 MB. Mira accepts PDFs up to 50 MB.",
  },
  spot: {
    left: "left",
    right: "right",
    top: "top",
    bottom: "bottom",
    center: "center",
    centerV: (vert: string) => `${vert} center`,
    centerH: (h: string) => `center ${h}`,
    corner: (h: string, vert: string) => `${vert} ${h}`,
  },
  flow: {
    stampFailed: "Couldn't place the signature on the PDF.",
    auditFailed: "Couldn't add the signature record page.",
    saveFailed: "The signed PDF wasn't saved.",
    auditIncomplete: (name: string) =>
      `${name}'s signature hasn't been recorded yet, so the signature record page can't be created. Reload the document and try again.`,
  },
  stamp: {
    invalidTime: "The signing time isn't valid.",
    encrypted:
      "This PDF is protected with an owner password, so Mira can't add a signature. Save it again without protection in the app it came from, then try again.",
    notPdf: "This file isn't a PDF or is damaged, so it can't be signed.",
    broken:
      "This PDF is damaged or its format isn't supported, so Mira can't add a signature. Save it again from the app it came from, then try again.",
    invalidDocTag: "The document code isn't valid.",
    imageNotTransparent:
      "This signature image doesn't have a transparent background, so it could cover text in the document. Draw your signature again, or import a photo of it on white paper.",
    imageDense:
      "More than half of this signature image is covered in ink, so it could cover text in the document. Draw it again with thinner strokes, or import a photo of your signature on white paper.",
    imageCover:
      "This signature image has white areas that aren't transparent, so it could cover text in the document. Draw your signature again, or import a photo of it on white paper.",
    pageMissing: (page: number, count: number) => `Page ${page} isn't in this PDF (it has ${count} ${plural(count, "page", "pages")}).`,
    invalidPlacement: "The signature position isn't valid.",
    imageUnreadable: "The signature image can't be read.",
  },
};

export default en;
