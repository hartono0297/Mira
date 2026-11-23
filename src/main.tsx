import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/nunito/latin-400.css";
import "@fontsource/nunito/latin-600.css";
import "@fontsource/nunito/latin-700.css";
import "./styles/global.css";
import { ThemeProvider, bootTheme } from "./theme/ThemeProvider";
import App from "./App";
import { TextFieldMenu } from "./components/ContextMenu";

// Pasang warna tema sebelum render pertama supaya tidak ada kedip putih di mode gelap.
bootTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
      {/* Mematikan menu bawaan WebView dan memberi menu teks berbahasa Indonesia. */}
      <TextFieldMenu />
    </ThemeProvider>
  </React.StrictMode>,
);
