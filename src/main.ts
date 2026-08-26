import fs from "node:fs";
import path from "node:path";
import {
  FileSystemAdapter,
  Notice,
  Plugin,
  TFile,
  type WorkspaceLeaf
} from "obsidian";

import { DependencyIndex } from "./dependency-index";
import { collectDirtyBuffers } from "./dirty-buffer-overlay";
import { ForwardSearchScheduler } from "./forward-search-scheduler";
import { SourceNavigationScheduler } from "./source-navigation-scheduler";
import { chooseSourceEditorLeaf } from "./editor-leaf-policy";
import {
  TYPST_VIEW_TYPE,
  TypstEditorView,
  type TypstForwardSearchRequest
} from "./editor-view";
import {
  CompilerClientError,
  TypstianCompilerClient,
  type CompilerCompileResult,
  type CompilerDiagnostic
} from "./compiler-client";
import {
  resolveCompilationRoot,
  resolveDiagnosticVaultPath,
  resolveCompilerEntryPath
} from "./path-policy";
import {
  chooseForwardPreview,
  isSavedForwardSnapshot,
  shouldPreviewFollow
} from "./preview-routing";
import {
  TYPST_PREVIEW_VIEW_TYPE,
  TypstPreviewView,
  type TypstSourceLocation
} from "./preview-view";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type TypstianSettings
} from "./settings-model";
import { TypstianSettingsTab } from "./settings-tab";

export default class TypstianPlugin extends Plugin {
  override settings: TypstianSettings = DEFAULT_SETTINGS;
  private readonly dependencies = new DependencyIndex();
  private readonly compilers = new Set<TypstianCompilerClient>();
  private readonly forwardSearchScheduler = new ForwardSearchScheduler<{
    editor: TypstEditorView;
    request: TypstForwardSearchRequest;
  }>(({ editor, request }, isCurrent) =>
    this.handleForwardSearch(editor, request, isCurrent)
  );
  private readonly sourceNavigationScheduler =
    new SourceNavigationScheduler<TypstSourceLocation>(
      (location, isCurrent) => this.performRevealSourceLocation(location, isCurrent)
    );
  private revealingSourceLeaf: WorkspaceLeaf | null = null;
  private creatingSourceLeaf = false;
  private settingsUpdate = Promise.resolve();

  private unloaded = false;
  private lifecycleGeneration = 0;

