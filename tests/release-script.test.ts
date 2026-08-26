import { describe, expect, it } from "vitest";
import { nextVersion, releaseEdits } from "../scripts/release.mjs";

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
