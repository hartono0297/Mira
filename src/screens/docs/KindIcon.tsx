import { IconFile, IconFileSpreadsheet, IconFileTypePdf, IconFileWord } from "@tabler/icons-react";
import type { DocumentKind } from "../../api/documents";

const ICONS = {
  word: IconFileWord,
  excel: IconFileSpreadsheet,
  pdf: IconFileTypePdf,
  other: IconFile,
} as const;

// Ikon jenis file. Dekoratif: jenisnya sudah terbaca dari nama file.
export function KindIcon({ kind, size = 24 }: { kind: DocumentKind; size?: number }) {
  const Icon = ICONS[kind] ?? IconFile;
  return <Icon size={size} stroke={1.6} className="doc-kind" aria-hidden="true" />;
}
