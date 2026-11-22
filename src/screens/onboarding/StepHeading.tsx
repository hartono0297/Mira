import { useEffect, useRef } from "react";

// Fokus pindah ke judul setiap ganti langkah, supaya pengguna keyboard dan
// pembaca layar tahu isi layar sudah berganti.
export function StepHeading({ children }: { children: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <h1 ref={ref} tabIndex={-1} className="onb-title">
      {children}
    </h1>
  );
}
