import type { CompilerCompileResult } from "./compiler-client";
import { clampPreviewZoom, type PreviewRenderState, type SerializedPreviewState } from "./preview-renderer";

export function compilerResultToRenderState(result: CompilerCompileResult): PreviewRenderState {
  if (result.ok) {
    return {
      status: "ready",
      pdf: result.pdf
    };
  }

  return {
    status: "error",
    message: result.message,
    diagnostics: result.diagnostics
  };
}

export function parsePreviewState(value: unknown): SerializedPreviewState {
  const state = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  const sourcePath = typeof state.sourcePath === "string" && state.sourcePath.endsWith(".typ")
    ? state.sourcePath
    : null;
  const zoom = typeof state.zoom === "number" ? clampPreviewZoom(state.zoom) : 1;

  return {
    sourcePath,
    zoom,
    fit: typeof state.fit === "boolean" ? state.fit : false
  };
}
