import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutsideProject } from "../../api/board";
import { OutsideProjects, outsideLabel } from "./OutsideProjects";

const board = vi.hoisted(() => ({ outsideProjects: vi.fn() }));
const org = vi.hoisted(() => ({ addProjectMember: vi.fn() }));
const listeners = vi.hoisted(() => new Set<() => void>());

vi.mock("../../api/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/board")>()),
  boardApi: board,
  subscribeBoard: (handler: () => void) => {
    listeners.add(handler);
    return () => listeners.delete(handler);
  },
}));

vi.mock("../../api/org", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/org")>()),
  orgApi: org,
  subscribeOrg: (handler: () => void) => {
    listeners.add(handler);
    return () => listeners.delete(handler);
  },
}));

async function event() {
  await act(async () => {
    listeners.forEach((h) => h());
  });
}

const ME = "a".repeat(64);
const P3 = "3".repeat(32);
const P4 = "4".repeat(32);

function outside(id: string, extra: Partial<OutsideProject> = {}): OutsideProject {
  return {
    id,
    code: null,
    name: null,
    teamId: "9".repeat(32),
    teamName: "Keuangan",
    creatorName: "Budi Uji",
    memberCount: 3,
    createdAt: "2026-11-22T03:00:00Z",
    ...extra,
  };
}

let items: OutsideProject[];

beforeEach(() => {
  listeners.clear();
  items = [outside(P3), outside(P4, { code: "GD", name: "Gudang Baru", teamName: null, memberCount: 1 })];
  board.outsideProjects.mockReset().mockImplementation(async () => items);
  org.addProjectMember.mockReset().mockImplementation(async (id: string) => {
    items = items.filter((p) => p.id !== id);
    return null;
  });
});

describe("Proyek lain (superadmin)", () => {
  it("label: kode dan nama kalau diketahui, kalau tidak departemennya", () => {
    expect(outsideLabel(outside(P3))).toBe("Proyek Departemen Keuangan");
    expect(outsideLabel(outside(P3, { teamName: null }))).toBe("Proyek tanpa departemen");
    expect(outsideLabel(outside(P3, { code: "GD", name: "Gudang" }))).toBe("GD Gudang");
  });

  it("tidak tampil apa pun kalau tidak ada proyek lain", async () => {
    items = [];
    const { container } = render(<OutsideProjects myKey={ME} onJoined={() => {}} />);
    await waitFor(() => expect(board.outsideProjects).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("menampilkan pembuat dan jumlah anggota, lalu bergabung setelah konfirmasi", async () => {
    const user = userEvent.setup();
    const onJoined = vi.fn();
    render(<OutsideProjects myKey={ME} onJoined={onJoined} />);
    const section = await screen.findByRole("region", { name: "Proyek lain" });
    expect(within(section).getByText("Proyek Departemen Keuangan")).toBeInTheDocument();
    expect(within(section).getByText("dibuat Budi Uji, 3 anggota")).toBeInTheDocument();
    expect(within(section).getByText("GD Gudang Baru")).toBeInTheDocument();
    const buttons = within(section).getAllByRole("button", { name: /^Gabung ke proyek ini/ });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAccessibleDescription("Proyek Departemen Keuangan");

    await user.click(buttons[0]);
    const confirm = screen.getByRole("dialog", { name: "Gabung ke Proyek Departemen Keuangan?" });
    expect(
      within(confirm).getByText(
        "Anda akan menjadi anggota proyek ini. Langkah ini tercatat di log organisasi dan terlihat oleh semua anggota.",
      ),
    ).toBeInTheDocument();
    expect(within(confirm).getByText("Board muncul setelah laptop anggota proyek tersambung.")).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Gabung" }));

    expect(org.addProjectMember).toHaveBeenCalledWith(P3, ME);
    expect(onJoined).toHaveBeenCalledWith(P3);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(within(section).queryByText("Proyek Departemen Keuangan")).not.toBeInTheDocument();
    const status = within(section).getByRole("status");
    expect(status).toHaveTextContent(
      "Anda sudah menjadi anggota Proyek Departemen Keuangan. Board muncul setelah laptop anggota proyek tersambung.",
    );
    await waitFor(() => expect(status).toHaveFocus());
  });

  it("gagal bergabung: error di dialog konfirmasi", async () => {
    const user = userEvent.setup();
    org.addProjectMember.mockRejectedValueOnce({ code: "forbidden", message: "Hanya superadmin yang bisa bergabung sendiri." });
    render(<OutsideProjects myKey={ME} onJoined={() => {}} />);
    const section = await screen.findByRole("region", { name: "Proyek lain" });
    await user.click(within(section).getAllByRole("button", { name: /^Gabung ke proyek ini/ })[1]);
    const confirm = screen.getByRole("dialog", { name: "Gabung ke GD Gudang Baru?" });
    // Board proyek yang namanya diketahui sudah ada di laptop ini.
    expect(within(confirm).queryByText(/Board muncul setelah/)).not.toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Gabung" }));
    expect(await within(confirm).findByText("Anda belum bergabung")).toBeInTheDocument();
    expect(within(confirm).getByText("Hanya superadmin yang bisa bergabung sendiri.")).toBeInTheDocument();
  });

  it("dimuat ulang saat organisasi atau board berubah", async () => {
    render(<OutsideProjects myKey={ME} onJoined={() => {}} />);
    const section = await screen.findByRole("region", { name: "Proyek lain" });
    items = [...items, outside("5".repeat(32), { teamName: "Gudang", creatorName: "Sari Uji" })];
    await event();
    expect(await within(section).findByText("Proyek Departemen Gudang")).toBeInTheDocument();
  });

  it("gagal dibaca: catatan singkat dengan Coba lagi", async () => {
    const user = userEvent.setup();
    board.outsideProjects.mockRejectedValueOnce({ code: "database", message: "Database terkunci." });
    render(<OutsideProjects myKey={ME} onJoined={() => {}} />);
    expect(await screen.findByText(/Daftar proyek lain belum terbaca/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByText("GD Gudang Baru")).toBeInTheDocument();
  });
});
