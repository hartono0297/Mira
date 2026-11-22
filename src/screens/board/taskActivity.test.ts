import { describe, expect, it } from "vitest";
import { activitySentence } from "./taskActivity";

const ME = "a".repeat(64);
const SARI = { publicKey: "b".repeat(64), name: "Sari" };

describe("activitySentence renumbered", () => {
  it("menjelaskan nomor lama yang bentrok", () => {
    expect(activitySentence({ at: "t", actor: SARI, kind: "renumbered", detail: "PA-12" }, ME)).toBe(
      "Sari mengganti nomor task ini dari PA-12 karena nomornya sama dengan task lain",
    );
  });

  it("tanpa detail tetap terbaca, dan pelaku laptop ini jadi Anda", () => {
    const me = { publicKey: ME, name: "Rina" };
    expect(activitySentence({ at: "t", actor: me, kind: "renumbered", detail: "" }, ME)).toBe(
      "Anda mengganti nomor task ini",
    );
  });
});
