// @vitest-environment happy-dom
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { describe, expect, it } from "vitest";

import { TypstianCompilerClient } from "../src/compiler-client";
import { createPdfJsEngine } from "../src/pdfjs-adapter";
import { createWasmEngine } from "../src/wasm-engine";
import {
  MAX_VAULT_INPUT_FILE_BYTES,
  rootedReadFile,
} from "../src/wasm-vault-reader";

const fixtureRoot = path.resolve("helper/tests/fixtures/project");

function localDate(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
}

function utcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

describe("bundled Typstian WASM engine", () => {
it("loads embedded Brotli WASM without a release-side asset", { timeout: 15_000 }, async () => {
    const runtime = globalThis as typeof globalThis & {
      __TYPSTIAN_WASM_BROTLI__?: string;
    };
    runtime.__TYPSTIAN_WASM_BROTLI__ = brotliCompressSync(
      fs.readFileSync("helper/wasm/pkg/typstian_wasm_bg.wasm"),
      {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 0,
        },
      },
    ).toString("base64");
    try {
      const baselineStartedAt = performance.now();
      const baselineDelay = await new Promise<number>((resolve) => {
        setImmediate(() => resolve(performance.now() - baselineStartedAt));
      });
      const startedAt = performance.now();
      const eventLoopTurn = new Promise<number>((resolve) => {
        setImmediate(() => resolve(performance.now() - startedAt));
      });
      const firstEngine = await createWasmEngine({
        rootPath: fixtureRoot,
        wasmPath: path.resolve("missing-community-release-asset.wasm"),
        maxOutputBytes: 70 * 1024 * 1024,
      });
      const secondEngine = await createWasmEngine({
        rootPath: fixtureRoot,
        wasmPath: path.resolve("another-missing-community-release-asset.wasm"),
        maxOutputBytes: 70 * 1024 * 1024,
      });
      try {
        expect(await eventLoopTurn).toBeLessThan(baselineDelay + 75);
        const responses = await Promise.all([
          firstEngine.checkEnvironment(),
          secondEngine.checkEnvironment(),
        ]);
        for (const response of responses) {
          expect(JSON.parse(response)).toEqual({
            type: "environment",
            protocolVersion: 5,
            typstVersion: "0.15.1",
          });
        }
      } finally {
        firstEngine.dispose();
        secondEngine.dispose();
      }
    } finally {
      delete runtime.__TYPSTIAN_WASM_BROTLI__;
    }
  });

it("compiles an equation with the embedded math face", async () => {
    const client = new TypstianCompilerClient({
      rootPath: fixtureRoot,
      wasmPath: path.resolve("helper/wasm/pkg/typstian_wasm_bg.wasm"),
    });
    try {
      const result = await client.compile({ revision: 1, entryPath: "equation.typ" });

      // Operating systems do not ship a math face, so without the embedded one
      // Typst fails the whole compile with "no font could be found".
      expect(result.ok).toBe(true);
    } finally {
      client.close();
    }
  });

it("resolves datetime.today() to the host's own local date", async () => {
    const client = new TypstianCompilerClient({
      rootPath: fixtureRoot,
      wasmPath: path.resolve("helper/wasm/pkg/typstian_wasm_bg.wasm"),
    });
    try {
      // The date is read on both sides of the compile so a midnight rollover
      // widens the expectation instead of failing the run.
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 86_400_000);
      const source = [
        `#let local = datetime.today().display("[year]-[month]-[day]")`,
        `#let utc = datetime.today(offset: 0).display("[year]-[month]-[day]")`,
        `#assert(local == "${localDate(now)}" or local == "${localDate(tomorrow)}",`,
        `  message: "local: " + local)`,
        `#assert(utc == "${utcDate(now)}" or utc == "${utcDate(tomorrow)}",`,
        `  message: "utc: " + utc)`,
        `Dated`,
      ].join("\n");
      const result = await client.compile({
        revision: 1,
        entryPath: "today.typ",
        overlay: new Map([["today.typ", new TextEncoder().encode(source)]]),
      });

      // A wrong offset sign would shift the local date by twice the host's
      // offset, which no fixed expectation on the Rust side can catch.
      expect(result.ok, result.ok ? "" : JSON.stringify(result)).toBe(true);
    } finally {
      client.close();
    }
  });

