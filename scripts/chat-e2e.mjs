// Uji ujung ke ujung Chat Tahap 2 (bagian lokal) di satu laptop.
//
// Menjalankan mira.exe dengan folder data baru, port jaringan sendiri, dan mDNS
// mati (tidak bicara dengan instance lain), lalu lewat DevTools Protocol:
// onboarding, buka Chat, kirim pesan (Enter dan Shift+Enter), balas, cek bahwa
// lampiran yang tidak dipilih lewat dialog ditolak, buat channel, hapus pesan,
// arsipkan dan kembalikan channel, atur notifikasi, ambil screenshot terang dan
// gelap, restart, dan pastikan semuanya tetap tersimpan.
//
// v0.4: buat grup yang hanya berisi pembuatnya, lipat bagian Grup (dicek dengan CSS
// sungguhan, bukan hanya atribut), dan pastikan lipatan bertahan setelah restart.
//
// Pakai:  node scripts/chat-e2e.mjs <path mira.exe> <folder screenshot> [folder induk data]
// Folder data dibuat di bawah folder induk (bawaan: folder temp) dan dihapus di akhir.
// Build dulu: npx tauri build --debug --no-bundle

import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { newOffice } from "./e2e-onboarding.mjs";

const exe = resolve(process.argv[2] ?? "src-tauri/target/debug/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots");
const parent = resolve(process.argv[4] ?? tmpdir());
mkdirSync(shots, { recursive: true });
mkdirSync(parent, { recursive: true });
const dataDir = mkdtempSync(join(parent, "mira-chat-"));
const CDP_PORT = 9342;
const MIRA_PORT = 47870;

