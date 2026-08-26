// @vitest-environment happy-dom

import { TFile, View } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import type { DependencyIndex } from "../src/dependency-index";
import TypstianPlugin from "../src/main";
import { TypstEditorView } from "../src/editor-view";

interface DeferredLeaf {
  view: unknown;
  openFile: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
}

function deferredLeaf(options: { holdCompletion?: boolean } = {}) {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  let releaseCompletion = (): void => undefined;
  const completion = options.holdCompletion === true
    ? new Promise<void>((resolve) => { releaseCompletion = resolve; })
    : Promise.resolve();
  const reveals: ReturnType<typeof vi.fn>[] = [];
  const leaf: DeferredLeaf = {
    view: {},
    detach: vi.fn(),
    openFile: vi.fn(async (file: TFile) => {
      await gate;
      const editor = new TypstEditorView(leaf as never);
      editor.file = file;
      editor.setViewData("0123456789", true);
      reveals.push(vi.spyOn(editor, "revealByteOffset"));
      leaf.view = editor;
      await completion;
    }),
  };
  return { finish, leaf, releaseCompletion, reveals };
}

describe("TypstianPlugin vault dependency invalidation", () => {
  it("refreshes dependency lifecycle changes and clears renamed entry edges", async () => {
    const { internals, plugin, vaultCallbacks } = harness([]);
    let sourcePath: string | null = "book/main.typ";
    const preview = {
      follow: vi.fn((path: string | null) => { sourcePath = path; }),
      getSourcePath: vi.fn(() => sourcePath),
      refresh: vi.fn(),
    };
    vi.spyOn(internals, "previewViews").mockReturnValue([preview]);
    await plugin.onload();

    const dependency = Object.assign(new TFile(), {
      path: "book/image.svg",
      extension: "svg",
      basename: "image",
    });
    internals.dependencies.update("book/main.typ", ["/vault/book/image.svg"]);

    vaultCallbacks.get("create")?.(dependency);
    expect(preview.refresh).toHaveBeenCalledOnce();

    preview.refresh.mockClear();
    vaultCallbacks.get("delete")?.(dependency);
    expect(preview.refresh).toHaveBeenCalledOnce();

    preview.refresh.mockClear();
    const renamedDependency = Object.assign(new TFile(), {
      path: "book/renamed.svg",
      extension: "svg",
      basename: "renamed",
    });
    vaultCallbacks.get("rename")?.(renamedDependency, "book/image.svg");
    expect(preview.refresh).toHaveBeenCalledOnce();

    preview.refresh.mockClear();
    sourcePath = "book/old.typ";
    internals.dependencies.update("book/old.typ", ["/vault/book/section.typ"]);
    const renamedEntry = Object.assign(new TFile(), {
      path: "book/new.typ",
      extension: "typ",
      basename: "new",
    });
    vaultCallbacks.get("rename")?.(renamedEntry, "book/old.typ");

    expect(preview.follow).toHaveBeenLastCalledWith("book/new.typ");
    expect(preview.refresh).not.toHaveBeenCalled();
    expect(internals.dependencies.affectedBy("/vault/book/section.typ")).toEqual([]);
  });
});


