// 各模块共用的文案（英文）。
import type { Messages } from "../zh";

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const common: Messages["common"] = {
  appName: "Paperloom",
  pageTitle: (name) => `${name} · Paperloom`,
  ok: "OK",
  cancel: "Cancel",
  close: "Close",
  save: "Save",
  delete: "Delete",
  remove: "Remove",
  rename: "Rename",
  edit: "Edit",
  create: "New",
  undo: "Undo",
  retry: "Retry",
  loading: "Loading…",
  unknown: "Unknown",
  list: (items) => (items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`),
  quote: (s) => `“${s}”`,
  failedWith: (what, reason) => `${what}: ${reason}`,
  language: {
    label: "Language",
    switchTitle: "Change interface language",
    changedElsewhere: "The interface language was changed to English in another tab.",
    reload: "Reload",
  },
  time: {
    justNow: "just now",
    minutesAgo: (n) => `${n} min ago`,
    hoursAgo: (n) => (n === 1 ? "1 hour ago" : `${n} hours ago`),
    dateTime: (d, withYear) => `${MONTHS[d.getMonth()]} ${d.getDate()}${withYear ? `, ${d.getFullYear()}` : ""} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
  },
};

export default common;
