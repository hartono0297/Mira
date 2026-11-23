// Uji ujung ke ujung Board v0.4 (subtask, timer, durasi status) antar dua "laptop"
// Mira di satu PC, lewat transport jaringan sungguhan (QUIC di 127.0.0.1, mDNS).
//
// Pola sama dengan e2e-fitur-multi.mjs: dua instance mira.exe, masing-masing dengan
// folder data (MIRA_DATA_DIR), port QUIC (MIRA_PORT), dan port debug WebView2 sendiri,
// dikendalikan lewat Chrome DevTools Protocol. Organisasi, proyek, dan aksi board
// dijalankan lewat command Tauri (IPC); hasilnya dibandingkan lewat board_get_task di
// kedua laptop, ditambah kartu di layar B dan screenshot dialog detail task.
//
//   A  Ayu   superadmin, membuat kantor, departemen Desain, proyek, dan task
//   B  Budi  bergabung dengan kode undangan (disetujui lewat undangan A), anggota proyek
//
// Konflik offline: A dimatikan, B mengubah judul subtask X dan menambah subtask, B
// dimatikan, A dinyalakan lalu menghapus X dan menambah subtask, B dinyalakan lagi.
// Hasil akhir harus sama di kedua laptop (hapus menang atas ubah judul).
//
// Dialog detail task hanya dibuka lewat [data-open-task="<id>"] untuk screenshot,
// tanpa mengubah isinya (isi dialog diuji di board-e2e.mjs).
//
// Pakai:  node scripts/board-v04-multi-e2e.mjs <path mira.exe> <folder screenshot> [folder induk data]
// Folder data dibuat di bawah folder induk (bawaan: folder temp) dan dihapus di akhir.
// E2E_PORT_OFFSET menggeser semua port supaya bisa jalan berdampingan dengan uji lain.

import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { mainNav } from "./e2e-onboarding.mjs";

const exe = resolve(process.argv[2] ?? "src-tauri/target/debug/mira.exe");
const shots = resolve(process.argv[3] ?? "docs/progress/screenshots/v04-board");
const parent = resolve(process.argv[4] ?? tmpdir());
mkdirSync(shots, { recursive: true });
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, "mira-board-v04-"));

const PORT_OFFSET = Number(process.env.E2E_PORT_OFFSET ?? 0) || 0;
const NODES = {
  A: { name: "Ayu Uji", port: 47891 + PORT_OFFSET, cdp: 9391 + PORT_OFFSET, dir: join(root, "laptop-a") },
  B: { name: "Budi Uji", port: 47892 + PORT_OFFSET, cdp: 9392 + PORT_OFFSET, dir: join(root, "laptop-b") },
};
const addr = (id) => `127.0.0.1:${NODES[id].port}`;
// Sinkron berjalan saat ada perubahan, ditambah cadangan berkala 60 detik; board polling 15 detik.
const SYNC_MS = 150000;

const ORG = "Kantor Uji Board v04";
const DEPT = "Desain";
const PROJECT = "Proyek Sampul Katalog";
const PROJECT_CODE = "SK";
const TASK = "Desain sampul katalog 2027";
const SUB = {
  s1: "Kumpulkan referensi warna",
  s2: "Buat sketsa kasar",
  s3: "Kirim draf ke klien",
  s4: "Periksa ejaan teks sampul",
  s3Renamed: "Kirim draf ke klien (diubah Budi saat offline)",
  offB: "Tambahan Budi saat offline",
  offA: "Tambahan Ayu saat offline",
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
// Kunci laptop uji milik skrip ini. Di akhir hanya kunci ini yang dihapus, supaya kunci
// uji lain yang berjalan bersamaan tidak ikut hilang (lihat e2e-fitur-multi.mjs).
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
      // Cek pembaruan diarahkan ke alamat mati: tidak ada panggilan internet atau dialog pembaruan.
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
  if (!browser) throw new Error(`WebView2 ${id} tidak bisa dihubungi lewat CDP`);
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
  return running[id];
}

