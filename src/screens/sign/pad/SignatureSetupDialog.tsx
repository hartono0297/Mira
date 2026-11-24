import { IconArrowLeft, IconLock, IconPhotoUp } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { toAppError, type AppError } from "../../../api";
import { Dialog, DialogClose } from "../../../components/Dialog";
import { ErrorAlert } from "../../../components/ErrorAlert";
import { FieldError } from "../../../components/FieldError";
import { SIGN_PAD_TEXT } from "../../../i18n/sign-pad";
import { importSignatureImage, type SignatureImage } from "./image";
import { PIN_MAX, validatePin } from "./pin";
import { SignaturePad, type SignaturePadHandle } from "./SignaturePad";
import "./pad.css";

export type SaveSignatureInput = { png: Uint8Array; width: number; height: number; pin: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (input: SaveSignatureInput) => Promise<void>;
};

type Method = "draw" | "import";

// Pratinjau PNG dari byte di memori. URL dilepas saat gambar berganti.
function usePngUrl(png: Uint8Array | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!png) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [png]);
  return url;
}

// Dialog "Buat tanda tangan": langkah 1 gambar atau impor, langkah 2 PIN.
// Isi dikosongkan setiap kali dialog ditutup. Setelah onSave berhasil, dialog ditutup.
export function SignatureSetupDialog({ open, onOpenChange, onSave }: Props) {
  const T = SIGN_PAD_TEXT.setup;
  const [step, setStep] = useState<"image" | "pin">("image");
  const [method, setMethod] = useState<Method>("draw");
  const [imported, setImported] = useState<{ image: SignatureImage; fileName: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [image, setImage] = useState<SignatureImage | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [pin2Error, setPin2Error] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<AppError | null>(null);
  const [saving, setSaving] = useState(false);

  const padRef = useRef<SignaturePadHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);
  const pin2Ref = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  // Isian dan tombol nonaktif selama menyimpan, jadi fokus lepas ke body. Target
  // fokus dicatat di sini dan dipasang setelah render yang mengaktifkannya lagi.
  const refocus = useRef<"pin" | "save" | null>(null);
  const methodRefs = useRef<Record<Method, HTMLInputElement | null>>({ draw: null, import: null });
  const focusAfterStep = useRef<"pin" | "method" | null>(null);

  const ids = {
    method: useId(),
    methodHint: useId(),
    imageError: useId(),
    file: useId(),
    importHint: useId(),
    pin: useId(),
    pinHint: useId(),
    pinError: useId(),
    pin2: useId(),
    pin2Error: useId(),
  };

  // Direset saat dialog ditutup, jadi dialog selalu dibuka dalam keadaan bersih.
  // Kotak gambar ikut kosong karena isi dialog dilepas Radix saat tertutup.
  useEffect(() => {
    if (open) return;
    setStep("image");
    setMethod("draw");
    setImported(null);
    setImporting(false);
    setImageError(null);
    setImage(null);
    setPreparing(false);
    setPin("");
    setPin2("");
    setPinError(null);
    setPin2Error(null);
    setSaveError(null);
    setSaving(false);
  }, [open]);

  useEffect(() => {
    const target = focusAfterStep.current;
    focusAfterStep.current = null;
    if (target === "pin") pinRef.current?.focus();
    if (target === "method") methodRefs.current[method]?.focus();
  }, [step, method]);

  useEffect(() => {
    const target = refocus.current;
    if (saving || !target) return;
    refocus.current = null;
    (target === "pin" ? pinRef : saveRef).current?.focus();
  }, [saving]);

  const importedUrl = usePngUrl(imported?.image.png ?? null);
  const finalUrl = usePngUrl(image?.png ?? null);

  function pickMethod(next: Method) {
    setMethod(next);
    setImageError(null);
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Nilai dikosongkan supaya file yang sama bisa dipilih lagi setelah error.
    e.target.value = "";
    if (!file) return;
    setImporting(true);
    setImageError(null);
    try {
      const result = await importSignatureImage(file);
      setImported({ image: result, fileName: file.name });
    } catch (err) {
      setImageError(toAppError(err).message);
    } finally {
      setImporting(false);
    }
  }

  async function goToPin() {
    if (preparing || importing) return;
    setImageError(null);
    let result: SignatureImage | null = null;
    if (method === "draw") {
      setPreparing(true);
      try {
        result = (await padRef.current?.getPng()) ?? null;
      } catch (err) {
        setImageError(toAppError(err).message);
        return;
      } finally {
        setPreparing(false);
      }
      if (!result) {
        setImageError(T.padEmpty);
        return;
      }
    } else {
      result = imported?.image ?? null;
      if (!result) {
        setImageError(T.noImport);
        document.getElementById(ids.file)?.focus();
        return;
      }
    }
    setImage(result);
    setSaveError(null);
    focusAfterStep.current = "pin";
    setStep("pin");
  }

  function backToImage() {
    if (saving) return;
    setSaveError(null);
    focusAfterStep.current = "method";
    setStep("image");
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (saving || !image) return;
    const p1 = validatePin(pin, T.newPinEmpty);
    const p2 = p1 ? null : pin2.length === 0 ? T.repeatEmpty : pin2 !== pin ? T.repeatMismatch : null;
    setPinError(p1);
    setPin2Error(p2);
    setSaveError(null);
    if (p1) {
      pinRef.current?.focus();
      return;
    }
    if (p2) {
      pin2Ref.current?.focus();
      return;
    }
    setSaving(true);
    try {
      await onSave({ png: image.png, width: image.width, height: image.height, pin });
      setSaving(false);
      onOpenChange(false);
    } catch (err) {
      const error = toAppError(err);
      setSaving(false);
      if (error.code === "pin_invalid") {
        setPinError(error.message);
        refocus.current = "pin";
      } else {
        setSaveError(error);
        refocus.current = "save";
      }
    }
  }

  const busy = saving;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={T.title}
      description={T.description}
    >
      <div className="sig-setup">
        <p className="sig-step">{step === "image" ? T.stepImage : T.stepPin}</p>

        <div className="sig-step-body" hidden={step !== "image"}>
          <fieldset className="sig-methods">
            <legend className="sig-legend">{T.methodLegend}</legend>
            <div className="sig-seg">
              {(
                [
                  ["draw", T.methodDraw],
                  ["import", T.methodImport],
                ] as const
              ).map(([value, text]) => (
                <label key={value} className="sig-seg-opt">
                  <input
                    ref={(el) => {
                      methodRefs.current[value] = el;
                    }}
                    type="radio"
                    name={ids.method}
                    value={value}
                    checked={method === value}
                    onChange={() => pickMethod(value)}
                    aria-describedby={ids.methodHint}
                  />
                  <span>{text}</span>
                </label>
              ))}
            </div>
            <p id={ids.methodHint} className="hint">
              {T.methodHint}
            </p>
          </fieldset>

          <div hidden={method !== "draw"}>
            <SignaturePad ref={padRef} onChange={() => setImageError(null)} describedBy={ids.imageError} />
          </div>

          {method === "import" && (
            <div className="sig-import">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg"
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                aria-label={T.fileLabel}
                onChange={onFile}
              />
              <div className={`sig-paper sig-preview${importedUrl ? "" : " sig-preview-empty"}`}>
                {importedUrl ? (
                  <img src={importedUrl} alt={T.previewAlt(imported?.fileName ?? T.previewFallback)} />
                ) : (
                  <IconPhotoUp size={28} aria-hidden="true" className="sig-preview-icon" />
                )}
              </div>
              <div className="sig-import-row">
                <button
                  id={ids.file}
                  type="button"
                  className="btn btn-ghost"
                  // Tidak dinonaktifkan selama memproses supaya fokus keyboard tetap di tombol ini.
                  onClick={() => {
                    if (!importing) fileRef.current?.click();
                  }}
                  aria-busy={importing || undefined}
                  aria-describedby={`${ids.importHint} ${ids.imageError}`}
                >
                  <IconPhotoUp size={18} aria-hidden="true" />
                  {importing ? T.importing : imported ? T.pickOther : T.pickFile}
                </button>
                {imported && <span className="sig-file-name">{imported.fileName}</span>}
              </div>
              <p id={ids.importHint} className="hint">
                {T.importHint}
              </p>
            </div>
          )}

          <div id={ids.imageError} aria-live="polite">
            {imageError && <FieldError text={imageError} />}
          </div>

          <div className="dlg-actions">
            <DialogClose asChild>
              <button type="button" className="btn btn-ghost">
                {T.cancel}
              </button>
            </DialogClose>
            <button
              type="button"
              className="btn"
              onClick={goToPin}
              aria-busy={preparing || undefined}
            >
              {preparing ? T.preparing : T.next}
            </button>
          </div>
        </div>

        {step === "pin" && (
          <form className="sig-step-body" onSubmit={save} noValidate>
            <div className="sig-paper sig-thumb">
              {finalUrl && <img src={finalUrl} alt={T.finalAlt} />}
            </div>

            <div className="field">
              <label htmlFor={ids.pin}>{T.newPin}</label>
              <input
                ref={pinRef}
                id={ids.pin}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={PIN_MAX}
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                aria-invalid={pinError ? true : undefined}
                aria-describedby={`${ids.pinHint} ${ids.pinError}`}
                disabled={busy}
              />
              <p id={ids.pinHint} className="hint">
                {T.pinHint}
              </p>
              <div id={ids.pinError} aria-live="polite">
                {pinError && <FieldError text={pinError} />}
              </div>
            </div>

            <div className="field">
              <label htmlFor={ids.pin2}>{T.repeatPin}</label>
              <input
                ref={pin2Ref}
                id={ids.pin2}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={PIN_MAX}
                value={pin2}
                onChange={(e) => setPin2(e.target.value)}
                aria-invalid={pin2Error ? true : undefined}
                aria-describedby={ids.pin2Error}
                disabled={busy}
              />
              <div id={ids.pin2Error} aria-live="polite">
                {pin2Error && <FieldError text={pin2Error} />}
              </div>
            </div>

            <p className="sig-warn">
              <IconLock size={16} aria-hidden="true" />
              <span>{T.warn}</span>
            </p>

            <div aria-live="polite">
              {saveError && (
                <ErrorAlert title={T.saveErrorTitle}>
                  <p>{saveError.message}</p>
                </ErrorAlert>
              )}
            </div>

            <div className="dlg-actions">
              <button type="button" className="btn btn-ghost" onClick={backToImage} disabled={busy}>
                <IconArrowLeft size={18} aria-hidden="true" />
                {T.back}
              </button>
              <button ref={saveRef} type="submit" className="btn" disabled={busy} aria-busy={busy || undefined}>
                {busy ? T.saving : T.save}
              </button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}
