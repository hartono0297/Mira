import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { countText, formatCount, SidebarCount } from "./SidebarCount";

describe("formatCount dan countText", () => {
  it("menulis angka apa adanya sampai 99", () => {
    expect(formatCount(1)).toBe("1");
    expect(formatCount(99)).toBe("99");
    expect(countText(3, "belum dibaca")).toBe("3 belum dibaca");
    expect(countText(99, "belum dibaca")).toBe("99 belum dibaca");
  });

  it("di atas 99 menjadi 99+", () => {
    expect(formatCount(100)).toBe("99+");
    expect(formatCount(4321)).toBe("99+");
    expect(countText(100, "belum dibaca")).toBe("lebih dari 99 belum dibaca");
  });
});

describe("SidebarCount", () => {
  it("menampilkan angka untuk mata dan artinya untuk pembaca layar", () => {
    render(
      <button type="button">
        Chat
        <SidebarCount count={3} meaning="belum dibaca" />
      </button>,
    );
    expect(screen.getByRole("button", { name: "Chat, 3 belum dibaca" })).toBeInTheDocument();
    expect(screen.getByText("3")).toHaveAttribute("aria-hidden", "true");
  });

  it("di atas 99 menampilkan 99+", () => {
    render(
      <button type="button">
        Chat
        <SidebarCount count={150} meaning="belum dibaca" />
      </button>,
    );
    expect(screen.getByText("99+")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chat, lebih dari 99 belum dibaca" })).toBeInTheDocument();
  });

  it.each([0, -2, Number.NaN, Number.POSITIVE_INFINITY])("tidak menampilkan apa pun untuk %s", (count) => {
    const { container } = render(<SidebarCount count={count} meaning="belum dibaca" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("menambah kelas tambahan tanpa membuang side-count", () => {
    const { container } = render(<SidebarCount count={2} meaning="task" className="prj-count" />);
    expect(container.firstChild).toHaveClass("side-count", "prj-count");
  });
});
