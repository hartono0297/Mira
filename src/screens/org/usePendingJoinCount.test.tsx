import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { router } from "../../test/fixtures";
import { overview } from "../../test/orgFixtures";
import { formatCount, OrgNavCount, usePendingJoinCount } from "./usePendingJoinCount";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});

describe("formatCount", () => {
  it("menulis angka apa adanya sampai 99, lalu 99+", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1)).toBe("1");
    expect(formatCount(99)).toBe("99");
    expect(formatCount(100)).toBe("99+");
    expect(formatCount(1500)).toBe("99+");
  });
});

describe("OrgNavCount", () => {
  it("tidak tampil kalau tidak ada yang menunggu", async () => {
    invoke.mockImplementation(router({ org_overview: overview({ pendingJoinCount: 0 }) }));
    const { container } = render(<OrgNavCount />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("org_overview", undefined));
    expect(container).toBeEmptyDOMElement();
  });

  it("menampilkan angka beserta teks untuk pembaca layar", async () => {
    invoke.mockImplementation(router({ org_overview: overview({ pendingJoinCount: 3 }) }));
    render(<OrgNavCount />);
    const visible = await screen.findByText("3");
    expect(visible).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText(", 3 permintaan bergabung menunggu")).toHaveClass("sr-only");
  });

  it("menulis 99+ di atas 99, tetapi pembaca layar mendapat angka sebenarnya", async () => {
    invoke.mockImplementation(router({ org_overview: overview({ pendingJoinCount: 150 }) }));
    render(<OrgNavCount />);
    expect(await screen.findByText("99+")).toBeInTheDocument();
    expect(screen.getByText(", 150 permintaan bergabung menunggu")).toBeInTheDocument();
  });

  it("tetap kosong kalau org_overview gagal", async () => {
    invoke.mockImplementation(async () => {
      throw { code: "no_org", message: "Belum tergabung di organisasi." };
    });
    const { container } = render(<OrgNavCount />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("org_overview", undefined));
    expect(container).toBeEmptyDOMElement();
  });
});

describe("usePendingJoinCount", () => {
  it("0 saat gagal dibaca atau data tidak berbentuk benar", async () => {
    invoke.mockImplementation(router({ org_overview: { publicKey: "x" } }));
    const { result } = renderHook(() => usePendingJoinCount());
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(result.current).toBe(0);
  });

  it("mengikuti pendingJoinCount dari org_overview", async () => {
    invoke.mockImplementation(router({ org_overview: overview({ pendingJoinCount: 7 }) }));
    const { result } = renderHook(() => usePendingJoinCount());
    await waitFor(() => expect(result.current).toBe(7));
  });
});