// Selektor. Semua nama aksesibel ada di sini supaya mudah disesuaikan kalau
// label di UI berubah sedikit.
const sel = {
  nav: (page, name) => page.getByRole("button", { name: new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*(,|$)") }),
  themeRadio: (page, label) => page.getByLabel(label, { exact: true }),
  list: (page) => page.getByRole("navigation", { name: /Daftar percakapan/i }),
  // v0.3: channel buatan superadmin ada di bagian Umum (lima bagian, docs/plans/v03-c.md).
  channelSection: (page) => sel.list(page).getByRole("region", { name: /^(Channel|Umum)$/ }),
  // "Channel umum" atau "Channel umum, diarsipkan, ...". Diakhiri koma atau akhir teks supaya
  // tombol "Channel umum baru" tidak ikut cocok.
  row: (page, name) => sel.list(page).getByRole("button", { name: new RegExp(`^Channel ${name}(,|$)`) }),
  newChannelBtn: (page) => sel.list(page).getByRole("button", { name: /^Channel (umum )?baru$/i }),
  notifyBtn: (page) => page.getByRole("button", { name: /notifikasi chat/i }),
  conv: (page, title) => page.getByRole("region", { name: title, exact: true }),
  log: (page) => page.getByRole("region", { name: /^Pesan di/ }),
  emptyConv: (page) => sel.log(page).getByText(/^Belum ada pesan/),
  composer: (page) => page.getByRole("combobox", { name: /^Pesan untuk/ }),
  blockedNote: (page) => page.getByText(/Channel ini diarsipkan/i),
  message: (page, text) => sel.log(page).getByRole("listitem").filter({ hasText: text }).first(),
  replyBtn: (msg) => msg.getByRole("button", { name: /^Balas pesan/ }),
  deleteBtn: (msg) => msg.getByRole("button", { name: /^Hapus pesan/ }),
  statusBtn: (msg) => msg.getByRole("button", { name: /^Status:/ }),
  replyQuote: (msg) => msg.getByRole("button", { name: /^Balasan untuk/ }).or(msg.locator(".conv-quote")),
  replyChip: (page) => page.getByText(/^Membalas /),
  headerMenu: (page, title) => page.getByRole("button", { name: `Menu ${title}`, exact: true }),
  menuItem: (page, name) => page.getByRole("menuitem", { name }),
  dialog: (page, name) => page.getByRole("dialog", { name }),
  channelName: (dlg) => dlg.getByLabel(/Nama channel/i),
  channelScope: (dlg) => dlg.getByLabel(/Untuk siapa/i),
  createChannel: (dlg) => dlg.getByRole("button", { name: /^Buat channel/ }),
  confirmDelete: (dlg) => dlg.getByRole("button", { name: /^Hapus pesan$/ }),
  notifyMentions: (dlg) => dlg.getByRole("radio", { name: /menyebut saya/i }),
  close: (dlg) => dlg.getByRole("button", { name: /^Tutup$/ }),
  groupRow: (page, name) => sel.list(page).getByRole("button", { name: new RegExp(`^Grup ${name}(,|$)`) }),
  // Juga baris di bagian terlipat (tersembunyi), untuk memastikan barisnya ada tapi tidak terlihat.
  groupRowAny: (page, name) =>
    sel.list(page).getByRole("button", { name: new RegExp(`^Grup ${name}(,|$)`), includeHidden: true }),
  section: (page, title) => sel.list(page).getByRole("region", { name: title, exact: true }),
  foldBtn: (page, title) => sel.section(page, title).locator("button.chat-fold"),
  sectionBody: (page, title) => sel.section(page, title).locator(".chat-sec-body"),
};

// Keadaan lipat sebuah bagian menurut tampilan sungguhan: tombol, atribut, dan CSS.
async function foldState(page, title) {
  const expanded = await sel.foldBtn(page, title).getAttribute("aria-expanded");
  const display = await sel.sectionBody(page, title).evaluate((el) => getComputedStyle(el).display);
  return { expanded, display };
}

const TEXT = {
  first: "Selamat pagi tim, ini pesan uji pertama.",
  line1: "Baris pertama pesan uji.",
  line2: "Baris kedua pesan uji.",
  reply: "Ini balasan untuk pesan pertama.",
  channelMsg: "Halo proyek A, channel ini untuk koordinasi.",
  toDelete: "Pesan ini akan dihapus.",
  soloGroup: "Catatan Rina",
  soloMsg: "Catatan pribadi di grup yang hanya berisi saya.",
};

function miraCredentials() {
  try {
    const out = execFileSync("cmdkey", ["/list"], { encoding: "utf8" });
    return new Set(out.match(/device-key-[0-9a-f]{64}\.id\.mira\.desktop/g) ?? []);
  } catch {
    return new Set();
  }
}
const credentialsBefore = miraCredentials();
// Kunci laptop uji milik skrip ini. Di akhir hanya kunci ini yang dihapus, supaya kunci uji skrip
// lain yang berjalan bersamaan (sesi lain di PC yang sama) tidak ikut hilang.
let ownKey = null;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "LULUS" : "GAGAL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function launch() {
  const log = createWriteStream(join(dataDir, "stderr.log"), { flags: "a" });
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: dataDir,
      MIRA_PORT: String(MIRA_PORT),
      MIRA_DISABLE_MDNS: "1",
      MIRA_UPDATER_ENDPOINT: "http://127.0.0.1:9/latest.json",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.pipe(log);
  let browser;
  for (let i = 0; i < 80 && !browser; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    } catch {
      /* belum siap */
    }
  }
  if (!browser) throw new Error("WebView2 tidak bisa dihubungi lewat CDP");
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages())[0];
    if (!page) await new Promise((r) => setTimeout(r, 250));
  }
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  return { child, browser, page };
}

async function stop({ child, browser }) {
  await browser.close().catch(() => {});
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* sudah berhenti */
  }
  await new Promise((r) => setTimeout(r, 1500));
}

const shot = (page, name) => page.screenshot({ path: join(shots, name) });

// Memanggil perintah Rust langsung. Error dikembalikan sebagai data, bukan dilempar.
function invoke(page, cmd, args = {}) {
  return page.evaluate(
    async ({ cmd, args }) => {
      try {
        return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(cmd, args) };
      } catch (err) {
        return { ok: false, error: err };
      }
    },
    { cmd, args },
  );
}

async function setTheme(page, label) {
  await sel.nav(page, "Pengaturan").click();
  await sel.themeRadio(page, label).check();
  await page.waitForTimeout(300);
  await sel.nav(page, "Chat").click();
  await sel.list(page).waitFor({ timeout: 10000 });
}

async function openConv(page, name) {
  await sel.row(page, name).click();
  await sel.conv(page, `#${name}`).waitFor({ timeout: 10000 });
}

