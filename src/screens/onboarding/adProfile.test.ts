import { describe, expect, it } from "vitest";
import type { AdDeptSuggestion, LocalAd } from "../../api/join";
import {
  adLine,
  adUse,
  asLocalAd,
  dnOus,
  normalizeAdDomain,
  outdatedCount,
  ouPath,
  sameDomain,
  type SuggestState,
} from "./adProfile";
import { office } from "./joinFixtures";

const ad: LocalAd = {
  domain: "macf.co.id",
  user: "rina",
  dn: "CN=Rina Wijaya,OU=Keuangan,OU=Kantor Pusat,DC=macf,DC=co,DC=id",
  displayName: "Rina Wijaya",
  department: "Keuangan",
  complete: true,
};

describe("adProfile", () => {
  it("sameDomain: tanpa beda huruf besar dan titik akhir", () => {
    expect(sameDomain("MACF.co.id", "macf.co.id.")).toBe(true);
    expect(sameDomain("macf.co.id", "macf.com")).toBe(false);
    expect(sameDomain(null, "macf.co.id")).toBe(false);
    expect(sameDomain("", "")).toBe(false);
  });

  it("normalizeAdDomain: huruf kecil, minimal dua bagian, tanpa spasi atau garis miring", () => {
    expect(normalizeAdDomain(" MACF.co.id. ")).toBe("macf.co.id");
    expect(normalizeAdDomain("macf")).toBeNull();
    expect(normalizeAdDomain("macf co.id")).toBeNull();
    expect(normalizeAdDomain("macf\\rina")).toBeNull();
    expect(normalizeAdDomain("a..b")).toBeNull();
    expect(normalizeAdDomain("")).toBeNull();
  });

  it("dnOus: OU paling dalam dulu, menghormati koma yang di-escape dan byte hex", () => {
    expect(dnOus(ad.dn)).toEqual(["Keuangan", "Kantor Pusat"]);
    expect(dnOus("CN=Wijaya\\, Rina,OU=R\\&D\\, Lab,ou=Pusat,DC=x,DC=id")).toEqual(["R&D, Lab", "Pusat"]);
    expect(dnOus("CN=a,OU=Caf\\C3\\A9,OU=A\\2CB,DC=x,DC=id")).toEqual(["Café", "A,B"]);
    expect(dnOus("CN=a,OU=Tim+OU=Kedua,DC=x")).toEqual(["Tim", "Kedua"]);
    expect(dnOus(null)).toEqual([]);
    expect(dnOus("bukan dn")).toEqual([]);
  });

  it("ouPath: dari luar ke dalam", () => {
    expect(ouPath(ad.dn)).toBe("Kantor Pusat › Keuangan");
    expect(ouPath("CN=a,DC=x,DC=id")).toBeNull();
  });

  it("adUse: berlaku hanya kalau domain sama dan kantor menerima AD", () => {
    const own = office({ adDomain: "MACF.co.id", acceptsAd: true });
    expect(adUse(null, own)).toEqual({ kind: "none" });
    expect(adUse(ad, null)).toEqual({ kind: "none" });
    expect(adUse(ad, own)).toEqual({ kind: "use" });
    expect(adUse(ad, office({ adDomain: null, acceptsAd: true }))).toEqual({ kind: "skip", reason: "noDomain" });
    expect(adUse(ad, office({ adDomain: "lain.co.id", acceptsAd: true }))).toEqual({
      kind: "skip",
      reason: "otherDomain",
    });
    expect(adUse(ad, office({ adDomain: "macf.co.id", acceptsAd: false }))).toEqual({
      kind: "skip",
      reason: "outdated",
    });
    expect(adUse({ ...ad, user: null }, own)).toEqual({ kind: "skip", reason: "noUser" });
  });

  it("adUse: urutan alasan (domain berbeda, laptop lama, domain kosong, nama akun)", () => {
    const skip = (o: Parameters<typeof office>[0], a: LocalAd = ad) => adUse(a, office(o));
    expect(skip({ adDomain: "lain.co.id", acceptsAd: false })).toEqual({ kind: "skip", reason: "otherDomain" });
    expect(skip({ adDomain: null, acceptsAd: false })).toEqual({ kind: "skip", reason: "outdated" });
    expect(skip({ adDomain: null, acceptsAd: true }, { ...ad, user: null })).toEqual({ kind: "skip", reason: "noDomain" });
    expect(skip({ adDomain: "macf.co.id", acceptsAd: false }, { ...ad, user: null })).toEqual({
      kind: "skip",
      reason: "outdated",
    });
  });

  it("adLine: satu baris, dari alasan tidak dipakai sampai departemen", () => {
    const own = office({ adDomain: "macf.co.id", acceptsAd: true });
    const depts = [{ id: "t-keu", name: "Keuangan" }];
    const done = (value: AdDeptSuggestion | null): SuggestState => ({ kind: "done", value });
    const pending: SuggestState = { kind: "pending" };
    expect(adLine(null, own, done(null), depts)).toBeNull();
    expect(adLine(ad, office({ acceptsAd: false }), pending, depts)).toEqual({ kind: "skip", reason: "outdated" });
    // Menunggu jawaban usulan: belum ada baris.
    expect(adLine(ad, own, pending, depts)).toBeNull();
    const match: AdDeptSuggestion = { teamId: "t-keu", source: "attribute", adDepartment: "Keuangan", inMira: true };
    expect(adLine(ad, own, done(match), depts)).toEqual({ kind: "matched", dept: "Keuangan" });
    // Usulan menunjuk departemen yang tidak ada di daftar kantor: belum cocok.
    expect(adLine(ad, own, done({ ...match, teamId: "t-hapus" }), depts)).toEqual({
      kind: "unmatched",
      dept: "Keuangan",
    });
    const julius: LocalAd = {
      ...ad,
      department: null,
      dn: "CN=Julius,OU=IT- BussinesAnalyst_AppSupport & MIS_QA,OU=IT-Department,OU=IT & CP Department,OU=HO,OU=Member Users,DC=macf,DC=co,DC=id",
    };
    expect(adLine(julius, own, done(null), depts)).toEqual({
      kind: "unmatched",
      dept: "IT- BussinesAnalyst_AppSupport & MIS_QA",
    });
    expect(adLine({ ...julius, dn: null }, own, done(null), depts)).toEqual({ kind: "noDept" });
    // Data sebagian: kotak sudah menjelaskan, tidak ada baris tambahan.
    expect(adLine({ ...julius, dn: null, complete: false }, own, done(null), depts)).toBeNull();
  });

  it("outdatedCount: hanya bilangan bulat positif", () => {
    expect(outdatedCount(office({ adOutdated: 2 }))).toBe(2);
    expect(outdatedCount(office({ adOutdated: 0 }))).toBeNull();
    expect(outdatedCount(office({ adOutdated: null }))).toBeNull();
    expect(outdatedCount(office({ adOutdated: undefined as unknown as null }))).toBeNull();
  });

  it("asLocalAd: tanpa domain dianggap tidak ada", () => {
    expect(asLocalAd(null)).toBeNull();
    expect(asLocalAd({ domain: "" })).toBeNull();
    expect(asLocalAd(ad)).toBe(ad);
  });
});
