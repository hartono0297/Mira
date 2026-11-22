// Uji ujung ke ujung beberapa "laptop" Mira di satu PC (Tahap 1).
//
// Menjalankan empat instance mira.exe hasil build release, masing-masing
// dengan folder data (MIRA_DATA_DIR), port QUIC (MIRA_PORT), dan port debug
// WebView2 sendiri, lalu mengendalikannya lewat Chrome DevTools Protocol.
// Aksi dijalankan lewat command Tauri yang sama dengan yang dipakai tampilan;
// hasilnya dicek di data dan di layar (daftar "Di jaringan").
//
//   A  Ayu    membuat organisasi, superadmin
//   B  Budi   bergabung dengan kode Anggota (lewat penemuan otomatis)
//   C  Citra  bergabung dengan kode Admin tim sekali pakai
//   D  Dodi   orang luar: kode salah, kode terpakai, kode kedaluwarsa
//
// Pakai:  node scripts/e2e-multi.mjs <path mira.exe> <folder screenshot>
// Butuh:  playwright-core (alat uji saja, tidak dibundel ke aplikasi).

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const exe = resolve(process.argv[2] ?? "src-tauri/target/release/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots/tahap-1");
mkdirSync(shots, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "mira-multi-"));

const NODES = {
  A: { name: "Ayu Uji", port: 47851, cdp: 9351, dir: join(root, "laptop-a") },
  B: { name: "Budi Uji", port: 47852, cdp: 9352, dir: join(root, "laptop-b") },
  C: { name: "Citra Uji", port: 47853, cdp: 9353, dir: join(root, "laptop-c") },
  D: { name: "Dodi Uji", port: 47854, cdp: 9354, dir: join(root, "laptop-d"), env: { MIRA_DISABLE_MDNS: "1" } },
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

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "LULUS" : "GAGAL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const running = {};

async function launch(id, extraEnv = {}) {
  const node = NODES[id];
  mkdirSync(node.dir, { recursive: true });
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      MIRA_DATA_DIR: node.dir,
      MIRA_PORT: String(node.port),
      ...(node.env ?? {}),
      ...extraEnv,
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
async function waitFor(desc, fn, timeoutMs = 45000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = String(e?.message ?? e);
    }
    await sleep(1000);
  }
  throw new Error(`Menunggu terlalu lama: ${desc} (terakhir: ${JSON.stringify(last)?.slice(0, 200)})`);
}
async function reload(id) {
  await running[id].page.reload();
  await running[id].page.waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
}
const onlineNames = async (id) =>
  (await must(id, "get_network_status")).peers.filter((p) => p.online).map((p) => p.displayName).sort();
const teamNames = async (id) => (await must(id, "get_directory")).teams.map((t) => t.name).sort();
const channelNames = async (id) => (await must(id, "get_directory")).channels.map((c) => c.name).sort();
const memberOf = (dir, pk) => dir.members.find((m) => m.publicKey === pk);

