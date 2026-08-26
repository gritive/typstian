import { describe, expect, it } from "vitest";

import { compilerResultToRenderState, parsePreviewState } from "../src/preview-model";

describe("compilerResultToRenderState", () => {
  it("maps a compiled PDF to a ready preview", () => {
    const pdf = new Uint8Array([37, 80, 68, 70, 45]);

    expect(compilerResultToRenderState({
      ok: true,
      revision: 7,
      pdf,
      pages: [{ widthPt: 595, heightPt: 842 }],
      dependencies: [],
      diagnostics: []
    })).toEqual({ status: "ready", pdf });
  });

  it("maps a compiler failure without pretending the old PDF is current", () => {
    const diagnostics = [{
      path: "book/main.typ",
      line: 3,
      column: 5,
      severity: "error" as const,
      message: "expected expression"
    }];
    expect(compilerResultToRenderState({
      ok: false,
      revision: 8,
      reason: "compile-error",
      message: "Typst compilation failed.",
      dependencies: [],
      diagnostics
    })).toEqual({
      status: "error",
      message: "Typst compilation failed.",
      diagnostics
    });
  });

  it("validates restored preview state", () => {
    expect(parsePreviewState({
      sourcePath: "book/main.typ",
      zoom: 99,
      fit: "yes"
    })).toEqual({ sourcePath: "book/main.typ", zoom: 4, fit: false });
    expect(parsePreviewState({ sourcePath: "book/main.md" })).toEqual({
      sourcePath: null,
      zoom: 1,
      fit: false
    });
  });
});