it("embeds a Korean glyph", async () => {
    const client = new TypstianCompilerClient({
      rootPath: fixtureRoot,
      wasmPath: path.resolve("helper/wasm/pkg/typstian_wasm_bg.wasm"),
    });
    try {
      const result = await client.compile({ revision: 1, entryPath: "korean.typ" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const loadingTask = createPdfJsEngine().load(result.pdf);
      try {
        const document = await loadingTask.promise;
        const page = await document.getPage(1);
        const content = await page.getTextContent() as {
          items: Array<{ str?: string }>;
        };
        expect(content.items.map((item) => item.str ?? "").join(" ")).toContain("한");
        page.cleanup();
      } finally {
        await loadingTask.destroy();
      }
    } finally {
      client.close();
    }
  });

  it("compiles the imported image fixture and answers a retained-document jump", async () => {
    const client = new TypstianCompilerClient({
      rootPath: fixtureRoot,
      wasmPath: path.resolve("helper/wasm/pkg/typstian_wasm_bg.wasm"),
    });
    try {
      const environment = await client.checkEnvironment();
      expect(environment).toEqual({ protocolVersion: 5, typstVersion: "0.15.1" });

      const result = await client.compile({ revision: 1, entryPath: "main.typ" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(new TextDecoder().decode(result.pdf.subarray(0, 5))).toBe("%PDF-");
      expect(result.dependencies).toEqual(expect.arrayContaining([
        "main.typ",
        "section.typ",
        "assets/mark.svg"
      ]));

      const section = fs.readFileSync(path.join(fixtureRoot, "section.typ"), "utf8");
      const cursor = section.indexOf("한");
      expect(cursor).toBeGreaterThanOrEqual(0);
      const byteOffset = new TextEncoder().encode(section.slice(0, cursor)).length;
      const forward = await client.forward({
        revision: 1,
        source: "section.typ",
        byteOffset
      });
      expect(forward.revision).toBe(1);
      expect(forward.positions[0]).toMatchObject({ page: 1 });
      expect(forward.positions[0]?.xPt).toBeGreaterThanOrEqual(0);
      expect(forward.positions[0]?.yPt).toBeGreaterThanOrEqual(0);

      const position = forward.positions[0];
      if (position === undefined) throw new Error("missing forward position");
      const jump = await client.jump({
        revision: 1,
        page: position.page,
        xPt: position.xPt,
        yPt: position.yPt
      });
      expect(jump.revision).toBe(1);
      expect(jump.location).not.toBeNull();
      if (jump.location === null) throw new Error("missing inverse-search location");
      expect(jump.location.path).toBe("section.typ");
      expect(Number.isSafeInteger(jump.location.byteOffset)).toBe(true);

      await expect(client.jump({
        revision: 1,
        page: 1,
        xPt: 0,
        yPt: 0
      })).resolves.toEqual({ revision: 1, location: null });
    } finally {
      client.close();
    }
  }, 30_000);

  it("preserves a root-relative source location for compile diagnostics", async () => {
    const client = new TypstianCompilerClient({
      rootPath: path.resolve("helper/tests/fixtures/diagnostics"),
      wasmPath: path.resolve("helper/wasm/pkg/typstian_wasm_bg.wasm"),
    });
    try {
      const result = await client.compile({ revision: 1, entryPath: "invalid.typ" });
      expect(result.ok).toBe(false);
      const diagnostic = result.diagnostics[0];
      expect(diagnostic).toMatchObject({
        path: "invalid.typ",
        severity: "error"
      });
      expect(typeof diagnostic?.line).toBe("number");
      expect(typeof diagnostic?.column).toBe("number");
    } finally {
      client.close();
    }
  }, 30_000);

  it("does not let WASM imports escape the configured compilation root", async () => {
    const client = new TypstianCompilerClient({
      rootPath: path.resolve("helper/tests/fixtures/escape/vault"),
      wasmPath: path.resolve("helper/wasm/pkg/typstian_wasm_bg.wasm"),
    });
    try {
      const result = await client.compile({ revision: 1, entryPath: "import.typ" });
      expect(result).toMatchObject({
        ok: false,
        revision: 1,
        reason: "compile-error"
      });
      expect(result.dependencies).not.toContain("../outside.typ");
    } finally {
      client.close();
    }
  }, 30_000);
});


describe("WASM vault input bounds", () => {
  it("rejects an oversized vault file before reading it into memory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "typstian-input-bound-"));
    const asset = path.join(root, "oversized.bin");
    try {
      fs.writeFileSync(asset, "");
      fs.truncateSync(asset, MAX_VAULT_INPUT_FILE_BYTES + 1);

      expect(rootedReadFile(root)("oversized.bin")).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
