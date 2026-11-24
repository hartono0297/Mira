import { describe, expect, it } from "vitest";
import { notesFor } from ".";

// Catatan versi Inggris (<versi>.en.md) opsional; tanpa itu versi Indonesia dipakai.
describe("catatan Yang baru per bahasa", () => {
  it("bahasa Inggris kembali ke catatan Indonesia kalau .en.md belum ada", () => {
    const id = notesFor("0.3.0", "id");
    expect(id).not.toBeNull();
    expect(notesFor("0.3.0", "en")).toBe(id);
    expect(notesFor("v0.3.0", "en")).toBe(id);
    expect(notesFor("9.9.9", "en")).toBeNull();
  });
});
