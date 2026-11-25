// Uji ujung ke ujung reaksi, emoji, emote, dan sticker di Chat (v0.5.1,
// docs/plans/chat-sticker.md) antar tiga "laptop" Mira di satu PC, lewat transport
// jaringan sungguhan (QUIC di 127.0.0.1, penemuan mDNS), seperti e2e-fitur-multi.mjs.
//
//   A  Ayu    superadmin
//   B  Budi   anggota, diberi lima label keahlian
//   C  Citra  anggota
//
// Pemeriksaan:
//   0. Persiapan organisasi tiga laptop, jalan uji MIRA_E2E_PICK aktif.
//   1. Reaksi: B memberi 👍 lewat tombol reaksi cepat di pesan A, A dan C melihat chip 1;
//      C juga 👍 (A melihat 2); B menghapus (1). Dicek di layar dan lewat chat_messages.
//   2. Label: A membuat lima label dan memasangnya ke B. Pesan B di #umum menampilkan
//      kelima label di baris penulis (A, C, dan B sendiri dengan "(Anda)"), kepala pesan
//      pribadi A ke B juga. A memberi 🙏 ke pesan B lewat menu "Beri reaksi".
//   3. Sticker kantor: A menambah :kopi: (PNG) di Organisasi, tab Sticker. B dan C
//      melihatnya di pemilih sticker. B mengirim :kopi:, A dan C melihat gambar besar.
//   4. Emote di teks: C mengetik "Pagi :kop", saran :kopi: muncul, C mengirim
//      "Pagi :kopi: semua", A melihat gambar sebaris.
//   5. Sticker pribadi: C menyimpan :kopi: dari pesan (menu "Simpan sticker"), lalu
//      mengunggah :halo: (GIF animasi) dan mengirimnya ke B lewat pesan pribadi.
//   6. Offline lalu menyusul: C dimatikan; A memberi ❤️ ke pesan B, A menambah :siap:
//      (GIF), B mengirim :siap:. C dinyalakan lagi dan menyusul ketiganya.
//   7. Admin menyembunyikan: A menghapus pesan sticker B lewat menu "Hapus pesan",
//      B dan C melihat "Pesan dihapus".
//   8. Pemilih emoji dengan keyboard: Tab ke tombol Emoji, Enter, ketik "jempol", Enter.
//   9. Screenshot terang dan gelap, Indonesia dan Inggris.
//
// Dialog berkas Windows untuk unggah sticker dilewati lewat jalan uji di build debug:
// chat_sticker_pick (src-tauri/src/chat/commands.rs) mengembalikan file di variabel
// lingkungan MIRA_E2E_PICK tanpa membuka dialog, dan mencatatnya seperti hasil dialog
// (ChatRuntime::remember_picked). Skrip memberi tiap instance satu path tetap, lalu
// menulis ulang isi file itu dengan gambar yang diinginkan sebelum setiap unggahan.
// Build release mengabaikan variabel itu, jadi skrip ini butuh build debug.
//
// Selektor layar dikumpulkan di objek UI dan SEL di bawah (teks Indonesia dan Inggris
// dari src/i18n/*.ts). Sesuaikan di sana kalau label di layar berubah.
//
// Pakai:  node scripts/sticker-e2e.mjs [path mira.exe] [folder screenshot] [folder kerja]
//   bawaan: src-tauri/target/debug/mira.exe, docs/progress/screenshots/chat-sticker, folder temp
// Build dulu: npx tauri build --debug --no-bundle
// Port digeser E2E_PORT_OFFSET (bawaan 1100) supaya tidak bentrok dengan e2e sesi lain.

import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { FIXTURES } from "./sticker-e2e-fixtures.mjs";

const exe = resolve(process.argv[2] ?? "src-tauri/target/debug/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots/chat-sticker");
const workParent = resolve(process.argv[4] ?? process.env.MIRA_E2E_WORK ?? tmpdir());
mkdirSync(shots, { recursive: true });
mkdirSync(workParent, { recursive: true });
// Screenshot per langkah (bukti) ikut di subfolder; screenshot saat gagal di folder kerja.
const stepShots = join(shots, "langkah");
mkdirSync(stepShots, { recursive: true });
const failShots = join(workParent, "sticker-e2e-gagal");
mkdirSync(failShots, { recursive: true });
const root = mkdtempSync(join(workParent, "mira-sticker-e2e-"));

const PORT_OFFSET = Number(process.env.E2E_PORT_OFFSET ?? 1100) || 0;
const NODES = {
  A: { name: "Ayu Uji", port: 47861 + PORT_OFFSET, cdp: 9361 + PORT_OFFSET, dir: join(root, "laptop-a") },
  B: { name: "Budi Uji", port: 47862 + PORT_OFFSET, cdp: 9362 + PORT_OFFSET, dir: join(root, "laptop-b") },
  C: { name: "Citra Uji", port: 47863 + PORT_OFFSET, cdp: 9363 + PORT_OFFSET, dir: join(root, "laptop-c") },
};
// Satu file "hasil dialog" per instance. Isinya ditulis ulang sebelum setiap unggahan.
for (const id of Object.keys(NODES)) NODES[id].pick = join(root, `pilihan-sticker-${id.toLowerCase()}.gambar`);
const addr = (id) => `127.0.0.1:${NODES[id].port}`;
// Sinkron berjalan saat ada perubahan, ditambah cadangan berkala 60 detik.
const SYNC_MS = 150000;

const TEXT = {
  rapat: "Rapat mingguan Senin jam 9, mohon konfirmasi.",
  label: "Budi siap, gambar kerja sudah saya periksa.",
  emoteTyped: "Pagi :kop",
  emoteFinal: "Pagi :kopi: semua",
};
const LABELS = ["Arsitek", "Drafter", "Estimator", "Pengawas K3", "Surveyor"];
const PACK = "Kantor";
const EMOJI = { thumbs: "👍", heart: "❤️", pray: "🙏" };