describe("TypstianPlugin settings updates", () => {
  it("skips persistence and backend restart when normalized settings are unchanged", async () => {
    const plugin = new TypstianPlugin({} as never, {} as never);
    const restartBackend = vi.fn();
    const internals = plugin as unknown as {
      settings: { rootPath: string };
      previewViews(): Array<{ restartBackend(): void }>;
    };
    internals.settings = { rootPath: "projects/book" };
    vi.spyOn(internals, "previewViews").mockReturnValue([{ restartBackend }]);
    const saveData = vi.spyOn(plugin, "saveData");

    await plugin.updateSettings({ rootPath: " projects/book " });

    expect(saveData).not.toHaveBeenCalled();
    expect(restartBackend).not.toHaveBeenCalled();
  });

  it("serializes settings persistence before restarting each backend", async () => {
    const plugin = new TypstianPlugin({} as never, {} as never);
    const restartBackend = vi.fn();
    const internals = plugin as unknown as {
      settings: { rootPath: string };
      previewViews(): Array<{ restartBackend(): void }>;
    };
    internals.settings = { rootPath: "" };
    vi.spyOn(internals, "previewViews").mockReturnValue([{ restartBackend }]);
    let resolveFirstSave: (() => void) | undefined;
    const saveData = vi.spyOn(plugin, "saveData")
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveFirstSave = resolve;
      }))
      .mockResolvedValueOnce();

    const first = plugin.updateSettings({ rootPath: "first" });
    const second = plugin.updateSettings({ rootPath: "second" });
    await Promise.resolve();

    expect(saveData).toHaveBeenCalledTimes(1);
    expect(restartBackend).not.toHaveBeenCalled();
    resolveFirstSave?.();
    await first;
    await second;

    expect(saveData).toHaveBeenNthCalledWith(1, { rootPath: "first" });
    expect(saveData).toHaveBeenNthCalledWith(2, { rootPath: "second" });
    expect(restartBackend).toHaveBeenCalledTimes(2);
    expect(internals.settings).toEqual({ rootPath: "second" });
  });

  it("does not apply an in-flight settings save after plugin unload", async () => {
    const plugin = new TypstianPlugin({} as never, {} as never);
    const restartBackend = vi.fn();
    const internals = plugin as unknown as {
      settings: { rootPath: string };
      previewViews(): Array<{ restartBackend(): void }>;
    };
    internals.settings = { rootPath: "" };
    vi.spyOn(internals, "previewViews").mockReturnValue([{ restartBackend }]);
    let resolveSave: (() => void) | undefined;
    vi.spyOn(plugin, "saveData").mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
    );

    const update = plugin.updateSettings({ rootPath: "project" });
    await Promise.resolve();
    plugin.onunload();
    resolveSave?.();
    await update;

    expect(internals.settings).toEqual({ rootPath: "" });
    expect(restartBackend).not.toHaveBeenCalled();
  });
});

describe("TypstianPlugin diagnostic fan-out", () => {
  it("leaves an editor outside the compile's dependencies untouched", async () => {
    const first = deferredLeaf();
    const second = deferredLeaf();
    const { internals, workspace } = harness([first.leaf, second.leaf]);
    first.finish();
    second.finish();
    const openFile = (leaf: DeferredLeaf): ((file: TFile) => Promise<void>) =>
      leaf.openFile as unknown as (file: TFile) => Promise<void>;
    await openFile(first.leaf)(fileAt("a.typ"));
    await openFile(second.leaf)(fileAt("b.typ"));
    (workspace.getLeavesOfType as unknown as { mockReturnValue(value: unknown): void })
      .mockReturnValue([first.leaf, second.leaf]);
    const editorA = first.leaf.view as TypstEditorView;
    const editorB = second.leaf.view as TypstEditorView;
    const markedA = vi.spyOn(editorA, "setDiagnostics");
    const markedB = vi.spyOn(editorB, "setDiagnostics");

    internals.publishDiagnostics({
      ok: true,
      dependencies: ["a.typ"],
      diagnostics: [{ severity: "warning", message: "careful", path: "a.typ", line: 1, column: 1 }],
    });

    // A second project's preview must not clear the marks this editor is
    // showing for its own compile.
    expect(markedA).toHaveBeenCalledTimes(1);
    expect(markedB).not.toHaveBeenCalled();
  });
});

function fileAt(path: string): TFile {
  return Object.assign(new TFile(), {
    path,
    extension: "typ",
    basename: path.replace(/\.typ$/, ""),
  });
}