  override async onload(): Promise<void> {
    this.unloaded = false;
    this.lifecycleGeneration += 1;
    this.settings = normalizeSettings(
      await this.loadData() as Parameters<typeof normalizeSettings>[0] | null ?? {}
    );

    this.registerView(TYPST_VIEW_TYPE, (leaf) => this.createEditorView(leaf));
    this.registerExtensions(["typ"], TYPST_VIEW_TYPE);
    this.registerView(TYPST_PREVIEW_VIEW_TYPE, (leaf) => this.createPreviewView(leaf));

    this.addCommand({
      id: "open-typst-preview",
      name: "Open Typst preview",
      checkCallback: (checking) => {
        const source = this.activeTypstPath();
        if (source === null) return false;
        if (!checking) void this.openPreview(source);
        return true;
      }
    });
    this.addCommand({
      id: "check-typst-environment",
      name: "Check Typst environment",
      callback: () => { void this.checkEnvironment(); }
    });
    this.addSettingTab(new TypstianSettingsTab(this.app, this));

    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (
        !this.creatingSourceLeaf
        && leaf !== this.revealingSourceLeaf
      ) {
        this.sourceNavigationScheduler.cancel();
      }
      if (leaf?.view instanceof TypstEditorView && leaf.view.file !== null) {
        this.followInAllPreviews(leaf.view.file.path);
      }
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      this.handleSavedFile(file);
    }));
    this.registerEvent(this.app.vault.on("create", (file) => {
      this.handleSavedFile(file);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.handleVaultPath(file.path);
      this.dependencies.remove(file.path);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile && file.extension === "typ") {
        for (const preview of this.previewViews()) {
          if (preview.getSourcePath() === oldPath) preview.follow(file.path);
        }
      }
      this.handleVaultPath(oldPath);
      this.dependencies.remove(oldPath);
      this.handleVaultPath(file.path, false);
    }));

    this.app.workspace.onLayoutReady(() => {
      for (const preview of this.previewViews()) {
        const source = preview.getSourcePath();
        if (source === null) continue;
        const file = this.app.vault.getAbstractFileByPath(source);
        if (file instanceof TFile && file.extension === "typ") preview.refresh();
        else preview.follow(null);
      }
    });
  }

  override onunload(): void {
    this.unloaded = true;
    this.lifecycleGeneration += 1;
    this.forwardSearchScheduler.dispose();
    this.sourceNavigationScheduler.dispose();
    for (const compiler of this.compilers) compiler.close();
    this.compilers.clear();
    this.dependencies.clear();
  }

  async updateSettings(value: TypstianSettings): Promise<void> {
    const next = normalizeSettings(value);
    const lifecycleGeneration = this.lifecycleGeneration;
    const update = this.settingsUpdate.then(async () => {
      if (
        this.unloaded
        || lifecycleGeneration !== this.lifecycleGeneration
        || next.rootPath === this.settings.rootPath
      ) {
        return;
      }
      await this.saveData(next);
      if (this.unloaded || lifecycleGeneration !== this.lifecycleGeneration) return;
      this.settings = next;
      for (const preview of this.previewViews()) preview.restartBackend();
    });
    this.settingsUpdate = update.catch(() => undefined);
    await update;
  }

  private createEditorView(leaf: WorkspaceLeaf): TypstEditorView {
    const view = new TypstEditorView(leaf, {
      onDirty: () => {
        const source = view.file?.path;
        if (source === undefined) return;
        this.handleDirtyPath(source);
      },
      onForwardSearch: (request) => {
        this.forwardSearchScheduler.schedule(view, { editor: view, request });
      },
      onClose: () => {
        this.forwardSearchScheduler.cancel(view);
      }
    });
    return view;
  }

  private createPreviewView(leaf: WorkspaceLeaf): TypstPreviewView {
    let compiler: TypstianCompilerClient | null = null;
    const getCompiler = (): TypstianCompilerClient => {
      compiler ??= this.createCompilerClient();
      return compiler;
    };
    const disposeBackend = (): void => {
      if (compiler === null) return;
      compiler.close();
      this.compilers.delete(compiler);
      compiler = null;
    };

    return new TypstPreviewView(leaf, {
      compile: (sourcePath, revision, signal) => {
        const vaultRoot = this.vaultRoot();
        const root = this.compilationRoot(vaultRoot);
        const entryPath = resolveCompilerEntryPath(vaultRoot, root, sourcePath);
        if (entryPath === null) {
          return Promise.reject(new CompilerClientError(
            "invalid-input",
            "The Typst entry file must be inside the configured compilation root."
          ));
        }
        return getCompiler().compile({
          entryPath,
          revision,
          overlay: this.dirtyBufferOverlay(vaultRoot, root),
          signal
        });
      },
      jump: (request) => getCompiler().jump(request),
      forward: (request) => getCompiler().forward(request),
      onCompiled: (sourcePath, result) => this.recordDependencies(sourcePath, result),
      onDiagnostic: (diagnostic) => { void this.revealDiagnostic(diagnostic); },
      onSourceLocation: (location, isCurrent) => this.revealSourceLocation(location, isCurrent),
      disposeBackend,
      restartBackend: disposeBackend,
      requestSaveLayout: () => this.app.workspace.requestSaveLayout()
    });
  }

  private createCompilerClient(): TypstianCompilerClient {
    const vaultRoot = this.vaultRoot();
    if (this.manifest.dir === undefined) {
      throw new Error("Typstian plugin directory is unavailable.");
    }
    const compiler = new TypstianCompilerClient({
      rootPath: this.compilationRoot(vaultRoot),
      wasmPath: path.join(vaultRoot, this.manifest.dir, "typstian_wasm_bg.wasm"),
    });
    this.compilers.add(compiler);
    return compiler;
  }

  private recordDependencies(sourcePath: string, result: CompilerCompileResult): void {
    const vaultRoot = this.vaultRoot();
    const root = this.compilationRoot(vaultRoot);
    const absoluteDependencies = result.dependencies.map((dependency) => path.resolve(root, dependency));
    if (result.ok) this.dependencies.update(sourcePath, absoluteDependencies);
    else this.dependencies.extend(sourcePath, absoluteDependencies);
  }

  private async openPreview(sourcePath: string): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(TYPST_PREVIEW_VIEW_TYPE)[0];
    if (leaf === undefined) {
      leaf = this.app.workspace.getLeaf("split", "vertical");
      await leaf.setViewState({ type: TYPST_PREVIEW_VIEW_TYPE, active: true });
    }
    if (leaf.view instanceof TypstPreviewView) leaf.view.follow(sourcePath);
    await this.app.workspace.revealLeaf(leaf);
  }

  private followInAllPreviews(sourcePath: string): void {
    const affectedEntries = new Set(
      this.dependencies.affectedBy(path.resolve(this.vaultRoot(), sourcePath))
    );
    for (const preview of this.previewViews()) {
      const entry = preview.getSourcePath();
      if (shouldPreviewFollow(entry, sourcePath, affectedEntries)) preview.follow(sourcePath);
    }
  }

  private dirtyBufferOverlay(
    vaultRoot: string,
    compilationRoot: string
  ): ReadonlyMap<string, Uint8Array> {
    const buffers = this.app.workspace.getLeavesOfType(TYPST_VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view): view is TypstEditorView => view instanceof TypstEditorView)
      .filter((view) => view.file !== null && view.hasUnsavedChanges())
      .map((view) => ({ path: view.file!.path, text: view.getViewData() }));
    return collectDirtyBuffers(vaultRoot, compilationRoot, buffers);
  }

  private previewViews(): TypstPreviewView[] {
    return this.app.workspace.getLeavesOfType(TYPST_PREVIEW_VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view): view is TypstPreviewView => view instanceof TypstPreviewView);
  }

  private activeTypstPath(): string | null {
    const view = this.app.workspace.getActiveViewOfType(TypstEditorView);
    return view?.file?.path ?? null;
  }

