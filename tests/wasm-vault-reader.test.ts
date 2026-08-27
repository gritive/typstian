import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  rootedReadFile,
  rootedReadFileAsync,
} from "../src/wasm-vault-reader";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("vault containment", () => {
  it("reads a folder whose name merely starts with two dots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "typstian-dots-"));
    try {
      const canonicalRoot = fs.realpathSync(root);
      fs.mkdirSync(path.join(canonicalRoot, "..hidden"));
      fs.writeFileSync(path.join(canonicalRoot, "..hidden", "main.typ"), "= Hi\n");

      // `..hidden` is a legitimate name, not a way out of the vault.
      expect(rootedReadFile(canonicalRoot)("..hidden/main.typ")).toEqual(
        new TextEncoder().encode("= Hi\n"),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("async rooted WASM reader", () => {
  it("rejects a parent replaced by an external symlink after canonicalization", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "typstian-vault-race-"));
    const root = path.join(temporary, "vault");
    const slot = path.join(root, "slot");
    const candidate = path.join(slot, "main.typ");
    const outside = path.join(temporary, "outside");
    fs.mkdirSync(slot, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(candidate, "inside");
    fs.writeFileSync(path.join(outside, "main.typ"), "outside");

    const realpath = fs.promises.realpath.bind(fs.promises);
    let replaced = false;
    vi.spyOn(fs.promises, "realpath").mockImplementation(async (target) => {
      const resolved = await realpath(target);
      if (!replaced && String(target).endsWith(path.join("slot", "main.typ"))) {
        replaced = true;
        fs.rmSync(slot, { recursive: true, force: true });
        fs.symlinkSync(outside, slot, "dir");
      }
      return resolved;
    });

    try {
      const readFile = rootedReadFileAsync(root);
      await expect(readFile("slot/main.typ")).resolves.toBeUndefined();
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});


describe("rooted WASM reader policy parity", () => {
  it("accepts and rejects the same regular, escaped, and symlinked paths", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "typstian-vault-policy-"));
    const root = path.join(temporary, "vault");
    const outside = path.join(temporary, "outside.typ");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "inside.typ"), "inside");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(root, "link.typ"), "file");
    const syncRead = rootedReadFile(root);
    const asyncRead = rootedReadFileAsync(root);

    try {
      const cases = [
        "inside.typ",
        "../outside.typ",
        outside,
        "link.typ",
        "missing.typ",
      ];
      for (const candidate of cases) {
        const syncBytes = syncRead(candidate);
        const asyncBytes = await asyncRead(candidate);
        expect(asyncBytes).toEqual(syncBytes);
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
