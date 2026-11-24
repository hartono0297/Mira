// Uji ujung ke ujung permintaan bergabung (v0.3 bagian A, diperbarui v0.4) di satu PC Windows.
//
// Menjalankan beberapa instance mira.exe, masing-masing dengan folder data
// (MIRA_DATA_DIR), port QUIC (MIRA_PORT), dan port debug WebView2 sendiri,
// lalu mengendalikannya lewat Chrome DevTools Protocol. Laptop baru melewati
// layar onboarding yang asli (nama, firewall kalau perlu, mencari kantor,
// pilih kantor, departemen, keterangan, menunggu persetujuan); laptop
// superadmin memutuskan lewat kartu Permintaan bergabung atau command Tauri.
//
//   A  Ayu    membuat kantor dan departemen, superadmin
//   B  Budi   bergabung dengan kode undangan lewat layar "Pakai kode undangan"
//   K  Kiki   membuat kantor kedua, supaya N melihat dua kantor
//   N  Nina   laptop baru: melihat dua kantor, memilih satu, mengisi keterangan, disetujui
//   R  Rudi   laptop baru: satu kantor (terpilih otomatis), minta bergabung, ditolak
//   X  Xena   laptop baru tanpa mDNS: kantor tidak terlihat, tombol kantor baru
//             hanya di dalam "Untuk admin IT", lalu lewat alamat rekan
//
// Semua instance memakai satu IP, jadi batas per IP di laptop A berlaku
// bersama. Skenario dijalankan berurutan, tidak tumpang tindih.
//
// Pakai:  node scripts/join-e2e.mjs <path mira.exe> <folder screenshot>
// Butuh:  playwright-core (alat uji saja, tidak dibundel ke aplikasi).

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { mainNav, openAdminIT, passFirewall as passFirewallStep, passName } from "./e2e-onboarding.mjs";

const exe = resolve(process.argv[2] ?? "src-tauri/target/debug/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots/v04-onboarding");
mkdirSync(shots, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "mira-join-e2e-"));

const ORG = "Kantor Uji Gabung";
const DEPT = "Keuangan";
const ORG2 = "Kantor Uji Lain";
const DEPT2 = "Gudang";
const NOTE = "Staf keuangan, NIK 4471";
// Nama akun login Windows yang dibaca Mira dari sistem.
const ACCOUNT = process.env.USERNAME ?? "";
const NODES = {
  A: { name: "Ayu Uji", port: 47881, cdp: 9381, dir: join(root, "laptop-a") },
  B: { name: "Budi Uji", port: 47882, cdp: 9382, dir: join(root, "laptop-b") },
  K: { name: "Kiki Uji", port: 47886, cdp: 9386, dir: join(root, "laptop-k") },
  N: { name: "Nina Uji", port: 47883, cdp: 9383, dir: join(root, "laptop-n") },
  R: { name: "Rudi Uji", port: 47884, cdp: 9384, dir: join(root, "laptop-r") },
  X: { name: "Xena Uji", port: 47885, cdp: 9385, dir: join(root, "laptop-x"), env: { MIRA_DISABLE_MDNS: "1" } },
};
const addr = (id) => `127.0.0.1:${NODES[id].port}`;

function miraCredentials() {
  try {
    const out = execFileSync("cmdkey", ["/list"], { encoding: "utf8" });
    return new Set(out.match(/device-key-[0-9a-f]{64}\.id\.mira\.desktop/g) ?? []);
  } catch {
    return new Set();
  }
}
const credentialsBefore = miraCredentials();
// Kunci publik laptop uji ini. Kredensial baru yang bukan milik skrip ini
// (misalnya dari uji lain yang berjalan bersamaan) tidak dihapus.
const ourKeys = new Set();

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "LULUS" : "GAGAL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const running = {};

