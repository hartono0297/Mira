import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LabelView, PersonView } from "../../api/org";
import { setLang } from "../../i18n/core";
import { router } from "../../test/fixtures";
import { renderInLang } from "../../test/i18n";
import { label, LABEL_1, LABEL_2, ME, overview, person, PK_B, PK_C } from "../../test/orgFixtures";
import type { OrgPage } from "./context";
import { LabelsPanel } from "./LabelsPanel";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

function page(): OrgPage {
  return {
    overview: overview(),
    act: vi.fn(async () => true),
    pending: null,
    notify: vi.fn(),
    version: 0,
    refresh: vi.fn(),
    isMe: (pk) => pk === ME,
  };
}

const PEOPLE: PersonView[] = [
  person(ME, "Andi", { isSuperadmin: true }),
  person(PK_B, "Budi", { labels: [{ id: LABEL_1, name: "Drafter" }] }),
  person(PK_C, "Sari", { labels: [{ id: LABEL_1, name: "Drafter" }] }),
];
const LABELS: LabelView[] = [
  label(LABEL_1, "Drafter", [PK_B, PK_C]),
  { ...label(LABEL_2, "Arsitek", [ME]), archived: true },
];

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  invoke.mockImplementation(router({ org_labels: LABELS, org_people: PEOPLE }));
});

afterEach(() => {
  setLang("id");
});

describe("Label dalam bahasa Inggris", () => {
  it("menulis daftar, tombol, dan dialog dalam bahasa Inggris", async () => {
    const user = userEvent.setup();
    renderInLang(() => <LabelsPanel page={page()} />, "en");

    expect(await screen.findByRole("list", { name: "Active labels" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Labels" })).toBeInTheDocument();
    expect(screen.getByText("2 people")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose people, label Drafter" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete label Drafter" })).toBeInTheDocument();
    expect(screen.getByText("Deleted (1)")).toBeInTheDocument();
    expect(screen.getByText("1 person saved")).toBeInTheDocument();
    expect(screen.queryByText(/Atur orang|Ganti nama|Dihapus|orang tersimpan/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New label" }));
    expect(await screen.findByRole("dialog", { name: "New label" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create label" }));
    expect(screen.getByText("Enter a label name first.")).toBeInTheDocument();
    expect(screen.getByText("1 to 30 characters, such as Drafter, K3, or Senior.")).toBeInTheDocument();
    expect(screen.queryByText(/Isi nama label|Batal/)).not.toBeInTheDocument();
  });
});
