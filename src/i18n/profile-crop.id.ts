// Teks dialog pemotong foto profil (src/components/profile). Label e2e di
// docs/plans/foto-profil.md 3.5: judul, "Posisi foto", "Perbesar", "Simpan foto", "Batal".
const id = {
  title: "Atur foto profil",
  description: "Yang terlihat di dalam lingkaran menjadi foto profil Anda.",
  area: "Posisi foto",
  areaHint:
    "Seret foto atau tekan tombol panah untuk menggeser, tahan Shift untuk langkah lebih jauh. Tekan + atau - atau putar roda mouse untuk memperbesar dan memperkecil.",
  zoom: "Perbesar",
  zoomIn: "Perbesar foto",
  zoomOut: "Perkecil foto",
  zoomValue: (percent: number) => `${percent}%`,
  // Diumumkan pembaca layar setelah menggeser atau memperbesar dengan keyboard.
  announceZoom: (percent: number) => `Perbesaran ${percent}%`,
  announcePosition: (left: number, top: number) => `Posisi ${left}% dari kiri, ${top}% dari atas`,
  save: "Simpan foto",
  saving: "Menyimpan foto...",
  cancel: "Batal",
  errorTitle: "Foto belum tersimpan",
};

export default id;
