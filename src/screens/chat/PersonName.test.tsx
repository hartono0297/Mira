import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LabelRef } from "../../api/org";
import { renderInLang } from "../../test/i18n";
import { ConversationHeader } from "./ConversationHeader";
import { MemberRow } from "./GroupMembers";
import { PeopleLabelsProvider } from "./PeopleLabels";
import { PersonName } from "./PersonName";
import { dm, penguji, personView, sari } from "./conversationTestData";

const org = vi.hoisted(() => ({ people: vi.fn() }));

vi.mock("../../api/org", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/org")>()),
  orgApi: org,
}));

const drafter = { id: "1".repeat(32), name: "Drafter" };

const MANY: LabelRef[] = [
  "Arsitek",
  "Drafter",
  "Surveyor",
  "Pengawas lapangan",
  "Juru gambar senior",
  "Estimator biaya",
  "Ahli struktur baja",
  "Koordinator K3",
].map((name, i) => ({ id: String(i).repeat(32), name }));

function names(root: ParentNode): string[] {
  return [...root.querySelectorAll(".lab:not(.lab-more)")].map((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".sr-only").forEach((s) => s.remove());
    return copy.textContent ?? "";
  });
}

beforeEach(() => {
  org.people.mockReset().mockResolvedValue([{ ...personView(sari, "Desain"), labels: [drafter] }]);
});

describe("PersonName di chat", () => {
  it("menampilkan label profil di samping nama", async () => {
    render(
      <PeopleLabelsProvider>
        <PersonName person={sari} />
      </PeopleLabelsProvider>,
    );
    expect(await screen.findByText("Drafter")).toHaveClass("lab");
    expect(screen.getByText("Sari Uji")).toBeInTheDocument();
  });

  it("chip orang terpilih: nama saja", async () => {
    render(
      <PeopleLabelsProvider>
        <PersonName person={sari} plain />
      </PeopleLabelsProvider>,
    );
    await vi.waitFor(() => expect(org.people).toHaveBeenCalled());
    expect(screen.queryByText("Drafter")).toBeNull();
  });

  it("tanpa data organisasi tetap menampilkan nama", async () => {
    org.people.mockRejectedValue({ code: "x", message: "gagal" });
    render(
      <PeopleLabelsProvider>
        <PersonName person={sari} me />
      </PeopleLabelsProvider>,
    );
    await vi.waitFor(() => expect(org.people).toHaveBeenCalled());
    expect(screen.getByText("Sari Uji").closest(".nwl-name")).toHaveTextContent("Sari Uji (Anda)");
  });

  it("labelsMode all: delapan label tampil semua, termasuk untuk saya sendiri", async () => {
    org.people.mockResolvedValue([{ ...personView(penguji, "Desain"), labels: MANY }]);
    const { container } = render(
      <PeopleLabelsProvider>
        <PersonName person={penguji} me labelsMode="all" />
      </PeopleLabelsProvider>,
    );
    expect(await screen.findByText("Koordinator K3")).toHaveClass("lab");
    expect(names(container)).toEqual(MANY.map((l) => l.name));
    expect(container.querySelector(".lab-more")).toBeNull();
    expect(container.querySelector(".nwl-name")).toHaveTextContent("Penguji (Anda)");
    expect(container.querySelector(".nwl-labels")).toHaveClass("nwl-wrap");
  });

  it("labelsMode compact: tiga label dan +5 yang bisa difokus", async () => {
    org.people.mockResolvedValue([{ ...personView(sari, "Desain"), labels: MANY }]);
    const { container } = render(
      <PeopleLabelsProvider>
        <PersonName person={sari} labelsMode="compact" />
      </PeopleLabelsProvider>,
    );
    const more = await screen.findByRole("button", { name: /dan 5 label lain: Pengawas lapangan/ });
    expect(more).toHaveTextContent("+5");
    expect(names(container)).toEqual(["Arsitek", "Drafter", "Surveyor"]);
  });

  it("labelsMode none mengalahkan label yang ada", async () => {
    render(
      <PeopleLabelsProvider>
        <PersonName person={sari} labelsMode="none" />
      </PeopleLabelsProvider>,
    );
    await vi.waitFor(() => expect(org.people).toHaveBeenCalled());
    expect(screen.queryByText("Drafter")).toBeNull();
  });
});

