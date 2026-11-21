import { IconAlertTriangle } from "@tabler/icons-react";
import type { ReactNode } from "react";

type Props = {
  title: string;
  children?: ReactNode;
};

// Kotak error di dalam form. Dipasang di dalam wilayah aria-live milik pemanggil.
export function ErrorAlert({ title, children }: Props) {
  return (
    <div className="alert">
      <IconAlertTriangle size={18} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        {children}
      </div>
    </div>
  );
}
