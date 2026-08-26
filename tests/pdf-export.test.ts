// @vitest-environment happy-dom

import { TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import TypstianPlugin from "../src/main";
import { resolvePdfExportPath } from "../src/pdf-export";

const missing = (): boolean => false;

describe("resolvePdfExportPath", () => {
  it("puts the PDF beside a nested source under the same basename", () => {
    expect(resolvePdfExportPath("book/chapters/intro.typ", missing))
      .toBe("book/chapters/intro.pdf");
  });

  it("replaces only the final extension of a dotted basename", () => {
    expect(resolvePdfExportPath("notes/report.v1.2.typ", missing))
      .toBe("notes/report.v1.2.pdf");
  });

  it("keeps a vault-root source at the vault root", () => {
    expect(resolvePdfExportPath("main.typ", missing)).toBe("main.pdf");
  });

  it("numbers the target instead of overwriting an existing file", () => {
    const taken = new Set(["book/main.pdf", "book/main-1.pdf"]);
    expect(resolvePdfExportPath("book/main.typ", (path) => taken.has(path)))
      .toBe("book/main-2.pdf");
  });

  it("gives up rather than probing unbounded candidates", () => {
    expect(resolvePdfExportPath("book/main.typ", () => true)).toBeNull();
  });
});

function harness(existing: string[] = []) {
  const files = new Set(existing);
  const vault = {
    adapter: {},
    getAbstractFileByPath: vi.fn(
      (path: string) => (files.has(path) ? Object.assign(new TFile(), { path }) : null),
    ),
    createBinary: vi.fn((path: string, data: ArrayBuffer) => {
      void data;
      files.add(path);
      return Promise.resolve(Object.assign(new TFile(), { path }));
    }),
    on: vi.fn(),
  };
  const workspace = {
    getLeavesOfType: vi.fn(() => []),
    getActiveViewOfType: vi.fn(() => null),
    on: vi.fn(),
    onLayoutReady: vi.fn(),
  };
  const plugin = new TypstianPlugin({ vault, workspace } as never, {} as never);
  const internals = plugin as unknown as {
    savePdf(sourcePath: string): Promise<void>;
    vaultRoot(): string;
    compilationRoot(vaultRoot: string): string;
    createCompilerClient(): unknown;
  };
  vi.spyOn(internals, "vaultRoot").mockReturnValue("/vault");
  vi.spyOn(internals, "compilationRoot").mockReturnValue("/vault");
  return { internals, vault };
}

function compilerStub(result: unknown) {
  return {
    close: vi.fn(),
    compile: vi.fn(() => Promise.resolve(result)),
  };
}

describe("TypstianPlugin PDF export", () => {
  it("writes the compiled bytes through the vault binary API", async () => {
    const { internals, vault } = harness();
    const compiler = compilerStub({
      ok: true,
      revision: 1,
      pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      pages: [],
      dependencies: [],
      diagnostics: [],
    });
    vi.spyOn(internals, "createCompilerClient").mockReturnValue(compiler);

    await internals.savePdf("book/main.typ");

    expect(compiler.compile).toHaveBeenCalledWith(
      expect.objectContaining({ entryPath: "book/main.typ" }),
    );
    expect(vault.createBinary).toHaveBeenCalledOnce();
    const [target, data] = vault.createBinary.mock.calls[0]!;
    expect(target).toBe("book/main.pdf");
    expect(new Uint8Array(data)).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    expect(compiler.close).toHaveBeenCalledOnce();
  });

  it("does not write anything when the compile fails", async () => {
    const { internals, vault } = harness();
    const compiler = compilerStub({
      ok: false,
      revision: 1,
      reason: "compile-error",
      message: "unknown variable",
      dependencies: [],
      diagnostics: [],
    });
    vi.spyOn(internals, "createCompilerClient").mockReturnValue(compiler);

    await internals.savePdf("book/main.typ");

    expect(vault.createBinary).not.toHaveBeenCalled();
    expect(compiler.close).toHaveBeenCalledOnce();
  });

  it("writes beside the source without touching an existing PDF", async () => {
    const { internals, vault } = harness(["book/main.pdf"]);
    const compiler = compilerStub({
      ok: true,
      revision: 1,
      pdf: new Uint8Array([0x25]),
      pages: [],
      dependencies: [],
      diagnostics: [],
    });
    vi.spyOn(internals, "createCompilerClient").mockReturnValue(compiler);

    await internals.savePdf("book/main.typ");

    expect(vault.createBinary.mock.calls[0]?.[0]).toBe("book/main-1.pdf");
  });
});
