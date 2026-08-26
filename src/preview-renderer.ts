import type { CompilerDiagnostic } from "./compiler-client";
import { PdfPreviewRenderer, type PdfEngine, type PdfPreviewPoint } from "./pdf-preview-renderer";
import { createPdfJsEngine } from "./pdfjs-adapter";

export type PreviewRenderState =
  | { status: "idle" }
  | { status: "compiling" }
  | { status: "ready"; pdf: Uint8Array }
  | { status: "error"; message: string; diagnostics: readonly CompilerDiagnostic[] }
  | { status: "compiler-unavailable"; message: string };

export interface SerializedPreviewState {
  sourcePath: string | null;
  zoom: number;
  fit: boolean;
}

export interface PreviewRendererOptions {
  sourcePath?: string | null;
  zoom?: number;
  fit?: boolean;
  onDiagnostic?: (diagnostic: CompilerDiagnostic) => void;
  onPoint?: (point: PdfPreviewPoint) => void;
  pdfEngine?: PdfEngine;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

export function clampPreviewZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export class PreviewRenderer {
  private readonly pdf: PdfPreviewRenderer;
  private readonly onDiagnostic: ((diagnostic: CompilerDiagnostic) => void) | undefined;
  private sourcePath: string | null;
  private disposed = false;
  private renderGeneration = 0;
  private hasVisiblePdf = false;

  constructor(
    private readonly root: HTMLElement,
    options: PreviewRendererOptions = {}
  ) {
    this.onDiagnostic = options.onDiagnostic;
    this.sourcePath = options.sourcePath ?? null;
    this.root.classList.add("typst-preview-scroll");
    this.pdf = new PdfPreviewRenderer(root, {
      engine: options.pdfEngine ?? createPdfJsEngine(),
      onPoint: options.onPoint,
      zoom: clampPreviewZoom(options.zoom ?? 1),
      fit: options.fit ?? false
    });
  }

  async render(state: PreviewRenderState): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.renderGeneration;

    if (state.status === "ready") {
      try {
        await this.pdf.render(state.pdf);
        if (this.isCurrent(generation)) this.hasVisiblePdf = true;
      } catch {
        if (this.isCurrent(generation)) {
          await this.pdf.clear();
          this.hasVisiblePdf = false;
          this.renderError("Unable to render the compiled PDF.", []);
        }
      }
      return;
    }

    if (this.hasVisiblePdf && state.status === "compiling") {
      this.renderMessage("Compiling Typst document…", "status");
      return;
    }

    await this.pdf.clear();
    if (!this.isCurrent(generation)) return;
    this.hasVisiblePdf = false;
    switch (state.status) {
      case "idle":
        this.renderMessage("Open a Typst file to preview it.", "status");
        break;
      case "compiling":
        this.renderMessage("Compiling Typst document…", "status");
        break;
      case "error":
        this.renderError(state.message, state.diagnostics);
        break;
      case "compiler-unavailable":
        this.renderMessage(state.message, "alert");
        break;
    }
  }

  setSourcePath(sourcePath: string | null): void {
    this.sourcePath = sourcePath;
  }

  async zoomIn(): Promise<void> {
    if (!this.disposed) await this.pdf.zoomIn();
  }

  async zoomOut(): Promise<void> {
    if (!this.disposed) await this.pdf.zoomOut();
  }

  async fitToWidth(): Promise<void> {
    if (!this.disposed) await this.pdf.fitToWidth();
  }

  serialize(): SerializedPreviewState {
    return {
      sourcePath: this.sourcePath,
      ...this.pdf.serialize()
    };
  }

  reveal(point: PdfPreviewPoint): boolean {
    return !this.disposed && this.pdf.reveal(point);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.renderGeneration += 1;
    await this.pdf.dispose();
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.renderGeneration;
  }

  private renderMessage(message: string, role: "status" | "alert"): void {
    this.root.querySelector(".typst-preview-message")?.remove();
    const element = createEl("p");
    element.className = "typst-preview-message";
    element.setAttribute("role", role);
    element.textContent = message;
    this.root.append(element);
  }

  private renderError(message: string, diagnostics: readonly CompilerDiagnostic[]): void {
    const container = createDiv();
    container.className = "typst-preview-error";
    container.setAttribute("role", "alert");

    const summary = createEl("p");
    summary.textContent = message;
    container.append(summary);

    for (const diagnostic of diagnostics) {
      const located = diagnostic.path !== undefined
        && diagnostic.line !== undefined
        && diagnostic.column !== undefined;
      const element = createEl(located ? "button" : "p");
      element.className = "typst-preview-diagnostic";
      if (element instanceof HTMLButtonElement) {
        element.type = "button";
        element.textContent =
          `${diagnostic.path}:${diagnostic.line}:${diagnostic.column} — ${diagnostic.message}`;
        element.setAttribute(
          "aria-label",
          `Go to ${diagnostic.path}, line ${diagnostic.line}, column ${diagnostic.column}: ${diagnostic.message}`
        );
        element.addEventListener("click", () => this.onDiagnostic?.(diagnostic));
      } else {
        element.textContent = diagnostic.message;
      }
      container.append(element);
    }

    this.root.append(container);
  }
}
