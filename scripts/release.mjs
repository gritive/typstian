#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import console from "node:console";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function components(version, label) {
  const parts = SEMVER.exec(version);
  if (!parts) throw new Error(`${label} ${version} is not a semantic version.`);
  return parts.slice(1).map(Number);
}

export function nextVersion(current, bump) {
  const [major, minor, patch] = components(current, "Current version");

  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  if (!SEMVER.test(bump)) {
    throw new Error(`Expected patch, minor, major, or an explicit version, got ${bump}.`);
  }

  const wanted = components(bump, "Target version");
  const ahead = wanted.findIndex((value, index) => value !== [major, minor, patch][index]);
  if (ahead < 0 || wanted[ahead] < [major, minor, patch][ahead]) {
    throw new Error(`Version ${bump} must be greater than the current ${current}.`);
  }
  return bump;
}

export function releaseEdits({ manifest, packageJson, packageLock, versions }, version) {
  return {
    manifest: { ...manifest, version },
    packageJson: { ...packageJson, version },
    packageLock: {
      ...packageLock,
      version,
      packages: { ...packageLock.packages, "": { ...packageLock.packages[""], version } },
    },
    versions: { ...versions, [version]: manifest.minAppVersion },
  };
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), "utf8"));
}

function writeJson(relativePath, value) {
  fs.writeFileSync(path.join(projectRoot, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function git(...args) {
  return execFileSync("git", args, { cwd: projectRoot, encoding: "utf8" }).trim();
}

function run(command, ...args) {
  execFileSync(command, args, { cwd: projectRoot, stdio: "inherit" });
}

function requireCleanCheckout(version) {
  if (git("status", "--porcelain")) {
    throw new Error("The working tree has uncommitted changes; commit or stash them first.");
  }
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  git("fetch", "origin", branch, "--tags");
  if (git("rev-parse", "HEAD") !== git("rev-parse", `origin/${branch}`)) {
    throw new Error(`${branch} differs from origin/${branch}; pull or push first.`);
  }
  if (git("tag", "--list", version)) {
    throw new Error(`Tag ${version} already exists.`);
  }
  return branch;
}

function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const bump = argv.find((argument) => !argument.startsWith("-"));
  if (!bump) throw new Error("Usage: npm run release -- <patch|minor|major|x.y.z> [--dry-run]");

  const manifest = readJson("manifest.json");
  const version = nextVersion(manifest.version, bump);
  const branch = requireCleanCheckout(version);

  const edits = releaseEdits({
    manifest,
    packageJson: readJson("package.json"),
    packageLock: readJson("package-lock.json"),
    versions: readJson("versions.json"),
  }, version);
  writeJson("manifest.json", edits.manifest);
  writeJson("package.json", edits.packageJson);
  writeJson("package-lock.json", edits.packageLock);
  writeJson("versions.json", edits.versions);

  run("npm", "run", "licenses:generate");
  run("npm", "run", "typecheck");
  run("npm", "run", "lint");
  run("npm", "test");

  if (dryRun) {
    console.log(`Prepared ${version} without committing. Run "git checkout -- ." to discard it.`);
    return;
  }

  git("commit", "--all", "--message", `chore: release ${version}`);
  git("tag", version);
  git("push", "--atomic", "origin", branch, version);
  console.log(`Released ${version}; the tag push starts the release workflow.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