// ---------------------------------------------------------------------------
// Teks layar (Indonesia, Inggris). Sumber: src/i18n/*.id.ts dan *.en.ts.
// ---------------------------------------------------------------------------
const UI = {
  mainMenu: ["Menu utama", "Main menu"], // shell
  nav: {
    chat: ["Chat", "Chat"],
    org: ["Organisasi", "Organization"],
    settings: ["Pengaturan", "Settings"],
  },
  settingsPart: { appearance: ["Tampilan", "Appearance"], language: ["Bahasa", "Language"] }, // settings.parts
  theme: { terang: ["Terang", "Light"], gelap: ["Gelap", "Dark"] }, // settings.appearance.modes
  langRadio: { id: "Bahasa Indonesia", en: "English" },
  convList: ["Daftar percakapan", "Conversations"], // chat.list.label
  logPrefix: ["Pesan di", "Messages in"], // chat.conv.region
  composerPrefix: ["Pesan untuk", "Message to"], // chat.composer.inputLabel
  newDirect: ["Pesan baru", "New message", "Chat pribadi baru"], // chat.list.newDirect
  dmRowPrefix: ["Pesan pribadi dengan", "Direct message with", "Chat pribadi dengan"], // chat.list.rowDirect
  deleted: ["Pesan dihapus", "Message deleted"], // chat-text.deleted
  // Kolom pesan (chat-sticker.composer)
  emojiBtn: ["Sisipkan emoji", "Insert emoji"],
  stickerBtn: ["Kirim sticker", "Send a sticker"],
  suggestList: ["Saran emoji", "Emoji suggestions"],
  // Pemilih emoji (emoji.dialog, emoji.search)
  emojiDialog: ["Pilih emoji", "Choose an emoji"],
  emojiSearch: ["Cari emoji", "Search emoji"],
  // Pemilih sticker (chat-sticker.picker, chat-sticker.form)
  stickerPicker: ["Pilih sticker", "Choose a sticker"],
  tabOffice: ["Kantor", "Office"],
  tabMine: ["Punya saya", "Mine"],
  upload: ["Unggah sticker", "Upload a sticker"],
  myForm: ["Sticker baru", "New sticker"],
  myName: ["Nama", "Name"],
  mySave: ["Simpan sticker", "Save sticker"],
  // Reaksi di pesan (chat-reaction)
  reactionBar: ["Reaksi untuk pesan", "Reactions to message from"],
  addReaction: ["Beri reaksi ke pesan", "React to message from"], // tombol "+" di bilah chip
  reactionPicker: ["Pilih reaksi untuk pesan", "Choose a reaction for message", "Pilih emoji", "Choose an emoji"],
  // Menu pesan (chat-menu)
  msgMenu: ["Aksi untuk pesan", "Actions for message"],
  menuReact: ["Beri reaksi", "React"],
  menuSaveSticker: ["Simpan sticker", "Save sticker"],
  menuDelete: ["Hapus pesan", "Delete message"],
  deleteConfirm: ["Hapus pesan", "Delete message"], // chat.message.deleteConfirm
  // Organisasi, tab Sticker (org-stickers)
  orgTabs: ["Bagian organisasi", "Organization sections"],
  orgTab: ["Sticker", "Stickers"],
  orgAdd: ["Tambah sticker", "Add sticker"],
  orgAddDialog: ["Tambah sticker kantor", "Add an office sticker"],
  orgName: ["Nama", "Name"],
  orgPack: ["Paket", "Pack"],
  orgKeywords: ["Kata kunci (boleh kosong)", "Keywords (optional)"],
  orgSubmit: ["Tambah sticker", "Add sticker"],
  orgStickerList: ["Sticker di paket", "Stickers in pack"],
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const anyOf = (texts) => new RegExp(`^(${texts.map(esc).join("|")})$`);
const startsAny = (texts) => new RegExp(`^(${texts.map(esc).join("|")})`);
// Tombol menu utama: angka notifikasi bisa menambah ", 3 belum dibaca" di belakang nama.
const menuRe = (texts) => new RegExp(`^(${texts.map(esc).join("|")})\\s*(,|$)`);
// Emoji dengan atau tanpa VS16 (U+FE0F), supaya "❤" dan "❤️" sama-sama cocok.
const noVs = (e) => e.replace(/️/g, "");
const emojiRe = (e) => [...noVs(e)].map(esc).join("\\uFE0F?") + "\\uFE0F?";
// Nama aksesibel sticker di pemilih: ":kopi:" atau "kopi", boleh diikuti keterangan.
// Tombol "Hapus :kopi: dari sticker saya" tidak cocok karena diawali "Hapus".
const stickerItemRe = (name) => new RegExp(`^:?${name}:?(\\W|$)`);
const stickerAlt = (name) => `:${name}:`;

// ---------------------------------------------------------------------------
// Selektor. Ubah di sini kalau struktur layar berbeda.
// ---------------------------------------------------------------------------
const SEL = {
  nav: (p, key) =>
    p.getByRole("navigation", { name: anyOf(UI.mainMenu) }).getByRole("button", { name: menuRe(UI.nav[key]) }),
  settingsPart: (p, key) => p.locator("ul.settings-nav").getByRole("button", { name: anyOf(UI.settingsPart[key]) }),
  themeRadio: (p, key) => p.getByLabel(anyOf(UI.theme[key])),
  langRadio: (p, lang) => p.locator(".lang-picker-full").getByRole("radio", { name: UI.langRadio[lang], exact: true }),

  list: (p) => p.getByRole("navigation", { name: anyOf(UI.convList) }),
  channelRow: (p, name) => SEL.list(p).getByRole("button", { name: new RegExp(`^Channel ${esc(name)}(,|$)`) }),
  dmRow: (p, name) => SEL.list(p).getByRole("button", { name: new RegExp(`${startsAny(UI.dmRowPrefix).source} ${esc(name)}(,|$)`) }),
  newDirectBtn: (p) => p.getByRole("button", { name: anyOf(UI.newDirect) }),
  conv: (p, title) => p.getByRole("region", { name: title, exact: true }),
  log: (p) => p.getByRole("region", { name: startsAny(UI.logPrefix) }),
  composer: (p) => p.getByRole("combobox", { name: startsAny(UI.composerPrefix) }),
  message: (p, text) => SEL.log(p).getByRole("listitem").filter({ hasText: text }).first(),
  convHead: (p) => p.locator("header.conv-head"),

  // Label profil (src/components/NameWithLabels.tsx). ".lab-more" adalah ringkasan "+2".
  msgHead: (msg) => msg.locator(".conv-msg-head"),
  labels: (scope) => scope.locator(".nwl-labels .lab:not(.lab-more)"),
  labelsMore: (scope) => scope.locator(".nwl-labels .lab-more"),

  // Reaksi (src/screens/chat/ReactionBar.tsx, MessageItem.tsx). Chip: <ul class="rx-bar"
  // aria-label="Reaksi untuk pesan ..."> berisi button.rx-chip[data-rx-emoji] dengan
  // span.rx-count dan aria-pressed untuk reaksi saya. Nama aksesibelnya memakai nama emoji
  // ("jempol 2. ..."), jadi chip dicari lewat data-rx-emoji.
  reactionBar: (msg) => msg.getByRole("list", { name: startsAny(UI.reactionBar) }),
  chips: (msg) => msg.locator("ul.rx-bar button.rx-chip[data-rx-emoji]"),
  chip: (msg, emoji) => msg.locator(`ul.rx-bar button.rx-chip[data-rx-emoji="${emoji}"]`),
  // Reaksi cepat di bilah aksi (toolbar "Reaksi cepat untuk pesan ..."): tombol
  // "Beri reaksi jempol" yang berisi karakter emojinya.
  quickReact: (msg, emoji) => msg.locator(".rx-quick .rx-quick-btn").filter({ hasText: emoji }),
  addReactionBtn: (msg) => msg.getByRole("button", { name: startsAny(UI.addReaction) }),
  reactionPicker: (p) => p.getByRole("dialog", { name: startsAny(UI.reactionPicker) }),

  // Menu pesan (klik kanan)
  msgMenu: (p) => p.getByRole("menu", { name: startsAny(UI.msgMenu) }),
  menuItem: (menu, texts) => menu.getByRole("menuitem", { name: anyOf(texts) }),
  // Bagian pesan yang diklik kanan: teks, gambar sticker, atau badan pesan.
  menuTarget: (msg) => msg.locator(".conv-text, .sticker-img-large, .conv-msg-body").first(),
  confirmDialog: (p) => p.getByRole("dialog").filter({ has: p.getByRole("button", { name: anyOf(UI.deleteConfirm) }) }),

  // Kolom pesan (src/screens/chat/Composer.tsx)
  emojiBtn: (p) => p.getByRole("button", { name: anyOf(UI.emojiBtn) }),
  stickerBtn: (p) => p.getByRole("button", { name: anyOf(UI.stickerBtn) }),
  suggestList: (p) => p.getByRole("listbox", { name: anyOf(UI.suggestList) }),
  suggestOption: (p, name) => SEL.suggestList(p).getByRole("option", { name: new RegExp(`^:${name}:`) }),
  emojiDialog: (p) => p.getByRole("dialog", { name: anyOf(UI.emojiDialog) }),
  emojiSearch: (scope) => scope.getByLabel(anyOf(UI.emojiSearch)),

  // Pemilih sticker (src/screens/chat/StickerPicker.tsx)
  picker: (p) => p.getByRole("dialog", { name: anyOf(UI.stickerPicker) }),
  pickerTab: (picker, key) => picker.getByRole("tab", { name: anyOf(key === "office" ? UI.tabOffice : UI.tabMine) }),
  pickerItem: (picker, name) =>
    picker
      .getByRole("button", { name: stickerItemRe(name) })
      .or(picker.getByRole("option", { name: stickerItemRe(name) }))
      .first(),
  uploadBtn: (p) => p.getByRole("button", { name: anyOf(UI.upload) }),
  myForm: (p) =>
    p
      .getByRole("dialog", { name: anyOf(UI.myForm) })
      .or(p.locator("form").filter({ has: p.getByRole("button", { name: anyOf(UI.mySave) }) }))
      .first(),
  myName: (form) => form.getByLabel(anyOf(UI.myName)),
  mySave: (form) => form.getByRole("button", { name: anyOf(UI.mySave) }),

  // Gambar sticker dan emote (src/screens/chat/StickerImage.tsx)
  stickerLarge: (scope, name) => scope.locator(`img.sticker-img-large[alt="${stickerAlt(name)}"]`),
  stickerInline: (scope, name) => scope.locator(`img.sticker-img-inline[alt="${stickerAlt(name)}"]`),
  fileCards: (msg) => msg.locator(".conv-files"),

  // Organisasi, tab Sticker (src/screens/org/StickersPanel.tsx)
  orgTab: (p) => p.getByRole("navigation", { name: anyOf(UI.orgTabs) }).getByRole("button", { name: anyOf(UI.orgTab) }),
  orgAdd: (p) => p.getByRole("button", { name: anyOf(UI.orgAdd) }).first(),
  orgAddDialog: (p) => p.getByRole("dialog", { name: anyOf(UI.orgAddDialog) }),
  orgName: (dlg) => dlg.getByLabel(anyOf(UI.orgName)),
  orgPack: (dlg) => dlg.getByLabel(startsAny(UI.orgPack)),
  orgKeywords: (dlg) => dlg.getByLabel(startsAny(UI.orgKeywords)),
  orgSubmit: (dlg) => dlg.getByRole("button", { name: anyOf(UI.orgSubmit) }),
  orgStickerList: (p) => p.getByRole("list", { name: startsAny(UI.orgStickerList) }),
};

// ---------------------------------------------------------------------------
// Kunci laptop uji di Windows Credential Manager: di akhir hanya kunci milik skrip ini
// yang dihapus (skrip lain di PC ini mungkin sedang berjalan).
// ---------------------------------------------------------------------------
function miraCredentials() {
  try {
    const out = execFileSync("cmdkey", ["/list"], { encoding: "utf8" });
    return new Set(out.match(/device-key-[0-9a-f]{64}\.id\.mira\.desktop/g) ?? []);
  } catch {
    return new Set();
  }
}
const credentialsBefore = miraCredentials();
const ownKeys = new Set();
const keyTarget = (publicKey) => `device-key-${publicKey}.id.mira.desktop`;
function checkOwnKeys(when) {
  const now = miraCredentials();
  const gone = [...ownKeys].filter((k) => !now.has(k));
  if (gone.length) note(`${when}: ${gone.length} dari ${ownKeys.size} kunci uji sudah dihapus dari Credential Manager oleh proses lain`);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "LULUS" : "GAGAL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const note = (msg) => console.log(`CATATAN  ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const secs = (since) => `${Math.round((Date.now() - since) / 1000)} dtk`;
const short = (e) => String(e?.message ?? e).split("\n")[0].slice(0, 200);

const running = {};

async function launch(id) {
  const node = NODES[id];
  mkdirSync(node.dir, { recursive: true });
  const log = createWriteStream(join(root, `${id}-stderr.log`), { flags: "a" });
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: node.dir,
      MIRA_PORT: String(node.port),
      MIRA_E2E_PICK: node.pick,
      MIRA_UPDATER_ENDPOINT: "http://127.0.0.1:9/latest.json",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${node.cdp}`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.pipe(log);
  let browser;
  for (let i = 0; i < 80 && !browser; i++) {
    await sleep(500);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${node.cdp}`);
    } catch {
      /* belum siap */
    }
  }
  if (!browser) {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* sudah berhenti */
    }
    throw new Error(`WebView2 ${id} tidak bisa dihubungi lewat CDP port ${node.cdp} (port dipakai proses lain?)`);
  }
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages())[0];
    if (!page) await sleep(250);
  }
  const consoleLines = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") consoleLines.push(`[${m.type()}] ${m.text()}`);
  });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  running[id] = { child, browser, page, consoleLines };
  // Kunci laptop dicatat segera, supaya tetap dibersihkan walau skrip gagal di tengah persiapan.
  const st = await call(id, "get_app_state");
  if (st.ok && st.value?.identity?.publicKey) ownKeys.add(keyTarget(st.value.identity.publicKey));
  return running[id];
}

