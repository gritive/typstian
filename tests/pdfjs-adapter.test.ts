import { describe, expect, it, vi } from "vitest";

import { createPdfJsEngine, type PdfJsApi } from "../src/pdfjs-adapter";

describe("createPdfJsEngine", () => {
  it("loads owned PDF bytes with network-free and eval-free PDF.js options", () => {
    const loadingTask = { promise: Promise.resolve({ numPages: 0 }), destroy: vi.fn() };
    const getDocument = vi.fn(() => loadingTask);
    const worker = { destroy: vi.fn() };
    const api = {
      createMessageChannel: () => ({
        port1: { start: vi.fn(), close: vi.fn() },
        port2: { start: vi.fn(), close: vi.fn() },
      }),
      createPdfWorker: () => worker,
      getDocument,
      initializeWorkerFromPort: vi.fn(),
      TextLayer: class {},
    } as unknown as PdfJsApi;
    const engine = createPdfJsEngine(api);
    const bytes = new Uint8Array([1, 2, 3]);

    expect(engine.load(bytes).promise).toBe(loadingTask.promise);
    expect(getDocument).toHaveBeenCalledWith({
      data: bytes,
      isEvalSupported: false,
      useWorkerFetch: false,
      worker,
    });
  });

  it("starts both MessagePorts before PDF.js begins loading the document", () => {
    const calls: string[] = [];
    const port1 = {
      start: vi.fn(() => calls.push("start-port-1")),
      close: vi.fn(),
    };
    const port2 = {
      start: vi.fn(() => calls.push("start-port-2")),
      close: vi.fn(),
    };
    const loadingTask = { promise: Promise.resolve({ numPages: 0 }), destroy: vi.fn() };
    const api = {
      createMessageChannel: () => ({ port1, port2 }),
      createPdfWorker: vi.fn(() => ({ destroy: vi.fn() })),
      getDocument: vi.fn(() => {
        calls.push("get-document");
        return loadingTask;
      }),
      initializeWorkerFromPort: vi.fn(),
      TextLayer: class {},
    } as unknown as PdfJsApi;

    createPdfJsEngine(api).load(new Uint8Array([1]));

    expect(calls).toEqual(["start-port-1", "start-port-2", "get-document"]);
  });

  it("adapts the public TextLayer render and cancel lifecycle", async () => {
    const render = vi.fn(() => Promise.resolve());
    const cancel = vi.fn();
    const TextLayer = vi.fn(function (this: { render: typeof render; cancel: typeof cancel }) {
      this.render = render;
      this.cancel = cancel;
    });
    const api = { getDocument: vi.fn(), TextLayer } as unknown as PdfJsApi;
    const engine = createPdfJsEngine(api);
    const container = {} as HTMLElement;
    const viewport = { width: 10, height: 20, convertToPdfPoint: vi.fn() };
    const source = { items: [] };

    const task = engine.createTextLayer({
      textContentSource: source,
      container,
      viewport,
    });
    await task.render();
    task.cancel();

    expect(TextLayer).toHaveBeenCalledWith({
      textContentSource: source,
      container,
      viewport,
    });
    expect(render).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("owns one bundled in-process worker until the loading task is destroyed", async () => {
    const port1 = { start: vi.fn(), close: vi.fn() };
    const port2 = { start: vi.fn(), close: vi.fn() };
    const worker = { destroy: vi.fn(() => Promise.resolve()) };
    const loadingTask = {
      promise: Promise.resolve({ numPages: 0 }),
      destroy: vi.fn(() => Promise.resolve()),
    };
    const initializeWorkerFromPort = vi.fn();
    const createPdfWorker = vi.fn(() => worker);
    const getDocument = vi.fn(() => loadingTask);
    const api = {
      createMessageChannel: () => ({ port1, port2 }),
      createPdfWorker,
      getDocument,
      initializeWorkerFromPort,
      TextLayer: class {},
    } as unknown as PdfJsApi;
    const task = createPdfJsEngine(api).load(new Uint8Array([1]));

    expect(initializeWorkerFromPort).toHaveBeenCalledWith(port1);
    expect(createPdfWorker).toHaveBeenCalledWith(port2);
    expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ worker }));

    await task.destroy();
    await task.destroy();

    expect(loadingTask.destroy).toHaveBeenCalledOnce();
    expect(worker.destroy).toHaveBeenCalledOnce();
    expect(port1.close).toHaveBeenCalledOnce();
    expect(port2.close).toHaveBeenCalledOnce();
  });

  it("closes both ports when bundled worker initialization throws", async () => {
    const port1 = { start: vi.fn(), close: vi.fn() };
    const port2 = { start: vi.fn(), close: vi.fn() };
    const api = {
      createMessageChannel: () => ({ port1, port2 }),
      createPdfWorker: vi.fn(),
      getDocument: vi.fn(),
      initializeWorkerFromPort: vi.fn(() => { throw new Error("worker init failed"); }),
      TextLayer: class {}
    } as unknown as PdfJsApi;

    expect(() => createPdfJsEngine(api).load(new Uint8Array([1])))
      .toThrow("worker init failed");
    await Promise.resolve();

    expect(port1.close).toHaveBeenCalledOnce();
    expect(port2.close).toHaveBeenCalledOnce();
  });

  it("destroys the worker and ports when getDocument throws synchronously", async () => {
    const port1 = { start: vi.fn(), close: vi.fn() };
    const port2 = { start: vi.fn(), close: vi.fn() };
    const worker = { destroy: vi.fn(() => Promise.resolve()) };
    const api = {
      createMessageChannel: () => ({ port1, port2 }),
      createPdfWorker: vi.fn(() => worker),
      getDocument: vi.fn(() => { throw new Error("PDF load failed"); }),
      initializeWorkerFromPort: vi.fn(),
      TextLayer: class {}
    } as unknown as PdfJsApi;

    expect(() => createPdfJsEngine(api).load(new Uint8Array([1])))
      .toThrow("PDF load failed");
    await Promise.resolve();
    await Promise.resolve();

    expect(worker.destroy).toHaveBeenCalledOnce();
    expect(port1.close).toHaveBeenCalledOnce();
    expect(port2.close).toHaveBeenCalledOnce();
  });
});
