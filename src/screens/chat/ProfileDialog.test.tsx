import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Person } from "../../api/chat";
import type { PersonView } from "../../api/org";
import { ChatActionsContext, type ChatActions } from "./ChatActions";
import { ME, orgPeople, penguji, personView, sari } from "./conversationTestData";
import { PROFILE, ProfileDialog } from "./ProfileDialog";

const org = vi.hoisted(() => ({ people: vi.fn() }));

vi.mock("../../api/org", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/org")>()),
  orgApi: org,
}));

function chatActions(extra: Partial<ChatActions> = {}): ChatActions {
  return {
    me: ME,
    canMessage: () => true,
    openDm: vi.fn().mockResolvedValue(undefined),
    showProfile: vi.fn(),
    ...extra,
  };
}

function renderProfile(person: Person | null, c: ChatActions | null = chatActions()) {
  const onOpenChange = vi.fn();
  render(
    <ChatActionsContext.Provider value={c}>
      <ProfileDialog person={person} onOpenChange={onOpenChange} />
    </ChatActionsContext.Provider>,
  );
  return { onOpenChange, c };
}

const sariView: PersonView = {
  ...personView(sari, "Drafting"),
  fingerprint: "AB12 CD34 EF56 7890",
  departmentRole: "admin",
  labels: [
    { id: "l1", name: "Arsitek" },
    { id: "l2", name: "Senior" },
    { id: "l3", name: "K3" },
    { id: "l4", name: "Penguji mutu" },
  ],
};

function factOf(dlg: HTMLElement, term: string): HTMLElement {
  const dt = within(dlg).getByText(term, { selector: "dt" });
  const dd = dt.nextElementSibling;
  if (!(dd instanceof HTMLElement)) throw new Error(`nilai ${term} tidak ada`);
  return dd;
}

beforeEach(() => {
  org.people.mockReset().mockResolvedValue([...orgPeople.filter((p) => p.publicKey !== sari.publicKey), sariView]);
});

