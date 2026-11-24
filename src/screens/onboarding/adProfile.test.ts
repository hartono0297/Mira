import { describe, expect, it } from "vitest";
import type { LocalAd } from "../../api/join";
import { adUse, asLocalAd, dnOus, normalizeAdDomain, ouPath, sameDomain } from "./adProfile";
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

  it("asLocalAd: tanpa domain dianggap tidak ada", () => {
    expect(asLocalAd(null)).toBeNull();
    expect(asLocalAd({ domain: "" })).toBeNull();
    expect(asLocalAd(ad)).toBe(ad);
  });
});