private handleVaultPath(vaultPath: string, includeDirectEntry = true): void {
    const absolutePath = path.resolve(this.vaultRoot(), vaultPath);
    const affected = new Set(this.dependencies.affectedBy(absolutePath));
    if (includeDirectEntry && path.extname(vaultPath).toLowerCase() === ".typ") {
      affected.add(vaultPath);
    }
    for (const preview of this.previewViews()) {
      const source = preview.getSourcePath();
      if (source !== null && affected.has(source)) preview.refresh();
    }
  }

  private handleSavedFile(file: unknown): void {
    if (!(file instanceof TFile)) return;
    if (file.extension === "typ") void this.markSavedEditors(file);
    this.handleVaultPath(file.path);
  }

  private async markSavedEditors(file: TFile): Promise<void> {
    let savedText: string;
    try {
      savedText = await this.app.vault.read(file);
    } catch {
      return;
    }
    for (const leaf of this.app.workspace.getLeavesOfType(TYPST_VIEW_TYPE)) {
      if (leaf.view instanceof TypstEditorView && leaf.view.file?.path === file.path) {
        leaf.view.markSaved(savedText);
      }
    }
  }

  private async handleForwardSearch(
    editor: TypstEditorView,
    request: TypstForwardSearchRequest,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (
      !isCurrent()
      || editor.file?.path !== request.sourcePath
      || editor.getViewData() !== request.sourceText
    ) {
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(request.sourcePath);
    if (!(file instanceof TFile)) return;

    let savedText: string;
    try {
      savedText = await this.app.vault.read(file);
    } catch {
      if (isCurrent()) new Notice("Unable to read the Typst source for forward search.");
      return;
    }
    if (!isCurrent()) return;
    if (!isSavedForwardSnapshot(
      editor.file?.path ?? null,
      editor.getViewData(),
      savedText,
      request
    )) {
      new Notice("Save the Typst file before using forward search.");
      return;
    }

    const previews = this.previewViews();
    const affectedEntries = new Set(
      this.dependencies.affectedBy(path.resolve(this.vaultRoot(), request.sourcePath))
    );
    const preview = chooseForwardPreview(
      previews.map((candidate) => ({
        preview: candidate,
        sourcePath: candidate.getSourcePath()
      })),
      request.sourcePath,
      affectedEntries
    );
    if (!isCurrent()) return;
    if (preview === undefined) {
      new Notice("Open a preview containing this Typst source before using forward search.");
      return;
    }

    const vaultRoot = this.vaultRoot();
    const compilerSource = resolveCompilerEntryPath(
      vaultRoot,
      this.compilationRoot(vaultRoot),
      request.sourcePath
    );
    if (!isCurrent()) return;
    if (compilerSource === null) {
      new Notice("The Typst source must be inside the configured compilation root.");
      return;
    }
    await preview.forward(compilerSource, request.byteOffset, isCurrent);
  }

  private handleDirtyPath(sourcePath: string): void {
    const absolutePath = path.resolve(this.vaultRoot(), sourcePath);
    const affected = new Set(this.dependencies.affectedBy(absolutePath));
    affected.add(sourcePath);
    for (const preview of this.previewViews()) {
      const entry = preview.getSourcePath();
      if (entry !== null && affected.has(entry)) preview.markDirty();
    }
  }

  private async revealDiagnostic(diagnostic: CompilerDiagnostic): Promise<void> {
    if (
      diagnostic.path === undefined
      || diagnostic.line === undefined
      || diagnostic.column === undefined
    ) {
      new Notice(diagnostic.message);
      return;
    }
    const editor = await this.openSourceEditor(diagnostic.path);
    editor?.revealDiagnostic(diagnostic.line, diagnostic.column);
  }

  private revealSourceLocation(
    location: TypstSourceLocation,
    isCurrent: () => boolean,
  ): Promise<void> {
    return this.sourceNavigationScheduler.schedule(location, isCurrent);
  }

  private async performRevealSourceLocation(
    location: TypstSourceLocation,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!isCurrent()) return;
    const editor = await this.openSourceEditor(location.path, isCurrent);
    if (
      editor !== null
      && isCurrent()
      && !editor.revealByteOffset(location.byteOffset)
    ) {
      new Notice("The inverse-search location is no longer valid for the current file.");
    }
  }

  private async openSourceEditor(
    compilerPath: string,
    isCurrent: () => boolean = () => true,
  ): Promise<TypstEditorView | null> {
    if (!isCurrent()) return null;
    const vaultRoot = this.vaultRoot();
    const vaultPath = resolveDiagnosticVaultPath(
      vaultRoot,
      this.compilationRoot(vaultRoot),
      compilerPath
    );
    if (vaultPath === null) {
      new Notice("The source location points outside this vault.");
      return null;
    }
    const file = this.app.vault.getAbstractFileByPath(vaultPath);
    if (!(file instanceof TFile)) {
      new Notice(`Typst source not found: ${vaultPath}`);
      return null;
    }

    const editorLeaves = this.app.workspace.getLeavesOfType(TYPST_VIEW_TYPE)
      .filter((candidate) => candidate.view instanceof TypstEditorView);
    let leaf = chooseSourceEditorLeaf(
      editorLeaves.map((candidate) => ({
        leaf: candidate,
        sourcePath: candidate.view instanceof TypstEditorView
          ? candidate.view.file?.path
          : undefined,
      })),
      vaultPath
    );
    if (!isCurrent()) return null;
    const previousLeaf = this.app.workspace.activeLeaf;
    const created = leaf === undefined;
    if (leaf === undefined) {
      this.creatingSourceLeaf = true;
      try {
        leaf = this.app.workspace.getLeaf("tab");
      } finally {
        this.creatingSourceLeaf = false;
      }
    }
    if (!(leaf.view instanceof TypstEditorView) || leaf.view.file?.path !== vaultPath) {
      this.revealingSourceLeaf = leaf;
      try {
        await leaf.openFile(file);
      } finally {
        if (this.revealingSourceLeaf === leaf) this.revealingSourceLeaf = null;
      }
      if (!isCurrent()) {
        if (created) {
          await this.discardStaleCreatedLeaf(leaf, vaultPath, previousLeaf);
        }
        return null;
      }
    }
    if (!(leaf.view instanceof TypstEditorView) || !isCurrent()) return null;
    this.revealingSourceLeaf = leaf;
    try {
      await this.app.workspace.revealLeaf(leaf);
    } finally {
      if (this.revealingSourceLeaf === leaf) this.revealingSourceLeaf = null;
    }
    if (!isCurrent()) return null;
    return leaf.view;
  }

  private async discardStaleCreatedLeaf(
    leaf: WorkspaceLeaf,
    vaultPath: string,
    previousLeaf: WorkspaceLeaf | null,
  ): Promise<void> {
    const isUntouchedTarget = (): boolean =>
      leaf.view instanceof TypstEditorView
      && leaf.view.file?.path === vaultPath
      && leaf.view.canDiscardUncommittedOpen();
    if (!isUntouchedTarget()) return;

    if (this.app.workspace.activeLeaf === leaf) {
      if (previousLeaf === null || previousLeaf === leaf) return;
      this.revealingSourceLeaf = previousLeaf;
      try {
        await this.app.workspace.revealLeaf(previousLeaf);
      } finally {
        if (this.revealingSourceLeaf === previousLeaf) {
          this.revealingSourceLeaf = null;
        }
      }
    }
    if (
      this.app.workspace.activeLeaf !== leaf
      && isUntouchedTarget()
    ) {
      leaf.detach();
    }
  }

  private async checkEnvironment(): Promise<void> {
    let compiler: TypstianCompilerClient | null = null;
    try {
      compiler = this.createCompilerClient();
      const result = await compiler.checkEnvironment();
      new Notice(
        `Typstian WASM compiler; Typst ${result.typstVersion}\nRoot: ${this.compilationRoot(this.vaultRoot())}`
      );
    } catch (error) {
      const message = error instanceof CompilerClientError
        ? error.message
        : "Unable to initialize the bundled Typstian WASM compiler.";
      new Notice(message);
    } finally {
      if (compiler !== null) {
        compiler.close();
        this.compilers.delete(compiler);
      }
    }
  }

  private vaultRoot(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Typstian requires a local filesystem vault.");
    }
    return fs.realpathSync.native(adapter.getBasePath());
  }

  private compilationRoot(vaultRoot: string): string {
    return resolveCompilationRoot(vaultRoot, this.settings.rootPath);
  }
}