describe("ProfileDialog", () => {
  it("tertutup saat person null", () => {
    renderProfile(null);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(org.people).not.toHaveBeenCalled();
  });

  it("memuat: judul dari nama, status memuat", () => {
    org.people.mockReturnValue(new Promise(() => {}));
    renderProfile(sari);
    const dlg = screen.getByRole("dialog", { name: "Profil Sari Uji" });
    expect(within(dlg).getByRole("status")).toHaveTextContent(PROFILE.loading);
  });

  it("menampilkan label, peran, departemen dengan admin departemen, dan sidik kunci", async () => {
    renderProfile(sari);
    const dlg = screen.getByRole("dialog", { name: "Profil Sari Uji" });
    expect(await within(dlg).findByText("AB12 CD34 EF56 7890")).toBeInTheDocument();
    // Semua label tampil, tidak diringkas menjadi "+1".
    for (const label of ["Arsitek", "Senior", "K3", "Penguji mutu"]) expect(within(dlg).getByText(label)).toBeInTheDocument();
    expect(dlg.querySelector(".lab-more")).toBeNull();
    // Chip boleh turun baris supaya banyak label tidak melebarkan dialog.
    expect(dlg.querySelector(".prof-name")).toHaveClass("nwl-wrap-all");
    expect(dlg.querySelector(".prof-name .nwl-labels")).toHaveClass("nwl-wrap");
    expect(factOf(dlg, PROFILE.role)).toHaveTextContent(/^Anggota$/);
    expect(factOf(dlg, PROFILE.department)).toHaveTextContent(/^Drafting, admin departemen$/);
    expect(factOf(dlg, PROFILE.fingerprint)).toHaveTextContent(PROFILE.fingerprintNote("Sari Uji"));
    expect(org.people).toHaveBeenCalledTimes(1);
  });

  it("delapan label panjang tampil semua, juga di profil saya sendiri", async () => {
    const many = [
      "Arsitek",
      "Drafter",
      "Surveyor",
      "Pengawas lapangan",
      "Juru gambar senior",
      "Estimator biaya",
      "Ahli struktur baja",
      "Koordinator K3",
    ].map((name, i) => ({ id: `m${i}`, name }));
    org.people.mockResolvedValue([{ ...personView(penguji, "Desain"), labels: many }]);
    renderProfile(penguji);
    const dlg = screen.getByRole("dialog", { name: /Penguji/ });
    expect(await within(dlg).findByText("Koordinator K3")).toHaveClass("lab");
    for (const l of many) expect(within(dlg).getByText(l.name)).toHaveClass("lab");
    expect(dlg.querySelector(".lab-more")).toBeNull();
    expect(within(dlg).queryByRole("button", { name: /label lain/ })).toBeNull();
  });

  it("superadmin tanpa departemen", async () => {
    org.people.mockResolvedValue([{ ...personView(sari, null), isSuperadmin: true, role: "superadmin" }]);
    renderProfile(sari);
    const dlg = screen.getByRole("dialog", { name: "Profil Sari Uji" });
    await within(dlg).findByText(PROFILE.role);
    expect(factOf(dlg, PROFILE.role)).toHaveTextContent(/^Superadmin$/);
    expect(factOf(dlg, PROFILE.department)).toHaveTextContent(PROFILE.noDepartment);
  });

  it("tamu: peran Tamu, tanpa baris departemen", async () => {
    org.people.mockResolvedValue([{ ...personView(sari, null), isGuest: true, role: "guest" }]);
    renderProfile(sari);
    const dlg = screen.getByRole("dialog", { name: "Profil Sari Uji" });
    await within(dlg).findByText(PROFILE.role);
    expect(factOf(dlg, PROFILE.role)).toHaveTextContent(/^Tamu$/);
    expect(within(dlg).queryByText(PROFILE.department)).toBeNull();
  });

  it("tidak ditemukan: nama dari Person tetap tampil dengan penjelasan", async () => {
    org.people.mockResolvedValue(orgPeople.filter((p) => p.publicKey !== sari.publicKey));
    renderProfile(sari);
    const dlg = screen.getByRole("dialog", { name: "Profil Sari Uji" });
    expect(await within(dlg).findByText(PROFILE.notFound("Sari Uji"))).toBeInTheDocument();
    expect(within(dlg).getByText("Sari Uji", { selector: ".nwl-name" })).toBeInTheDocument();
    expect(within(dlg).queryByText(PROFILE.fingerprint)).toBeNull();
  });

  it("error dengan Coba lagi yang memuat ulang", async () => {
    const user = userEvent.setup();
    org.people.mockRejectedValueOnce({ code: "x", message: "Data organisasi belum terbaca." });
    renderProfile(sari);
    const dlg = screen.getByRole("dialog", { name: "Profil Sari Uji" });
    expect(await within(dlg).findByText(PROFILE.loadFailed)).toBeInTheDocument();
    expect(within(dlg).getByText("Data organisasi belum terbaca.")).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: PROFILE.retry }));
    expect(await within(dlg).findByText("AB12 CD34 EF56 7890")).toBeInTheDocument();
    expect(within(dlg).queryByText(PROFILE.loadFailed)).toBeNull();
  });

  it("Kirim pesan pribadi memanggil openDm lalu menutup dialog", async () => {
    const user = userEvent.setup();
    const { c, onOpenChange } = renderProfile(sari);
    const dlg = screen.getByRole("dialog", { name: "Profil Sari Uji" });
    await user.click(within(dlg).getByRole("button", { name: PROFILE.sendDm }));
    expect(c?.openDm).toHaveBeenCalledWith(sari);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("tanpa Kirim pesan pribadi kalau tidak bisa chat pribadi atau profil saya sendiri", async () => {
    renderProfile(sari, chatActions({ canMessage: () => false }));
    const dlg = screen.getByRole("dialog", { name: "Profil Sari Uji" });
    await within(dlg).findByText("AB12 CD34 EF56 7890");
    expect(within(dlg).queryByRole("button", { name: PROFILE.sendDm })).toBeNull();
  });

  it("profil saya: (Anda) dan catatan sidik untuk diri sendiri, tanpa Kirim pesan pribadi", async () => {
    renderProfile(penguji);
    const dlg = screen.getByRole("dialog", { name: "Profil Penguji" });
    expect(await within(dlg).findByText(PROFILE.fingerprintNoteMe)).toBeInTheDocument();
    expect(within(dlg).getByText(PROFILE.me.trim())).toBeInTheDocument();
    expect(within(dlg).queryByRole("button", { name: PROFILE.sendDm })).toBeNull();
  });

  it("Tutup memanggil onOpenChange(false)", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderProfile(sari);
    await user.click(within(screen.getByRole("dialog", { name: "Profil Sari Uji" })).getByRole("button", { name: PROFILE.close }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
