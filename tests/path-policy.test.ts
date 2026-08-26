import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  resolveCompilationRoot,
  resolveDiagnosticVaultPath,
  resolveCompilerEntryPath
} from "../src/path-policy";

describe("resolveDiagnosticVaultPath", () => {
  const vault = path.resolve("/vault");

  it("maps a compiler path under the vault to an Obsidian path", () => {
    expect(resolveDiagnosticVaultPath(vault, vault, "book/chapter.typ"))
      .toBe("book/chapter.typ");
  });

  it("rejects paths outside the vault", () => {
    expect(resolveDiagnosticVaultPath(vault, vault, "../secret.typ")).toBeNull();
    expect(resolveDiagnosticVaultPath(vault, vault, path.resolve("/secret.typ"))).toBeNull();
  });
});

describe("resolveCompilationRoot", () => {
  it("rejects a vault-local root symlink that resolves outside the vault", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "typst-root-policy-"));
    try {
      const vault = path.join(temporary, "vault");
      const outside = path.join(temporary, "outside");
      fs.mkdirSync(vault);
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(vault, "linked"), process.platform === "win32" ? "junction" : "dir");

      expect(() => resolveCompilationRoot(vault, "linked"))
        .toThrow("Compilation root must resolve inside the vault");
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("returns the canonical path for a real directory inside the vault", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "typst-root-policy-"));
    try {
      const root = path.join(temporary, "book");
      fs.mkdirSync(root);
      expect(resolveCompilationRoot(temporary, "book")).toBe(fs.realpathSync(root));
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});

describe("resolveCompilerEntryPath", () => {
  const vault = path.resolve("/vault");
  const root = path.resolve(vault, "book");

  it("maps a vault path to the compiler root", () => {
    expect(resolveCompilerEntryPath(vault, root, "book/chapters/main.typ"))
      .toBe("chapters/main.typ");
  });

  it("rejects sources outside the compilation root or vault", () => {
    expect(resolveCompilerEntryPath(vault, root, "other/main.typ")).toBeNull();
    expect(resolveCompilerEntryPath(vault, root, "../secret.typ")).toBeNull();
    expect(resolveCompilerEntryPath(vault, root, "book/main.md")).toBeNull();
  });
});
