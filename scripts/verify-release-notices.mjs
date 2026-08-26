import console from "node:console";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const main = readFileSync(resolve(projectRoot, "main.js"), "utf8");
const notices = readFileSync(resolve(projectRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
const embeddedNotices = notices.replaceAll("*/", "* /");

if (!main.includes(embeddedNotices)) {
  throw new Error("main.js does not contain the complete generated distribution notices");
}

for (const requiredNotice of [
  "MIT License",
  "Copyright (c) 2026 Typstian contributors",
  "SIL OPEN FONT LICENSE",
  "GUST Font License",
  "Bitstream Vera",
  "Unicode License V3",
]) {
  if (!main.includes(requiredNotice)) {
    throw new Error(`main.js is missing required notice: ${requiredNotice}`);
  }
}

console.log("Verified complete generated notices in main.js.");
