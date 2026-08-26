import { describe, expect, it } from "vitest";

import { DependencyIndex } from "../src/dependency-index";

describe("DependencyIndex", () => {
  it("returns only entries affected by a normalized changed dependency", () => {
    const index = new DependencyIndex();
    index.update("book\\main.typ", ["book/./chapter.typ", "book/images/../logo.svg"]);
    index.update("letter.typ", ["shared/signature.typ"]);

    expect(index.affectedBy("book/chapter.typ")).toEqual(["book/main.typ"]);
    expect(index.affectedBy("book\\logo.svg")).toEqual(["book/main.typ"]);
    expect(index.affectedBy("unrelated.typ")).toEqual([]);
  });

  it("extends partial failure dependencies without forgetting the last successful graph", () => {
    const index = new DependencyIndex();
    index.update("book/main.typ", ["book/main.typ", "book/section.typ"]);

    index.extend("book/main.typ", ["book/missing.typ"]);

    expect(index.affectedBy("book/section.typ")).toEqual(["book/main.typ"]);
    expect(index.affectedBy("book/missing.typ")).toEqual(["book/main.typ"]);
  });

  it("replaces old dependency edges when an entry is updated", () => {
    const index = new DependencyIndex();
    index.update("main.typ", ["old.typ", "kept.typ"]);

    index.update("main.typ", ["kept.typ", "new.typ"]);

    expect(index.affectedBy("old.typ")).toEqual([]);
    expect(index.affectedBy("kept.typ")).toEqual(["main.typ"]);
    expect(index.affectedBy("new.typ")).toEqual(["main.typ"]);
  });

  it("deduplicates and returns affected entries deterministically", () => {
    const index = new DependencyIndex();
    index.update("z.typ", ["shared.typ", "shared.typ"]);
    index.update("a.typ", ["shared.typ"]);

    expect(index.affectedBy("shared.typ")).toEqual(["a.typ", "z.typ"]);
  });

  it("removes one entry or clears the index", () => {
    const index = new DependencyIndex();
    index.update("one.typ", ["shared.typ"]);
    index.update("two.typ", ["shared.typ"]);

    index.remove("one.typ");
    expect(index.affectedBy("shared.typ")).toEqual(["two.typ"]);

    index.clear();
    expect(index.affectedBy("shared.typ")).toEqual([]);
  });
});
