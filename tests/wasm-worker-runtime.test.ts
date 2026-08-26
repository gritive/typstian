import fs from "node:fs";
import path from "node:path";
import { Worker as NodeWorker } from "node:worker_threads";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

import { rootedReadFile } from "../src/wasm-vault-reader";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface WorkerHarness {
  worker: NodeWorker;
  call<T>(method: string, payload: unknown): Promise<T>;
  inputBatches(): number;
}

async function startWorker(maxOutputBytes: number): Promise<WorkerHarness> {
  const bundle = await build({
    entryPoints: ["src/wasm-worker.ts"],
    bundle: true,
    define: { "import.meta.url": "undefined" },
    format: "iife",
    platform: "browser",
    target: "es2021",
    write: false,
  });
  const workerSource = bundle.outputFiles[0]?.text;
  if (workerSource === undefined) throw new Error("missing worker bundle");

  const wrapper = `
    const { parentPort } = require("node:worker_threads");
    globalThis.self = {
      addEventListener(type, listener) {
        if (type === "message") parentPort.on("message", data => listener({ data }));
      },
      postMessage(message) {
        parentPort.postMessage(message);
      }
    };
    ${workerSource}
  `;
  const worker = new NodeWorker(wrapper, { eval: true });
  const fixtureRoot = path.resolve("tests/fixtures/project");
  const readFile = rootedReadFile(fixtureRoot);
  const pending = new Map<number, PendingRequest>();
  let requestId = 0;
  let inputBatches = 0;

  worker.on("message", (message: unknown) => {
    if (typeof message !== "object" || message === null) return;
    const record = message as Record<string, unknown>;
    if (
      record.type === "need-inputs"
      && Array.isArray(record.vaultPaths)
      && Array.isArray(record.fontPaths)
    ) {
      inputBatches += 1;
      const vaultFiles = record.vaultPaths
        .filter((filePath): filePath is string => typeof filePath === "string")
        .map((filePath) => {
          const bytes = readFile(filePath);
          return {
            kind: "vault",
            path: filePath,
            bytes: bytes?.buffer ?? null,
          };
        });
      const fontFiles = record.fontPaths
        .filter((fontPath): fontPath is string => typeof fontPath === "string")
        .map((fontPath) => ({ kind: "font", path: fontPath, bytes: null }));
      worker.postMessage({
        type: "inputs",
        batchId: record.batchId,
        files: [...vaultFiles, ...fontFiles],
        done: true,
      });
      return;
    }
    if (record.type !== "response" || typeof record.id !== "number") return;
    const request = pending.get(record.id);
    if (request === undefined) return;
    pending.delete(record.id);
    if (record.ok === true) request.resolve(record.value);
    else request.reject(new Error(String(record.error)));
  });

  const call = <T>(method: string, payload: unknown): Promise<T> => {
    const id = ++requestId;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      worker.postMessage({ type: "request", id, method, payload });
    });
  };

  const module = await WebAssembly.compile(
    fs.readFileSync("helper/wasm/pkg/typstian_wasm_bg.wasm"),
  );
  await call("initialize", { module, maxOutputBytes });
  return { worker, call, inputBatches: () => inputBatches };
}

describe("bundled browser WASM worker", () => {
  it("compiles through asynchronous input batches without blocking the host", async () => {
    const harness = await startWorker(70 * 1024 * 1024);
    try {
      let hostTurnRan = false;
      const compiling = harness.call<unknown>("compile", {
        revision: 1,
        entryPath: "main.typ",
      });
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          hostTurnRan = true;
          resolve();
        }, 0);
      });
      expect(hostTurnRan).toBe(true);

      const response = await compiling as Record<string, unknown>;
      expect(response).toMatchObject({ type: "compiled", revision: 1 });
      expect(response.pdfBuffer).toBeInstanceOf(ArrayBuffer);
      expect(new Uint8Array(response.pdfBuffer as ArrayBuffer).subarray(0, 5)).toEqual(
        Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
      );
      expect(harness.inputBatches()).toBeGreaterThan(0);
    } finally {
      await harness.worker.terminate();
    }
  }, 30_000);

  it("rejects oversized compiler output before parsing it", async () => {
    const harness = await startWorker(1);
    try {
      await expect(harness.call("compile", {
        revision: 1,
        entryPath: "main.typ",
      })).rejects.toThrow("output exceeded its limit");
    } finally {
      await harness.worker.terminate();
    }
  });
});
