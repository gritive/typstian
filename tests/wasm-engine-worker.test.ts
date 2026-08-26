import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  readVault: vi.fn<(path: string) => Promise<Uint8Array | undefined>>(),
  readPackage: vi.fn<(key: string) => Promise<Uint8Array | undefined>>(),
  readFont: vi.fn<(path: string, signal?: AbortSignal) => Promise<Uint8Array | undefined>>(),
  registerFonts: vi.fn(),
}));

vi.mock("../src/wasm-vault-reader", () => ({
  rootedReadFile: () => () => undefined,
  rootedReadFileAsync: () => host.readVault,
}));

vi.mock("../src/typst-packages", () => ({
  createLocalPackageReader: () => ({ readSync: () => undefined, read: host.readPackage }),
  typstPackageDirectories: () => [],
}));

vi.mock("../src/system-fonts", () => ({
  registerSystemFonts: host.registerFonts,
  systemFontDirectories: () => [],
}));

import { createWasmEngine } from "../src/wasm-engine";

type WorkerListener = (event: { data?: unknown; message?: string }) => void;

class FakeBrowserWorker {
  static instances: FakeBrowserWorker[] = [];
  static vaultPaths: string[] = [];
  static packagePaths: string[] = [];
  static fontPaths: string[] = [];

  readonly messages: Array<Record<string, unknown>> = [];
  readonly terminate = vi.fn();
  private readonly listeners = new Map<string, Set<WorkerListener>>();
  private compileRequestId: number | undefined;

  constructor(readonly url: string) {
    FakeBrowserWorker.instances.push(this);
  }

  addEventListener(type: string, listener: WorkerListener): void {
    const listeners = this.listeners.get(type) ?? new Set<WorkerListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: WorkerListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: Record<string, unknown>): void {
    this.messages.push(message);
    if (message.type === "request" && message.method === "initialize") {
      this.respond(Number(message.id), undefined);
      return;
    }
    if (message.type === "request" && message.method === "compile") {
      this.compileRequestId = Number(message.id);
      queueMicrotask(() => this.emit("message", {
        data: {
          type: "need-inputs",
          batchId: 1,
          vaultPaths: FakeBrowserWorker.vaultPaths,
          packagePaths: FakeBrowserWorker.packagePaths,
          fontPaths: FakeBrowserWorker.fontPaths,
        },
      }));
      return;
    }
    if (message.type === "inputs" && typeof message.error === "string") {
      this.failCompile(message.error);
      return;
    }
    if (message.type === "inputs" && message.done === true) {
      this.respond(this.compileRequestId!, "compiled");
    }
  }

