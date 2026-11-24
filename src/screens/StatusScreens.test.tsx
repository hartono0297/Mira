// Layar status (gagal dibuka, dikeluarkan, nonaktif) dalam bahasa Inggris.
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n/core";
import { appState } from "../test/fixtures";
import { renderInLang } from "../test/i18n";
import { ThemeProvider } from "../theme/ThemeProvider";
import { RemovedScreen } from "./RemovedScreen";
import { ErrorScreen, LoadingScreen } from "./StatusScreens";
import { SuspendedScreen } from "./SuspendedScreen";

afterEach(() => {
  setLang("id");
});

describe("layar status dalam bahasa Inggris", () => {
  it("memuat", () => {
    renderInLang(() => (
      <ThemeProvider>
        <LoadingScreen />
      </ThemeProvider>
    ));
    expect(screen.getByText("Opening Mira's data on this laptop...")).toBeInTheDocument();
    expect(screen.queryByText(/Membuka data Mira/)).not.toBeInTheDocument();
  });

  it("gagal dibuka: judul, langkah berikutnya, dan kode error", () => {
    renderInLang(() => <ErrorScreen error={{ code: "database", message: "database is locked" }} onRetry={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Mira can't open yet" })).toBeInTheDocument();
    expect(screen.getByText("Next step:")).toBeInTheDocument();
    expect(screen.getByText(/Close any other Mira window/)).toBeInTheDocument();
    expect(screen.getByText("Error code: database")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText(/Langkah berikutnya|Kode error|Coba lagi/)).not.toBeInTheDocument();
  });

  it("gagal dibuka dalam bahasa Indonesia tetap seperti sebelumnya", () => {
    renderInLang(() => <ErrorScreen error={{ code: "database", message: "database is locked" }} onRetry={vi.fn()} />, "id");
    expect(screen.getByRole("heading", { name: "Mira belum bisa dibuka" })).toBeInTheDocument();
    expect(screen.getByText("Kode error: database")).toBeInTheDocument();
  });

  it("laptop dikeluarkan dari organisasi", () => {
    const state = appState({ membership: "removed" });
    renderInLang(() => (
      <ThemeProvider>
        <RemovedScreen state={state as never} onReset={vi.fn()} />
      </ThemeProvider>
    ));
    expect(
      screen.getByRole("heading", { name: `This laptop has been removed from ${state.organization?.name}` }),
    ).toBeInTheDocument();
    expect(screen.getByText(/give them this laptop's fingerprint/)).toBeInTheDocument();
    expect(screen.getByText("This laptop's fingerprint")).toBeInTheDocument();
    expect(screen.getByText(state.identity.fingerprint)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset and start over" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
    expect(screen.queryByText(/dikeluarkan|Periksa lagi|Reset dan/)).not.toBeInTheDocument();
  });

  it("akun dinonaktifkan", () => {
    const state = appState({ membership: "suspended" });
    renderInLang(() => (
      <ThemeProvider>
        <SuspendedScreen state={state as never} onRefresh={vi.fn()} />
      </ThemeProvider>
    ));
    expect(
      screen.getByRole("heading", { name: `Your account at ${state.organization?.name} is deactivated` }),
    ).toBeInTheDocument();
    expect(screen.getByText("Contact IT or a superadmin at your office. They can turn your account back on.")).toBeInTheDocument();
    expect(screen.getByText(state.identity.fingerprint)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(screen.queryByText(/dinonaktifkan|Periksa lagi|Hubungi/)).not.toBeInTheDocument();
  });
});
