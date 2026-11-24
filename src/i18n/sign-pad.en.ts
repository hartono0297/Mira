import type { Dict } from "./core";
import type id from "./sign-pad.id";

const en: Dict<typeof id> = {
  pin: {
    empty: "Enter your PIN.",
    digitsOnly: "Use only the digits 0 to 9 in your PIN.",
    length: (min: number, max: number) => `Your PIN needs ${min} to ${max} digits.`,
  },
  pinDialog: {
    title: "Enter your PIN",
    description: "You need your signature PIN every time you sign.",
    submit: "Sign",
    label: "Signature PIN",
    locked: (clock: string) => `Too many wrong PINs. Try again at ${clock}.`,
    cooling: (when: string) =>
      `This signature can be used from ${when}, 24 hours after the previous signature was deleted without a PIN.`,
    errorTitle: "Can't continue yet",
    cancel: "Cancel",
    checking: "Checking PIN...",
  },
  pad: {
    emptyLabel: "Signature drawing box, empty",
    filledLabel: (count: number) => `Signature drawing box, ${count} ${count === 1 ? "stroke" : "strokes"}`,
    hint: "Sign above the line with a mouse, pen, or finger. Pressing a pen harder makes the line thicker.",
    undo: "Undo stroke",
    clear: "Clear",
  },
  setup: {
    title: "Create a signature",
    description:
      "This signature goes on the PDFs you sign. The image is stored on this laptop, locked with a PIN.",
    stepImage: "Step 1 of 2: signature image",
    stepPin: "Step 2 of 2: create a PIN",
    methodLegend: "How to create it",
    methodDraw: "Draw",
    methodImport: "Import an image",
    methodHint:
      "Drawing needs a mouse, pen, or touch screen. If you use a keyboard, choose Import an image and use a photo or scan of your signature.",
    fileLabel: "Signature image file",
    previewAlt: (fileName: string) => `Signature preview from ${fileName}`,
    previewFallback: "file",
    importing: "Processing image...",
    pickOther: "Choose another file",
    pickFile: "Choose an image file",
    importHint: "PNG or JPG, up to 5 MB. Photograph your signature on white paper; the white background is removed automatically.",
    cancel: "Cancel",
    preparing: "Preparing image...",
    next: "Continue to PIN",
    padEmpty: "The drawing box is still empty. Sign above the line first.",
    noImport: "No image yet. Choose a signature image file first.",
    finalAlt: "Signature to be saved",
    newPin: "New PIN",
    newPinEmpty: "Create a PIN first, 6 to 12 digits.",
    pinHint: "6 to 12 digits. You'll enter this PIN every time you sign.",
    repeatPin: "Repeat PIN",
    repeatEmpty: "Type the same PIN once more.",
    repeatMismatch: "The PINs don't match. Type the same PIN again.",
    warn: "A PIN can't be recovered, not even by an admin. If you forget it, delete this signature and create a new one.",
    saveErrorTitle: "Signature not saved",
    back: "Back",
    saving: "Saving...",
    save: "Save signature",
  },
  image: {
    toPngFailed: "The signature image couldn't be converted to PNG. Try again.",
    tooComplex: "The image is too complex to save. Use a photo with a cleaner background.",
    wrongType: "This file isn't a PNG or JPG image. Choose a photo or scan of your signature.",
    tooLarge: "The image is larger than 5 MB. Make it smaller or choose another file.",
    cannotOpen: "The image can't be opened. The file may be damaged. Choose another PNG or JPG file.",
    empty: "This image is empty. Choose another file.",
    cannotProcess: "The image can't be processed on this laptop.",
    noInk: "No visible ink in this image. Choose a signature photo with clear ink.",
  },
};

export default en;