async function launch(id) {
  const node = NODES[id];
  mkdirSync(node.dir, { recursive: true });
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: node.dir,
      MIRA_PORT: String(node.port),
      // Build debug: cek pembaruan diarahkan ke alamat mati, supaya tidak ada
      // panggilan ke internet atau dialog pembaruan di tengah uji.
      MIRA_UPDATER_ENDPOINT: "http://127.0.0.1:9/latest.json",
      ...(node.env ?? {}),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${node.cdp}`,
    },
    stdio: "ignore",
  });
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    await sleep(500);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${node.cdp}`);
    } catch {
      /* belum siap */
    }
  }
  if (!browser) throw new Error(`WebView2 ${id} tidak bisa dihubungi lewat CDP`);
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages())[0];
    if (!page) await sleep(250);
  }
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
  running[id] = { child, browser, page };
  try {
    const st = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_app_state"));
    if (st?.identity?.publicKey) ourKeys.add(st.identity.publicKey.toLowerCase());
  } catch {
    /* kunci dicatat lagi lewat selisih cmdkey */
  }
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
async function call(id, cmd, args = {}) {
  return running[id].page.evaluate(
    async ([c, a]) => {
      try {
        return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(c, a) };
      } catch (error) {
        return { ok: false, error };
      }
    },
    [cmd, args],
  );
}
async function must(id, cmd, args) {
  const r = await call(id, cmd, args);
  if (!r.ok) throw new Error(`${id} ${cmd}: ${JSON.stringify(r.error)}`);
  return r.value;
}
async function waitFor(desc, fn, timeoutMs = 45000, everyMs = 1000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = String(e?.message ?? e);
    }
    await sleep(everyMs);
  }
  throw new Error(`Menunggu terlalu lama: ${desc} (terakhir: ${JSON.stringify(last)?.slice(0, 200)})`);
}
const shot = (id, file) => running[id].page.screenshot({ path: join(shots, file) });
const bodyText = (id) => running[id].page.locator("body").innerText();
const heading = (id) => running[id].page.locator("h1.onb-title").first();
const shellVisible = (id) => running[id].page.locator('nav[aria-label="Menu utama"]').isVisible();

// Judul langkah onboarding yang sedang tampil.
async function waitHeading(id, re, timeoutMs = 30000) {
  return waitFor(`${id} menampilkan judul ${re}`, async () => {
    const h = heading(id);
    if (!(await h.isVisible())) return null;
    const t = await h.innerText();
    return re.test(t) ? t : null;
  }, timeoutMs, 300);
}

// Langkah 1 dari 3 (nama), lalu firewall kalau aturan Mira belum ada.
// Hasil: teks tombol firewall yang diklik, atau null kalau layar itu dilewati sendiri.
async function startOnboarding(id) {
  await passName(running[id].page, NODES[id].name);
  return passFirewallStep(running[id].page);
}

// Layar pilih kantor: pilih kantor (kalau ada beberapa), departemen,
// keterangan opsional, kirim. Hasil: kode cocok di layar menunggu.
async function requestToJoin(id, { office = null, note = null } = {}) {
  const page = running[id].page;
  if (office) await page.getByRole("radio", { name: new RegExp("^" + office) }).check();
  await page.locator('select[name="team"]').selectOption({ label: DEPT });
  if (note) await page.getByLabel("Keterangan untuk admin (opsional)", { exact: true }).fill(note);
  await page.getByRole("button", { name: "Kirim permintaan" }).click();
  await waitHeading(id, /^Menunggu persetujuan$/, 30000);
  return (await page.locator(".onb-match").innerText()).trim();
}

// Permintaan dari `name` yang terlihat di laptop A (kartu penyetuju).
async function requestOnA(name, timeoutMs = 30000) {
  return waitFor(`A melihat permintaan ${name}`, async () => {
    const list = await must("A", "org_join_requests");
    return list.find((r) => r.displayName === name) ?? null;
  }, timeoutMs);
}

async function goOrganization(id) {
  try {
    await mainNav(running[id].page, "Organisasi").click({ timeout: 5000 });
    await sleep(1500);
  } catch {
    /* menu belum ada: screenshot layar yang sedang terbuka */
  }
}

const pk = {};

