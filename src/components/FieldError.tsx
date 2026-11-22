import { IconAlertCircle } from "@tabler/icons-react";

export function FieldError({ text }: { text: string }) {
  return (
    <p className="field-error">
      <IconAlertCircle size={16} aria-hidden="true" />
      {text}
    </p>
  );
}