async function stop(id) {
  const app = running[id];
  if (!app) return;
  delete running[id];
  await app.browser.close().catch(() => {});
  try {
    execFileSync("taskkill", ["/PID", String(app.child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* sudah berhenti */
  }
  await sleep(1500);
}

// Memanggil command Tauri di instance `id`. Hasil: { ok, value } atau { ok: false, error }.
async function call(id, cmd, args = {}, timeoutMs = 0) {
  return running[id].page.evaluate(
    async ([c, a, ms]) => {
      const run = window.__TAURI_INTERNALS__.invoke(c, a).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
      if (!ms) return run;
      const late = new Promise((r) => setTimeout(() => r({ ok: false, error: { code: "timeout" }, timeout: true }), ms));
      return Promise.race([run, late]);
    },
    [cmd, args, timeoutMs],
  );
}
async function must(id, cmd, args) {
  const r = await call(id, cmd, args);
  if (!r.ok) throw new Error(`${id} ${cmd}: ${JSON.stringify(r.error)}`);
  return r.value;
}
async function waitFor(desc, fn, timeoutMs = SYNC_MS, everyMs = 1000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = short(e);
    }
    await sleep(everyMs);
  }
  throw new Error(`Menunggu terlalu lama: ${desc} (terakhir: ${JSON.stringify(last)?.slice(0, 200)})`);
}
// Seperti waitFor, tapi kegagalan dikembalikan sebagai teks, bukan dilempar.
const settle = (desc, fn, timeoutMs) => waitFor(desc, fn, timeoutMs).catch((e) => String(e.message));
const page = (id) => running[id].page;
const stepShot = (id, name) => page(id).screenshot({ path: join(stepShots, name) }).catch(() => {});
const onlineNames = async (id) =>
  (await must(id, "get_network_status")).peers.filter((p) => p.online).map((p) => p.displayName).sort();

// ---------------------------------------------------------------------------
// Langkah layar
// ---------------------------------------------------------------------------
async function goChat(id) {
  await SEL.nav(page(id), "chat").click();
  await SEL.list(page(id)).waitFor({ timeout: 15000 });
}
async function openChannel(id, name) {
  await SEL.channelRow(page(id), name).click({ timeout: SYNC_MS });
  await SEL.conv(page(id), `#${name}`).waitFor({ timeout: 15000 });
}
async function send(id, text) {
  const input = SEL.composer(page(id));
  await input.click();
  await input.fill(text);
  await input.press("Enter");
  await SEL.message(page(id), text).waitFor({ timeout: 15000 });
}
async function setTheme(id, key) {
  await SEL.nav(page(id), "settings").click();
  await SEL.settingsPart(page(id), "appearance").click();
  await SEL.themeRadio(page(id), key).check();
  await sleep(300);
}
async function setLang(id, lang) {
  await SEL.nav(page(id), "settings").click();
  await SEL.settingsPart(page(id), "language").click();
  await SEL.langRadio(page(id), lang).check();
  await page(id)
    .waitForFunction((l) => document.documentElement.lang === l, lang, { timeout: 5000 })
    .catch(() => {});
  await sleep(300);
}
// Membuka pesan pribadi dengan `name` lewat dialog "Pesan baru".
async function openDm(id, name) {
  const p = page(id);
  await goChat(id);
  await SEL.newDirectBtn(p).first().click();
  const dlg = p.getByRole("dialog", { name: anyOf(UI.newDirect) });
  await dlg.waitFor({ timeout: 10000 });
  await dlg.getByRole("button", { name: new RegExp(esc(name)) }).first().click();
  await SEL.conv(p, name).waitFor({ timeout: 15000 });
}
async function messagesOf(id, conv) {
  return (await must(id, "chat_messages", { conv, before: null, limit: 100 })).messages;
}
async function apiReaction(id, conv, messageId, emoji) {
  const m = (await messagesOf(id, conv)).find((x) => x.id === messageId);
  const r = (m?.reactions ?? []).find((x) => noVs(x.emoji) === noVs(emoji));
  return r ? { count: r.count, mine: r.mine, people: r.people.map((p) => p.name) } : { count: 0, mine: false, people: [] };
}
// Keadaan chip reaksi di layar: { count, mine } (count 0 kalau chip tidak ada).
async function chipState(msg, emoji) {
  if (!(await msg.count())) return { count: 0, mine: false };
  const all = await SEL.chips(msg).evaluateAll((els) =>
    els.map((el) => ({
      emoji: el.dataset.rxEmoji ?? "",
      count: Number(el.querySelector(".rx-count")?.textContent ?? "NaN"),
      mine: el.getAttribute("aria-pressed") === "true",
      label: el.getAttribute("aria-label") ?? "",
    })),
  );
  return all.find((c) => noVs(c.emoji) === noVs(emoji)) ?? { count: 0, mine: false };
}
// Menunggu chip `emoji` di pesan `text` di laptop `id` menunjukkan `want`.
function waitChip(id, text, emoji, want, timeoutMs = SYNC_MS) {
  return settle(
    `${id} melihat ${emoji} ${want} di "${text.slice(0, 20)}"`,
    async () => {
      const s = await chipState(SEL.message(page(id), text), emoji);
      return s.count === want ? s : null;
    },
    timeoutMs,
  );
}
// Reaksi lewat tombol reaksi cepat: arahkan mouse ke pesan, lalu klik tombolnya.
async function reactQuick(msg, emoji) {
  await msg.scrollIntoViewIfNeeded().catch(() => {});
  await msg.hover();
  const btn = SEL.quickReact(msg, emoji);
  if (!(await btn.count())) return { ok: false, how: "tombol reaksi cepat tidak ditemukan" };
  try {
    await btn.first().click({ timeout: 4000 });
    return { ok: true, how: "arahkan dan klik" };
  } catch {
    await btn.first().focus();
    await btn.first().press("Enter");
    return { ok: true, how: "fokus dan Enter (klik tidak bisa)" };
  }
}
// Klik kanan pesan, tunggu menu pesan, pilih item.
async function messageMenu(id, msg, texts) {
  const p = page(id);
  await msg.scrollIntoViewIfNeeded().catch(() => {});
  await SEL.menuTarget(msg).click({ button: "right" });
  const menu = SEL.msgMenu(p);
  await menu.waitFor({ state: "visible", timeout: 5000 });
  await SEL.menuItem(menu, texts).click();
}
async function openPicker(id) {
  const p = page(id);
  const picker = SEL.picker(p);
  if (!(await picker.isVisible().catch(() => false))) await SEL.stickerBtn(p).click();
  await picker.waitFor({ timeout: 10000 });
  return picker;
}
async function closePopup(id) {
  await page(id).keyboard.press("Escape").catch(() => {});
  await sleep(200);
}
// Menunggu sticker `name` muncul di tab pemilih (`tab`: office atau mine). Pemilih ditutup
// dan dibuka ulang di antara percobaan supaya katalog terbaru dimuat.
function waitPickerItem(id, tab, name, timeoutMs = SYNC_MS) {
  return settle(
    `${id} melihat :${name}: di pemilih sticker`,
    async () => {
      const picker = await openPicker(id);
      await SEL.pickerTab(picker, tab).click();
      const item = SEL.pickerItem(picker, name);
      if (await item.isVisible().catch(() => false)) return true;
      await closePopup(id);
      await sleep(1500);
      return false;
    },
    timeoutMs,
  );
}
// Gambar sticker besar `name` di percakapan yang terbuka: dimuat, ukurannya, dan
// apakah pesannya juga punya kartu file (seharusnya tidak).
async function stickerMessageState(id, name) {
  const p = page(id);
  const img = SEL.stickerLarge(SEL.log(p), name);
  if (!(await img.count())) return null;
  const info = await img.last().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { loaded: el.complete && el.naturalWidth > 0, w: Math.round(r.width), h: Math.round(r.height), data: el.src.startsWith("data:image/") };
  });
  const li = SEL.log(p).getByRole("listitem").filter({ has: p.locator(`img.sticker-img-large[alt="${stickerAlt(name)}"]`) }).last();
  info.files = await SEL.fileCards(li).count();
  return info;
}
const stickerOk = (s) => s && s.loaded && s.data && s.w >= 100 && s.files === 0;
function waitStickerMessage(id, name, timeoutMs = SYNC_MS) {
  return settle(
    `${id} melihat pesan sticker :${name}:`,
    async () => {
      const s = await stickerMessageState(id, name);
      return stickerOk(s) ? s : null;
    },
    timeoutMs,
  );
}
const describeSticker = (s) => (typeof s === "object" && s ? `${s.w}x${s.h} px, data URL=${s.data}, kartu file=${s.files}` : String(s));