try {
  // ----- 1. Kantor A dan anggota B (kode undangan) -----------------------------
  await launch("A");
  await must("A", "save_display_name", { name: NODES.A.name });
  await must("A", "create_organization", { name: ORG });
  const dept = await must("A", "org_create_department", { name: DEPT });
  pk.A = (await must("A", "get_app_state")).identity.publicKey;
  await must("A", "org_move_member", { publicKey: pk.A, teamId: dept.id });
  const aState = await must("A", "get_app_state");
  check("A membuat kantor dan departemen, lalu masuk ke departemennya", aState.organization?.name === ORG && Boolean(dept.id), `${aState.organization?.name} / ${dept.name}`);
  await running.A.page.reload();
  await running.A.page.waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
  await waitFor("Shell A tampil", () => shellVisible("A"), 20000);

  const invite = await must("A", "create_invite", { teamId: dept.id, role: "member", validity: "24h", projectIds: [] });

  // B lewat layar onboarding: firewall, cari, kantor ditemukan, "Cari dengan
  // cara lain", "Pakai kode undangan".
  await launch("B");
  pk.B = (await must("B", "get_app_state")).identity.publicKey;
  let bViaUi = false;
  try {
    await startOnboarding("B");
    const h = await waitHeading("B", /^(Kantor ditemukan|Beberapa kantor ditemukan|Kantor belum ditemukan)/, 25000);
    if (/ditemukan/.test(h) && !/belum/.test(h)) {
      await running.B.page.getByRole("button", { name: "Cari dengan cara lain" }).click();
    }
    await running.B.page.getByRole("button", { name: /Pakai kode undangan/ }).click();
    await waitHeading("B", /^Gabung dengan kode undangan$/);
    const bName = running.B.page.locator('input[name="displayName"]');
    if (await bName.isVisible()) await bName.fill(NODES.B.name);
    await running.B.page.locator('input[name="inviteCode"]').fill(invite.code);
    await shot("B", "j01-b-kode-undangan.png");
    await running.B.page.getByRole("button", { name: "Gabung ke organisasi" }).click();
    await waitFor("Shell B tampil setelah kode undangan", () => shellVisible("B"), 45000);
    bViaUi = true;
  } catch (e) {
    console.log(`Catatan: jalur layar kode undangan B gagal: ${e.message}`);
    await shot("B", "j01-b-kode-undangan-gagal.png").catch(() => {});
  }
  if (!bViaUi) {
    const r = await call("B", "join_with_code", { code: invite.code, address: addr("A") });
    if (!r.ok) console.log(`Catatan: join_with_code B lewat alamat juga gagal: ${JSON.stringify(r.error)}`);
  }
  const bState = await must("B", "get_app_state");
  check("Kode undangan tetap jalan: B bergabung lewat layar \"Pakai kode undangan\"", bViaUi && bState.organization?.name === ORG, bViaUi ? "" : "jalur layar gagal");
  const bOnA = await waitFor("A melihat B aktif", async () => {
    const d = await must("A", "get_directory");
    return d.members.find((m) => m.publicKey === pk.B && m.status === "active") ?? null;
  }).catch(() => null);
  check("B tercatat sebagai anggota aktif di laptop A", Boolean(bOnA));
  await sleep(3000); // B mulai mengiklankan j=1 lewat mDNS.

  // ----- 2. Kantor kedua K, lalu laptop baru N melihat dua kantor ----------------
  await launch("K");
  await must("K", "save_display_name", { name: NODES.K.name });
  await must("K", "create_organization", { name: ORG2 });
  const dept2 = await must("K", "org_create_department", { name: DEPT2 });
  pk.K = (await must("K", "get_app_state")).identity.publicKey;
  await must("K", "org_move_member", { publicKey: pk.K, teamId: dept2.id });
  check("K membuat kantor kedua di jaringan yang sama", (await must("K", "get_app_state")).organization?.name === ORG2);
  await sleep(3000); // K mulai mengiklankan j=1 lewat mDNS.

  await launch("N");
  pk.N = (await must("N", "get_app_state")).identity.publicKey;
  await waitFor("N menampilkan langkah nama", () => running.N.page.getByRole("button", { name: "Lanjut", exact: true }).isVisible(), 20000, 300);
  const nFirst = await bodyText("N");
  await shot("N", "j02-n-nama.png").catch(() => {});
  check("N: layar pertama meminta nama (Langkah 1 dari 3)", nFirst.includes("Langkah 1 dari 3") && nFirst.includes("Nama tampilan"));
  check("N: layar pertama tidak menyebut kantor baru atau superadmin", !/kantor baru|superadmin/i.test(nFirst));
  const fwLabel = await startOnboarding("N");
  check("N: langkah firewall singkat atau dilewati sendiri", true, fwLabel ? `tombol "${fwLabel}"` : "aturan sudah ada, layar dilewati");
  let searchSeen = false;
  try {
    await waitHeading("N", /^Mencari kantor di jaringan/, 5000);
    searchSeen = true;
    await shot("N", "j03-n-mencari.png");
  } catch {
    /* kantor sudah ditemukan sebelum layar mencari tertangkap */
  }
  let nHeading = "";
  try {
    nHeading = await waitHeading("N", /^(Kantor ditemukan|Beberapa kantor ditemukan|Kantor belum ditemukan)/, 30000);
  } catch (e) {
    nHeading = String(e.message);
  }
  check("N: layar mencari kantor tampil", searchSeen || /ditemukan/.test(nHeading), searchSeen ? "" : "langsung ke hasil");
  check('N melihat dua kantor lewat mDNS: "Beberapa kantor ditemukan"', nHeading === "Beberapa kantor ditemukan", nHeading);
  const nBody = await bodyText("N");
  const fpA = await must("A", "org_fingerprint");
  const fpK = await must("K", "org_fingerprint");
  check("N: kedua kantor tampil dengan nama dan sidiknya", nBody.includes(ORG) && nBody.includes(ORG2) && nBody.includes(fpA) && nBody.includes(fpK), `${fpA} / ${fpK}`);
  check('N: tidak ada "kantor baru" atau "Untuk admin IT" saat kantor terlihat', !nBody.includes("Siapkan Mira untuk kantor baru") && !nBody.includes("Untuk admin IT"));
  const teamSelect = running.N.page.locator('select[name="team"]');
  check("N: departemen belum bisa dipilih sebelum kantor dipilih", await teamSelect.isDisabled());
  await shot("N", "j04-n-dua-kantor.png");
  await running.N.page.getByRole("radio", { name: new RegExp("^" + ORG) }).check();
  const deptOptions = await teamSelect.locator("option").allInnerTexts();
  check("N: daftar departemen berasal dari kantor yang dipilih", deptOptions.includes(DEPT) && !deptOptions.includes(DEPT2), JSON.stringify(deptOptions));
  const noteField = running.N.page.getByLabel("Keterangan untuk admin (opsional)", { exact: true });
  check('N: isian "Keterangan untuk admin" tampil, paling banyak 80 karakter', (await noteField.isVisible()) && (await noteField.getAttribute("maxlength")) === "80");
  await teamSelect.selectOption({ label: DEPT });
  await noteField.fill(NOTE);
  await shot("N", "j04b-n-formulir.png");
  const nCode = await requestToJoin("N");
  await shot("N", "j05-n-menunggu.png");
  check("N: layar menunggu menampilkan kode cocok", /^[0-9A-Z]{4} [0-9A-Z]{4}$/.test(nCode), nCode);

  // ----- 3. A melihat dan menyetujui ---------------------------------------------
  const nReq = await requestOnA(NODES.N.name).catch((e) => ({ error: e.message }));
  check("A melihat permintaan N di org_join_requests", Boolean(nReq?.id), nReq?.error ?? `${nReq.teamName}, ${nReq.laptop}, ip ${nReq.ip}`);
  check("Kode cocok di A sama dengan kode di layar N", nReq?.code === nCode, `A ${nReq?.code} / N ${nCode}`);
  check("Permintaan N tertuju ke departemen yang dipilih", nReq?.teamId === dept.id);
  check("Permintaan N membawa keterangan dan nama akun login", nReq?.note === NOTE && Boolean(ACCOUNT) && nReq?.account === ACCOUNT, `${JSON.stringify(nReq?.note)} / ${JSON.stringify(nReq?.account)}`);
  const kReqs = await must("K", "org_join_requests");
  check("Kantor K tidak menerima permintaan N", !kReqs.some((r) => r.displayName === NODES.N.name));
  // Kartu penyetuju di halaman Organisasi A (bagian B): angka di menu, sidik di header,
  // kode yang sama di kartu, lalu Setujui lewat klik.
  const pa = running.A.page;
  const navCounted = await waitFor("menu Organisasi A membawa angka permintaan", async () =>
    (await pa.locator('nav[aria-label="Menu utama"]').getByRole("button", { name: /^Organisasi\s*,\s*1 permintaan/ }).count()) > 0,
  40000).catch(() => false);
  check("Menu Organisasi A menampilkan 1 permintaan menunggu", navCounted === true);
  await goOrganization("A");
  const headText = await pa.locator("main.org header.page-head .org-fp").innerText({ timeout: 10000 }).catch(() => "");
  check("Header Organisasi A menampilkan sidik organisasi", headText.includes(fpA), fpA);
  let approvedByClick = false;
  try {
    await pa.locator("nav.org-tabs-wrap").getByRole("button", { name: /^Permintaan bergabung/ }).click({ timeout: 10000 });
    await pa.getByText(nCode, { exact: true }).waitFor({ timeout: 15000 });
    await shot("A", "j06-a-permintaan-bergabung.png");
    const card = await pa.locator("main.org").innerText();
    check("Kartu A menampilkan keterangan, akun login, dan laptop N", card.includes(NOTE) && card.includes(ACCOUNT) && card.includes(nReq.laptop), `${ACCOUNT} / ${nReq.laptop}`);
    check("Kartu A memberi petunjuk mencocokkan kode lewat telepon", /telepon/i.test(card));
    await pa.getByRole("button", { name: `Setujui permintaan ${NODES.N.name}` }).click({ timeout: 10000 });
    approvedByClick = true;
  } catch (e) {
    await shot("A", "j06-a-organisasi.png");
    await must("A", "org_approve_join", { requestId: nReq.id });
    console.log(`Catatan: kartu permintaan tidak bisa diklik: ${e.message}`);
  }
  check("A menyetujui N lewat kartu Permintaan bergabung (kode yang sama tampil)", approvedByClick);
  const nShell = await waitFor("Layar N berganti sendiri ke shell", () => shellVisible("N"), 40000, 500).catch(() => false);
  check("Layar N berganti sendiri ke shell setelah disetujui", nShell === true);
  const nState = await must("N", "get_app_state");
  check("N punya organisasi setelah disetujui", nState.organization?.name === ORG, JSON.stringify(nState.organization?.name ?? null));
  await sleep(1500);
  await shot("N", "j07-n-masuk-mira.png");
  const nOnA = await waitFor("A melihat N aktif", async () => {
    const d = await must("A", "get_directory");
    return d.members.find((m) => m.publicKey === pk.N && m.status === "active") ?? null;
  }).catch(() => null);
  check("N tercatat sebagai anggota aktif di laptop A", Boolean(nOnA));
  const aLeft = await must("A", "org_join_requests");
  check("Permintaan N hilang dari daftar A setelah disetujui", !aLeft.some((r) => r.id === nReq.id));
  await stop("N");
  await stop("B");
  await stop("K");
  await sleep(3000); // iklan mDNS K berhenti.

  // ----- 4. Laptop R ditolak -------------------------------------------------------
  await launch("R");
  await startOnboarding("R");
  const rHeading = await waitHeading("R", /^(Kantor ditemukan|Beberapa kantor ditemukan|Kantor belum ditemukan)/, 30000).catch((e) => String(e.message));
  check(`R menemukan satu kantor lewat mDNS: "Kantor ditemukan: ${ORG}"`, rHeading === `Kantor ditemukan: ${ORG}`, rHeading);
  // Hanya radio pilihan kantor: pemilih bahasa ringkas di onboarding juga radio.
  const rRadios = await running.R.page.locator('input[type="radio"][name="office"]').count();
  const rFirst = await bodyText("R");
  check("R: satu kantor terpilih otomatis, tampil dengan sidiknya", rRadios === 0 && rFirst.includes(fpA) && (await running.R.page.locator('select[name="team"]').isEnabled()), `radio ${rRadios}`);
  await shot("R", "j07b-r-satu-kantor.png");
  const rCode = await requestToJoin("R");
  const rReq = await requestOnA(NODES.R.name).catch((e) => ({ error: e.message }));
  check("A melihat permintaan R dengan kode yang sama", rReq?.code === rCode, `A ${rReq?.code} / R ${rCode}`);
  await must("A", "org_reject_join", { requestId: rReq.id });
  const rRejected = await waitHeading("R", /^Permintaan ditolak$/, 40000).catch(() => null);
  check("Layar R berganti ke \"Permintaan ditolak\"", rRejected !== null);
  const rBody = await bodyText("R");
  check("Layar R menyebut nama penolak", rBody.includes(`${NODES.A.name} menolak permintaan Anda`), rBody.split("\n").find((l) => l.includes("menolak")) ?? "");
  await shot("R", "j08-r-ditolak.png");
  const rState = await must("R", "get_app_state");
  check("R tidak punya organisasi", rState.organization === null);
  const rOut = await must("R", "join_outgoing");
  check("Permintaan R tercatat ditolak", rOut?.status === "rejected" && rOut?.decidedByName === NODES.A.name, JSON.stringify(rOut && { status: rOut.status, by: rOut.decidedByName }));
  await stop("R");

  // ----- 5. Laptop X tanpa mDNS -------------------------------------------------------
  await launch("X");
  await startOnboarding("X");
  const xHeading = await waitHeading("X", /^(Kantor ditemukan|Beberapa kantor ditemukan|Kantor belum ditemukan)/, 25000).catch((e) => String(e.message));
  check("X tanpa mDNS: layar \"Kantor belum ditemukan\"", xHeading === "Kantor belum ditemukan", xHeading);
  const newOffice = running.X.page.getByRole("button", { name: "Siapkan Mira untuk kantor baru", exact: true });
  await shot("X", "j09-x-belum-ditemukan.png");
  check('X: tombol kantor baru tidak terlihat tanpa membuka "Untuk admin IT"', !(await newOffice.isVisible()));
  await openAdminIT(running.X.page);
  check('X: tombol kantor baru ada di dalam "Untuk admin IT"', await newOffice.isVisible());
  await shot("X", "j09b-x-admin-it.png");
  await running.X.page.locator("summary", { hasText: "Untuk admin IT" }).click();
  await running.X.page.locator('input[name="peerAddress"]').fill(addr("A"));
  await running.X.page.getByRole("button", { name: "Hubungkan" }).click();
  const xOffice = await waitHeading("X", /^(Kantor ditemukan|Beberapa kantor ditemukan)/, 20000).catch((e) => String(e.message));
  check(`X lewat "Masukkan alamat laptop rekan" menemukan "${ORG}"`, xOffice === `Kantor ditemukan: ${ORG}`, xOffice);
  const xBody = await bodyText("X");
  check("X: pilihan kantor baru hilang setelah kantor terlihat", !xBody.includes("Siapkan Mira untuk kantor baru"));
  const xCode = await requestToJoin("X");
  const xReq = await requestOnA(NODES.X.name).catch((e) => ({ error: e.message }));
  check("A melihat permintaan X (alamat manual) dengan kode yang sama", xReq?.code === xCode, `A ${xReq?.code} / X ${xCode}`);
  await must("A", "org_approve_join", { requestId: xReq.id });
  const xShell = await waitFor("Layar X berganti sendiri ke shell", () => shellVisible("X"), 40000, 500).catch(() => false);
  check("X masuk Mira setelah disetujui (tanpa mDNS)", xShell === true && (await must("X", "get_app_state")).organization?.name === ORG);
  await sleep(1500);
  await shot("X", "j10-x-masuk-mira.png");
} catch (err) {
  check("Skrip berjalan tanpa error", false, String(err?.message ?? err));
  for (const id of Object.keys(running)) await shot(id, `error-${id.toLowerCase()}.png`).catch(() => {});
}

for (const id of Object.keys(running)) await stop(id);
for (const target of miraCredentials()) {
  if (!credentialsBefore.has(target)) {
    const key = target.slice("device-key-".length, "device-key-".length + 64);
    if (!ourKeys.has(key)) {
      console.log(`Kredensial baru bukan milik uji ini, dibiarkan: ${target}`);
      continue;
    }
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
