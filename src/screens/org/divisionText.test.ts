import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../../i18n/core";
import { deptWithDivisions } from "./divisionText";

describe("deptWithDivisions", () => {
  afterEach(() => setLang("id"));

  it("departemen dan divisi dipisah titik tengah, divisi dipisah koma", () => {
    expect(deptWithDivisions("IT Department", [{ name: "Mobile" }, { name: "Web" }])).toBe(
      "IT Department · Mobile, Web",
    );
  });

  it("tanpa divisi: hanya departemen", () => {
    expect(deptWithDivisions("Desain", [])).toBe("Desain");
    expect(deptWithDivisions("Desain", undefined)).toBe("Desain");
    expect(deptWithDivisions("Desain", null)).toBe("Desain");
  });

  it("tanpa departemen: null, divisi diabaikan", () => {
    expect(deptWithDivisions(null, [{ name: "Mobile" }])).toBeNull();
    expect(deptWithDivisions(undefined, undefined)).toBeNull();
    expect(deptWithDivisions("  ", [])).toBeNull();
  });

  it("nama divisi kosong dilewati, spasi dirapikan", () => {
    expect(deptWithDivisions(" Desain ", [{ name: " Interior " }, { name: "" }])).toBe("Desain · Interior");
  });

  it("divisi yang dikepalai diberi tanda kepala", () => {
    expect(deptWithDivisions("IT Department", [{ name: "Mobile", role: "head" }, { name: "Web", role: "member" }])).toBe(
      "IT Department · Mobile (kepala), Web",
    );
    setLang("en");
    expect(deptWithDivisions("IT Department", [{ name: "Mobile", role: "head" }])).toBe("IT Department · Mobile (head)");
  });
});
