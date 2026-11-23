import { afterEach, describe, expect, it, vi } from "vitest";
import { firewallName, hostPlatform, isMac, keyStoreName, systemName } from "./platform";

function withUserAgent(ua: string) {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(ua);
}

describe("platform", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("WKWebView di macOS (juga Apple Silicon) terbaca sebagai macOS", () => {
    withUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)");
    expect(hostPlatform()).toBe("macos");
    expect(isMac()).toBe(true);
    expect(systemName()).toBe("macOS");
    expect(firewallName()).toBe("Firewall macOS");
    expect(keyStoreName()).toBe("Keychain macOS");
  });

  it("WebView2 di Windows terbaca sebagai Windows", () => {
    withUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    );
    expect(hostPlatform()).toBe("windows");
    expect(systemName()).toBe("Windows");
    expect(firewallName()).toBe("Windows Firewall");
    expect(keyStoreName()).toBe("Windows Credential Manager");
  });

  it("lainnya (jsdom) memakai teks Windows", () => {
    withUserAgent("Mozilla/5.0 (darwin) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/26.0.0");
    expect(hostPlatform()).toBe("other");
    expect(isMac()).toBe(false);
    expect(systemName()).toBe("Windows");
  });

  it("nama firewall mengikuti platform yang dilaporkan inti", () => {
    expect(firewallName(true)).toBe("Firewall macOS");
    expect(firewallName(false)).toBe("Windows Firewall");
  });
});
