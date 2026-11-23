import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { DEFAULT_LANG, setLang } from "./i18n/core";

afterEach(() => {
  cleanup();
  // Tes yang mengganti bahasa tidak boleh memengaruhi tes berikutnya.
  setLang(DEFAULT_LANG);
});