// Label di dalam `scope`: daftar nama dan apakah ada ringkasan "+N".
async function labelState(scope) {
  const names = (await SEL.labels(scope).evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim())))
    .map((t) => t.replace(/,\s*$/, ""));
  const more = await SEL.labelsMore(scope).count();
  return { names, more };
}
const allLabels = (s) => s.more === 0 && LABELS.every((l) => s.names.includes(l)) && s.names.length === LABELS.length;

async function catalog(id) {
  return must(id, "chat_stickers");
}

// Sticker kantor lewat Organisasi, tab Sticker. Kalau UI gagal, cadangan invoke
// (chat_sticker_pick + chat_office_sticker_add) supaya langkah berikutnya tetap teruji.
async function addOfficeSticker(id, name, keywords) {
  writeFileSync(NODES[id].pick, FIXTURES[name].bytes());
  const p = page(id);
  const res = { ui: false, detail: "" };
  try {
    await SEL.nav(p, "org").click();
    await SEL.orgTab(p).click();
    await SEL.orgAdd(p).click();
    const dlg = SEL.orgAddDialog(p);
    await dlg.waitFor({ timeout: 15000 });
    await SEL.orgName(dlg).fill(name);
    const pack = SEL.orgPack(dlg);
    await pack.fill(PACK).catch(async () => pack.selectOption({ label: PACK }));
    await SEL.orgKeywords(dlg).fill(keywords.join(", "));
    await stepShot(id, `org-tambah-${name}-${id.toLowerCase()}.png`);
    await SEL.orgSubmit(dlg).click();
    await dlg.waitFor({ state: "hidden", timeout: 15000 });
    await SEL.orgStickerList(p).filter({ hasText: name }).first().waitFor({ timeout: 15000 });
    res.ui = true;
    res.detail = "lewat Organisasi > Sticker";
  } catch (e) {
    res.detail = `UI: ${short(e)}`;
    await closePopup(id);
    const picked = await call(id, "chat_sticker_pick", {}, 10000);
    if (picked.ok && picked.value) {
      const r = await call(id, "chat_office_sticker_add", { path: picked.value.path, pack: PACK, name, keywords });
      res.detail += r.ok ? "; cadangan invoke berhasil" : `; cadangan invoke gagal: ${JSON.stringify(r.error)}`;
    } else {
      res.detail += `; chat_sticker_pick: ${JSON.stringify(picked.error ?? picked.value)}`;
    }
  }
  return res;
}

// Sticker pribadi lewat pemilih sticker, tab Punya saya, Unggah sticker. Percakapan harus
// sudah terbuka. Cadangan invoke seperti addOfficeSticker.
async function addMySticker(id, name) {
  writeFileSync(NODES[id].pick, FIXTURES[name].bytes());
  const p = page(id);
  const res = { ui: false, detail: "" };
  try {
    const picker = await openPicker(id);
    await SEL.pickerTab(picker, "mine").click();
    await SEL.uploadBtn(p).first().click();
    const form = SEL.myForm(p);
    await form.waitFor({ timeout: 15000 });
    await SEL.myName(form).fill(name);
    await stepShot(id, `pribadi-unggah-${name}-${id.toLowerCase()}.png`);
    await SEL.mySave(form).click();
    await waitFor(`:${name}: ada di Punya saya`, async () => (await catalog(id)).mine.some((s) => s.name === name), 15000);
    res.ui = true;
    res.detail = "lewat pemilih sticker > Punya saya > Unggah sticker";
  } catch (e) {
    res.detail = `UI: ${short(e)}`;
    await closePopup(id);
    const picked = await call(id, "chat_sticker_pick", {}, 10000);
    if (picked.ok && picked.value) {
      const r = await call(id, "chat_my_sticker_add", { path: picked.value.path, name, keywords: [] });
      res.detail += r.ok ? "; cadangan invoke berhasil" : `; cadangan invoke gagal: ${JSON.stringify(r.error)}`;
    } else {
      res.detail += `; chat_sticker_pick: ${JSON.stringify(picked.error ?? picked.value)}`;
    }
  }
  return res;
}

