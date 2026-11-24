import { plural, type Dict } from "./core";
import type id from "./chat-text.id";

const en: Dict<typeof id> = {
  days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  months: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
  today: "Today",
  yesterday: "Yesterday",
  date: (weekday: string, day: number, month: string, year: number) => `${weekday}, ${day} ${month} ${year}`,
  time: (hours: string, minutes: string) => `${hours}:${minutes}`,
  dateTime: (date: string, time: string) => `${date} at ${time}`,
  decimalSeparator: ".",
  bytes: (n: number) => `${n} ${plural(n, "byte", "bytes")}`,

  you: "You",
  youSuffix: " (you)",
  deleted: "Message deleted",

  readCount: (read: number, total: number) => `Read by ${read} of ${total}`,
  deliveredCount: (delivered: number, total: number) => `Delivered to ${delivered} of ${total}`,

  scope: {
    project: "Project",
    direct: "Direct message",
    org: "Whole office",
    group: "Group",
    team: (name: string) => `Department ${name}`,
    projectNamed: (name: string) => `Project ${name}`,
  },
  prefix: {
    team: "Department",
    project: "Project",
    group: "Group",
  },

  sections: {
    umum: "General",
    departemen: "Department",
    proyek: "Projects",
    grup: "Groups",
    pribadi: "Direct messages",
  },

  unread: (n: number) => `${n} unread ${plural(n, "message", "messages")}`,
  mentionsYou: (n: number) => `${n} ${plural(n, "mentions", "mention")} you`,
};

export default en;
