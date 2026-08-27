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

  it("rejects one dirty buffer over the vault input file limit", () => {
    const oversized = "a".repeat(50 * 1024 * 1024 + 1);

    expect(() => collectDirtyBuffers(vault, vault, [
      { path: "main.typ", text: oversized },
    ])).toThrow("Dirty Typst buffer main.typ exceeded the 50 MiB file limit.");
  });

  it("charges only the last dirty buffer for a compiler path", () => {
    const first = "a".repeat(40 * 1024 * 1024);
    const second = "b".repeat(40 * 1024 * 1024);

    const overlay = collectDirtyBuffers(vault, vault, [
      { path: "main.typ", text: first },
      { path: "main.typ", text: second },
    ]);

    expect(overlay.size).toBe(1);
    expect(overlay.get("main.typ")).toHaveLength(40 * 1024 * 1024);
    expect(overlay.get("main.typ")?.[0]).toBe("b".charCodeAt(0));
  });

  it("rejects dirty buffers over the aggregate vault input limit", () => {
    const first = "a".repeat(40 * 1024 * 1024);
    const second = "b".repeat(30 * 1024 * 1024 + 1);

    expect(() => collectDirtyBuffers(vault, vault, [
      { path: "main.typ", text: first },
      { path: "chapter.typ", text: second },
    ])).toThrow("Dirty Typst buffers exceeded the 70 MiB aggregate limit.");
  });
});
