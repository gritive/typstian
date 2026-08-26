import path from "node:path";
import { describe, expect, it } from "vitest";

import { collectDirtyBuffers } from "../src/dirty-buffer-overlay";

const vault = path.resolve("/vault");

describe("collectDirtyBuffers", () => {
  it("maps an unsaved editor to its compiler path and UTF-8 bytes", () => {
    const overlay = collectDirtyBuffers(vault, vault, [
      { path: "book/chapter.typ", text: "= Hello" }
    ]);

    expect([...overlay.keys()]).toEqual(["book/chapter.typ"]);
    expect(overlay.get("book/chapter.typ"))
      .toEqual(new TextEncoder().encode("= Hello"));
  });

  it("keys buffers relative to a compilation root below the vault", () => {
    const overlay = collectDirtyBuffers(vault, path.join(vault, "book"), [
      { path: "book/chapter.typ", text: "= Hello" }
    ]);

    expect([...overlay.keys()]).toEqual(["chapter.typ"]);
  });

  it("excludes buffers outside the compilation root", () => {
    const overlay = collectDirtyBuffers(vault, path.join(vault, "book"), [
      { path: "notes/secret.typ", text: "leak" },
      { path: "../outside.typ", text: "leak" }
    ]);

    expect(overlay.size).toBe(0);
  });

  it("excludes buffers that are not Typst sources", () => {
    const overlay = collectDirtyBuffers(vault, vault, [
      { path: "book/notes.md", text: "# Hello" }
    ]);

    expect(overlay.size).toBe(0);
  });
});
