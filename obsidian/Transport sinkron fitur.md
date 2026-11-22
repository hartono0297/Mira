---
tags: [mira, jaringan, sinkron]
---

# Transport sinkron fitur

Transport memberi kontrak `network/feature.rs` jalur sungguhan di atas koneksi anggota [[Tahap 1]]. Chat dan board sudah memakainya. Dokumen dan tanda tangan belum tersambung. Status: selesai dan sudah digabung di branch `integrasi-fitur`.

## Sesi sinkron

Satu stream per pasangan (rekan, topik):
1. Pengirim mengirim `FeatureHave` berisi paling banyak 8192 id.
2. Penerima membalas `FeatureWant` berisi id yang belum ia punya.
3. Pengirim mengirim `FeatureRecords` (paling banyak 512 record atau sekitar 1 MiB per frame).
4. Penerima hanya menyimpan record yang ia minta, menjalankan `check_incoming`, lalu `ingest`. Kalau ada yang berubah, tampilan menerima `mira://feature`.

Record yang dibuang dicatat dengan kode `feature_records_dropped`. Topik yang tidak dikenal penerima hanya menghentikan stream itu; topik lain tetap jalan.

## Kapan sinkron

- Rekan tersambung: semua topik ditawarkan penuh.
- Perubahan lokal: digabung dengan jeda 250 ms, lalu hanya id baru yang ditawarkan.
- Gosip: record yang diterima diteruskan ke rekan lain.
- Op keanggotaan baru: semua topik ditawarkan penuh, karena cakupan data bisa berubah.
- Cadangan berkala tiap 60 detik.

## Unduh blob

Setiap unduhan memakai stream sendiri: `BlobGet`, lalu `BlobHeader { size }` dan isi file, atau `BlobRefused { code }`. Server memeriksa izin untuk setiap permintaan dan mengulanginya setiap 4 MiB. Peminta menulis ke file sementara, menolak kalau ukuran melebihi batas atau hash BLAKE3 tidak cocok, dan baru memindahkan file kalau semuanya cocok.

## Keputusan penting

- Tawaran delta, bukan selalu penuh. Review keamanan menunjukkan bahwa dengan 30 laptop dan 50.000 pesan, tawaran penuh untuk setiap pesan baru memicu ratusan sesi berisi beberapa MB id.
- Jawaban `busy` dan `unavailable` sengaja tidak membedakan "tidak ada" dan "tidak boleh", supaya keberadaan blob tidak bocor.
- Nama topik di event tampilan diambil dari fitur lokal, bukan dari kiriman rekan.

Batas sumber daya lengkap ada di laporan.

Laporan: [transport-fitur.md](../docs/progress/transport-fitur.md). Rencana: [transport-fitur.md](../docs/plans/transport-fitur.md).

Lihat juga: [[Arsitektur]], [[Keamanan dan izin]].
