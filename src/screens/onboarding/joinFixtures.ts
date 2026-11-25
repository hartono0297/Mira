// Data contoh untuk uji layar bergabung (Onboarding v0.3 dan v0.4).
import type { FoundOffice, JoinDevice, JoinSearch, OutgoingJoinRequest } from "../../api/join";

export const device: JoinDevice = {
  laptop: "LAPTOP-DESAIN-03",
  os: "Windows 11",
  appVersion: "0.4.0",
  account: "desain03",
  addresses: ["192.168.1.23"],
};

export function office(overrides: Partial<FoundOffice> = {}): FoundOffice {
  return {
    key: "org-biro:fp1",
    orgId: "b".repeat(32),
    name: "Biro Contoh",
    fingerprint: "7KQ2-M9XD",
    departments: [
      { id: "t-adm", name: "Administrasi" },
      { id: "t-des", name: "Desain" },
    ],
    peerCount: 2,
    conflict: false,
    sameName: false,
    acceptsNote: true,
    adOutdated: 0,
    adDomain: null,
    acceptsAd: false,
    createdAt: "2026-01-05T08:00:00Z",
    ...overrides,
  };
}

export function searchResult(overrides: Partial<JoinSearch> = {}): JoinSearch {
  return { offices: [], legacyOffices: [], orgSeen: false, mdnsOk: true, mdnsError: null, ...overrides };
}

export function outgoing(overrides: Partial<OutgoingJoinRequest> = {}): OutgoingJoinRequest {
  return {
    requestId: "req-1",
    code: "4F2A 91C0",
    orgFingerprint: "7KQ2-M9XD",
    orgId: "b".repeat(32),
    orgName: "Biro Contoh",
    teamId: "t-des",
    teamName: "Desain",
    displayName: "Rina",
    note: null,
    ad: null,
    createdAt: "2026-11-23T09:00:00Z",
    status: "pending",
    decidedByName: null,
    decidedAt: null,
    lastSentAt: "2026-11-23T09:00:01Z",
    lastError: null,
    ...overrides,
  };
}
