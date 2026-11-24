import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { COMPONENTS_TEXT } from "../i18n/components";

type Props = {
  text: string;
  label?: string;
  className?: string;
  autoFocus?: boolean;
};

type CopyState = "idle" | "copied" | "failed";

export function CopyButton({ text, label, className = "btn btn-ghost btn-sm", autoFocus }: Props) {
  const T = COMPONENTS_TEXT.copy;
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    window.clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("clipboard");
      await navigator.clipboard.writeText(text);
      setState("copied");
      timer.current = window.setTimeout(() => setState("idle"), 2500);
    } catch {
      setState("failed");
    }
  }

  return (
    <span className="copy-row">
      <button type="button" className={className} onClick={copy} autoFocus={autoFocus}>
        {state === "copied" ? <IconCheck size={16} aria-hidden="true" /> : <IconCopy size={16} aria-hidden="true" />}
        {state === "copied" ? T.copied : (label ?? T.label)}
      </button>
      <span aria-live="polite" className={state === "failed" ? "field-error" : "sr-only"}>
        {state === "copied" && T.copiedLive}
        {state === "failed" && T.failed}
      </span>
    </span>
  );
}