// Mengirim sticker dari pemilih di percakapan yang terbuka. Cadangan: chat_send_sticker.
async function sendStickerUi(id, tab, name, conv) {
  try {
    const picker = await openPicker(id);
    await SEL.pickerTab(picker, tab).click();
    await SEL.pickerItem(picker, name).click({ timeout: 10000 });
    await SEL.stickerLarge(SEL.log(page(id)), name).last().waitFor({ timeout: 15000 });
    await closePopup(id);
    return { ui: true, detail: "klik di pemilih sticker" };
  } catch (e) {
    await closePopup(id);
    const cat = await catalog(id);
    const s = (tab === "office" ? cat.office : cat.mine).find((x) => x.name === name);
    if (!s) return { ui: false, detail: `UI: ${short(e)}; :${name}: tidak ada di katalog` };
    const r = await call(id, "chat_send_sticker", { conv, source: { kind: tab, id: s.id }, replyTo: null });
    return { ui: false, detail: `UI: ${short(e)}; cadangan chat_send_sticker ${r.ok ? "berhasil" : JSON.stringify(r.error)}` };
  }
}

// ---------------------------------------------------------------------------
// Uji
// ---------------------------------------------------------------------------
console.log(`mira.exe: ${exe}`);
console.log(`Port QUIC ${NODES.A.port}-${NODES.C.port}, CDP ${NODES.A.cdp}-${NODES.C.cdp} (E2E_PORT_OFFSET=${PORT_OFFSET})`);
if (/[\\/]release[\\/]/i.test(exe)) {
  note("path mira.exe berada di folder release: MIRA_E2E_PICK hanya dibaca build debug, unggah sticker akan membuka dialog Windows");
}