describe("semua label di chat", () => {
  it("daftar anggota grup dan proyek: semua label tiap anggota, juga saya", async () => {
    org.people.mockResolvedValue([
      { ...personView(sari, "Desain"), labels: MANY },
      { ...personView(penguji, "Desain"), labels: MANY.slice(0, 5) },
    ]);
    render(
      <PeopleLabelsProvider>
        <ul>
          <MemberRow person={sari} me={false} department="Desain" />
          <MemberRow person={penguji} me department="Desain" />
        </ul>
      </PeopleLabelsProvider>,
    );
    const rows = await vi.waitFor(() => {
      const items = screen.getAllByRole("listitem");
      expect(names(items[0])).toHaveLength(8);
      return items;
    });
    expect(names(rows[0])).toEqual(MANY.map((l) => l.name));
    expect(names(rows[1])).toEqual(MANY.slice(0, 5).map((l) => l.name));
    expect(rows[1]).toHaveTextContent("Penguji (Anda)");
    expect(within(rows[0]).queryByRole("button", { name: /label lain/ })).toBeNull();
  });

  it("kepala pesan pribadi: semua label rekan di bawah nama, judul tetap nama saja", async () => {
    org.people.mockResolvedValue([{ ...personView(sari, "Desain"), labels: MANY }]);
    render(
      <PeopleLabelsProvider>
        <ConversationHeader
          summary={dm()}
          groupState={{ group: null, loading: false, error: null, reload: vi.fn() }}
          onChanged={vi.fn()}
          onGone={vi.fn()}
        />
      </PeopleLabelsProvider>,
    );
    const line = await vi.waitFor(() => {
      const el = document.querySelector(".conv-head-labels");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(names(line)).toEqual(MANY.map((l) => l.name));
    expect(line.querySelector(".lab-more")).toBeNull();
    expect(line.querySelector(".sr-only")?.textContent).toBe("Label: ");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/^Sari Uji$/);
  });

  it("kepala pesan pribadi tanpa label: tidak ada baris label", async () => {
    org.people.mockResolvedValue([{ ...personView(sari, "Desain"), labels: [] }]);
    render(
      <PeopleLabelsProvider>
        <ConversationHeader
          summary={dm()}
          groupState={{ group: null, loading: false, error: null, reload: vi.fn() }}
          onChanged={vi.fn()}
          onGone={vi.fn()}
        />
      </PeopleLabelsProvider>,
    );
    await vi.waitFor(() => expect(org.people).toHaveBeenCalled());
    expect(document.querySelector(".conv-head-labels")).toBeNull();
  });

  it("bahasa Inggris: awalan label dan +N", async () => {
    org.people.mockResolvedValue([{ ...personView(sari, "Design"), labels: MANY }]);
    renderInLang(() => (
      <PeopleLabelsProvider>
        <ConversationHeader
          summary={dm()}
          groupState={{ group: null, loading: false, error: null, reload: vi.fn() }}
          onChanged={vi.fn()}
          onGone={vi.fn()}
        />
        <PersonName person={sari} me labelsMode="all" />
        <PersonName person={sari} labelsMode="compact" />
      </PeopleLabelsProvider>
    ));
    expect(
      await screen.findByRole("button", {
        name: ", and 5 more labels: Pengawas lapangan, Juru gambar senior, Estimator biaya, Ahli struktur baja, Koordinator K3",
      }),
    ).toHaveTextContent("+5");
    expect(document.querySelector(".conv-head-labels .sr-only")?.textContent).toBe("Labels: ");
    expect(screen.getByText("(you)", { exact: false })).toBeInTheDocument();
    expect(screen.getAllByText(", labels", { exact: false }).length).toBeGreaterThan(0);
  });
});
