import { ItemView, type ViewStateResult, type WorkspaceLeaf } from "obsidian";

import {
  CompilerClientError,
  type CompilerCompileResult,
  type CompilerDiagnostic,
  type CompilerForwardRequest,
  type CompilerForwardResult,
  type CompilerJumpRequest,
  type CompilerJumpResult
} from "./compiler-client";
import type { PdfEngine, PdfPreviewPoint } from "./pdf-preview-renderer";
import { compilerResultToRenderState, parsePreviewState } from "./preview-model";
import { PreviewController, type PreviewState } from "./preview-controller";
import { PreviewRenderer, type SerializedPreviewState } from "./preview-renderer";

export const TYPST_PREVIEW_VIEW_TYPE = "typst-preview";

export interface TypstSourceLocation {
  path: string;
  byteOffset: number;
}

export interface TypstPreviewViewOptions {
  compile: (
    sourcePath: string,
    revision: number,
    signal: AbortSignal
  ) => Promise<CompilerCompileResult>;
  jump: (request: CompilerJumpRequest) => Promise<CompilerJumpResult>;
  forward: (request: CompilerForwardRequest) => Promise<CompilerForwardResult>;
  onCompiled: (sourcePath: string, result: CompilerCompileResult) => void;
  onDiagnostic: (diagnostic: CompilerDiagnostic) => void;
  onSourceLocation: (
    location: TypstSourceLocation,
    isCurrent: () => boolean,
  ) => void | Promise<void>;
  disposeBackend: () => void | Promise<void>;
  restartBackend?: () => void | Promise<void>;
  pdfEngine?: PdfEngine;
  requestSaveLayout: () => void;
}

export class TypstPreviewView extends ItemView {
  private state: SerializedPreviewState = { sourcePath: null, zoom: 1, fit: false };
  private renderer: PreviewRenderer | null = null;
  private controller: PreviewController<CompilerCompileResult> | null = null;
  private nextRevision = 0;
  private activeRevision: number | null = null;
  private jumpAbort: AbortController | null = null;
  private closed = false;

  private forwardAbort: AbortController | null = null;
  private activeRender: Promise<void> = Promise.resolve();
  constructor(leaf: WorkspaceLeaf, private readonly options: TypstPreviewViewOptions) {
    super(leaf);
  }

  override getViewType(): string {
    return TYPST_PREVIEW_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return this.state.sourcePath === null
      ? "Typst preview"
      : `Typst preview: ${this.state.sourcePath.split("/").at(-1) ?? this.state.sourcePath}`;
  }

  override getState(): Record<string, unknown> {
    return { ...(this.renderer?.serialize() ?? this.state) };
  }

  override setState(state: unknown, result: ViewStateResult): Promise<void> {
    void result;
    this.state = parsePreviewState(state);
    if (this.renderer !== null) {
      this.mountRenderer();
      this.follow(this.state.sourcePath);
    }
    return Promise.resolve();
  }

  getSourcePath(): string | null {
    return this.state.sourcePath;
  }

  follow(sourcePath: string | null): void {
    const normalized = sourcePath?.endsWith(".typ") === true ? sourcePath : null;
    this.invalidateRevision();
    if (normalized !== this.state.sourcePath) {
      this.state = { ...this.state, sourcePath: normalized };
      this.options.requestSaveLayout();
    }
    this.renderer?.setSourcePath(normalized);
    this.controller?.setSource(normalized);
    void this.renderer?.render({ status: "idle" });
    if (normalized !== null) this.controller?.notifySaved(normalized);
  }

  markDirty(): void {
    this.invalidateRevision();
    this.controller?.markDirty();
  }

  refresh(): void {
    if (this.state.sourcePath !== null) {
      this.invalidateRevision();
      this.controller?.notifySaved(this.state.sourcePath);
    }
  }

  async forward(
    source: string,
    byteOffset: number,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    const revision = this.activeRevision;
    const entry = this.state.sourcePath;
    const renderer = this.renderer;
    const rendered = this.activeRender;
    if (
      revision === null
      || entry === null
      || renderer === null
      || !isCurrent()
    ) {
      return false;
    }

    const active = new AbortController();
    this.forwardAbort = active;
    try {
      const result = await this.options.forward({
        revision,
        source,
        byteOffset,
        signal: active.signal,
      });
      const position = result.positions[0];
      if (
        active.signal.aborted
        || this.forwardAbort !== active
        || position === undefined
        || result.revision !== revision
        || this.activeRevision !== revision
        || this.state.sourcePath !== entry
        || this.renderer !== renderer
        || !isCurrent()
      ) {
        return false;
      }
      await rendered;
      if (
        active.signal.aborted
        || this.forwardAbort !== active
        || this.activeRevision !== revision
        || this.state.sourcePath !== entry
        || this.renderer !== renderer
        || this.activeRender !== rendered
        || !isCurrent()
      ) {
        return false;
      }
      return renderer.reveal(position);
    } catch {
      return false;
    } finally {
      if (this.forwardAbort === active) this.forwardAbort = null;
    }
  }

