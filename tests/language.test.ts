import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { typstLanguage } from "../src/language";

describe("typstLanguage", () => {
  it("parses Typst code with the real Lezer grammar", () => {
    const state = EditorState.create({
      doc: "#let answer = 42\n= Result: #answer",
      extensions: [typstLanguage],
    });

    const tree = syntaxTree(state);
    expect(tree.topNode.getChild("LetBinding")).not.toBeNull();
    expect(tree.topNode.getChild("Heading")).not.toBeNull();
  });
});