try {
  // ---------- 0. Persiapan ----------
  for (const id of Object.keys(NODES)) await launch(id);
  for (const id of Object.keys(NODES)) await must(id, "save_display_name", { name: NODES[id].name });
  const pk = {};
  for (const id of Object.keys(NODES)) pk[id] = (await must(id, "get_app_state")).identity.publicKey;
  for (const id of Object.keys(NODES)) ownKeys.add(keyTarget(pk[id]));

  await must("A", "create_organization", { name: "Kantor Uji Sticker" });
  const team = await must("A", "create_team", { name: "Tim Desain" });
  await must("A", "add_team_member", { teamId: team.id, publicKey: pk.A });
  const invB = await must("A", "create_invite", { teamId: team.id, role: "member", validity: "24h", projectIds: [] });
  const invC = await must("A", "create_invite", { teamId: team.id, role: "member", validity: "24h", projectIds: [] });
  const joinB = await call("B", "join_with_code", { code: invB.code, address: addr("A") });
  const joinC = await call("C", "join_with_code", { code: invC.code, address: addr("A") });
  if (!joinB.ok || !joinC.ok) throw new Error(`Gabung gagal: B=${JSON.stringify(joinB)} C=${JSON.stringify(joinC)}`);
  await waitFor("A melihat B dan C di Tim Desain", async () => {
    const d = await must("A", "get_directory");
    const t = d.teams.find((x) => x.id === team.id);
    return [pk.B, pk.C].every((k) => t?.members.some((m) => m.publicKey === k));
  });
  for (const id of ["A", "B", "C"]) {
    const others = ["A", "B", "C"].filter((x) => x !== id).map((x) => NODES[x].name).sort();
    await waitFor(`${id} melihat dua rekan online`, async () => JSON.stringify(await onlineNames(id)) === JSON.stringify(others));
  }
  const umumConv = await waitFor("#umum ada di A, B, C", async () => {
    const all = [];
    for (const id of ["A", "B", "C"]) all.push((await must(id, "chat_overview")).conversations.find((c) => c.isUmum));
    return all.every(Boolean) ? all[0] : null;
  });
  check("0. Persiapan: A, B, C satu organisasi, saling online, #umum tersedia", Boolean(umumConv), `#${umumConv?.name}, ${secs(t0)}`);

  // Jalan uji dialog: chat_sticker_pick harus kembali cepat dengan file MIRA_E2E_PICK.
  writeFileSync(NODES.A.pick, FIXTURES.kopi.bytes());
  const probe = await call("A", "chat_sticker_pick", {}, 8000);
  const probeOk = probe.ok && probe.value?.mime === "image/png" && probe.value?.width === 128;
  check(
    "0. Jalan uji MIRA_E2E_PICK: chat_sticker_pick mengembalikan file uji tanpa dialog",
    probeOk,
    probe.timeout ? "tidak kembali dalam 8 dtk (dialog Windows terbuka? pakai build debug)" : JSON.stringify(probe.value ?? probe.error),
  );
  if (probe.timeout) {
    // Dialog Windows yang terbuka memblokir instance A: tidak ada gunanya melanjutkan.
    throw new Error("chat_sticker_pick membuka dialog: jalankan dengan build debug (npx tauri build --debug --no-bundle)");
  }

  for (const id of ["A", "B", "C"]) {
    await page(id).reload();
    await page(id).waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
    await SEL.nav(page(id), "chat").waitFor({ timeout: 20000 });
    await setLang(id, "id");
    await setTheme(id, "terang");
    await goChat(id);
    await openChannel(id, umumConv.name);
  }

  // ---------- 1. Reaksi ----------
  let rapatId = null;
  {
    await send("A", TEXT.rapat);
    rapatId = (await messagesOf("A", umumConv.id)).find((m) => m.text === TEXT.rapat)?.id;
    const seen = await settle("B dan C melihat pesan A", async () =>
      (await SEL.message(page("B"), TEXT.rapat).count()) > 0 && (await SEL.message(page("C"), TEXT.rapat).count()) > 0,
    );
    if (seen !== true) throw new Error(`pesan A tidak sampai: ${seen}`);

    const since = Date.now();
    const viaB = await reactQuick(SEL.message(page("B"), TEXT.rapat), EMOJI.thumbs);
    if (!viaB.ok) await call("B", "chat_react", { conv: umumConv.id, messageId: rapatId, emoji: EMOJI.thumbs, on: true });
    const onB = await waitChip("B", TEXT.rapat, EMOJI.thumbs, 1, 15000);
    check(
      "1. B memberi 👍 ke pesan A lewat tombol reaksi cepat, chip 👍 1 aktif di B",
      viaB.ok && typeof onB === "object" && onB.mine,
      `${viaB.how}; ${typeof onB === "object" ? onB.label : onB}`,
    );
    const onA = await waitChip("A", TEXT.rapat, EMOJI.thumbs, 1);
    const onC = await waitChip("C", TEXT.rapat, EMOJI.thumbs, 1);
    check("1. A melihat chip 👍 1 di pesannya", typeof onA === "object", typeof onA === "object" ? secs(since) : onA);
    check("1. C melihat chip 👍 1", typeof onC === "object", typeof onC === "object" ? secs(since) : onC);
    await stepShot("A", "reaksi-1-a.png");

    const viaC = await reactQuick(SEL.message(page("C"), TEXT.rapat), EMOJI.thumbs);
    if (!viaC.ok) await call("C", "chat_react", { conv: umumConv.id, messageId: rapatId, emoji: EMOJI.thumbs, on: true });
    const two = await waitChip("A", TEXT.rapat, EMOJI.thumbs, 2);
    check("1. C juga memberi 👍, A melihat chip 👍 2", viaC.ok && typeof two === "object", `${viaC.how}; ${typeof two === "object" ? two.label : two}`);
    await stepShot("A", "reaksi-2-a.png");

    // B menghapus reaksinya dengan mengklik chip miliknya.
    let removed = "chip tidak ada";
    const chipB = SEL.chip(SEL.message(page("B"), TEXT.rapat), EMOJI.thumbs);
    if (await chipB.count()) {
      await chipB.first().click();
      removed = "klik chip";
    } else {
      await call("B", "chat_react", { conv: umumConv.id, messageId: rapatId, emoji: EMOJI.thumbs, on: false });
    }
    const backA = await waitChip("A", TEXT.rapat, EMOJI.thumbs, 1);
    const backC = await waitChip("C", TEXT.rapat, EMOJI.thumbs, 1);
    const bAfter = await chipState(SEL.message(page("B"), TEXT.rapat), EMOJI.thumbs);
    check(
      "1. B menghapus 👍 dengan klik chip: A dan C melihat 👍 1, chip di B tidak aktif lagi",
      removed === "klik chip" && typeof backA === "object" && typeof backC === "object" && !bAfter.mine && bAfter.count === 1,
      `${removed}; A=${typeof backA === "object" ? backA.count : backA}; C=${typeof backC === "object" ? `${backC.count}, milik C=${backC.mine}` : backC}`,
    );
    const api = {};
    for (const id of ["A", "B", "C"]) api[id] = await apiReaction(id, umumConv.id, rapatId, EMOJI.thumbs);
    check(
      "1. chat_messages: reactions 👍 count 1 oleh Citra di A, B, C; mine hanya di C",
      ["A", "B", "C"].every((id) => api[id].count === 1 && api[id].people.join() === NODES.C.name) &&
        api.C.mine && !api.A.mine && !api.B.mine,
      JSON.stringify(api),
    );
  }

  // ---------- 2. Label di baris penulis dan kepala pesan pribadi ----------
  {
    for (const name of LABELS) {
      const labelId = await must("A", "org_create_label", { name });
      await must("A", "org_set_label_assigned", { labelId, publicKey: pk.B, assigned: true });
    }
    const synced = await settle("A, B, C melihat lima label Budi", async () => {
      for (const id of ["A", "B", "C"]) {
        const b = (await must(id, "org_people")).find((p) => p.publicKey === pk.B);
        if ((b?.labels ?? []).length !== LABELS.length) return false;
      }
      return true;
    });
    check("2. A membuat lima label dan memasangnya ke B; tersinkron ke B dan C", synced === true, synced === true ? "" : synced);

    await send("B", TEXT.label);
    const labelMsgId = (await messagesOf("B", umumConv.id)).find((m) => m.text === TEXT.label)?.id;
    for (const id of ["A", "C"]) {
      const st = await settle(`${id} melihat lima label di pesan B`, async () => {
        const msg = SEL.message(page(id), TEXT.label);
        if (!(await msg.count())) return null;
        const s = await labelState(SEL.msgHead(msg));
        return allLabels(s) ? s : null;
      });
      check(
        `2. Pesan B di #umum menampilkan kelima label di baris penulis (laptop ${id})`,
        typeof st === "object",
        typeof st === "object" ? st.names.join(", ") : st,
      );
    }
    const own = await settle("B melihat label di pesannya sendiri", async () => {
      const head = SEL.msgHead(SEL.message(page("B"), TEXT.label));
      const s = await labelState(head);
      const text = await head.innerText();
      // Pesan sendiri tertulis "Anda" ("You"), tetap dengan label profil.
      return allLabels(s) && /(^|\W)(Anda|You)(\W|$)/.test(text) ? { ...s, text } : null;
    }, 60000);
    check(
      "2. Pesan B di laptop B sendiri: penulis Anda dan kelima label",
      typeof own === "object",
      typeof own === "object" ? own.text.replace(/\s+/g, " ").slice(0, 120) : own,
    );
    await stepShot("A", "label-pesan-a.png");

    await openDm("A", NODES.B.name);
    const head = await settle("kepala pesan pribadi A ke B menampilkan lima label", async () => {
      const s = await labelState(SEL.convHead(page("A")));
      return allLabels(s) ? s : null;
    }, 30000);
    check(
      "2. Kepala pesan pribadi A ke B menampilkan kelima label",
      typeof head === "object",
      typeof head === "object" ? head.names.join(", ") : head,
    );
    await stepShot("A", "label-kepala-dm-a.png");

    // Reaksi ke pesan orang lain lewat menu pesan "Beri reaksi".
    await goChat("A");
    await openChannel("A", umumConv.name);
    let via = "";
    try {
      await messageMenu("A", SEL.message(page("A"), TEXT.label), UI.menuReact);
      const picker = SEL.reactionPicker(page("A"));
      await picker.waitFor({ timeout: 8000 });
      await SEL.emojiSearch(picker).fill("terima kasih");
      await sleep(300);
      await SEL.emojiSearch(picker).press("Enter");
      via = "menu Beri reaksi, cari, Enter";
    } catch (e) {
      via = `UI: ${short(e)}; cadangan chat_react`;
      await closePopup("A");
      await call("A", "chat_react", { conv: umumConv.id, messageId: labelMsgId, emoji: EMOJI.pray, on: true });
    }
    const apiPray = await settle("A memberi 🙏", async () => {
      const r = await apiReaction("A", umumConv.id, labelMsgId, EMOJI.pray);
      return r.count === 1 && r.mine ? r : null;
    }, 15000);
    const onBPray = await waitChip("B", TEXT.label, EMOJI.pray, 1);
    check(
      "2. A memberi 🙏 ke pesan B lewat menu Beri reaksi, B melihat chip 🙏 1",
      !via.startsWith("UI:") && typeof apiPray === "object" && typeof onBPray === "object",
      `${via}; A=${JSON.stringify(apiPray)}; B=${typeof onBPray === "object" ? onBPray.label : onBPray}`,
    );
  }

  // ---------- 3. Sticker kantor ----------
  let kopiMsgId = null;
  {
    const since = Date.now();
    const add = await addOfficeSticker("A", "kopi", ["kopi", "pagi"]);
    const onA = (await catalog("A")).office.find((s) => s.name === "kopi");
    check(
      "3. A (superadmin) menambah sticker :kopi: paket Kantor lewat Organisasi, tab Sticker",
      add.ui && onA?.state === "active" && onA?.pack === PACK && onA?.mime === "image/png",
      `${add.detail}; katalog A: ${JSON.stringify(onA ? { pack: onA.pack, state: onA.state, mime: onA.mime, ready: onA.ready } : null)}`,
    );
    await stepShot("A", "org-sticker-kopi-a.png");

    for (const id of ["B", "C"]) {
      await goChat(id);
      await openChannel(id, umumConv.name);
      const seen = await waitPickerItem(id, "office", "kopi");
      check(`3. ${id} melihat :kopi: di pemilih sticker, tab Kantor`, seen === true, seen === true ? secs(since) : seen);
      if (id === "B") await stepShot("B", "pemilih-sticker-kopi-b.png");
      await closePopup(id);
    }

    const sent = await sendStickerUi("B", "office", "kopi", umumConv.id);
    kopiMsgId = (await messagesOf("B", umumConv.id)).find((m) => m.sticker?.name === "kopi")?.id;
    check("3. B mengirim :kopi: di #umum dari pemilih sticker", sent.ui && Boolean(kopiMsgId), sent.detail);
    const sentAt = Date.now();
    for (const id of ["A", "C"]) {
      await goChat(id);
      await openChannel(id, umumConv.name);
      const s = await waitStickerMessage(id, "kopi");
      check(
        `3. ${id} melihat pesan sticker :kopi: sebagai gambar besar (img alt ":kopi:", bukan kartu file)`,
        typeof s === "object",
        typeof s === "object" ? `${describeSticker(s)}, ${secs(sentAt)}` : s,
      );
    }
    const apiC = (await messagesOf("C", umumConv.id)).find((m) => m.id === kopiMsgId);
    check(
      "3. chat_messages di C: pesan berbentuk sticker (sticker.name kopi, ready, teks :kopi:)",
      apiC?.sticker?.name === "kopi" && apiC?.sticker?.ready === true && apiC?.text === ":kopi:",
      JSON.stringify(apiC?.sticker ?? null),
    );
    await stepShot("C", "sticker-kopi-c.png");
  }

  // ---------- 4. Emote di teks ----------
  {
    const pc = page("C");
    const input = SEL.composer(pc);
    await input.click();
    await input.fill("");
    await input.pressSequentially(TEXT.emoteTyped, { delay: 60 });
    const option = SEL.suggestOption(pc, "kopi");
    const shown = await option.waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
    const options = shown
      ? await SEL.suggestList(pc).getByRole("option").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.textContent?.trim()))
      : [];
    check("4. Saran :kop memunculkan :kopi: (emote kantor) di daftar saran", shown, options.slice(0, 6).join(" | ") || "daftar saran tidak muncul");
    await stepShot("C", "saran-kop-c.png");
    if (shown) {
      await option.click();
      const after = await input.inputValue();
      await input.pressSequentially(after.endsWith(" ") ? "semua" : " semua", { delay: 30 });
    } else {
      await input.fill(TEXT.emoteFinal);
    }
    const value = await input.inputValue();
    check("4. Memilih saran mengisi kolom pesan menjadi \"Pagi :kopi: semua\"", value.trim() === TEXT.emoteFinal, JSON.stringify(value));
    await input.press("Enter");
    const sentAt = Date.now();
    const inline = await settle("A melihat emote sebaris", async () => {
      const msg = SEL.log(page("A")).getByRole("listitem").filter({ hasText: "semua" }).filter({ hasText: "Pagi" }).last();
      const img = SEL.stickerInline(msg, "kopi");
      if (!(await img.count())) return null;
      const info = await img.first().evaluate((el) => ({
        loaded: el.complete && el.naturalWidth > 0,
        h: Math.round(el.getBoundingClientRect().height),
      }));
      info.text = (await msg.innerText()).includes(":kopi:");
      return info.loaded ? info : null;
    });
    check(
      "4. A melihat :kopi: sebagai gambar sebaris di teks pesan C (img alt \":kopi:\")",
      typeof inline === "object" && inline.h <= 40 && !inline.text,
      typeof inline === "object" ? `tinggi ${inline.h} px, teks ":kopi:" tampil=${inline.text}, ${secs(sentAt)}` : inline,
    );
    await stepShot("A", "emote-sebaris-a.png");
  }

  // ---------- 5. Simpan sticker dan sticker pribadi ----------
  {
    let via = "";
    try {
      await messageMenu("C", SEL.log(page("C")).getByRole("listitem").filter({ has: page("C").locator(`img.sticker-img-large[alt=":kopi:"]`) }).first(), UI.menuSaveSticker);
      via = "klik kanan, Simpan sticker";
    } catch (e) {
      via = `UI: ${short(e)}; cadangan chat_my_sticker_save`;
      await closePopup("C");
      await call("C", "chat_my_sticker_save", { messageId: kopiMsgId });
    }
    const saved = await settle("kopi ada di sticker pribadi C", async () => (await catalog("C")).mine.find((s) => s.name === "kopi"), 15000);
    const inMine = await waitPickerItem("C", "mine", "kopi", 20000);
    check(
      "5. C menyimpan sticker dari pesan lewat menu Simpan sticker, :kopi: ada di tab Punya saya",
      !via.startsWith("UI:") && typeof saved === "object" && inMine === true,
      `${via}; pemilih: ${inMine === true ? "ada" : inMine}`,
    );
    await stepShot("C", "punya-saya-kopi-c.png");
    await closePopup("C");

    const up = await addMySticker("C", "halo");
    const halo = (await catalog("C")).mine.find((s) => s.name === "halo");
    check(
      "5. C mengunggah sticker pribadi :halo: (GIF animasi) lewat Unggah sticker",
      up.ui && halo?.mime === "image/gif",
      `${up.detail}; ${JSON.stringify(halo ? { mime: halo.mime, size: halo.size } : null)}`,
    );
    await closePopup("C");

    await openDm("C", NODES.B.name);
    const dmConv = (await must("C", "chat_overview")).conversations.find((c) => c.kind === "dm" && c.peer?.publicKey === pk.B)?.id;
    const sent = await sendStickerUi("C", "mine", "halo", dmConv);
    check("5. C mengirim :halo: ke B lewat pesan pribadi", sent.ui, sent.detail);
    const sentAt = Date.now();
    await goChat("B");
    await SEL.dmRow(page("B"), NODES.C.name).click({ timeout: SYNC_MS });
    const onB = await waitStickerMessage("B", "halo");
    check(
      "5. B melihat sticker :halo: di pesan pribadi dari C",
      typeof onB === "object",
      typeof onB === "object" ? `${describeSticker(onB)}, ${secs(sentAt)}` : onB,
    );
    await stepShot("B", "dm-halo-b.png");
  }

  // ---------- 6. Offline lalu menyusul ----------
  let siapMsgId = null;
  {
    await stop("C");
    const offAt = Date.now();
    const cOff = await settle("A melihat C offline", async () => !(await onlineNames("A")).includes(NODES.C.name), 120000);
    note(`C dimatikan; A melihat C offline ${cOff === true ? `setelah ${secs(offAt)}` : "tidak terjadi"}`);

    await goChat("A");
    await openChannel("A", umumConv.name);
    const labelMsgId = (await messagesOf("A", umumConv.id)).find((m) => m.text === TEXT.label)?.id;
    const viaA = await reactQuick(SEL.message(page("A"), TEXT.label), EMOJI.heart);
    if (!viaA.ok) await call("A", "chat_react", { conv: umumConv.id, messageId: labelMsgId, emoji: EMOJI.heart, on: true });
    const heart = await waitChip("A", TEXT.label, EMOJI.heart, 1, 15000);
    check("6. C mati: A memberi ❤️ ke pesan B lewat reaksi cepat", viaA.ok && typeof heart === "object", `${viaA.how}; ${typeof heart === "object" ? heart.label : heart}`);

    const add = await addOfficeSticker("A", "siap", ["siap", "oke"]);
    const onA = (await catalog("A")).office.find((s) => s.name === "siap");
    check("6. C mati: A menambah sticker kantor :siap: (GIF animasi)", add.ui && onA?.mime === "image/gif", add.detail);

    const bHas = await settle("B menerima :siap: di katalog", async () => (await catalog("B")).office.find((s) => s.name === "siap" && s.ready));
    await goChat("B");
    await openChannel("B", umumConv.name);
    const sent = await sendStickerUi("B", "office", "siap", umumConv.id);
    siapMsgId = (await messagesOf("B", umumConv.id)).find((m) => m.sticker?.name === "siap")?.id;
    check("6. C mati: B mengirim sticker :siap: di #umum", typeof bHas === "object" && sent.ui && Boolean(siapMsgId), sent.detail);

    const onAt = Date.now();
    checkOwnKeys("sebelum C menyala lagi");
    await launch("C");
    await SEL.nav(page("C"), "chat").waitFor({ timeout: 20000 });
    await goChat("C");
    await openChannel("C", umumConv.name);
    const cHeart = await waitChip("C", TEXT.label, EMOJI.heart, 1);
    check("6. C menyala lagi dan menyusul reaksi ❤️ di pesan B", typeof cHeart === "object", typeof cHeart === "object" ? secs(onAt) : cHeart);
    const cCat = await settle("C menyusul :siap: di katalog", async () => (await catalog("C")).office.find((s) => s.name === "siap"));
    check(
      "6. C menyusul sticker kantor :siap: di katalog",
      typeof cCat === "object",
      typeof cCat === "object" ? `ready=${cCat.ready}, ${secs(onAt)}` : cCat,
    );
    const cMsg = await waitStickerMessage("C", "siap");
    check("6. C menyusul pesan sticker :siap: dari B", typeof cMsg === "object", typeof cMsg === "object" ? `${describeSticker(cMsg)}, ${secs(onAt)}` : cMsg);
    const cApi = await apiReaction("C", umumConv.id, labelMsgId, EMOJI.heart);
    check("6. chat_messages di C: ❤️ 1 dari Ayu di pesan B", cApi.count === 1 && cApi.people.join() === NODES.A.name, JSON.stringify(cApi));
    await stepShot("C", "menyusul-c.png");
  }

  // ---------- 7. Admin menyembunyikan pesan sticker ----------
  {
    await goChat("A");
    await openChannel("A", umumConv.name);
    const canDelete = (await messagesOf("A", umumConv.id)).find((m) => m.id === siapMsgId)?.canDelete;
    let via = "";
    try {
      const msg = SEL.log(page("A")).getByRole("listitem").filter({ has: page("A").locator(`img.sticker-img-large[alt=":siap:"]`) }).last();
      await messageMenu("A", msg, UI.menuDelete);
      const dlg = SEL.confirmDialog(page("A"));
      await dlg.waitFor({ timeout: 8000 });
      await stepShot("A", "hapus-sticker-konfirmasi-a.png");
      await dlg.getByRole("button", { name: anyOf(UI.deleteConfirm) }).click();
      await dlg.waitFor({ state: "hidden", timeout: 10000 });
      via = "klik kanan, Hapus pesan, konfirmasi";
    } catch (e) {
      via = `UI: ${short(e)}; cadangan chat_delete_message`;
      await closePopup("A");
      await call("A", "chat_delete_message", { conv: umumConv.id, messageId: siapMsgId });
    }
    check("7. A (superadmin) menghapus pesan sticker B lewat menu Hapus pesan dan konfirmasi", canDelete === true && !via.startsWith("UI:"), `canDelete=${canDelete}; ${via}`);
    const since = Date.now();
    for (const id of ["B", "C"]) {
      await goChat(id);
      await openChannel(id, umumConv.name);
      const gone = await settle(`${id} melihat Pesan dihapus`, async () => {
        const marker = await SEL.log(page(id)).getByText(anyOf(UI.deleted)).count();
        const img = await SEL.stickerLarge(SEL.log(page(id)), "siap").count();
        const api = (await messagesOf(id, umumConv.id)).find((m) => m.id === siapMsgId);
        return marker > 0 && img === 0 && api?.deleted && !api?.sticker ? true : null;
      });
      check(`7. ${id} melihat pesan sticker :siap: menjadi "Pesan dihapus"`, gone === true, gone === true ? secs(since) : gone);
    }
    await stepShot("B", "sticker-dihapus-b.png");
  }

  // ---------- 8. Pemilih emoji dengan keyboard ----------
  {
    const pa = page("A");
    const input = SEL.composer(pa);
    await input.click();
    await input.fill("");
    // Tab maju dari kolom pesan sampai fokus di tombol Emoji (paling banyak 8 kali), lalu mundur.
    const focusedEmoji = () => pa.evaluate((names) => names.includes(document.activeElement?.getAttribute("aria-label") ?? ""), UI.emojiBtn);
    let reached = false;
    for (const key of ["Tab", "Shift+Tab"]) {
      await input.focus();
      for (let i = 0; i < 8 && !reached; i++) {
        await pa.keyboard.press(key);
        reached = await focusedEmoji();
      }
      if (reached) break;
    }
    if (!reached) await SEL.emojiBtn(pa).focus();
    await pa.keyboard.press("Enter");
    const dlg = SEL.emojiDialog(pa);
    const opened = await dlg.waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
    const searchFocused = opened && (await pa.evaluate((names) => names.includes(document.activeElement?.getAttribute("aria-label") ?? ""), UI.emojiSearch));
    check(
      "8. Tombol Emoji dicapai dengan Tab dan dibuka dengan Enter, fokus di kolom cari",
      reached && opened && searchFocused,
      `Tab mencapai tombol=${reached}, terbuka=${opened}, fokus di cari=${searchFocused}`,
    );
    if (opened) {
      await pa.keyboard.type("jempol", { delay: 40 });
      await sleep(300);
      await stepShot("A", "emoji-cari-jempol-a.png");
      await pa.keyboard.press("Enter");
    }
    const value = await input.inputValue();
    // Pemilih di kolom pesan sengaja tetap terbuka setelah memilih (closeOnPick false di Composer).
    const stillOpen = await dlg.isVisible().catch(() => false);
    check(
      "8. Ketik jempol lalu Enter: 👍 masuk ke kolom pesan",
      value.includes(EMOJI.thumbs),
      `kolom=${JSON.stringify(value)}, pemilih masih terbuka=${stillOpen}`,
    );
    if (stillOpen) {
      await pa.keyboard.press("Escape");
      await sleep(200);
      const closed = !(await dlg.isVisible().catch(() => false));
      const back = await pa.evaluate(() => document.activeElement?.getAttribute("role") === "combobox");
      check("8. Esc menutup pemilih emoji, fokus kembali ke kolom pesan", closed && back, `tertutup=${closed}, fokus di kolom pesan=${back}`);
    }
    await input.fill("");
  }

  // ---------- 9. Screenshot terang dan gelap, Indonesia dan Inggris ----------
  {
    const pa = page("A");
    for (const lang of ["id", "en"]) {
      for (const theme of ["terang", "gelap"]) {
        const tag = `${theme}-${lang}`;
        const taken = [];
        const failed = [];
        const take = async (file, fn) => {
          try {
            await fn();
            await sleep(500);
            await pa.screenshot({ path: join(shots, `${file}-${tag}.png`) });
            taken.push(file);
          } catch (e) {
            failed.push(`${file}: ${short(e)}`);
          } finally {
            await closePopup("A");
          }
        };
        await setLang("A", lang);
        await setTheme("A", theme);
        await goChat("A");
        await openChannel("A", umumConv.name);
        await take("01-reaksi", async () => {
          await SEL.message(pa, TEXT.rapat).scrollIntoViewIfNeeded();
        });
        await take("02-label-semua", async () => {
          await SEL.message(pa, TEXT.label).scrollIntoViewIfNeeded();
          await SEL.labels(SEL.msgHead(SEL.message(pa, TEXT.label))).first().waitFor({ timeout: 5000 });
        });
        await take("03-pemilih-emoji", async () => {
          await SEL.emojiBtn(pa).click();
          await SEL.emojiDialog(pa).waitFor({ timeout: 5000 });
        });
        await take("04-pemilih-sticker", async () => {
          const picker = await openPicker("A");
          await SEL.pickerTab(picker, "office").click();
          await SEL.pickerItem(picker, "kopi").waitFor({ timeout: 5000 });
        });
        await take("05-panel-sticker-kantor", async () => {
          await SEL.nav(pa, "org").click();
          await SEL.orgTab(pa).click();
          await SEL.orgStickerList(pa).first().waitFor({ timeout: 10000 });
        });
        check(`9. Screenshot ${tag}`, failed.length === 0, failed.length ? failed.join(" | ") : taken.join(", "));
      }
    }
    await setLang("A", "id");
    await setTheme("A", "terang");
  }
} catch (err) {
  check("Skrip berjalan tanpa error", false, String(err?.message ?? err).slice(0, 400));
  for (const id of Object.keys(running)) {
    await page(id).screenshot({ path: join(failShots, `gagal-${id.toLowerCase()}.png`) }).catch(() => {});
  }
  note(`screenshot saat gagal: ${failShots}`);
}