try {
  for (const id of Object.keys(NODES)) await launch(id);
  for (const id of Object.keys(NODES)) await must(id, "save_display_name", { name: NODES[id].name });
  const pk = {};
  for (const id of Object.keys(NODES)) pk[id] = (await must(id, "get_app_state")).identity.publicKey;

  // Menyiapkan organisasi.
  await must("A", "create_organization", { name: "Kantor Uji" });
  const team = await must("A", "create_team", { name: "Tim Desain" });
  const inviteMember = await must("A", "create_invite", { teamId: team.id, role: "member", validity: "24h", projectIds: [] });
  const inviteAdmin = await must("A", "create_invite", { teamId: team.id, role: "team_admin", validity: "once", projectIds: [] });
  check("Superadmin membuat tim dan dua kode undangan", /^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/.test(inviteMember.code), inviteMember.code);

  // B bergabung lewat penemuan otomatis (mDNS). Kalau gagal, dicatat lalu dicoba dengan alamat.
  let joinB = await call("B", "join_with_code", { code: inviteMember.code.toLowerCase().replaceAll("-", " "), address: null });
  check("B bergabung lewat penemuan otomatis (mDNS) dengan kode Anggota", joinB.ok, joinB.ok ? "" : JSON.stringify(joinB.error));
  if (!joinB.ok) joinB = await call("B", "join_with_code", { code: inviteMember.code, address: addr("A") });
  check("B bergabung dengan peran Anggota", joinB.ok && joinB.value.role === "member", JSON.stringify(joinB.ok ? joinB.value.role : joinB.error));

  const joinC = await call("C", "join_with_code", { code: inviteAdmin.code, address: addr("A") });
  check("C bergabung dengan peran Admin tim", joinC.ok && joinC.value.role === "team_admin", JSON.stringify(joinC.ok ? joinC.value.role : joinC.error));

  const dirA = await waitFor("A melihat B dan C di Tim Desain", async () => {
    const d = await must("A", "get_directory");
    const t = d.teams.find((x) => x.id === team.id);
    const roleOf = (k) => t?.members.find((m) => m.publicKey === k)?.role;
    return roleOf(pk.B) === "member" && roleOf(pk.C) === "admin" ? d : null;
  });
  check("Peran di tim tersinkron ke laptop superadmin", Boolean(dirA));

  // Saling menemukan dan tampil di "Di jaringan".
  for (const id of ["A", "B", "C"]) {
    const others = ["A", "B", "C"].filter((x) => x !== id).map((x) => NODES[x].name).sort();
    let names = [];
    try {
      names = await waitFor(`${id} melihat dua rekan online`, async () => {
        const n = await onlineNames(id);
        return JSON.stringify(n) === JSON.stringify(others) ? n : null;
      });
    } catch (e) {
      names = String(e.message);
    }
    check(`${id} melihat ${others.join(" dan ")} online`, Array.isArray(names), Array.isArray(names) ? "" : names);
    await reload(id);
    await sleep(2000);
    const body = await running[id].page.locator("body").innerText();
    check(`Daftar "Di jaringan" di layar ${id} menampilkan kedua rekan`, others.every((n) => body.includes(n)));
    await running[id].page.screenshot({ path: join(shots, `di-jaringan-${id.toLowerCase()}.png`) });
  }
  // Screenshot layar Tahap 1 untuk laporan (tidak dihitung sebagai pemeriksaan).
  try {
    const pa = running.A.page;
    await pa.getByRole("button", { name: "Organisasi", exact: true }).click();
    await sleep(1500);
    await pa.screenshot({ path: join(shots, "organisasi-a.png") });
    await pa.getByRole("button", { name: "Undang ke tim" }).first().click();
    await sleep(800);
    await pa.screenshot({ path: join(shots, "dialog-undangan.png") });
    await pa.keyboard.press("Escape");
    await pa.getByRole("button", { name: "Pengaturan", exact: true }).click();
    await pa.getByRole("button", { name: "Jaringan", exact: true }).click();
    await sleep(1500);
    await pa.screenshot({ path: join(shots, "pengaturan-jaringan.png") });
    const pd = running.D.page;
    await reload("D");
    await pd.getByRole("button", { name: /Gabung dengan kode/ }).click();
    await sleep(4000);
    await pd.screenshot({ path: join(shots, "panduan-firewall.png") });
    await pd.getByRole("button", { name: /Lewati, atur nanti|Lanjut ke kode undangan/ }).click();
    await sleep(800);
    await pd.screenshot({ path: join(shots, "gabung-dengan-kode.png") });
  } catch (e) {
    console.log(`Catatan: screenshot tambahan gagal: ${e.message}`);
  }

  const statusA = await must("A", "get_network_status");
  check("Status koneksi A: tersambung lewat LAN kantor", statusA.state === "lan", statusA.state);

  // Orang luar ditolak.
  const wrong = await call("D", "join_with_code", { code: "ABCD-EFGH-JKMN-PQRS-TVWX", address: addr("A") });
  check("Kode yang tidak sah ditolak", !wrong.ok && wrong.error.code === "invite_not_found", JSON.stringify(wrong.ok ? wrong.value : wrong.error));
  const used = await call("D", "join_with_code", { code: inviteAdmin.code, address: addr("A") });
  check("Kode sekali pakai yang sudah dipakai ditolak", !used.ok && used.error.code === "invite_used", JSON.stringify(used.ok ? used.value : used.error));
  const inviteLate = await must("A", "create_invite", { teamId: team.id, role: "member", validity: "24h", projectIds: [] });
  await stop("A");
  await launch("A", { MIRA_CLOCK_OFFSET_SECS: String(25 * 3600) });
  const expired = await waitFor("A bisa dihubungi lagi", async () => {
    const r = await call("D", "join_with_code", { code: inviteLate.code, address: addr("A") });
    return r.ok || r.error.code !== "no_peer_found" ? r : null;
  });
  check("Kode yang kedaluwarsa ditolak (jam A dimajukan 25 jam)", !expired.ok && expired.error.code === "invite_expired", JSON.stringify(expired.ok ? expired.value : expired.error));
  const dState = await must("D", "get_app_state");
  check("Laptop yang ditolak tidak mendapat organisasi", dState.organization === null);
  const dRejected = await must("A", "get_rejected_changes");
  check("Penolakan tercatat di laptop A", Array.isArray(dRejected));
  await stop("A");
  await launch("A");

  // Laptop yang dimatikan menyusul perubahan yang terlewat.
  await stop("C");
  const marketing = await must("A", "create_team", { name: "Tim Pemasaran" });
  await must("A", "add_team_member", { teamId: marketing.id, publicKey: pk.B });
  await launch("C");
  const caught = await waitFor("C menerima Tim Pemasaran setelah menyala", async () =>
    (await teamNames("C")).includes("Tim Pemasaran"),
  ).catch((e) => String(e.message));
  check("C yang dimatikan lalu dinyalakan menerima tim baru yang terlewat", caught === true, caught === true ? "" : caught);

  // Data tim hanya untuk anggota tim.
  const bSees = await waitFor("B menerima channel Tim Pemasaran", async () =>
    (await channelNames("B")).some((n) => n.includes("pemasaran")),
  ).catch(() => false);
  check("Anggota Tim Pemasaran (B) menerima channel timnya", bSees === true, JSON.stringify(await channelNames("B")));
  await sleep(5000);
  const cChannels = await channelNames("C");
  check("C yang bukan anggota Tim Pemasaran tidak menerima channel tim itu", !cChannels.some((n) => n.includes("pemasaran")), JSON.stringify(cChannels));

  // Mengeluarkan anggota.
  await must("A", "remove_member", { publicKey: pk.B });
  const bRemoved = await waitFor("B tahu dirinya dikeluarkan", async () =>
    (await must("B", "get_app_state")).membership === "removed",
  ).catch((e) => String(e.message));
  check("B mendapat status dikeluarkan", bRemoved === true, bRemoved === true ? "" : bRemoved);
  await must("A", "create_team", { name: "Tim Rahasia" });
  const cGets = await waitFor("C menerima Tim Rahasia", async () => (await teamNames("C")).includes("Tim Rahasia")).catch(() => false);
  check("Anggota yang masih aktif (C) menerima perubahan baru", cGets === true);
  await sleep(8000);
  const bDir = await call("B", "get_directory");
  const bTeams = bDir.ok ? bDir.value.teams.map((t) => t.name) : [];
  check("Anggota yang dikeluarkan (B) tidak menerima perubahan baru", !bTeams.includes("Tim Rahasia"), JSON.stringify(bDir.ok ? bTeams : bDir.error));
  const aDir = await must("A", "get_directory");
  check("B tercatat dikeluarkan di laptop A", memberOf(aDir, pk.B)?.status === "removed");
  const aOnline = await onlineNames("A");
  check("B tidak lagi tersambung ke A", !aOnline.includes(NODES.B.name), JSON.stringify(aOnline));
  await reload("B");
  await sleep(1500);
  await running.B.page.screenshot({ path: join(shots, "dikeluarkan-b.png") });
} catch (err) {
  check("Skrip berjalan tanpa error", false, String(err?.message ?? err));
}

for (const id of Object.keys(running)) await stop(id);
for (const target of miraCredentials()) {
  if (!credentialsBefore.has(target)) {
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