  emit(type: string, event: { data?: unknown; message?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  private respond(id: number, value: unknown): void {
    queueMicrotask(() => this.emit("message", {
      data: { type: "response", id, ok: true, value },
    }));
  }

  private failCompile(error: string): void {
    this.emit("message", {
      data: { type: "response", id: this.compileRequestId, ok: false, error },
    });
  }
}

function sizedBytes(size: number): Uint8Array {
  return new Proxy(new Uint8Array([1]), {
    get(target, property) {
      if (property === "byteLength") return size;
      return Reflect.get(target, property, target) as unknown;
    },
  });
}

describe("browser worker WASM engine", () => {
  let temporary: string;
  let wasmPath: string;

  beforeEach(() => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), "typstian-worker-engine-"));
    wasmPath = path.join(temporary, "compiler.wasm");
    fs.writeFileSync(wasmPath, "wasm");
    FakeBrowserWorker.instances = [];
    FakeBrowserWorker.vaultPaths = [];
    FakeBrowserWorker.packagePaths = [];
    FakeBrowserWorker.fontPaths = [];
    host.readVault.mockReset();
    host.readPackage.mockReset();
    host.readFont.mockReset();
    host.registerFonts.mockReset();
    host.registerFonts.mockResolvedValue({
      readSync: () => undefined,
      read: host.readFont,
    });
    vi.stubGlobal("Worker", FakeBrowserWorker);
    vi.stubGlobal("__TYPSTIAN_WORKER_SOURCE__", "self.onmessage = () => {};");
    vi.spyOn(WebAssembly, "compile").mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  it("streams asynchronous vault and font inputs before completing a batch", async () => {
    FakeBrowserWorker.vaultPaths = ["main.typ"];
    FakeBrowserWorker.fontPaths = ["/system/font.ttf"];
    host.readVault.mockResolvedValue(Uint8Array.from([1, 2]));
    host.readFont.mockResolvedValue(Uint8Array.from([3, 4, 5]));
    const engine = await createWasmEngine({
      rootPath: temporary,
      wasmPath,
      maxOutputBytes: 70 * 1024 * 1024,
    });

    await expect(engine.ready()).resolves.toBeUndefined();
    await expect(engine.compile({ revision: 1, entryPath: "main.typ" })).resolves.toBe(
      "compiled",
    );

    const worker = FakeBrowserWorker.instances[0]!;
    expect(worker.messages[0]).toMatchObject({
      method: "initialize",
      payload: { maxOutputBytes: 70 * 1024 * 1024 },
    });
    const inputMessages = worker.messages.filter((message) => message.type === "inputs");
    expect(worker.url).toMatch(/^blob:/);
    expect(host.readVault).toHaveBeenCalledWith("main.typ");
    expect(host.readFont).toHaveBeenCalledWith("/system/font.ttf", expect.any(AbortSignal));
    expect(inputMessages.map((message) => message.done)).toEqual([false, false, true]);
    expect(inputMessages.slice(0, 2).map((message) => message.files)).toMatchObject([
      [{ kind: "vault", path: "main.typ" }],
      [{ kind: "font", path: "/system/font.ttf" }],
    ]);
    engine.dispose();
  });

  it("streams package files on a channel of their own", async () => {
    FakeBrowserWorker.vaultPaths = ["main.typ"];
    FakeBrowserWorker.packagePaths = ["preview/greet/0.1.0/typst.toml"];
    host.readVault.mockResolvedValue(Uint8Array.from([1]));
    host.readPackage.mockResolvedValue(Uint8Array.from([2, 3]));
    const engine = await createWasmEngine({
      rootPath: temporary,
      wasmPath,
      maxOutputBytes: 70 * 1024 * 1024,
    });

    await expect(engine.compile({ revision: 1, entryPath: "main.typ" })).resolves.toBe(
      "compiled",
    );

    expect(host.readPackage).toHaveBeenCalledWith("preview/greet/0.1.0/typst.toml");
    expect(host.readVault).not.toHaveBeenCalledWith("preview/greet/0.1.0/typst.toml");
    const inputMessages = FakeBrowserWorker.instances[0]!.messages
      .filter((message) => message.type === "inputs");
    expect(inputMessages.slice(0, 2).map((message) => message.files)).toMatchObject([
      [{ kind: "vault", path: "main.typ" }],
      [{ kind: "package", path: "preview/greet/0.1.0/typst.toml" }],
    ]);
    engine.dispose();
  });

  it("charges package bytes to the same 70 MiB compile budget as vault files", async () => {
    FakeBrowserWorker.vaultPaths = ["main.typ"];
    FakeBrowserWorker.packagePaths = ["preview/greet/0.1.0/typst.toml"];
    host.readVault.mockResolvedValue(new Uint8Array(35 * 1024 * 1024));
    host.readPackage.mockResolvedValue(sizedBytes(40 * 1024 * 1024));
    const engine = await createWasmEngine({
      rootPath: temporary,
      wasmPath,
      maxOutputBytes: 70 * 1024 * 1024,
    });

    await expect(engine.compile({ revision: 1, entryPath: "main.typ" })).rejects.toThrow(
      "Typstian compiler inputs exceeded the 70 MiB limit.",
    );
    engine.dispose();
  });

it("prefers overlay bytes to disk reads", async () => {
    FakeBrowserWorker.vaultPaths = ["main.typ"];
    const overlayBytes = Uint8Array.from([1, 2, 3]);
    host.readVault.mockResolvedValue(Uint8Array.from([9]));
    const engine = await createWasmEngine({
      rootPath: temporary,
      wasmPath,
      maxOutputBytes: 70 * 1024 * 1024,
    });
    await engine.ready();

    await expect(engine.compile({
      revision: 1,
      entryPath: "main.typ",
      overlay: new Map([["main.typ", overlayBytes]]),
    })).resolves.toBe("compiled");

    expect(host.readVault).not.toHaveBeenCalled();
    const input = FakeBrowserWorker.instances[0]!.messages.find(
      (message) => message.type === "inputs" && message.done === false,
    );
    expect(input).toMatchObject({
      files: [{ kind: "vault", path: "main.typ", bytes: overlayBytes.buffer }],
    });
    engine.dispose();
  });

it("releases the compile input context when the request settles", async () => {
    FakeBrowserWorker.vaultPaths = ["main.typ"];
    const engine = await createWasmEngine({
      rootPath: temporary,
      wasmPath,
      maxOutputBytes: 70 * 1024 * 1024,
    });
    await engine.ready();
    await engine.compile({
      revision: 1,
      entryPath: "main.typ",
      overlay: new Map([["main.typ", Uint8Array.from([1])]]),
    });

    const worker = FakeBrowserWorker.instances[0]!;
    worker.emit("message", {
      data: {
        type: "need-inputs",
        batchId: 99,
        vaultPaths: ["main.typ"],
        packagePaths: [],
        fontPaths: [],
      },
    });
    await vi.waitFor(() => expect(worker.messages).toContainEqual(
      expect.objectContaining({
        type: "inputs",
        batchId: 99,
        done: true,
        error: "Typstian compiler requested inputs outside a compile.",
      }),
    ));
    engine.dispose();
  });

  it("rejects a compile before transferred vault inputs exceed 70 MiB", async () => {
    FakeBrowserWorker.vaultPaths = ["first.typ", "second.typ"];
    host.readVault.mockImplementation((filePath) => Promise.resolve(
      filePath === "first.typ"
        ? new Uint8Array(35 * 1024 * 1024)
        : sizedBytes(40 * 1024 * 1024),
    ));
    const engine = await createWasmEngine({
      rootPath: temporary,
      wasmPath,
      maxOutputBytes: 70 * 1024 * 1024,
    });
    await engine.ready();

    await expect(engine.compile({ revision: 1, entryPath: "first.typ" })).rejects.toThrow(
      "70 MiB limit",
    );
    const inputs = FakeBrowserWorker.instances[0]!.messages.filter(
      (message) => message.type === "inputs",
    );
    expect(inputs.at(-1)).toMatchObject({ done: true });
    expect(inputs.at(-1)?.error).toContain("70 MiB");
    engine.dispose();
  });

it("charges overlay bytes to the 70 MiB compile budget", async () => {
    FakeBrowserWorker.vaultPaths = ["first.typ", "second.typ"];
    const overlay = new Map([
      ["first.typ", new Uint8Array(35 * 1024 * 1024)],
      ["second.typ", sizedBytes(40 * 1024 * 1024)],
    ]);
    const engine = await createWasmEngine({
      rootPath: temporary,
      wasmPath,
      maxOutputBytes: 70 * 1024 * 1024,
    });
    await engine.ready();

    await expect(engine.compile({
      revision: 1,
      entryPath: "first.typ",
      overlay,
    })).rejects.toThrow("70 MiB limit");
    expect(host.readVault).not.toHaveBeenCalled();
    engine.dispose();
  });

  it("aborts font initialization when disposed", async () => {
    let initializationSignal: AbortSignal | undefined;
    host.registerFonts.mockImplementation(
      (_directories: string[], _register: unknown, signal: AbortSignal) => new Promise(
        (_resolve, reject) => {
          initializationSignal = signal;
          signal.addEventListener("abort", () => reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Font initialization was aborted."),
          ), { once: true });
        },
      ),
    );
    const engine = await createWasmEngine({
      rootPath: temporary,
      wasmPath,
      maxOutputBytes: 70 * 1024 * 1024,
    });
    const ready = engine.ready();
    await vi.waitFor(() => expect(initializationSignal).toBeDefined());

    engine.dispose();

    expect(initializationSignal?.aborted).toBe(true);
    await expect(ready).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeBrowserWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });
});
