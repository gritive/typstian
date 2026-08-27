import { describe, expect, it } from "vitest";
import { nextVersion, releaseEdits } from "../scripts/release.mjs";

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("release version bump", () => {
  it("increments the patch component", () => {
    expect(nextVersion("0.0.1", "patch")).toBe("0.0.2");
  });

  it("increments the minor component and resets the patch", () => {
    expect(nextVersion("0.4.9", "minor")).toBe("0.5.0");
  });

  it("increments the major component and resets the rest", () => {
    expect(nextVersion("1.4.9", "major")).toBe("2.0.0");
  });

  it("accepts an explicit target version", () => {
    expect(nextVersion("0.0.1", "1.2.3")).toBe("1.2.3");
  });

  it("rejects a target that does not move forward", () => {
    expect(() => nextVersion("1.2.3", "1.2.3")).toThrow(/greater than/);
    expect(() => nextVersion("1.2.3", "1.2.2")).toThrow(/greater than/);
  });

  it("rejects an unparsable bump argument", () => {
    expect(() => nextVersion("0.0.1", "1.2")).toThrow(/patch, minor, major/);
  });
});

describe("release file edits", () => {
  const manifest = { id: "typstian", version: "0.0.1", minAppVersion: "1.13.1" };
  const packageJson = { name: "typstian", version: "0.0.1" };
  const packageLock = { name: "typstian", version: "0.0.1", packages: { "": { name: "typstian", version: "0.0.1" } } };
  const versions = { "0.0.1": "1.13.1" };

  it("synchronizes every version-bearing release file", () => {
    const edits = releaseEdits({ manifest, packageJson, packageLock, versions }, "0.1.0");

    expect(edits.manifest.version).toBe("0.1.0");
    expect(edits.packageJson.version).toBe("0.1.0");
    expect(edits.packageLock.version).toBe("0.1.0");
    expect(edits.packageLock.packages[""]?.version).toBe("0.1.0");
  });

  it("maps the new version to the manifest minAppVersion and keeps history", () => {
    const edits = releaseEdits({ manifest, packageJson, packageLock, versions }, "0.1.0");

    expect(edits.versions).toEqual({ "0.0.1": "1.13.1", "0.1.0": "1.13.1" });
  });

  it("leaves the inputs untouched", () => {
    releaseEdits({ manifest, packageJson, packageLock, versions }, "0.1.0");

    expect(manifest.version).toBe("0.0.1");
    expect(versions).toEqual({ "0.0.1": "1.13.1" });
  });
});

describe("release publishing", () => {
  it("publishes the branch and tag with one atomic push", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typstian-release-"));
    try {
      const scriptsDirectory = path.join(fixtureRoot, "scripts");
      const binDirectory = path.join(fixtureRoot, "bin");
      const gitLog = path.join(fixtureRoot, "git.log");
      fs.mkdirSync(scriptsDirectory);
      fs.mkdirSync(binDirectory);
      fs.copyFileSync(
        path.resolve("scripts/release.mjs"),
        path.join(scriptsDirectory, "release.mjs"),
      );
      fs.writeFileSync(
        path.join(fixtureRoot, "manifest.json"),
        JSON.stringify({ id: "typstian", version: "0.0.1", minAppVersion: "1.13.1" }),
      );
      fs.writeFileSync(
        path.join(fixtureRoot, "package.json"),
        JSON.stringify({ name: "typstian", version: "0.0.1" }),
      );
      fs.writeFileSync(
        path.join(fixtureRoot, "package-lock.json"),
        JSON.stringify({
          name: "typstian",
          version: "0.0.1",
          packages: { "": { name: "typstian", version: "0.0.1" } },
        }),
      );
      fs.writeFileSync(
        path.join(fixtureRoot, "versions.json"),
        JSON.stringify({ "0.0.1": "1.13.1" }),
      );

      const fakeGit = path.join(binDirectory, "git");
      fs.writeFileSync(fakeGit, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GIT_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
  process.stdout.write("main\\n");
} else if (args[0] === "rev-parse") {
  process.stdout.write("same-commit\\n");
}
`);
      fs.chmodSync(fakeGit, 0o755);

      const fakeNpm = path.join(binDirectory, "npm");
      fs.writeFileSync(fakeNpm, "#!/usr/bin/env node\n");
      fs.chmodSync(fakeNpm, 0o755);

      const result = spawnSync(process.execPath, ["scripts/release.mjs", "patch"], {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_LOG: gitLog,
          PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      const commands = fs.readFileSync(gitLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(commands.filter(([command]) => command === "push")).toEqual([
        ["push", "--atomic", "origin", "main", "0.0.2"],
      ]);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