  restartBackend(): void {
    this.invalidateRevision();
    void Promise.resolve(this.options.restartBackend?.()).then(() => this.refresh());
  }

  protected override onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.replaceChildren();
    this.contentEl.classList.add("typstian-preview");
    const toolbar = createDiv();
    toolbar.className = "typst-preview-toolbar";
    this.contentEl.append(toolbar);

    toolbar.append(
      this.createToolbarButton("−", "Zoom out", () => this.renderer?.zoomOut()),
      this.createToolbarButton("+", "Zoom in", () => this.renderer?.zoomIn()),
      this.createToolbarButton("Fit", "Fit pages to the preview width", () => this.renderer?.fitToWidth())
    );

    const pages = createDiv();
    pages.className = "typst-preview-pages";
    this.contentEl.append(pages);
    this.mountRenderer(pages);
    this.follow(this.state.sourcePath);
    return Promise.resolve();
  }

  protected override async onClose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.invalidateRevision();
    this.controller?.dispose();
    this.controller = null;
    const renderer = this.renderer;
    this.renderer = null;
    await Promise.all([
      renderer?.dispose() ?? Promise.resolve(),
      Promise.resolve(this.options.disposeBackend())
    ]);
    this.contentEl.replaceChildren();
  }

  private mountRenderer(root?: HTMLElement): void {
    const pages = root ?? this.contentEl.querySelector<HTMLElement>(".typst-preview-pages");
    if (pages === null) return;
    this.invalidateRevision();
    this.controller?.dispose();
    void this.renderer?.dispose();
    this.renderer = new PreviewRenderer(pages, {
      ...this.state,
      onDiagnostic: this.options.onDiagnostic,
      onPoint: (point) => { void this.handlePoint(point); },
      ...(this.options.pdfEngine === undefined ? {} : { pdfEngine: this.options.pdfEngine })
    });
    this.controller = new PreviewController<CompilerCompileResult>({
      compile: (sourcePath, signal) => {
        const revision = ++this.nextRevision;
        return this.options.compile(sourcePath, revision, signal);
      },
      onState: (state) => this.renderControllerState(state)
    });
  }

  private renderControllerState(state: PreviewState<CompilerCompileResult>): void {
    if (state.status === "ready" && state.result !== undefined) {
      const sourcePath = this.state.sourcePath;
      if (sourcePath !== null) this.options.onCompiled(sourcePath, state.result);
      this.activeRevision = state.result.ok ? state.result.revision : null;
      const rendered = this.renderer?.render(compilerResultToRenderState(state.result)) ?? Promise.resolve();
      this.activeRender = rendered;
      void rendered;
      return;
    }
    if (state.status === "error") {
      this.activeRevision = null;
      const error = state.error;
      if (
        error instanceof CompilerClientError
        && (error.code === "unavailable" || error.code === "permission-denied")
      ) {
        const rendered = this.renderer?.render({
          status: "compiler-unavailable",
          message: error.message,
        }) ?? Promise.resolve();
        this.activeRender = rendered;
        void rendered;
      } else {
        const rendered = this.renderer?.render({
          status: "error",
          message: error instanceof CompilerClientError
            ? error.message
            : "Typst preview failed unexpectedly.",
          diagnostics: []
        }) ?? Promise.resolve();
        this.activeRender = rendered;
        void rendered;
      }
      return;
    }
    if (state.status === "idle" || state.status === "compiling") {
      if (state.status !== "idle") this.activeRevision = null;
      const rendered = this.renderer?.render({ status: state.status }) ?? Promise.resolve();
      this.activeRender = rendered;
      void rendered;
    }
  }

  private async handlePoint(point: PdfPreviewPoint): Promise<void> {
    const revision = this.activeRevision;
    if (revision === null) return;
    this.jumpAbort?.abort();
    const active = new AbortController();
    this.jumpAbort = active;
    const isCurrent = (): boolean =>
      !active.signal.aborted
      && this.jumpAbort === active
      && this.activeRevision === revision
      && !this.closed;
    try {
      const result = await this.options.jump({ ...point, revision, signal: active.signal });
      if (
        isCurrent()
        && result.revision === revision
        && result.location !== null
      ) {
        await this.options.onSourceLocation(result.location, isCurrent);
      }
    } catch {
      // A stale, cancelled, or failed inverse-search request must not disturb the preview.
    } finally {
      if (this.jumpAbort === active) this.jumpAbort = null;
    }
  }

  private invalidateRevision(): void {
    this.activeRevision = null;
    this.jumpAbort?.abort();
    this.jumpAbort = null;
    this.forwardAbort?.abort();
    this.forwardAbort = null;
  }

  private createToolbarButton(
    label: string,
    title: string,
    action: () => void | Promise<void> | undefined
  ): HTMLButtonElement {
    const button = createEl("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", () => {
      void Promise.resolve(action()).finally(() => {
        if (this.renderer !== null) this.state = this.renderer.serialize();
        this.options.requestSaveLayout();
      });
    });
    return button;
  }
}
