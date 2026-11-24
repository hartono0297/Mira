import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/nunito/latin-400.css";
import "@fontsource/nunito/latin-600.css";
import "@fontsource/nunito/latin-700.css";
import "./styles/global.css";
import { ThemeProvider, bootTheme } from "./theme/ThemeProvider";
import App from "./App";
import { TextFieldMenu } from "./components/ContextMenu";
import { useLang } from "./i18n/core";
import { bootLang, loadStoredLang } from "./i18n/preference";

// Pasang warna tema sebelum render pertama supaya tidak ada kedip putih di mode gelap.
bootTheme();
// Bahasa dari salinan lokal dulu, lalu pilihan tersimpan di inti Rust.
bootLang();
void loadStoredLang();

// Akar aplikasi berlangganan bahasa aktif. Saat bahasa berganti, akar render
// ulang dan seluruh pohon ikut render ulang tanpa kehilangan state, jadi
// teks di semua layar langsung berganti tanpa memulai ulang Mira.
function Root() {
  useLang();
  return (
    <ThemeProvider>
      <App />
      {/* Mematikan menu bawaan WebView dan memberi menu teks sesuai bahasa. */}
      <TextFieldMenu />
    </ThemeProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
