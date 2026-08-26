// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { PreviewRenderer, type PreviewRenderState } from "../src/preview-renderer";
import { makePdfEngine } from "./fake-pdf-engine";

describe("PreviewRenderer", () => {
  it.each<[PreviewRenderState, string]>([
    [{ status: "idle" }, "Open a Typst file"],
    [{ status: "compiling" }, "Compiling"],
    [{ status: "compiler-unavailable", message: "Compiler was not found" }, "Compiler was not found"]
  ])("renders the %s state", async (state, expected) => {
    const root = document.createElement("section");
    const renderer = new PreviewRenderer(root, { pdfEngine: makePdfEngine().engine });

    await renderer.render(state);

    expect(root.textContent).toContain(expected);
  });

  it("keeps the last PDF visible while compiling", async () => {
    const root = document.createElement("section");
    const renderer = new PreviewRenderer(root, { pdfEngine: makePdfEngine().engine });
    await renderer.render({
      status: "ready",
      pdf: new Uint8Array([37, 80, 68, 70, 45])
    });
    const visiblePages = root.querySelector(".typst-pdf-pages");
    expect(visiblePages).not.toBeNull();

    await renderer.render({ status: "compiling" });
    expect(root.querySelector(".typst-pdf-pages")).toBe(visiblePages);
    expect(root.textContent).toContain("Compiling");
  });

  it("passes one opaque PDF artifact to the selectable PDF renderer", async () => {
    const root = document.createElement("section");
    const { engine, load } = makePdfEngine();
    const renderer = new PreviewRenderer(root, { pdfEngine: engine });
    const pdf = new Uint8Array([37, 80, 68, 70, 45]);

    await renderer.render({ status: "ready", pdf });

    expect(load).toHaveBeenCalledWith(pdf);
    expect(root.querySelector(".typst-pdf-pages")).not.toBeNull();
    expect(root.querySelector("img")).toBeNull();
  });

  it("delegates zoom and fit while serializing the followed source", async () => {
    const root = document.createElement("section");
    const renderer = new PreviewRenderer(root, {
      sourcePath: "notes/main.typ",
      pdfEngine: makePdfEngine().engine
    });

    for (let index = 0; index < 30; index += 1) await renderer.zoomIn();
    expect(renderer.serialize()).toEqual({ sourcePath: "notes/main.typ", zoom: 4, fit: false });

    await renderer.fitToWidth();
    expect(renderer.serialize().fit).toBe(true);

    for (let index = 0; index < 30; index += 1) await renderer.zoomOut();
    expect(renderer.serialize()).toEqual({ sourcePath: "notes/main.typ", zoom: 0.25, fit: false });
  });

  it("renders located diagnostics as accessible navigation buttons", async () => {
    const root = document.createElement("section");
    const onDiagnostic = vi.fn();
    const renderer = new PreviewRenderer(root, {
      onDiagnostic,
      pdfEngine: makePdfEngine().engine
    });
    const diagnostic = {
      path: "notes/main.typ",
      line: 7,
      column: 3,
      severity: "error" as const,
      message: "expected expression"
    };

    await renderer.render({
      status: "error",
      message: "Compilation failed",
      diagnostics: [diagnostic]
    });

    const button = root.querySelector("button");
    expect(button?.textContent).toContain("notes/main.typ:7:3");
    expect(button?.getAttribute("aria-label")).toContain("Go to notes/main.typ, line 7, column 3");
    button?.click();
    expect(onDiagnostic).toHaveBeenCalledWith(diagnostic);
  });

  it("cleans the PDF runtime exactly once when disposed", async () => {
    const root = document.createElement("section");
    const { engine, destroy } = makePdfEngine();
    const renderer = new PreviewRenderer(root, { pdfEngine: engine });
    await renderer.render({ status: "ready", pdf: new Uint8Array([37, 80, 68, 70, 45]) });

    await renderer.dispose();
    await renderer.dispose();

    expect(destroy).toHaveBeenCalledOnce();
    expect(root.childElementCount).toBe(0);
  });

  it("does not erase a replacement renderer after asynchronous cleanup", async () => {
    let finishDestroy!: () => void;
    const pendingDestroy = new Promise<void>((resolve) => { finishDestroy = resolve; });
    const oldEngine = makePdfEngine();
    oldEngine.destroy.mockImplementation(() => pendingDestroy);
    const root = document.createElement("section");
    const oldRenderer = new PreviewRenderer(root, { pdfEngine: oldEngine.engine });
    await oldRenderer.render({ status: "ready", pdf: new Uint8Array([37, 80, 68, 70, 45]) });

    const disposing = oldRenderer.dispose();
    const replacement = new PreviewRenderer(root, { pdfEngine: makePdfEngine().engine });
    await replacement.render({ status: "idle" });
    finishDestroy();
    await disposing;

    expect(root.textContent).toContain("Open a Typst file");
    await replacement.dispose();
  });
});
