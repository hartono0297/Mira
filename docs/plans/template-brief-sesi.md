# Template brief untuk sesi kerja Mira

Session utama memakai template ini setiap kali memulai sesi baru untuk satu task: fitur baru, perubahan fitur, atau perbaikan fitur. Bagian khusus task ditulis di atas, dan aturan tetap di bawah ini disalin ke setiap brief.

## Bagian khusus task

- **Task:** apa yang diminta user, dengan kutipan kata-katanya.
- **Baca dulu:** laporan dan rencana terkait di `docs/progress/` dan `docs/plans/`, serta kontrak kalau ada (misalnya `docs/plans/v0.3-kontrak.md`).
- **Lingkup:** apa yang dibuat, dan apa yang bukan bagian sesi ini.
- **Milik sesi ini:** folder dan file yang boleh diubah. File lain hanya dibaca.
- **Selesai berarti:** tes apa yang harus lulus, uji ujung ke ujung mana yang dijalankan, dan laporan di `docs/progress/<nama>.md`.

## Aturan tetap

**Cara kerja**
- Ikuti alur ala superpowers:
  - tulis rencana di `docs/plans/<nama>.md`;
  - pecah jadi tugas kecil dan pakai TDD;
  - minta reviewer terpisah (keamanan atau tampilan);
  - verifikasi sebelum menyatakan selesai.
- **Wajib: panggil subagent sebanyak mungkin, supaya cepat.**
  - Pecah setiap pekerjaan sampai ke bagian-bagian yang bisa dikerjakan bersamaan, lalu kirim beberapa Agent sekaligus dalam satu pesan.
  - Selama satu subagent menunggu build atau tes, jangan biarkan bagian lain yang sudah bisa jalan menganggur. Mulai juga subagent untuk bagian itu.
  - Reviewer, penulis tes, dan pengerjaan uji ujung ke ujung juga dikerjakan subagent.
  - Satu-satunya batas: tugas yang paralel tidak boleh mengedit file yang sama, dan uji ujung ke ujung dijalankan satu per satu, karena memakai port dan Credential Manager yang sama.
- Untuk tampilan dan teks, muat skill `antislop:antislop`, `antislop:antislop-ui`, `antislop:antislop-human`, dan `antislop:antislop-copywriting` sebelum menulis baris pertama.
  - Cek pasangan warna dengan `check_contrast`.
  - Jangan pakai em dash.
  - Tulis dalam bahasa Indonesia.
  - Fokus harus terlihat.
  - Subagent UI juga wajib memuat skill ini.
- Jangan tanya user. Ambil keputusan yang wajar dan catat di laporan.

**Hemat disk**
- Build dan tes hanya di dalam worktree sesi ini, yang ada di D:. Jangan pernah membangun Rust, membuat folder `target`, atau menyalin `node_modules` di folder sementara atau scratchpad, karena letaknya di C:. Aturan yang sama berlaku untuk `CARGO_TARGET_DIR`: jangan diarahkan ke scratchpad. Dulu satu sesi membuat folder build 20 GB di scratchpad, dan sisa ruang C: tinggal kurang dari 1 GB.
- Subagent yang butuh worktree sendiri boleh memakainya. Kalau tugasnya hanya membaca atau mengedit file yang terpisah, pakai worktree sesi saja supaya tidak ada folder build tambahan.
- Data uji (`MIRA_DATA_DIR`) dan screenshot sementara boleh di scratchpad, karena ukurannya kecil. Hapus setelah selesai.
- Jangan menjalankan build release kalau build debug sudah cukup untuk uji.

**Keamanan dan kebersihan**
- Pakai `MIRA_DATA_DIR` dan `MIRA_PORT` di folder sementara.
- Hentikan hanya proses yang dijalankan sesi ini.
- Jangan ubah pengaturan sistem atau firewall.
- Commit lokal di branch sesi ini dengan pesan bahasa Indonesia yang diakhiri baris atribusi yang berlaku.
- Boleh push branch sesi (bukan `main`) untuk melihat CI. Jangan force-push, jangan pasang tag, dan jangan merge ke `main`.
- Jangan pernah meng-commit kunci, token, atau secret.

## Yang dilakukan session utama

- Menjalankan paling banyak 4 sampai 5 sesi bersamaan. Task berikutnya menunggu sampai ada sesi yang selesai dan digabung.
- Menyalakan Remote Control setiap sesi baru.
- Setelah sesi selesai, memeriksa hasilnya, menggabungkan, lalu menghapus sesi beserta worktree dan branch-nya supaya folder build ikut hilang.