function harness(leaves: DeferredLeaf[]) {
  const files = new Map<string, TFile>();
  const activeCallbacks: Array<(leaf: unknown) => void> = [];
  const vaultCallbacks = new Map<string, (...args: unknown[]) => void>();
  const workspace = {
    activeLeaf: { id: "preview" } as unknown,
    getLeavesOfType: vi.fn(() => leaves.filter(
      (leaf) => leaf.view instanceof TypstEditorView,
    )),
    getLeaf: vi.fn(() => {
      const leaf = leaves.find((candidate) => candidate.openFile.mock.calls.length === 0);
      if (leaf === undefined) throw new Error("missing test leaf");
      workspace.activeLeaf = leaf;
      for (const callback of activeCallbacks) callback(leaf);
      return leaf;
    }),
    revealLeaf: vi.fn((leaf: DeferredLeaf) => {
      workspace.activeLeaf = leaf;
      for (const callback of activeCallbacks) callback(leaf);
      return Promise.resolve();
    }),
    on: vi.fn((event: string, callback: (leaf: unknown) => void) => {
      if (event === "active-leaf-change") activeCallbacks.push(callback);
      return { event, callback };
    }),
    onLayoutReady: vi.fn(),
    getActiveViewOfType: vi.fn((type: unknown) => (
      type === View && workspace.activeLeaf !== null && workspace.activeLeaf !== undefined
        ? { leaf: workspace.activeLeaf }
        : null
    )),
    requestSaveLayout: vi.fn(),
  };
  const vault = {
    adapter: {},
    getAbstractFileByPath: vi.fn((path: string) => {
      let file = files.get(path);
      if (file === undefined) {
        const name = path.split("/").pop() ?? path;
        file = Object.assign(new TFile(), {
          path,
          extension: "typ",
          basename: name.replace(/\.typ$/, ""),
        });
        files.set(path, file);
      }
      return file;
    }),
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      vaultCallbacks.set(event, callback);
      return { event, callback };
    }),
    read: vi.fn(),
  };
  const app = { vault, workspace };
  const plugin = new TypstianPlugin(app as never, {} as never);
  const internals = plugin as unknown as {
    dependencies: DependencyIndex;
    previewViews(): Array<{
      follow(path: string | null): void;
      getSourcePath(): string | null;
      refresh(): void;
    }>;
    publishDiagnostics(result: unknown): void;
    vaultRoot(): string;
    compilationRoot(vaultRoot: string): string;
    revealSourceLocation(
      location: { path: string; byteOffset: number },
      isCurrent: () => boolean,
    ): Promise<void>;
  };
  vi.spyOn(internals, "vaultRoot").mockReturnValue("/vault");
  vi.spyOn(internals, "compilationRoot").mockReturnValue("/vault");
  return { activeCallbacks, internals, plugin, vaultCallbacks, workspace };
}