async function stop(id) {
  const app = running[id];
  if (!app) return;
  delete running[id];
  await app.browser.close().catch(() => {});
  try {
    // Hanya pohon proses yang dijalankan skrip ini.
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
async function waitFor(desc, fn, timeoutMs = SYNC_MS, everyMs = 1000) {
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
// Seperti waitFor, tapi kegagalan dikembalikan sebagai teks, bukan dilempar.
const settle = (desc, fn, timeoutMs) => waitFor(desc, fn, timeoutMs).catch((e) => String(e.message));
// Satu bagian uji. Error di dalamnya dicatat GAGAL, bagian berikutnya tetap jalan.
async function section(name, fn) {
  try {
    await fn();
  } catch (err) {
    check(`${name}: berjalan tanpa error`, false, String(err?.message ?? err).slice(0, 400));
    for (const id of Object.keys(running)) {
      await shot(id, `v04-gagal-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${id.toLowerCase()}.png`);
    }
  }
}

const page = (id) => running[id].page;
const shot = (id, name) => page(id).screenshot({ path: join(shots, name) }).catch(() => {});
const onlineNames = async (id) =>
  (await must(id, "get_network_status")).peers.filter((p) => p.online).map((p) => p.displayName).sort();
async function waitOnline(desc) {
  for (const id of ["A", "B"]) {
    const other = NODES[id === "A" ? "B" : "A"].name;
    await waitFor(`${desc}: ${id} melihat ${other} online`, async () => (await onlineNames(id)).includes(other));
  }
}

// ---- Data board ----
let projectId = null;
let taskId = null;
const ids = {};
const pk = {};

const getTask = async (id) => {
  const r = await call(id, "board_get_task", { projectId, taskId });
  return r.ok ? r.value : null;
};
const getCard = async (id) => {
  const r = await call(id, "board_get_board", { projectId });
  return r.ok ? r.value.columns.flatMap((c) => c.tasks).find((t) => t.id === taskId) ?? null : null;
};
// Bentuk subtask yang dibandingkan antar laptop: urutan, judul, centang, penanggung jawab.
const normSubs = (d) =>
  d.subtasks.map((s) => ({ id: s.id, title: s.title, done: s.done, assignee: s.assignee?.publicKey ?? null }));
const subsKey = (d) => JSON.stringify(normSubs(d));
const describeSubs = (d) =>
  d ? d.subtasks.map((s) => `${s.done ? "[x]" : "[ ]"} ${s.title}${s.assignee ? ` @${s.assignee.name}` : ""}`).join(" | ") : "tidak terbaca";
const totalsKey = (d) =>
  JSON.stringify(
    d.timeTotals
      .map((t) => ({ who: t.person.publicKey, secs: t.secs, running: t.runningSince }))
      .sort((x, y) => x.who.localeCompare(y.who)),
  );
const totalSecs = (d) => d.timeTotals.reduce((n, t) => n + t.secs, 0);
const secsOf = (d, who) => d.timeTotals.find((t) => t.person.publicKey === who)?.secs ?? null;

// ---- Layar ----
const projectNav = (p) => p.getByRole("navigation", { name: "Task saya dan proyek" });
const openBtn = (p) => p.locator(`[data-open-task="${taskId}"]`);
// Seluruh kartu (bukan bayangan seret, yang tidak punya data-card): progres subtask ada di metadata kartu.
const cardEl = (p) => p.locator(`section.pb-col [data-card="${taskId}"]`);

async function waitShell(id) {
  await mainNav(page(id), "Board").waitFor({ timeout: 30000 });
}
async function setTheme(id, label) {
  await mainNav(page(id), "Pengaturan").click();
  await page(id).getByLabel(label, { exact: true }).check();
  await sleep(300);
}
async function goProject(id) {
  const p = page(id);
  await mainNav(p, "Board").click();
  await projectNav(p).getByRole("button", { name: new RegExp(PROJECT) }).click({ timeout: SYNC_MS });
  await openBtn(p).waitFor({ timeout: 30000 });
}
// Dialog detail task v0.4. Pilihan Tenggat, Label, dan Hentikan timer juga
// role=dialog di dalamnya, jadi dialog task dikenali dari tombol Tutup-nya.
const taskDialog = (p) =>
  p.getByRole("dialog").filter({ has: p.getByRole("button", { name: "Tutup detail task" }) });
async function openDetail(id) {
  const p = page(id);
  await openBtn(p).click();
  // Tunggu tombol Tutup, bukan isian judul: anggota hanya-baca tidak punya isian judul.
  await taskDialog(p).waitFor({ timeout: 15000 });
}
async function closeDetail(id) {
  const p = page(id);
  const dlg = taskDialog(p);
  await p.keyboard.press("Escape");
  const hidden = await dlg
    .waitFor({ state: "hidden", timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  if (!hidden) await dlg.getByRole("button", { name: "Tutup detail task" }).click({ timeout: 3000 }).catch(() => {});
  await sleep(300);
}

try {
  // ---------- Persiapan: kantor, B bergabung, proyek dengan B ----------
  for (const id of Object.keys(NODES)) await launch(id);
  for (const id of Object.keys(NODES)) await must(id, "save_display_name", { name: NODES[id].name });
  for (const id of Object.keys(NODES)) {
    pk[id] = (await must(id, "get_app_state")).identity.publicKey;
    ownKeys.add(keyTarget(pk[id]));
  }

  await must("A", "create_organization", { name: ORG });
  const dept = await must("A", "org_create_department", { name: DEPT });
  await must("A", "org_move_member", { publicKey: pk.A, teamId: dept.id });
  const invite = await must("A", "create_invite", { teamId: dept.id, role: "member", validity: "24h", projectIds: [] });
  const joinB = await call("B", "join_with_code", { code: invite.code, address: addr("A") });
  if (!joinB.ok) throw new Error(`B gagal bergabung: ${JSON.stringify(joinB.error)}`);
  await waitFor("A melihat B aktif", async () => {
    const d = await must("A", "get_directory");
    return d.members.some((m) => m.publicKey === pk.B && m.status === "active");
  });
  await waitOnline("Persiapan");
  const bState = await must("B", "get_app_state");
  check("Persiapan: B bergabung lewat kode undangan A dan keduanya online", bState.organization?.name === ORG, secs(t0));

  const project = await must("A", "board_create_project", { name: PROJECT, code: PROJECT_CODE, teamId: dept.id, members: [pk.B] });
  projectId = project.id;
  const pm = await must("A", "org_project_members", { projectId });
  const onB = await settle("proyek muncul di B", async () => (await must("B", "board_list_projects")).some((p) => p.id === projectId));
  check(
    "Persiapan: A membuat proyek dengan B sebagai anggota, proyek terlihat di B",
    pm.members.some((m) => m.publicKey === pk.B) && onB === true,
    onB === true ? `${pm.members.length} anggota` : onB,
  );

  for (const id of Object.keys(NODES)) {
    await page(id).reload();
    await page(id).waitForFunction(() => "__TAURI_INTERNALS__" in window, null, { timeout: 20000 });
    await waitShell(id);
    await setTheme(id, "Terang");
  }

  // ---------- 1. A: task dengan tiga subtask ----------
  await section("1. Subtask dari A", async () => {
    const task = await must("A", "board_create_task", { projectId, input: { title: TASK, columnId: "todo" } });
    taskId = task.id;
    const base = { projectId, taskId };
    for (const k of ["s1", "s2", "s3"]) {
      const d = await must("A", "board_add_subtask", { ...base, title: SUB[k], assignee: null });
      ids[k] = d.subtasks.find((s) => s.title === SUB[k])?.id;
    }
    await must("A", "board_update_subtask", { ...base, subtaskId: ids.s1, patch: { done: true } });
    await must("A", "board_move_subtask", { ...base, subtaskId: ids.s3, index: 0 });
    const d = await must("A", "board_update_subtask", { ...base, subtaskId: ids.s2, patch: { assignee: pk.B } });
    const want = [
      { id: ids.s3, title: SUB.s3, done: false, assignee: null },
      { id: ids.s1, title: SUB.s1, done: true, assignee: null },
      { id: ids.s2, title: SUB.s2, done: false, assignee: pk.B },
    ];
    check(
      "1. A: tiga subtask, satu dicentang, satu dipindah ke atas, satu untuk Budi",
      subsKey(d) === JSON.stringify(want) && d.subtaskDone === 1 && d.subtaskTotal === 3,
      describeSubs(d),
    );
  });

  // ---------- 2. B melihat subtask yang sama ----------
  await section("2. Subtask sampai ke B", async () => {
    const since = Date.now();
    const a = await getTask("A");
    const same = await settle("detail task di B sama dengan A", async () => {
      const b = await getTask("B");
      return b && subsKey(b) === subsKey(a) ? b : null;
    });
    check(
      "2. Detail task di B: tiga subtask dengan urutan, centang, dan penanggung jawab yang sama dengan A",
      typeof same === "object",
      typeof same === "object" ? `${secs(since)}: ${describeSubs(same)}` : same,
    );
    const cardData = await getCard("B");
    check(
      "2. Kartu di board_get_board B: subtaskDone 1, subtaskTotal 3",
      cardData?.subtaskDone === 1 && cardData?.subtaskTotal === 3,
      JSON.stringify({ done: cardData?.subtaskDone, total: cardData?.subtaskTotal }),
    );
    await goProject("B");
    let cardText = "";
    const shown = await settle("kartu di board B menampilkan 1/3", async () => {
      cardText = await cardEl(page("B")).innerText();
      return /(^|[^\d])1\s*\/\s*3([^\d]|$)/.test(cardText);
    }, 60000);
    check(
      "2. Kartu di layar board B menampilkan 1/3",
      shown === true,
      `${shown === true ? "" : `${shown}; `}teks kartu: ${cardText.replace(/\s+/g, " ").slice(0, 160)}`,
    );
    await shot("B", "v04-01-board-kartu-b.png");
  });

  // ---------- 3. B mencentang dan menambah, A melihat ----------
  await section("3. Perubahan subtask dari B", async () => {
    const base = { projectId, taskId };
    await must("B", "board_update_subtask", { ...base, subtaskId: ids.s2, patch: { done: true } });
    const d = await must("B", "board_add_subtask", { ...base, title: SUB.s4, assignee: null });
    ids.s4 = d.subtasks.find((s) => s.title === SUB.s4)?.id;
    const since = Date.now();
    const onA = await settle("A melihat perubahan B", async () => {
      const a = await getTask("A");
      const b = await getTask("B");
      return a && b && subsKey(a) === subsKey(b) && a.subtaskDone === 2 && a.subtaskTotal === 4 ? a : null;
    });
    check(
      "3. B mencentang subtask lain dan menambah satu; A melihat 2/4 yang sama dengan B",
      typeof onA === "object",
      typeof onA === "object" ? `${secs(since)}: ${describeSubs(onA)}` : onA,
    );
    const s4 = typeof onA === "object" ? onA.subtasks.find((s) => s.id === ids.s4) : null;
    check("3. Subtask baru dari B tercatat dibuat oleh Budi di A", s4?.createdBy?.publicKey === pk.B, s4?.createdBy?.name ?? "tidak ada");
  });

  // ---------- 4. Timer dan catatan waktu ----------
  let aEntryId = null;
  await section("4. Timer dan catatan waktu", async () => {
    const base = { projectId, taskId };
    const started = await must("A", "board_start_timer", base);
    aEntryId = started.myRunningEntry;
    check("4. A memulai timer: myRunningEntry terisi di A", Boolean(aEntryId), String(aEntryId));
    const since = Date.now();
    const seen = await settle("B melihat timer A berjalan di kartu", async () => {
      const c = await getCard("B");
      return c && c.timersRunningSince.length > 0 ? c.timersRunningSince : null;
    });
    check(
      "4. Kartu di B: timersRunningSince tidak kosong saat timer A berjalan",
      Array.isArray(seen) && seen.length === 1,
      Array.isArray(seen) ? `${secs(since)}: ${seen.join(", ")}` : seen,
    );
    await sleep(2000);
    const stopped = await must("A", "board_stop_timer", { ...base, note: "Sketsa awal" });
    check(
      "4. A menghentikan timer: tidak ada timer berjalan, catatan A punya waktu akhir",
      stopped.myRunningEntry === null && stopped.timeEntries.some((e) => e.id === aEntryId && e.end !== null && e.mine),
      `catatan=${stopped.timeEntries.length}`,
    );
    const logged = await must("B", "board_log_time", { ...base, minutes: 30, note: "Revisi warna" });
    check(
      "4. B mencatat waktu manual 30 menit",
      logged.timeEntries.some((e) => e.manual && e.secs === 1800 && e.person.publicKey === pk.B),
      `total B=${secsOf(logged, pk.B)} dtk`,
    );
    const both = await settle("A dan B melihat total waktu yang sama", async () => {
      const a = await getTask("A");
      const b = await getTask("B");
      if (!a || !b) return null;
      const ok =
        totalsKey(a) === totalsKey(b) &&
        a.timeTotals.length === 2 &&
        secsOf(a, pk.B) === 1800 &&
        secsOf(a, pk.A) > 0 &&
        a.timeTotals.every((t) => t.runningSince === null);
      return ok ? { a, b } : null;
    });
    check(
      "4. timeTotals di A dan B: dua orang, angka per orang dan total sama",
      typeof both === "object" && totalSecs(both.a) === totalSecs(both.b),
      typeof both === "object"
        ? `Ayu ${secsOf(both.a, pk.A)} dtk, Budi ${secsOf(both.a, pk.B)} dtk, total ${totalSecs(both.a)} dtk`
        : both,
    );
    const cards = await settle("kartu A dan B sama", async () => {
      const ca = await getCard("A");
      const cb = await getCard("B");
      return ca && cb && ca.trackedSecs === cb.trackedSecs && ca.trackedSecs > 1800 && cb.timersRunningSince.length === 0 ? { ca, cb } : null;
    }, 60000);
    check(
      "4. trackedSecs kartu sama di A dan B, tanpa timer berjalan",
      typeof cards === "object",
      typeof cards === "object" ? `${cards.ca.trackedSecs} dtk` : cards,
    );
  });

  // ---------- 5. Durasi status ----------
  await section("5. Durasi status", async () => {
    await must("A", "board_move_task", { projectId, taskId, columnId: "doing", index: 0 });
    await sleep(1500);
    await must("A", "board_move_task", { projectId, taskId, columnId: "done", index: 0 });
    const a = await getTask("A");
    check(
      "5. A: statusTime.currentColumn = done dan cycleSecs terisi",
      a?.statusTime?.currentColumn === "done" && a?.statusTime?.cycleSecs !== null && a?.statusTime?.cycleSecs !== undefined,
      JSON.stringify(a?.statusTime),
    );
    const since = Date.now();
    const b = await settle("B melihat task di Selesai dengan cycle time", async () => {
      const d = await getTask("B");
      return d?.statusTime?.currentColumn === "done" && d.statusTime.cycleSecs != null ? d : null;
    });
    check(
      "5. B: statusTime.currentColumn = done dan cycleSecs sama dengan A",
      typeof b === "object" && b.statusTime.cycleSecs === a?.statusTime?.cycleSecs,
      typeof b === "object" ? `${secs(since)}: cycle A=${a?.statusTime?.cycleSecs}, B=${b.statusTime.cycleSecs}, peringatan jam=${b.statusTime.clockWarning}` : b,
    );
  });

  // ---------- 6. B tidak boleh menghapus catatan waktu A ----------
  await section("6. Hapus catatan waktu orang lain", async () => {
    const bView = await getTask("B");
    const entry = bView?.timeEntries.find((e) => e.person.publicKey === pk.A);
    check("6. Catatan waktu A terlihat di B sebagai bukan milik B", Boolean(entry) && entry.mine === false, entry ? entry.id : "tidak ada");
    const r = await call("B", "board_delete_time_entry", { projectId, taskId, entryId: entry?.id ?? aEntryId });
    check(
      "6. B menghapus catatan waktu milik A: ditolak",
      !r.ok,
      r.ok ? "malah berhasil" : `${r.error?.code ?? ""}: ${r.error?.message ?? JSON.stringify(r.error)}`.slice(0, 200),
    );
    await sleep(3000);
    const a = await getTask("A");
    const b = await getTask("B");
    check(
      "6. Catatan waktu A tetap ada di A dan B",
      [a, b].every((d) => d?.timeEntries.some((e) => e.id === (entry?.id ?? aEntryId))),
      `A=${a?.timeEntries.length}, B=${b?.timeEntries.length}`,
    );
  });

  // ---------- 7. Screenshot detail task, terang dan gelap ----------
  await section("7. Screenshot detail task", async () => {
    for (const [label, suffix] of [
      ["Terang", "terang"],
      ["Gelap", "gelap"],
    ]) {
      for (const id of ["A", "B"]) {
        await setTheme(id, label);
        await goProject(id);
        await openDetail(id);
        await sleep(700);
        await shot(id, `v04-02-detail-task-${id.toLowerCase()}-${suffix}.png`);
        check(`7. Dialog detail task terbuka di ${id} (${suffix})`, (await taskDialog(page(id)).count()) === 1);
        await closeDetail(id);
      }
    }
    for (const id of ["A", "B"]) await setTheme(id, "Terang");
  });

  // ---------- 8. Konflik offline ----------
  await section("8. Konflik offline", async () => {
    const base = { projectId, taskId };
    // A mati: perubahan B hanya ada di laptop B.
    await stop("A");
    let b = await must("B", "board_update_subtask", { ...base, subtaskId: ids.s3, patch: { title: SUB.s3Renamed } });
    b = await must("B", "board_add_subtask", { ...base, title: SUB.offB, assignee: null });
    ids.offB = b.subtasks.find((s) => s.title === SUB.offB)?.id;
    check(
      "8. B (A mati) mengubah judul subtask X dan menambah subtask",
      b.subtasks.some((s) => s.id === ids.s3 && s.title === SUB.s3Renamed) && Boolean(ids.offB),
      describeSubs(b),
    );
    await stop("B");

    // A menyala sendirian (B mati): hapus X dan tambah subtask.
    checkOwnKeys("sebelum A menyala lagi");
    await launch("A");
    await waitShell("A");
    await must("A", "board_delete_subtask", { ...base, subtaskId: ids.s3 });
    const a = await must("A", "board_add_subtask", { ...base, title: SUB.offA, assignee: null });
    ids.offA = a.subtasks.find((s) => s.title === SUB.offA)?.id;
    check(
      "8. A (B mati) menghapus subtask X dan menambah subtask",
      !a.subtasks.some((s) => s.id === ids.s3) && Boolean(ids.offA),
      describeSubs(a),
    );

    // Keduanya menyala.
    checkOwnKeys("sebelum B menyala lagi");
    const since = Date.now();
    await launch("B");
    await waitShell("B");
    await waitOnline("Setelah konflik");
    const merged = await settle("A dan B sama setelah konflik", async () => {
      const da = await getTask("A");
      const db = await getTask("B");
      if (!da || !db) return null;
      const hasBoth = (d) => d.subtasks.some((s) => s.id === ids.offA) && d.subtasks.some((s) => s.id === ids.offB);
      return subsKey(da) === subsKey(db) && hasBoth(da) && hasBoth(db) ? { da, db } : null;
    });
    check(
      "8. Setelah keduanya menyala: daftar subtask sama di A dan B",
      typeof merged === "object",
      typeof merged === "object" ? `${secs(since)}: ${describeSubs(merged.da)}` : merged,
    );
    if (typeof merged === "object") {
      const { da, db } = merged;
      check(
        "8. Subtask X yang dihapus A tetap terhapus di kedua laptop walau judulnya diubah B",
        !da.subtasks.some((s) => s.id === ids.s3) && !db.subtasks.some((s) => s.id === ids.s3),
        `A=${da.subtaskTotal}, B=${db.subtaskTotal}`,
      );
      check(
        "8. Subtask tambahan dari kedua laptop ada di A dan B, progres sama",
        da.subtaskDone === db.subtaskDone && da.subtaskTotal === db.subtaskTotal && da.subtaskTotal === 5,
        `${da.subtaskDone}/${da.subtaskTotal}`,
      );
      check(
        "8. Catatan waktu dan durasi status tetap sama di A dan B setelah restart",
        totalsKey(da) === totalsKey(db) && da.statusTime.currentColumn === db.statusTime.currentColumn && da.statusTime.cycleSecs === db.statusTime.cycleSecs,
        `total ${totalSecs(da)} dtk, kolom ${da.statusTime.currentColumn}`,
      );
    }
    for (const id of ["A", "B"]) {
      await setTheme(id, "Terang");
      await goProject(id);
      await openDetail(id);
      await sleep(700);
      await shot(id, `v04-03-setelah-konflik-${id.toLowerCase()}-terang.png`);
      await closeDetail(id);
    }
  });
} catch (err) {
  check("Skrip berjalan tanpa error", false, String(err?.message ?? err).slice(0, 400));
  for (const id of Object.keys(running)) await shot(id, `v04-gagal-${id.toLowerCase()}.png`);
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
// Kunci publik belum terbaca (gagal sangat awal): kembali ke cara lama, semua kunci baru.
const toDelete = ownKeys.size ? ownKeys : new Set([...miraCredentials()].filter((t) => !credentialsBefore.has(t)));
const present = miraCredentials();
for (const target of toDelete) {
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
