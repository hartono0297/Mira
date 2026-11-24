import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const profilePickPhoto = vi.fn();
const profileSetPhoto = vi.fn();
const refreshProfilePhotos = vi.fn();
const order: string[] = [];

vi.mock("../../api/profile", () => ({
  profilePickPhoto: () => profilePickPhoto(),
  profileSetPhoto: (...args: unknown[]) => profileSetPhoto(...args),
}));
vi.mock("../profilePhotos", () => ({
  refreshProfilePhotos: () => {
    order.push("refresh");
    return refreshProfilePhotos();
  },
}));

import { useChangePhoto } from "./useChangePhoto";

const picked = { token: "tok-9", preview: "BBBB", width: 900, height: 1600, previewWidth: 576, previewHeight: 1024 };

function Harness({ onDone }: { onDone?: () => void }) {
  const { start, busy, error, element } = useChangePhoto(onDone);
  return (
    <div>
      <button type="button" onClick={start}>
        Ganti foto
      </button>
      <output data-testid="busy">{String(busy)}</output>
      <output data-testid="error">{error ? `${error.code}: ${error.message}` : "none"}</output>
      {element}
    </div>
  );
}

beforeEach(() => {
  order.length = 0;
  profilePickPhoto.mockReset();
  profileSetPhoto.mockReset();
  refreshProfilePhotos.mockReset();
  refreshProfilePhotos.mockResolvedValue(undefined);
});

describe("useChangePhoto", () => {
  it("batal memilih file: dialog tidak terbuka dan tidak ada error", async () => {
    profilePickPhoto.mockResolvedValue(null);
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Ganti foto" }));
    await waitFor(() => expect(screen.getByTestId("busy")).toHaveTextContent("false"));
    expect(profilePickPhoto).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("error")).toHaveTextContent("none");
  });

  it("error memilih file dikembalikan lewat error, dialog tidak terbuka", async () => {
    profilePickPhoto.mockRejectedValue({ code: "invalid_input", message: "Foto terlalu besar. Pilih file sampai 20 MB." });
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Ganti foto" }));
    await waitFor(() =>
      expect(screen.getByTestId("error")).toHaveTextContent("invalid_input: Foto terlalu besar. Pilih file sampai 20 MB."),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("busy")).toHaveTextContent("false");
  });

  it("selama dialog file terbuka busy true dan start kedua diabaikan", async () => {
    let resolve: (v: null) => void = () => {};
    profilePickPhoto.mockReturnValue(new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Ganti foto" }));
    expect(screen.getByTestId("busy")).toHaveTextContent("true");
    await user.click(screen.getByRole("button", { name: "Ganti foto" }));
    expect(profilePickPhoto).toHaveBeenCalledTimes(1);
    await act(async () => resolve(null));
    expect(screen.getByTestId("busy")).toHaveTextContent("false");
  });

  it("foto dipilih: dialog terbuka, simpan memuat ulang foto lalu memanggil onDone", async () => {
    profilePickPhoto.mockResolvedValue(picked);
    profileSetPhoto.mockResolvedValue({ owner: "me", hash: "h2" });
    const onDone = vi.fn(() => order.push("done"));
    const user = userEvent.setup();
    render(<Harness onDone={onDone} />);
    await user.click(screen.getByRole("button", { name: "Ganti foto" }));
    expect(await screen.findByRole("dialog", { name: "Atur foto profil" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Simpan foto" }));
    expect(profileSetPhoto).toHaveBeenCalledWith("tok-9", { x: 0, y: 350, size: 900 });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["refresh", "done"]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Batal di dialog menutupnya tanpa onDone", async () => {
    profilePickPhoto.mockResolvedValue(picked);
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<Harness onDone={onDone} />);
    await user.click(screen.getByRole("button", { name: "Ganti foto" }));
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Batal" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(refreshProfilePhotos).not.toHaveBeenCalled();
  });
});
