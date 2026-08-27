import { describe, expect, it } from "vitest";

import { resolveNewTypstFile } from "../src/new-typst-file";

const nothingExists = (): boolean => false;

describe("resolveNewTypstFile", () => {
  it("names the first file Untitled.typ inside the given folder", () => {
    expect(resolveNewTypstFile("", nothingExists)?.path).toBe("Untitled.typ");
    expect(resolveNewTypstFile("book", nothingExists)?.path).toBe("book/Untitled.typ");
    expect(resolveNewTypstFile("book/", nothingExists)?.path).toBe("book/Untitled.typ");
    expect(resolveNewTypstFile(".", nothingExists)?.path).toBe("Untitled.typ");
  });

  it("moves to the next free name instead of overwriting a taken one", () => {
    const taken = new Set(["book/Untitled.typ", "book/Untitled 1.typ"]);
    expect(resolveNewTypstFile("book", (path) => taken.has(path))?.path)
      .toBe("book/Untitled 2.typ");
  });

  it("gives up rather than probing candidates without bound", () => {
    expect(resolveNewTypstFile("book", () => true)).toBeNull();
  });

  it("starts the document with a heading named after the file", () => {
    const taken = new Set(["Untitled.typ"]);
    expect(resolveNewTypstFile("", (path) => taken.has(path))?.content)
      .toBe("= Untitled 1\n");
  });
});