async function sendWithEnter(page, text) {
  const input = sel.composer(page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
  await sel.message(page, text).waitFor({ timeout: 10000 });
}

// Tombol aksi pesan baru terlihat saat hover atau fokus: pakai keyboard.
async function pressAction(button) {
  await button.focus();
  await button.press("Enter");
}

async function messagesIn(page, convId) {
  const res = await invoke(page, "chat_messages", { conv: convId, before: null, limit: 100 });
  return res.ok ? res.value.messages : [];
}

async function overview(page) {
  const res = await invoke(page, "chat_overview");
  if (!res.ok) throw new Error(`chat_overview gagal: ${JSON.stringify(res.error)}`);
  return res.value;
}

let app = null;
try {
  app = await launch();
  let { page } = app;

  // 1. Onboarding, tema Terang, buka Chat.
  await newOffice(page, { name: "Rina Uji", org: "Kantor Uji", dept: "Desain" });
  await sel.nav(page, "Chat").waitFor({ timeout: 10000 });
  await setTheme(page, "Terang");

  // 2. #umum terpilih dan kosong.
  await sel.conv(page, "#umum").waitFor({ timeout: 10000 });
  const umumCurrent = await sel.row(page, "umum").getAttribute("aria-current");
  await sel.emptyConv(page).waitFor({ timeout: 10000 });
  check("#umum terpilih otomatis dan menampilkan keadaan kosong", umumCurrent === "true", `aria-current=${umumCurrent}`);
  await shot(page, "t2-01-chat-kosong-terang.png");
  const firstOverview = await overview(page);
  ownKey = `device-key-${firstOverview.me}.id.mira.desktop`;
  const umumId = firstOverview.conversations.find((c) => c.isUmum)?.id;
  check("Ringkasan chat berisi #umum", !!umumId, umumId ?? "tidak ada");

  // 3. Kirim dengan Enter, status Menunggu, pesan banyak baris dengan Shift+Enter.
  await sendWithEnter(page, TEXT.first);
  check("Pesan terkirim dengan Enter dan tampil di percakapan", true);
  const firstMsg = sel.message(page, TEXT.first);
  const sent = (await messagesIn(page, umumId)).find((m) => m.text === TEXT.first);
  const statusUi = await sel.statusBtn(firstMsg).count();
  const statusText = statusUi ? await sel.statusBtn(firstMsg).getAttribute("aria-label") : "";
  // Organisasi baru hanya berisi satu orang: tidak ada penerima (total 0), jadi
  // status tidak ditampilkan. Kalau ada penerima yang offline, statusnya Menunggu.
  check(
    "Status pesan sesuai penerima: tanpa penerima tidak ditampilkan, dengan penerima offline Menunggu",
    sent?.status?.total === 0 ? statusUi === 0 : sent?.status?.state === "pending" && /Menunggu/.test(statusText),
    statusUi ? statusText : `state=${sent?.status?.state}, total=${sent?.status?.total}, baris status tidak tampil`,
  );

  const input = sel.composer(page);
  await input.click();
  await input.fill(TEXT.line1);
  await input.press("Shift+Enter");
  await input.pressSequentially(TEXT.line2);
  const draft = await input.inputValue();
  await input.press("Enter");
  await sel.message(page, TEXT.line2).waitFor({ timeout: 10000 });
  const multi = (await messagesIn(page, umumId)).find((m) => m.text.includes(TEXT.line2));
  check(
    "Shift+Enter membuat baris baru, pesan dua baris terkirim utuh",
    draft.includes("\n") && multi?.text === `${TEXT.line1}\n${TEXT.line2}`,
    JSON.stringify(multi?.text ?? null),
  );

  // 4. Balas pesan pertama.
  await pressAction(sel.replyBtn(firstMsg));
  const chip = await sel.replyChip(page).isVisible();
  await sendWithEnter(page, TEXT.reply);
  const replyMsg = sel.message(page, TEXT.reply);
  const quote = await sel.replyQuote(replyMsg).first().innerText().catch(() => "");
  check(
    "Balasan menampilkan kutipan pesan pertama",
    chip && quote.includes(TEXT.first.slice(0, 20)),
    `chip=${chip}, kutipan="${quote.replace(/\s+/g, " ").slice(0, 60)}"`,
  );
  await shot(page, "t2-02-percakapan-terang.png");

  // 5. Lampiran: dialog Windows tidak bisa diotomasi. Cek keamanan: path yang
  // tidak dipilih lewat dialog Lampirkan ditolak inti Rust.
  const testFile = join(dataDir, "lampiran-uji.txt");
  writeFileSync(testFile, "File uji lampiran chat Mira.\n");
  const countBefore = (await messagesIn(page, umumId)).length;
  const refused = await invoke(page, "chat_send", {
    conv: umumId,
    text: "Pesan dengan lampiran tidak sah",
    replyTo: null,
    mentions: [],
    files: [testFile],
  });
  const countAfter = (await messagesIn(page, umumId)).length;
  check(
    "chat_send menolak file yang tidak dipilih lewat dialog Lampirkan",
    !refused.ok && refused.error?.code === "forbidden" && /Lampirkan/.test(refused.error?.message ?? "") && countAfter === countBefore,
    refused.ok ? "malah terkirim" : `${refused.error?.code}: ${refused.error?.message}`,
  );
  console.log("CATATAN  Kirim lampiran lewat dialog Windows tidak diotomasi (dialog asli di luar WebView2).");

  // 6. Channel baru #proyek-a.
  await sel.newChannelBtn(page).click();
  const chDlg = sel.dialog(page, /Channel (umum )?baru/);
  await chDlg.waitFor({ timeout: 10000 });
  // v0.3: dialog ini hanya membuat channel Umum (seluruh kantor), tanpa pilihan cakupan.
  const scopeSelect = sel.channelScope(chDlg);
  const scopes = (await scopeSelect.count()) ? await scopeSelect.locator("option").allInnerTexts() : [];
  const umumOnly = (await chDlg.getByText(/Semua anggota kantor/).count()) > 0;
  check(
    "Superadmin membuat channel untuk seluruh kantor",
    scopes.includes("Seluruh kantor") || umumOnly,
    scopes.length ? scopes.join(" | ") : `dialog Channel umum baru, keterangan seluruh kantor=${umumOnly}`,
  );
  await sel.channelName(chDlg).fill("Proyek A");
  const previewOk = await chDlg.getByText("#proyek-a").first().isVisible();
  check("Nama channel dirapikan jadi #proyek-a", previewOk);
  await shot(page, "t2-03-channel-baru-terang.png");
  await sel.createChannel(chDlg).click();
  await chDlg.waitFor({ state: "hidden", timeout: 10000 });
  await sel.conv(page, "#proyek-a").waitFor({ timeout: 10000 });
  const proyekCurrent = await sel.row(page, "proyek-a").getAttribute("aria-current");
  check("#proyek-a dibuat dan langsung terpilih", proyekCurrent === "true", `aria-current=${proyekCurrent}`);
  await sendWithEnter(page, TEXT.channelMsg);
  check("Pesan terkirim di #proyek-a", true);

  // 7. Hapus pesan dengan konfirmasi.
  await sendWithEnter(page, TEXT.toDelete);
  await pressAction(sel.deleteBtn(sel.message(page, TEXT.toDelete)));
  const delDlg = sel.dialog(page, /Hapus pesan ini/);
  await delDlg.waitFor({ timeout: 10000 });
  await sel.confirmDelete(delDlg).click();
  await delDlg.waitFor({ state: "hidden", timeout: 10000 });
  await sel.log(page).getByText("Pesan dihapus", { exact: true }).waitFor({ timeout: 10000 });
  const goneText = await sel.log(page).getByText(TEXT.toDelete).count();
  check("Pesan dihapus diganti tanda Pesan dihapus", goneText === 0, `teks lama tersisa ${goneText}`);

  // 8. Arsipkan lalu kembalikan.
  await sel.headerMenu(page, "#proyek-a").click();
  await sel.menuItem(page, /Arsipkan channel/).click();
  await sel.blockedNote(page).waitFor({ timeout: 10000 });
  // v0.3: yang diarsipkan tetap di bagiannya (di akhir), diredam dengan tanda Diarsipkan.
  const archivedRow = await sel
    .channelSection(page)
    .getByRole("button", { name: /^Channel proyek-a, (.*, )?diarsipkan(,|$)/ })
    .count();
  const composerGone = (await sel.composer(page).count()) === 0;
  check(
    "Channel diarsipkan tetap di bagian Umum dengan tanda Diarsipkan, kolom pesan dikunci dengan alasan",
    archivedRow === 1 && composerGone,
    `baris Diarsipkan=${archivedRow}, kolom pesan hilang=${composerGone}`,
  );
  await shot(page, "t2-04-diarsipkan-terang.png");
  await sel.headerMenu(page, "#proyek-a").click();
  await sel.menuItem(page, /Kembalikan dari arsip/).click();
  await sel.composer(page).waitFor({ timeout: 10000 });
  const backInChannels = await sel.channelSection(page).getByRole("button", { name: /^Channel proyek-a$/ }).count();
  check("Channel dikembalikan dari arsip dan bisa menulis lagi", backInChannels === 1, `di Umum tanpa tanda arsip=${backInChannels}`);

  // 9. Pengaturan notifikasi.
  await sel.notifyBtn(page).click();
  let nDlg = sel.dialog(page, /Notifikasi chat/);
  await nDlg.waitFor({ timeout: 10000 });
  await sel.notifyMentions(nDlg).check();
  await nDlg.getByText(/^Tersimpan/).waitFor({ timeout: 10000 });
  await sel.close(nDlg).click();
  await nDlg.waitFor({ state: "hidden", timeout: 10000 });
  await sel.notifyBtn(page).click();
  nDlg = sel.dialog(page, /Notifikasi chat/);
  await nDlg.waitFor({ timeout: 10000 });
  check("Pilihan notifikasi Hanya chat pribadi dan yang menyebut saya tersimpan", await sel.notifyMentions(nDlg).isChecked());
  await sel.close(nDlg).click();
  await nDlg.waitFor({ state: "hidden", timeout: 10000 });

  // 9b. v0.4: grup tanpa anggota lain, lalu lipat bagian Grup.
  await sel.list(page).getByRole("button", { name: "Grup baru", exact: true }).click();
  const gDlg = sel.dialog(page, "Grup baru");
  await gDlg.waitFor({ timeout: 10000 });
  await gDlg.getByLabel("Nama grup").fill(TEXT.soloGroup);
  const createGroupBtn = gDlg.getByRole("button", { name: /^Buat grup$/ });
  const lockedBefore = await createGroupBtn.getAttribute("aria-disabled");
  await createGroupBtn.click();
  await gDlg.waitFor({ state: "hidden", timeout: 10000 });
  await sel.conv(page, TEXT.soloGroup).waitFor({ timeout: 10000 });
  const solo = (await overview(page)).conversations.find((c) => c.kind === "group" && c.name === TEXT.soloGroup);
  check(
    "Grup bisa dibuat tanpa memilih orang dan berisi pembuatnya saja",
    lockedBefore !== "true" && solo?.memberCount === 1 && solo?.section === "grup" && solo?.canPost === true,
    solo ? `anggota=${solo.memberCount}, bagian=${solo.section}, tombol terkunci=${lockedBefore}` : "grup tidak ada",
  );
  await sendWithEnter(page, TEXT.soloMsg);
  const soloMsgs = solo ? await messagesIn(page, solo.id) : [];
  check(
    "Pesan tersimpan di grup satu orang",
    soloMsgs.some((m) => m.text === TEXT.soloMsg),
    `${soloMsgs.length} pesan`,
  );

  // Bagian Grup berisi percakapan yang sedang dibuka, dan tetap bisa dilipat.
  await sel.foldBtn(page, "Grup").click();
  const folded = await foldState(page, "Grup");
  const rowCount = await sel.groupRowAny(page, TEXT.soloGroup).count();
  const rowVisible = await sel.groupRowAny(page, TEXT.soloGroup).isVisible();
  check(
    "Bagian Grup terlipat: panah tertutup, isi tersembunyi menurut CSS, baris tidak terlihat",
    rowCount === 1 && folded.expanded === "false" && folded.display === "none" && !rowVisible,
    `baris=${rowCount}, aria-expanded=${folded.expanded}, display=${folded.display}, baris terlihat=${rowVisible}`,
  );
  const umumOpen = await foldState(page, "Umum");
  check(
    "Bagian lain tetap terbuka",
    umumOpen.expanded === "true" && umumOpen.display !== "none" && (await sel.row(page, "umum").isVisible()),
    `Umum aria-expanded=${umumOpen.expanded}, display=${umumOpen.display}`,
  );
  await sel.conv(page, TEXT.soloGroup).waitFor({ timeout: 5000 });
  await sel.list(page).screenshot({ path: join(shots, "v04-01-grup-terlipat.png") });

  // 10. Mode gelap.
  await setTheme(page, "Gelap");
  await openConv(page, "umum");
  await sel.message(page, TEXT.reply).waitFor({ timeout: 10000 });
  await shot(page, "t2-05-percakapan-gelap.png");
  await sel.list(page).screenshot({ path: join(shots, "t2-06-daftar-gelap.png") });
  check("Screenshot terang dan gelap diambil", true);
  await stop(app);
  app = null;

  // 11. Restart: data tetap.
  app = await launch();
  page = app.page;
  await sel.nav(page, "Chat").click({ timeout: 20000 });
  await sel.list(page).waitFor({ timeout: 10000 });
  const afterRestart = await foldState(page, "Grup");
  check(
    "Setelah restart bagian Grup tetap terlipat",
    afterRestart.expanded === "false" && afterRestart.display === "none",
    `aria-expanded=${afterRestart.expanded}, display=${afterRestart.display}`,
  );
  await sel.foldBtn(page, "Grup").click();
  const reopened = await foldState(page, "Grup");
  await sel.groupRow(page, TEXT.soloGroup).click({ timeout: 10000 });
  await sel.message(page, TEXT.soloMsg).waitFor({ timeout: 10000 });
  check(
    "Bagian Grup dibuka lagi dan pesan grup satu orang tetap ada",
    reopened.expanded === "true" && reopened.display !== "none",
    `aria-expanded=${reopened.expanded}, display=${reopened.display}`,
  );
  await openConv(page, "umum");
  await sel.message(page, TEXT.reply).waitFor({ timeout: 10000 });
  const umumText = await sel.log(page).textContent();
  check(
    "Setelah restart pesan #umum tetap ada",
    [TEXT.first, TEXT.line1, TEXT.line2, TEXT.reply].every((t) => umumText.includes(t)),
  );
  await openConv(page, "proyek-a");
  await sel.message(page, TEXT.channelMsg).waitFor({ timeout: 10000 });
  const deletedMarker = await sel.log(page).getByText("Pesan dihapus", { exact: true }).count();
  check("Setelah restart #proyek-a dan tanda Pesan dihapus tetap ada", deletedMarker === 1, `tanda=${deletedMarker}`);
  await sel.notifyBtn(page).click();
  nDlg = sel.dialog(page, /Notifikasi chat/);
  await nDlg.waitFor({ timeout: 10000 });
  check("Setelah restart pengaturan notifikasi tetap", await sel.notifyMentions(nDlg).isChecked());
  await sel.close(nDlg).click();
  await stop(app);
  app = null;
} catch (err) {
  check("Skrip berjalan tanpa error", false, String(err?.message ?? err).slice(0, 300));
  if (app) {
    await app.page.screenshot({ path: join(shots, "gagal-chat.png") }).catch(() => {});
    await stop(app);
  }
}

// Kunci publik belum terbaca (gagal sangat awal): kembali ke cara lama, semua kunci baru.
const ownTargets = ownKey ? [ownKey] : [...miraCredentials()].filter((t) => !credentialsBefore.has(t));
for (const target of ownTargets) {
  if (!credentialsBefore.has(target)) {
    try {
      execFileSync("cmdkey", [`/delete:${target}`], { stdio: "ignore" });
    } catch {
      console.log(`Kunci uji tidak bisa dihapus: ${target}`);
    }
  }
}
console.log(`Folder data uji: ${dataDir} (log: stderr.log). Dihapus sekarang.`);
try {
  const log = readFileSync(join(dataDir, "stderr.log"), "utf8").trim();
  if (log) console.log(`stderr aplikasi:\n${log.slice(-2000)}`);
} catch {
  /* tidak ada log */
}
rmSync(dataDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} pemeriksaan lulus.`);
process.exit(failed ? 1 : 0);
