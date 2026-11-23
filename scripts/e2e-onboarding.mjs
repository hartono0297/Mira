// Langkah bersama untuk skrip uji ujung ke ujung (v0.3).
//
// - menuName / mainNav: tombol menu utama dicari dengan awalan, karena angka
//   notifikasi menambah teks ke nama tombol ("Chat, 3 belum dibaca", dan Chrome
//   kadang menyisipkan spasi sebelum koma: "Board , 1 task ...").
// - newOffice: onboarding v0.3 lewat tampilan sungguhan untuk laptop pertama
//   kantor: firewall (dilewati tanpa mengubah Windows), pencarian kantor,
//   "Kantor belum ditemukan", lalu "Siapkan Mira untuk kantor baru" dengan nama
//   organisasi, nama Anda, dan departemen. Kantor baru selalu punya departemen.
//
// Laptop lain di jaringan yang mengumumkan organisasi menyembunyikan pilihan
// kantor baru. Jalankan instance uji dengan MIRA_DISABLE_MDNS=1 supaya pencarian
// cepat selesai dan tidak melihat Mira lain di PC ini.

export const menuName = (name) => new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*(,|$)");

export const mainNav = (page, name) =>
  page.getByRole("navigation", { name: "Menu utama" }).getByRole("button", { name: menuName(name) });

// Langkah 1 dari 3. Hasil: teks tombol yang diklik.
export async function passFirewall(page) {
  await page.getByRole("heading", { name: "Izinkan Mira di jaringan kantor" }).waitFor({ timeout: 20000 });
  const btn = page.getByRole("button", { name: /^(Cari kantor|Lewati, atur nanti)$/ });
  await btn.waitFor({ state: "visible", timeout: 20000 });
  const label = (await btn.innerText()).trim();
  await btn.click();
  return label;
}

// Dari layar firewall sampai layar "Kantor belum ditemukan" (pencarian paling lama 15 detik).
export async function reachNotFound(page) {
  await passFirewall(page);
  await page.getByRole("heading", { name: "Kantor belum ditemukan" }).waitFor({ timeout: 40000 });
}

// Membuat kantor baru. `shot(file)` opsional dipanggil sebelum menekan Buat organisasi.
export async function newOffice(page, { name, org, dept }, { shot } = {}) {
  await reachNotFound(page);
  await page.getByRole("button", { name: "Siapkan Mira untuk kantor baru (khusus superadmin)" }).click();
  await page.getByRole("heading", { name: "Siapkan Mira untuk kantor baru" }).waitFor({ timeout: 10000 });
  await page.getByLabel("Nama organisasi").fill(org);
  await page.getByLabel("Nama Anda").fill(name);
  await page.getByLabel("Departemen Anda").fill(dept);
  if (shot) await shot();
  await page.getByRole("button", { name: "Buat organisasi" }).click();
  await page.getByRole("navigation", { name: "Menu utama" }).waitFor({ timeout: 20000 });
}
