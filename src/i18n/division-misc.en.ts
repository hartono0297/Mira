import type { Dict } from "./core";
import type id from "./division-misc.id";

const en: Dict<typeof id> = {
  newProject: {
    label: "For division",
    none: "Not a division project",
    option: (division: string, department: string) => `${division}, ${department}`,
    hint: "Optional. If you pick one, the project's department follows that division.",
    picked: (division: string) => `Members of the ${division} division join the project automatically.`,
    summaryNone: (division: string) =>
      `Nobody else selected yet: this project will have the ${division} division members and you, as its manager.`,
    summaryPicked: (picked: string, division: string) =>
      `${picked}, plus the ${division} division members and you as the manager.`,
  },
  ad: {
    colDivision: "Division",
    none: "No division",
    chooseDeptFirst: "Choose a department first",
    noDivisions: "No divisions yet",
    archivedOption: (name: string) => `${name} (archived)`,
    unknownOption: "Unknown division",
    note: "Deeper OUs can be mapped to a division. People approved through AD join that division automatically.",
    loadFailed: (message: string) => `The division list couldn't be read (${message}).`,
    retry: "Reload divisions",
  },
};

export default en;
