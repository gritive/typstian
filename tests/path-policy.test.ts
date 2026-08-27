import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  checkCompilationRoot,
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

  it("lets the filesystem error out for a root that does not exist", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "typst-root-policy-"));
    try {
      // "must resolve inside the vault" would be a false explanation of a
      // folder the user simply has not created yet.
      expect(() => resolveCompilationRoot(temporary, "boook")).toThrow(/ENOENT/);
      expect(() => resolveCompilationRoot(temporary, "boook"))
        .not.toThrow("Compilation root must resolve inside the vault");
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("keeps letting the filesystem error out for a dangling symlink that escapes", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "typst-root-policy-"));
    try {
      const vault = path.join(temporary, "vault");
      fs.mkdirSync(vault);
      fs.symlinkSync(path.join(temporary, "gone"), path.join(vault, "linked"));

      expect(() => resolveCompilationRoot(vault, "linked")).toThrow(/ENOENT/);
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

describe("checkCompilationRoot", () => {
  const withTemporaryVault = (body: (vault: string) => void): void => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "typst-root-check-"));
    try {
      body(temporary);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  };

  it("accepts a directory inside the vault", () => {
    withTemporaryVault((vault) => {
      fs.mkdirSync(path.join(vault, "book"));
      expect(checkCompilationRoot(vault, "book"))
        .toEqual({ ok: true, path: fs.realpathSync(path.join(vault, "book")) });
    });
  });

  it("reports a path that names nothing as missing", () => {
    withTemporaryVault((vault) => {
      expect(checkCompilationRoot(vault, "boook"))
        .toMatchObject({ ok: false, reason: "missing" });
    });
  });

  it("reports a path the filesystem refuses as unreadable", () => {
    withTemporaryVault((vault) => {
      // A symlink loop is the one filesystem refusal a test can create without
      // depending on the user it runs as.
      fs.symlinkSync("loop-b", path.join(vault, "loop-a"));
      fs.symlinkSync("loop-a", path.join(vault, "loop-b"));
      expect(checkCompilationRoot(vault, "loop-a"))
        .toMatchObject({ ok: false, reason: "unreadable" });
    });
  });

  it("reports a file as not a folder", () => {
    withTemporaryVault((vault) => {
      fs.writeFileSync(path.join(vault, "book.typ"), "");
      expect(checkCompilationRoot(vault, "book.typ")).toEqual({ ok: false, reason: "not-a-folder" });
    });
  });

  it("reports a path that escapes the vault, whether or not it exists", () => {
    withTemporaryVault((temporary) => {
      const vault = path.join(temporary, "vault");
      fs.mkdirSync(vault);
      fs.mkdirSync(path.join(temporary, "outside"));
      expect(checkCompilationRoot(vault, "../outside"))
        .toEqual({ ok: false, reason: "outside-vault" });
      expect(checkCompilationRoot(vault, "../notes"))
        .toEqual({ ok: false, reason: "outside-vault" });
    });
  });

  it("reports a dangling vault-local symlink whose target would be outside the vault", () => {
    withTemporaryVault((temporary) => {
      const vault = path.join(temporary, "vault");
      fs.mkdirSync(vault);
      fs.mkdirSync(path.join(temporary, "outside"));
      // The target does not exist, so canonicalization fails; creating it would
      // not help, because the root would then be an escape.
      fs.symlinkSync(path.join(temporary, "outside", "gone"), path.join(vault, "linked"));

      expect(checkCompilationRoot(vault, "linked"))
        .toMatchObject({ ok: false, reason: "outside-vault" });
    });
  });

  it("reports a symlink out of the vault whose target cannot be read", () => {
    withTemporaryVault((temporary) => {
      const vault = path.join(temporary, "vault");
      const outside = path.join(temporary, "outside");
      fs.mkdirSync(vault);
      fs.mkdirSync(outside);
      fs.symlinkSync("loop-b", path.join(outside, "loop-a"));
      fs.symlinkSync("loop-a", path.join(outside, "loop-b"));
      fs.symlinkSync(path.join(outside, "loop-a"), path.join(vault, "linked"));

      expect(checkCompilationRoot(vault, "linked"))
        .toMatchObject({ ok: false, reason: "outside-vault" });
    });
  });

  it("reports a link inside the vault that points at nothing", () => {
    withTemporaryVault((vault) => {
      fs.symlinkSync(path.join(vault, "gone"), path.join(vault, "linked"));

      expect(checkCompilationRoot(vault, "linked"))
        .toMatchObject({ ok: false, reason: "broken-link" });
    });
  });

  it("reports a vault-local symlink whose target escapes the vault", () => {
    withTemporaryVault((temporary) => {
      const vault = path.join(temporary, "vault");
      const outside = path.join(temporary, "outside");
      fs.mkdirSync(vault);
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(vault, "linked"), process.platform === "win32" ? "junction" : "dir");
      expect(checkCompilationRoot(vault, "linked"))
        .toEqual({ ok: false, reason: "outside-vault" });
    });
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