const failedSoFar = results.some((r) => !r.ok);
for (const id of Object.keys(running)) {
  if (failedSoFar && running[id].consoleLines.length) {
    console.log(`Konsol ${id} (error/peringatan, terakhir):\n${running[id].consoleLines.slice(-15).join("\n")}`);
  }
  await stop(id);
}
if (failedSoFar) {
  for (const id of Object.keys(NODES)) {
    try {
      const log = readFileSync(join(root, `${id}-stderr.log`), "utf8").trim();
      if (log) console.log(`stderr ${id} (akhir):\n${log.slice(-1500)}`);
    } catch {
      /* tidak ada log */
    }
  }
}
// Hanya kunci milik skrip ini. Kunci baru lain di Credential Manager bisa milik e2e sesi
// lain yang sedang berjalan (docs/progress/v04-onboarding-e2e-bentrok.md).
const present = miraCredentials();
const strangers = [...present].filter((t) => !credentialsBefore.has(t) && !ownKeys.has(t)).length;
if (strangers) note(`${strangers} kunci Mira baru lain di Credential Manager dibiarkan (bukan milik skrip ini)`);
for (const target of ownKeys) {
  if (present.has(target)) {
    try {
      execFileSync("cmdkey", [`/delete:${target}`], { stdio: "ignore" });
    } catch {
      console.log(`Kunci uji tidak bisa dihapus: ${target}`);
    }
  }
}
rmSync(root, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} pemeriksaan lulus.`);
process.exit(failed ? 1 : 0);
