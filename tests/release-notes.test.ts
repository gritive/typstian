import { describe, expect, it } from "vitest";

import { renderReleaseNotes } from "../scripts/release-notes.mjs";

const repository = "whitekid/typstian";

describe("release notes", () => {
  it("groups conventional commits under their kind", () => {
    const notes = renderReleaseNotes(
      [
        { subject: "feat: preview unsaved buffers", hash: "aaaaaaa" },
        { subject: "fix(wasm): resolve datetime.today()", hash: "bbbbbbb" },
        { subject: "perf: cut the release bundle", hash: "ccccccc" },
        { subject: "docs: rewrite the README", hash: "ddddddd" },
      ],
      { previousTag: "0.0.4", tag: "0.0.5", repository },
    );

    expect(notes).toContain("### Features\n- preview unsaved buffers (aaaaaaa)");
    expect(notes).toContain("### Fixes\n- resolve datetime.today() (bbbbbbb)");
    expect(notes).toContain("### Performance\n- cut the release bundle (ccccccc)");
    expect(notes).toContain("### Other changes\n- docs: rewrite the README (ddddddd)");
  });

  it("keeps the scope out of the summary but the type in for other changes", () => {
    const notes = renderReleaseNotes(
      [{ subject: "chore(deps): bump esbuild", hash: "eeeeeee" }],
      { previousTag: "0.0.4", tag: "0.0.5", repository },
    );

    expect(notes).toContain("- chore: bump esbuild (eeeeeee)");
  });

  it("drops the release commit the tag itself points at", () => {
    const notes = renderReleaseNotes(
      [
        { subject: "chore: release 0.0.5", hash: "fffffff" },
        { subject: "fix: pin the toolchain", hash: "ggggggg" },
      ],
      { previousTag: "0.0.4", tag: "0.0.5", repository },
    );

    expect(notes).not.toContain("release 0.0.5");
    expect(notes).toContain("- pin the toolchain (ggggggg)");
  });

  it("links the comparison against the previous tag", () => {
    const notes = renderReleaseNotes([], { previousTag: "0.0.4", tag: "0.0.5", repository });

    expect(notes).toContain(
      "**Full changelog**: https://github.com/whitekid/typstian/compare/0.0.4...0.0.5",
    );
  });

  it("says so when nothing but the release commit landed", () => {
    const notes = renderReleaseNotes(
      [{ subject: "chore: release 0.0.5", hash: "fffffff" }],
      { previousTag: "0.0.4", tag: "0.0.5", repository },
    );

    expect(notes).toContain("No user-facing changes.");
  });

  it("lists the tag's own commits when there is no previous tag", () => {
    const notes = renderReleaseNotes(
      [{ subject: "feat: first release", hash: "hhhhhhh" }],
      { previousTag: undefined, tag: "0.0.1", repository },
    );

    expect(notes).toContain("- first release (hhhhhhh)");
    expect(notes).toContain("/releases/tag/0.0.1");
  });
});
