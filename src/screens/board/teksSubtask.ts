// Teks bagian Subtask di dialog detail task. Isinya ada di kamus
// src/i18n/board-subtask.id.ts dan .en.ts. Batas sama dengan inti Rust
// (docs/plans/v04-board.md bagian 5).
import { defineText } from "../../i18n/core";
import en from "../../i18n/board-subtask.en";
import id from "../../i18n/board-subtask.id";

export { SUBTASK_MAX, SUBTASK_TITLE_MAX } from "../../i18n/board-subtask.id";

export const teksSubtask = defineText(id, en);
