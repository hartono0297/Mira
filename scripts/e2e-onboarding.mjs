// Langkah bersama untuk skrip uji ujung ke ujung (v0.4).
//
// - menuName / mainNav: tombol menu utama dicari dengan awalan, karena angka
//   notifikasi menambah teks ke nama tombol ("Chat, 3 belum dibaca", dan Chrome
//   kadang menyisipkan spasi sebelum koma: "Board , 1 task ...").
// - Onboarding v0.4 lewat tampilan sungguhan: nama (langkah 1), firewall (hanya
//   kalau aturan Mira belum ada, dilewati tanpa mengubah Windows), pencarian
//   kantor, lalu hasilnya.
// - newOffice: laptop pertama kantor. "Kantor belum ditemukan", buka bagian
//   "Untuk admin IT", "Siapkan Mira untuk kantor baru", isi nama organisasi,
//   nama Anda, departemen, dan ketik ulang nama organisasi. Kantor baru selalu
//   punya departemen.
//
// Laptop lain di jaringan yang mengumumkan organisasi menyembunyikan tombol
// kantor baru (juga di dalam bagian admin IT). Jalankan instance uji dengan
// MIRA_DISABLE_MDNS=1 supaya pencarian cepat selesai dan tidak melihat Mira
// lain di PC ini.

export const menuName = (name) => new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*(,|$)");

export const mainNav = (page, name) =>
  page.getByRole("navigation", { name: "Menu utama" }).getByRole("button", { name: menuName(name) });

const RESULT_HEADING = /^(Mencari kantor di jaringan|Kantor ditemukan|Beberapa kantor ditemukan|Kantor belum ditemukan)/;
const FIREWALL_HEADING = "Izinkan Mira di jaringan kantor";

// Langkah 1 dari 3: layar nama. Menunggu sampai layar itu tampil.
export async function waitNameStep(page, timeout = 20000) {
  await page.getByRole("button", { name: "Lanjut", exact: true }).waitFor({ state: "visible", timeout });
}

// Mengisi nama di langkah 1 lalu Lanjut.
export async function passName(page, name) {
  await waitNameStep(page);
  await page.getByLabel("Nama tampilan", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Lanjut", exact: true }).click();
}

// Setelah langkah nama: layar firewall hanya tampil kalau aturan Mira belum ada.
// Hasil: teks tombol yang diklik, atau null kalau layar firewall dilewati sendiri.
export async function passFirewall(page) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const fw = page.getByRole("heading", { name: FIREWALL_HEADING });
    if (await fw.isVisible().catch(() => false)) {
      const btn = page.getByRole("button", { name: /^(Cari kantor|Lewati, atur nanti)$/ });
      await btn.waitFor({ state: "visible", timeout: 20000 });
      const label = (await btn.innerText()).trim();
      await btn.click();
      return label;
    }
    const h = page.locator("h1.onb-title").first();
    if (await h.isVisible().catch(() => false)) {
      const text = (await h.innerText().catch(() => "")).trim();
      if (RESULT_HEADING.test(text)) return null;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Setelah langkah nama, layar firewall atau pencarian tidak tampil");
}

// Dari layar nama sampai layar "Kantor belum ditemukan" (pencarian paling lama 15 detik).
export async function reachNotFound(page, name = "Pengguna Uji") {
  await passName(page, name);
  await passFirewall(page);
  await page.getByRole("heading", { name: "Kantor belum ditemukan" }).waitFor({ timeout: 40000 });
}

// Membuka bagian lipat "Untuk admin IT" di layar "Kantor belum ditemukan".
export async function openAdminIT(page) {
  const summary = page.locator("summary", { hasText: "Untuk admin IT" });
  await summary.waitFor({ state: "visible", timeout: 10000 });
  const open = await summary.evaluate((el) => el.parentElement?.hasAttribute("open") ?? false);
  if (!open) await summary.click();
}

// Mengisi layar "Siapkan Mira untuk kantor baru" (sudah terbuka).
export async function fillNewOffice(page, { name, org, dept }) {
  await page.getByRole("heading", { name: "Siapkan Mira untuk kantor baru" }).waitFor({ timeout: 10000 });
  await page.getByLabel("Nama organisasi", { exact: true }).fill(org);
  await page.getByLabel("Nama Anda", { exact: true }).fill(name);
  await page.getByLabel("Departemen Anda", { exact: true }).fill(dept);
  await page.getByLabel("Ketik ulang nama organisasi", { exact: true }).fill(org);
}

// Membuat kantor baru. `shot(file)` opsional dipanggil sebelum menekan Buat organisasi.
export async function newOffice(page, { name, org, dept }, { shot } = {}) {
  await reachNotFound(page, name);
  await openAdminIT(page);
  await page.getByRole("button", { name: "Siapkan Mira untuk kantor baru", exact: true }).click();
  await fillNewOffice(page, { name, org, dept });
  if (shot) await shot();
  await page.getByRole("button", { name: "Buat organisasi" }).click();
  await page.getByRole("navigation", { name: "Menu utama" }).waitFor({ timeout: 20000 });
}
