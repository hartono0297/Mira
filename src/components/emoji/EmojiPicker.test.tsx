import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { setLang } from "../../i18n/core";
import { renderInLang } from "../../test/i18n";
import { EMOJI_COLUMNS, EmojiPicker, type EmojiPickerProps } from "./EmojiPicker";
import { emojiInCategory } from "./emojiData";

const FACES = emojiInCategory("faces");

const EMOTES = [
  { name: "kopi_pagi", render: () => <img alt="" src="data:image/png;base64,AA==" /> },
  { name: "mantap", render: () => <img alt="" src="data:image/png;base64,AA==" /> },
];

function setup(props: Partial<EmojiPickerProps> = {}) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  const user = userEvent.setup();
  const utils = render(<EmojiPicker onPick={onPick} onClose={onClose} recent={[]} {...props} />);
  return { ...utils, user, onPick, onClose };
}

const grid = () => screen.getByRole("grid");
const cell = (name: string) => within(grid()).getByRole("button", { name });
const tab = (name: string) => screen.getByRole("tab", { name });

describe("EmojiPicker", () => {
  it("membuka dengan fokus di kolom cari dan kategori Wajah", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "Pilih emoji" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Cari emoji" })).toHaveFocus();
    expect(screen.queryByRole("tab", { name: "Sering dipakai" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Emote kantor" })).toBeNull();
    expect(tab("Wajah")).toHaveAttribute("aria-selected", "true");
    expect(grid()).toHaveAccessibleName("Wajah");
    const first = cell(FACES[0].id);
    expect(first).toHaveAttribute("title", FACES[0].id);
    expect(first).toHaveTextContent(FACES[0].char);
  });

  it("mencari nama Indonesia lalu memilih dengan klik", async () => {
    const { user, onPick, onClose } = setup();
    await user.type(screen.getByRole("textbox", { name: "Cari emoji" }), "jempol");
    expect(grid()).toHaveAccessibleName('Hasil untuk "jempol"');
    expect(tab("Wajah")).toHaveAttribute("aria-selected", "false");
    await user.click(cell("jempol"));
    expect(onPick).toHaveBeenCalledWith("👍");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Enter di kolom cari memilih hasil pertama", async () => {
    const { user, onPick } = setup();
    await user.type(screen.getByRole("textbox", { name: "Cari emoji" }), "kopi{Enter}");
    expect(onPick).toHaveBeenCalledWith("☕");
  });

  it("hasil kosong memberi pesan singkat", async () => {
    const { user } = setup();
    await user.type(screen.getByRole("textbox", { name: "Cari emoji" }), "zzzz");
    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent('Tidak ada emoji untuk "zzzz".');
  });

  it("Tab berputar di kolom cari, tab kategori, dan kisi", async () => {
    const { user } = setup();
    const search = screen.getByRole("textbox", { name: "Cari emoji" });
    await user.tab();
    expect(tab("Wajah")).toHaveFocus();
    await user.tab();
    expect(cell(FACES[0].id)).toHaveFocus();
    await user.tab();
    expect(search).toHaveFocus();
    await user.tab({ shift: true });
    expect(cell(FACES[0].id)).toHaveFocus();
  });

  it("panah, Home, dan End menggerakkan sorotan di kisi; Enter memilih", async () => {
    const { user, onPick } = setup();
    await user.keyboard("{ArrowDown}");
    expect(cell(FACES[0].id)).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(cell(FACES[1].id)).toHaveFocus();
    expect(cell(FACES[1].id)).toHaveAttribute("tabindex", "0");
    expect(cell(FACES[0].id)).toHaveAttribute("tabindex", "-1");
    await user.keyboard("{ArrowDown}");
    expect(cell(FACES[1 + EMOJI_COLUMNS].id)).toHaveFocus();
    await user.keyboard("{ArrowLeft}{ArrowUp}");
    expect(cell(FACES[0].id)).toHaveFocus();
    await user.keyboard("{End}");
    expect(cell(FACES[FACES.length - 1].id)).toHaveFocus();
    await user.keyboard("{Home}");
    expect(cell(FACES[0].id)).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("textbox", { name: "Cari emoji" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowRight}{Enter}");
    expect(onPick).toHaveBeenCalledWith(FACES[1].char);
  });

  it("Spasi juga memilih", async () => {
    const { user, onPick } = setup();
    await user.keyboard("{ArrowDown} ");
    expect(onPick).toHaveBeenCalledWith(FACES[0].char);
  });

  it("panah di tab kategori pindah kategori", async () => {
    const { user } = setup();
    await user.tab();
    await user.keyboard("{ArrowRight}");
    expect(tab("Gestur dan orang")).toHaveFocus();
    expect(tab("Gestur dan orang")).toHaveAttribute("aria-selected", "true");
    expect(cell("jempol")).toBeInTheDocument();
    await user.keyboard("{End}");
    expect(tab("Bendera")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowRight}");
    expect(tab("Wajah")).toHaveFocus();
    await user.click(tab("Makanan dan minuman"));
    expect(cell("kopi")).toBeInTheDocument();
  });

  it("mengetik saat fokus di kisi pindah ke kolom cari", async () => {
    const { user } = setup();
    await user.keyboard("{ArrowDown}{ArrowRight}");
    await user.keyboard("kopi");
    const search = screen.getByRole("textbox", { name: "Cari emoji" });
    expect(search).toHaveFocus();
    expect(search).toHaveValue("kopi");
    expect(cell("kopi")).toBeInTheDocument();
  });

  it("Esc menutup dari kolom cari dan dari kisi", async () => {
    const { user, onClose } = setup();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard("{ArrowDown}{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("klik di luar menutup, kecuali pada tombol pemicu yang sedang terbuka", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">Lain</button>
        <button type="button" aria-expanded="true">
          Emoji
        </button>
        <EmojiPicker onPick={vi.fn()} onClose={onClose} recent={[]} />
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "Emoji" }));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: "Bendera" }));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Lain" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("tab Sering dipakai terbuka lebih dulu kalau ada isinya", async () => {
    const { user, onPick } = setup({ recent: ["🙏", "❤", ":mantap:", ":sudah_dihapus:", "🫠"], emotes: EMOTES });
    expect(tab("Sering dipakai")).toHaveAttribute("aria-selected", "true");
    expect(grid()).toHaveAccessibleName("Sering dipakai");
    const names = within(grid())
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    // Emote yang sudah tidak ada dilewati; emoji di luar data tetap tampil dengan karakternya.
    expect(names).toEqual(["terima kasih", "hati merah", ":mantap:", "🫠"]);
    await user.click(cell("hati merah"));
    expect(onPick).toHaveBeenCalledWith("❤️");
  });

  it("tab Emote kantor menampilkan emote dan memilih :nama:", async () => {
    const { user, onPick, onClose } = setup({ emotes: EMOTES, closeOnPick: false });
    await user.click(tab("Emote kantor"));
    expect(grid()).toHaveAccessibleName("Emote kantor");
    const emote = cell(":kopi_pagi:");
    expect(emote.querySelector("img")).not.toBeNull();
    await user.click(emote);
    expect(onPick).toHaveBeenCalledWith(":kopi_pagi:");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("pencarian juga menemukan emote kantor, emote lebih dulu", async () => {
    const { user } = setup({ emotes: EMOTES });
    await user.type(screen.getByRole("textbox", { name: "Cari emoji" }), "kopi");
    const names = within(grid())
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names.slice(0, 2)).toEqual([":kopi_pagi:", "kopi"]);
  });

  it("memakai labelledBy dan className pemanggil", () => {
    render(
      <>
        <h2 id="judul">Beri reaksi</h2>
        <EmojiPicker onPick={vi.fn()} onClose={vi.fn()} recent={[]} labelledBy="judul" className="letak-atas" />
      </>,
    );
    const dialog = screen.getByRole("dialog", { name: "Beri reaksi" });
    expect(dialog).toHaveClass("emoji-picker", "letak-atas");
  });
});

