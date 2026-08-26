#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import console from "node:console";
import process from "node:process";

const SECTIONS = [
  { heading: "Features", types: ["feat"] },
  { heading: "Fixes", types: ["fix"] },
  { heading: "Performance", types: ["perf"] },
];
const CONVENTIONAL = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?!?:\s*(?<summary>.+)$/;

function classify(subject) {
  const parts = CONVENTIONAL.exec(subject);
  if (!parts?.groups) return { type: undefined, summary: subject };
  return { type: parts.groups.type, summary: parts.groups.summary };
}

export function renderReleaseNotes(commits, { previousTag, tag, repository }) {
  const entries = commits
    .map(({ subject, hash }) => ({ ...classify(subject), hash }))
    // The release commit is the tag itself; it says nothing a reader needs.
    .filter((entry) => !/^release \d+\.\d+\.\d+$/.test(entry.summary));

  const listed = new Set();
  const sections = SECTIONS.flatMap(({ heading, types }) => {
    const matching = entries.filter((entry) => types.includes(entry.type ?? ""));
    matching.forEach((entry) => listed.add(entry));
    return matching.length === 0
      ? []
      : [`### ${heading}\n${matching.map((entry) => `- ${entry.summary} (${entry.hash})`).join("\n")}`];
  });

  const rest = entries.filter((entry) => !listed.has(entry));
  if (rest.length > 0) {
    sections.push(
      `### Other changes\n${rest
        .map((entry) => `- ${entry.type === undefined ? "" : `${entry.type}: `}${entry.summary} (${entry.hash})`)
        .join("\n")}`,
    );
  }

  const comparison = previousTag === undefined
    ? `https://github.com/${repository}/releases/tag/${tag}`
    : `https://github.com/${repository}/compare/${previousTag}...${tag}`;
  const body = sections.length === 0 ? "No user-facing changes." : sections.join("\n\n");
  return `${body}\n\n**Full changelog**: ${comparison}\n`;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function previousTagOf(tag) {
  try {
    return git("describe", "--tags", "--abbrev=0", `${tag}^`);
  } catch {
    return undefined;
  }
}

function main() {
  const [tag, repository = process.env.GH_REPO] = process.argv.slice(2);
  if (tag === undefined || repository === undefined) {
    throw new Error("Usage: release-notes.mjs <tag> [owner/repo]");
  }
  const previousTag = previousTagOf(tag);
  const range = previousTag === undefined ? tag : `${previousTag}..${tag}`;
  const log = git("log", "--no-merges", "--format=%h%x00%s", range);
  const commits = log
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [hash, subject] = line.split("\0");
      return { hash, subject };
    });
  console.log(renderReleaseNotes(commits, { previousTag, tag, repository }));
}

if (process.argv[1]?.endsWith("release-notes.mjs")) main();
