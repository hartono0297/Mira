import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PeopleLabelsProvider } from "./PeopleLabels";
import { PersonName } from "./PersonName";
import { personView, sari } from "./conversationTestData";

const org = vi.hoisted(() => ({ people: vi.fn() }));

vi.mock("../../api/org", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/org")>()),
  orgApi: org,
}));

const drafter = { id: "1".repeat(32), name: "Drafter" };

beforeEach(() => {
  org.people.mockResolvedValue([{ ...personView(sari, "Desain"), labels: [drafter] }]);
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
});
