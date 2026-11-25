import { plural, type Dict } from "./core";
import type id from "./org-requests.id";

const requests = (n: number) => plural(n, "request", "requests");

const en: Dict<typeof id> = {
  notRecorded: "Not recorded",
  card: {
    department: "Department",
    note: "Note from the requester (not verified)",
    laptop: "Laptop",
    account: "Sign-in account (reported by the requesting laptop)",
    accountNotSent: "Not sent",
    ip: "IP address",
    os: "System",
    appVersion: "Mira version",
    codeLabel: "Match code",
    verifyHint:
      "Make sure it's the right person: call them on a number you already know, not one from the note, or go to their desk. Ask them to read out the code on their screen, and approve only if the codes match.",
    previous: {
      accountRemoved: (name: string, date: string) =>
        `This Windows account was used by ${name}, who was removed on ${date}.`,
      laptopRemoved: (name: string, date: string) =>
        `A laptop with this name was used by ${name}, who was removed on ${date}.`,
      accountSuspended: (name: string, date: string) =>
        `This Windows account was used by ${name}, who has been deactivated since ${date}.`,
      laptopSuspended: (name: string, date: string) =>
        `A laptop with this name was used by ${name}, who has been deactivated since ${date}.`,
      reinstate: "Consider reactivating that person instead of approving a new laptop.",
      notProof: "This is a hint, not proof: the requesting laptop reports its own account and laptop name.",
    },
  },
  title: "Join requests",
  intro: "New laptops on the office network that choose this organization show up here.",
  introScoped: " You only see requests to your department.",
  loading: "Loading join requests...",
  loadErrorTitle: "Couldn't read join requests",
  loadErrorEmpty: "The Mira core didn't send the request list.",
  retry: "Try again",
  stale: (message: string) => `Couldn't read the latest list (${message}). Showing the last data loaded.`,
  emptyTitle: "No requests waiting.",
  emptyBody: (scoped: boolean) =>
    `Requests show up here when a new laptop on the office network chooses this organization${scoped ? " and your department" : ""}. People who can't find the office can still join with a code from the Invites tab.`,
  requested: "Asked to join",
  rejectAria: (name: string) => `Decline ${name}'s request`,
  reject: "Decline",
  approveAria: (name: string) => `Approve ${name}'s request`,
  approving: "Approving...",
  approve: "Approve",
  seenBy: (name: string) => `Received through ${name}'s laptop`,
  rejectAllFrom: (group: string, n: number) => `Decline all from ${group} (${n})`,
  approved: (name: string, team: string) => `${name} was approved and joined the ${team} department.`,
  approveFailed: "Request not approved",
  rejected: (name: string) => `You declined ${name}'s request. If that was a mistake, ${name} can send a new request.`,
  rejectFailed: "Request not declined",
  bulkStopped: (done: number, total: number) =>
    `Before stopping, ${done} of ${total} ${requests(total)} ${plural(done, "was", "were")} declined.`,
  bulkSkipped: (n: number) => `${n} ${plural(n, "was", "were")} already decided by someone else.`,
  bulkRetry: "You can decline the remaining ones below again.",
  bulkFailedTitle: (name: string) => `Couldn't decline ${name}'s request`,
  bulkSkippedTail: (n: number) => ` ${n} more ${plural(n, "was", "were")} already decided by someone else.`,
  bulkDone: (n: number, group: string, tail: string) =>
    `Declined ${n} ${requests(n)} from ${group}.${tail}`,
  bulkNoneLeft: (group: string) => `Every request from ${group} was already decided by someone else.`,
  rejectOneTitle: (name: string) => `Decline ${name}'s request?`,
  rejectOneTitleFallback: "Decline request",
  rejectOneConfirm: (name: string) => `Decline ${name}`,
  rejecting: "Declining...",
  rejectOneBody: (name: string) =>
    `A declined request can't be approved later. If it turns out to be a mistake, ${name} can send a new request from their laptop, with a new match code.`,
  bulkTitle: (n: number, group: string) => `Decline ${n} ${requests(n)} from ${group}?`,
  bulkTitleFallback: "Decline all requests",
  bulkConfirm: (n: number) => `Decline ${n} ${requests(n)}`,
  bulkProgress: (at: number, total: number) => `Declining ${at} of ${total}...`,
  bulkIpv6:
    "These requests came from the same IPv6 network (one /64). Check the names first: colleagues' laptops on the office network can share the same /64.",
  bulkSameIp: "These requests came from the same address:",
  bulkWhy:
    "Use this when someone floods the office with fake requests. Declined requests can't be approved later; people who really belong can send a new request.",
};

export default en;