describe("TypstianPlugin source navigation", () => {
  it("opens a new target and reveals its exact byte offset despite getLeaf activation", async () => {
    const sourceLeaf = deferredLeaf();
    const { internals, plugin } = harness([sourceLeaf.leaf]);
    await plugin.onload();

    const navigation = internals.revealSourceLocation(
      { path: "book/section.typ", byteOffset: 4 },
      () => true,
    );
    sourceLeaf.finish();
    await navigation;

    expect(sourceLeaf.leaf.openFile).toHaveBeenCalledOnce();
    expect(sourceLeaf.reveals[0]).toHaveBeenCalledWith(4);
  });

  it("serializes stale and latest opens and commits only the latest source", async () => {
    const oldLeaf = deferredLeaf();
    const latestLeaf = deferredLeaf();
    const { internals, plugin, workspace } = harness([oldLeaf.leaf, latestLeaf.leaf]);
    await plugin.onload();
    let oldCurrent = true;

    const oldNavigation = internals.revealSourceLocation(
      { path: "book/old.typ", byteOffset: 1 },
      () => oldCurrent,
    );
    oldCurrent = false;
    const latestNavigation = internals.revealSourceLocation(
      { path: "book/latest.typ", byteOffset: 9 },
      () => true,
    );

    expect(oldLeaf.leaf.openFile).toHaveBeenCalledOnce();
    expect(latestLeaf.leaf.openFile).not.toHaveBeenCalled();

    oldLeaf.finish();
    await oldNavigation;
    await Promise.resolve();
    expect(latestLeaf.leaf.openFile).toHaveBeenCalledOnce();
    expect(oldLeaf.leaf.detach).toHaveBeenCalledOnce();

    latestLeaf.finish();
    await latestNavigation;

    expect(workspace.revealLeaf).toHaveBeenCalledTimes(2);
    expect(workspace.revealLeaf).toHaveBeenNthCalledWith(1, { id: "preview" });
    expect(workspace.revealLeaf).toHaveBeenLastCalledWith(latestLeaf.leaf);
    expect(oldLeaf.reveals[0]).not.toHaveBeenCalled();
    expect(latestLeaf.reveals[0]).toHaveBeenCalledWith(9);
  });

  it("preserves a stale plugin-created leaf after the user edits it", async () => {
    const oldLeaf = deferredLeaf({ holdCompletion: true });
    const latestLeaf = deferredLeaf();
    const { internals, plugin, workspace } = harness([oldLeaf.leaf, latestLeaf.leaf]);
    await plugin.onload();
    let oldCurrent = true;
    const oldNavigation = internals.revealSourceLocation(
      { path: "book/old.typ", byteOffset: 1 },
      () => oldCurrent,
    );
    oldCurrent = false;
    const latestNavigation = internals.revealSourceLocation(
      { path: "book/latest.typ", byteOffset: 9 },
      () => true,
    );

    oldLeaf.finish();
    await vi.waitFor(() => {
      expect(oldLeaf.leaf.view).toBeInstanceOf(TypstEditorView);
    });
    workspace.activeLeaf = { id: "preview" };
    const oldEditor = oldLeaf.leaf.view as TypstEditorView;
    oldEditor.editorView.dispatch({
      changes: { from: oldEditor.getViewData().length, insert: "!" },
    });
    oldLeaf.releaseCompletion();
    await oldNavigation;

    expect(oldLeaf.leaf.detach).not.toHaveBeenCalled();
    latestLeaf.finish();
    await latestNavigation;
    expect(latestLeaf.reveals[0]).toHaveBeenCalledWith(9);
  });

  it("cancels a deferred open when keyboard context changes", async () => {
    const sourceLeaf = deferredLeaf();
    const { activeCallbacks, internals, plugin, workspace } = harness([sourceLeaf.leaf]);
    await plugin.onload();
    const navigation = internals.revealSourceLocation(
      { path: "book/section.typ", byteOffset: 4 },
      () => true,
    );

    const keyboardTarget = { id: "keyboard-target" };
    workspace.activeLeaf = keyboardTarget;
    activeCallbacks[0]?.(keyboardTarget);
    sourceLeaf.finish();
    await navigation;

    expect(sourceLeaf.leaf.detach).toHaveBeenCalledOnce();
    expect(workspace.revealLeaf).not.toHaveBeenCalled();
    expect(sourceLeaf.reveals[0]).not.toHaveBeenCalled();
  });

  it("does not move the cursor when context changes during revealLeaf", async () => {
    const sourceLeaf = deferredLeaf();
    const { activeCallbacks, internals, plugin, workspace } = harness([sourceLeaf.leaf]);
    let finishReveal!: () => void;
    const revealing = new Promise<void>((resolve) => { finishReveal = resolve; });
    workspace.revealLeaf.mockImplementation(async (leaf: DeferredLeaf) => {
      workspace.activeLeaf = leaf;
      for (const callback of activeCallbacks) callback(leaf);
      await revealing;
    });
    await plugin.onload();
    const navigation = internals.revealSourceLocation(
      { path: "book/section.typ", byteOffset: 4 },
      () => true,
    );

    sourceLeaf.finish();
    await vi.waitFor(() => {
      expect(workspace.revealLeaf).toHaveBeenCalledWith(sourceLeaf.leaf);
    });
    const keyboardTarget = { id: "keyboard-target" };
    workspace.activeLeaf = keyboardTarget;
    activeCallbacks[0]?.(keyboardTarget);
    finishReveal();
    await navigation;

    expect(sourceLeaf.leaf.detach).not.toHaveBeenCalled();
    expect(sourceLeaf.reveals[0]).not.toHaveBeenCalled();
  });
});
