import { plural, type Dict } from "./core";
import type id from "./org-invites.id";

const en: Dict<typeof id> = {
  panel: {
    createdBy: (name: string, when: string) => `Created by ${name}, ${when}.`,
    usedBy: (names: string) => ` Used by ${names}.`,
    validUntil: (when: string) => ` Valid until ${when}.`,
    endedAt: (when: string) => ` Ended ${when}.`,
    revoked: (team: string) => `The invite code for ${team} was revoked. It can't be used anymore.`,
    redeemTitle: "Use an invite code",
    redeemHint: "You aren't in a department yet. The admin who invited you gives you the code.",
    title: "Invite codes",
    create: "Create invite code",
    hint: "A code is shown only once, when it's created. Here you can see its status and how long it's valid.",
    noOpenDepartment:
      "You can't create a new code yet because every department is archived. Create or restore a department in the Departments tab.",
    emptyManage: "No invite codes yet. Create a code to invite someone new to a department.",
    emptyNoOpen:
      "No invite codes yet. Codes can only be created for departments that aren't archived, and right now there are none. Create or restore a department in the Departments tab.",
    emptyNone: "No invite codes you can manage. Department admins and superadmins create invite codes.",
    revokeAria: (label: string) => `Revoke invite code ${label}`,
    revoke: "Revoke",
    revokeTitle: (label: string) => `Revoke invite code ${label}?`,
    revokeTitleFallback: "Revoke invite code?",
    revokeConfirm: "Revoke code",
    revoking: "Revoking...",
    revokeFailed: "Code not revoked",
    revokeBody:
      "People who haven't used this code yet can no longer join with it. People who already joined with it stay in the organization. Revoking can't be undone. If you still need one, create a new code.",
  },
  dialog: {
    roleDesc: {
      member: "Chats in this department, and creates and works on tasks in the projects they belong to.",
      team_admin:
        "Approves join requests to this department, creates invite codes and department projects, and manages project members.",
      guest: "Views the board and reads comments in the chosen projects. Can't change tasks or comment.",
    },
    validityHint: {
      "24h": "Several people can use it for 24 hours after it's created.",
      "7d": "Several people can use it for 7 days after it's created.",
      once: "For one person. The code expires once used, or after 7 days if nobody uses it.",
    },
    validity: {
      "24h": "24 hours",
      "7d": "7 days",
      once: "Single use",
    },
    titleReady: "Invite code ready",
    titleTo: (team: string) => `Invite to ${team}`,
    titleDefault: "Invite to a department",
    pickAtLeastOne: "Tick at least one project the guest can see.",
    sendCode:
      "Send this code to the person you're inviting through a channel you trust, such as in person or by private message. They enter it the first time they open Mira.",
    copy: "Copy code",
    role: "Role",
    roleIn: (role: string, team: string) => `${role} in ${team}`,
    projects: "Projects",
    hiddenProject: "A project that isn't visible on this laptop",
    validUntil: "Valid until",
    once: ", for one person",
    shownOnce:
      "This code is shown only once. After you close this dialog, Mira can't show it again. If the code gets lost, revoke it and create a new one.",
    done: "Done",
    department: "Department",
    noTeams: "You don't manage any department yet. An invite code is always for one department.",
    guestProjects: "Projects the guest can see",
    guestHint: (max: number) =>
      `Guests can only view the board and comments of the ticked projects, and can't change tasks. Up to ${max} ${plural(max, "project", "projects")}.`,
    loadingProjects: "Loading department projects...",
    projectsError: "Couldn't read the project list",
    projectsRetry: "Try reading again",
    noProjects: (team: string | null) =>
      `${team ? `The ${team} department` : "This department"} has no projects visible on this laptop. You only see a project if you're a member. Create a project for this department on the Board, or ask a project manager to add you, then invite the guest to that project.`,
    atMax: (max: number) => `${max} ${plural(max, "project", "projects")} picked, the limit for one invite code.`,
    validFor: "Code valid for",
    forbidden: "You don't have permission to invite people to this department",
    failed: "Code not created",
    cancel: "Cancel",
    creating: "Creating code...",
    create: "Create invite code",
  },
};

export default en;