describe("EmojiPicker dalam bahasa Inggris", () => {
  it("memakai nama dan teks Inggris, lalu kembali ke Indonesia", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    renderInLang(() => <EmojiPicker onPick={onPick} onClose={vi.fn()} recent={["👍"]} emotes={EMOTES} />);

    expect(screen.getByRole("dialog", { name: "Choose an emoji" })).toBeInTheDocument();
    const search = screen.getByRole("textbox", { name: "Search emoji" });
    expect(search).toHaveAttribute("placeholder", "Search, for example thumbs or coffee");
    expect(screen.getByRole("tablist", { name: "Emoji categories" })).toBeInTheDocument();
    expect(tab("Frequently used")).toHaveAttribute("aria-selected", "true");
    expect(tab("Office emotes")).toBeInTheDocument();
    expect(tab("Food and drink")).toBeInTheDocument();
    expect(cell("thumbs up")).toHaveAttribute("title", "thumbs up");

    await user.type(search, "coffee");
    expect(grid()).toHaveAccessibleName('Results for "coffee"');
    await user.click(cell("coffee"));
    expect(onPick).toHaveBeenCalledWith("☕");

    await user.clear(search);
    await user.type(search, "zzzz");
    expect(screen.getByRole("status")).toHaveTextContent('No emoji match "zzzz".');

    act(() => setLang("id"));
    expect(screen.getByRole("status")).toHaveTextContent('Tidak ada emoji untuk "zzzz".');
    await user.clear(search);
    expect(cell("jempol")).toBeInTheDocument();
  });
});
