// Avatar: inisial atau foto, aksesibilitas, titik online (docs/plans/foto-profil.md 3.3 dan 3.5).
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Avatar } from "./Avatar";

const photoUrls = vi.hoisted(() => new Map<string, string>());
vi.mock("./profilePhotos", () => ({
  usePhotoUrl: (key: string | null | undefined) => (key ? (photoUrls.get(key) ?? null) : null),
}));

const KEY = "a".repeat(64);
const URL_A = "data:image/jpeg;base64,AAAA";

beforeEach(() => photoUrls.clear());

function root(container: HTMLElement) {
  return container.firstElementChild as HTMLElement;
}

describe("Avatar", () => {
  it("tanpa foto: inisial, tanpa img, kelas bawaan ukuran md", () => {
    const { container } = render(<Avatar name="Sari Wulandari" publicKey={KEY} />);
    const el = root(container);
    expect(el.tagName).toBe("SPAN");
    expect(el).toHaveTextContent("SW");
    expect(el).toHaveClass("avatar", "avatar-md");
    expect(el).toHaveAttribute("data-avatar-key", KEY);
    expect(container.querySelector("img")).toBeNull();
  });

  it("ukuran sm dan lg memberi kelas sendiri; className lama menggantikan kelas ukuran", () => {
    const { container: sm } = render(<Avatar name="Sari" size="sm" />);
    expect(root(sm)).toHaveClass("avatar", "avatar-sm");
    const { container: lg } = render(<Avatar name="Sari" size="lg" />);
    expect(root(lg)).toHaveClass("avatar", "avatar-lg");
    const { container: old } = render(<Avatar name="Sari" size="lg" className="avatar tc-av" />);
    expect(root(old)).toHaveClass("avatar", "tc-av");
    expect(root(old)).not.toHaveClass("avatar-lg");
  });

  it("tanpa kunci publik: tidak ada data-avatar-key dan tidak ada foto", () => {
    photoUrls.set(KEY, URL_A);
    const { container } = render(<Avatar name="Sari" className="conv-avatar" />);
    expect(root(container)).not.toHaveAttribute("data-avatar-key");
    expect(root(container)).toHaveClass("conv-avatar");
    expect(container.querySelector("img")).toBeNull();
  });

  it("ada foto: img avatar-img dengan data URL, inisial tidak tampil", () => {
    photoUrls.set(KEY, URL_A);
    const { container } = render(<Avatar name="Sari Wulandari" publicKey={KEY} />);
    const img = container.querySelector("img.avatar-img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", URL_A);
    expect(img).toHaveAttribute("alt", "");
    expect(root(container)).not.toHaveTextContent("SW");
  });

  it("img gagal dimuat: kembali ke inisial", () => {
    photoUrls.set(KEY, URL_A);
    const { container } = render(<Avatar name="Sari Wulandari" publicKey={KEY} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(root(container)).toHaveTextContent("SW");
  });

  it("foto baru setelah gagal dicoba lagi", () => {
    photoUrls.set(KEY, URL_A);
    const { container, rerender } = render(<Avatar name="Sari" publicKey={KEY} />);
    fireEvent.error(container.querySelector("img")!);
    photoUrls.set(KEY, "data:image/jpeg;base64,BBBB");
    rerender(<Avatar name="Sari" publicKey={KEY} title="baru" />);
    expect(container.querySelector("img")).toHaveAttribute("src", "data:image/jpeg;base64,BBBB");
  });

  it("dekoratif (bawaan): akar aria-hidden, tanpa role", () => {
    photoUrls.set(KEY, URL_A);
    const { container } = render(<Avatar name="Sari" publicKey={KEY} />);
    expect(root(container)).toHaveAttribute("aria-hidden", "true");
    expect(root(container)).not.toHaveAttribute("role");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("tidak dekoratif: role img dengan nama orang, dengan atau tanpa foto", () => {
    render(<Avatar name="Sari Wulandari" decorative={false} />);
    expect(screen.getByRole("img", { name: "Sari Wulandari" })).not.toHaveAttribute("aria-hidden");
    photoUrls.set(KEY, URL_A);
    render(<Avatar name="Budi" publicKey={KEY} decorative={false} />);
    expect(screen.getByRole("img", { name: "Budi" })).toBeInTheDocument();
  });

  it("title dan menu klik kanan diteruskan ke akar", () => {
    const onContextMenu = vi.fn();
    const { container } = render(<Avatar name="Sari" title="Sari (Anda)" onContextMenu={onContextMenu} />);
    expect(root(container)).toHaveAttribute("title", "Sari (Anda)");
    fireEvent.contextMenu(root(container));
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });

  it("titik online: tampil hanya saat online, labelnya dibacakan", () => {
    const { container, rerender } = render(<Avatar name="Sari" online={false} onlineLabel="Online" />);
    expect(container.querySelector(".avatar-dot")).toBeNull();
    expect(screen.queryByText("Online")).toBeNull();

    rerender(<Avatar name="Sari" online onlineLabel="Online" />);
    expect(container.querySelector(".avatar-dot")).not.toBeNull();
    const label = screen.getByText("Online");
    expect(label).toHaveClass("sr-only");
    // Dekoratif tapi punya status: status tetap sampai ke pembaca layar.
    expect(root(container)).not.toHaveAttribute("aria-hidden");
    expect(label.closest("[aria-hidden='true']")).toBeNull();
  });

  it("titik online pada avatar tidak dekoratif: nama tetap, status jadi deskripsi", () => {
    render(<Avatar name="Sari" decorative={false} online onlineLabel="Sedang online" />);
    const img = screen.getByRole("img", { name: "Sari" });
    expect(img).toHaveAccessibleDescription("Sedang online");
  });
});
