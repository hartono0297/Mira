import { COMPONENTS_TEXT as T } from "./i18n/components";

// The operating system Mira runs on, read from the webview user agent:
// WebView2 on Windows reports "Windows", WKWebView on macOS reports
// "Macintosh" (also on Apple Silicon). Anything else, including jsdom in
// tests, counts as "other" and gets the Windows wording, which is the default.
export type HostPlatform = "windows" | "macos" | "other";

export function hostPlatform(): HostPlatform {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Macintosh|Mac OS X/.test(ua)) return "macos";
  if (/Windows/.test(ua)) return "windows";
  return "other";
}

export function isMac(): boolean {
  return hostPlatform() === "macos";
}

// Names used in user-facing text. Brand names stay; only the word order of
// the macOS names follows the active language.
export function systemName(): string {
  return isMac() ? "macOS" : "Windows";
}

export function firewallName(mac: boolean = isMac()): string {
  return mac ? T.platform.macFirewall : "Windows Firewall";
}

export function keyStoreName(): string {
  return isMac() ? T.platform.macKeyStore : "Windows Credential Manager";
}
