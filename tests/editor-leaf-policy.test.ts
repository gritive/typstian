import { describe, expect, it } from "vitest";

import { chooseSourceEditorLeaf } from "../src/editor-leaf-policy";

describe("chooseSourceEditorLeaf", () => {
  it("does not replace a preexisting editor that shows another source file", () => {
    const entryEditorLeaf = { id: "entry-editor" };

    expect(chooseSourceEditorLeaf([
      { leaf: entryEditorLeaf, sourcePath: "book/main.typ" },
    ], "book/section.typ")).toBeUndefined();
  });

  it("prefers an editor that already has the inverse-search target open", () => {
    const entryEditorLeaf = { id: "entry-editor" };
    const targetEditorLeaf = { id: "target-editor" };

    expect(chooseSourceEditorLeaf([
      { leaf: entryEditorLeaf, sourcePath: "book/main.typ" },
      { leaf: targetEditorLeaf, sourcePath: "book/section.typ" },
    ], "book/section.typ")).toBe(targetEditorLeaf);
  });
});
