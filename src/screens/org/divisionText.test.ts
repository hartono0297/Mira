import { describe, expect, it } from "vitest";
import { deptWithDivisions } from "./divisionText";

describe("deptWithDivisions", () => {
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
});
