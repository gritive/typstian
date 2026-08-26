// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import { PreviewController } from "../src/preview-controller";

describe("PreviewController", () => {
  it("compiles an unsaved buffer after the dirty debounce", async () => {
    vi.useFakeTimers();
    const compile = vi.fn().mockResolvedValue("pdf");
    const states: string[] = [];
    const controller = new PreviewController({
      compile,
      dirtyDebounceMs: 300,
      onState: (state) => states.push(state.status)
    });

    controller.setSource("paper/main.typ");
    controller.markDirty();
    await vi.advanceTimersByTimeAsync(299);
    expect(compile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(compile).toHaveBeenCalledOnce();
    expect(states).toEqual(["compiling", "ready"]);
    vi.useRealTimers();
  });

  it("starts a saved-file compilation within 100 ms by default", async () => {
    vi.useFakeTimers();
    const compile = vi.fn().mockResolvedValue("pdf");
    const controller = new PreviewController({
      compile,
      onState: () => undefined
    });
    controller.setSource("paper/main.typ");

    controller.notifySaved("paper/main.typ");
    await vi.advanceTimersByTimeAsync(100);

    expect(compile).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("debounces a saved-file compilation", async () => {
    vi.useFakeTimers();
    const compile = vi.fn().mockResolvedValue("svg");
    const states: string[] = [];
    const controller = new PreviewController({
      compile,
      debounceMs: 300,
      onState: (state) => states.push(state.status)
    });
    controller.setSource("paper/main.typ");

    controller.notifySaved("paper/main.typ");
    await vi.advanceTimersByTimeAsync(299);
    expect(compile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(compile).toHaveBeenCalledOnce();
    expect(states).toEqual(["compiling", "ready"]);
    vi.useRealTimers();
  });

  it("cancels pending and active work when disposed", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const compile = vi.fn((_path: string, currentSignal: AbortSignal) => {
      signal = currentSignal;
      return new Promise<string>(() => undefined);
    });
    const controller = new PreviewController({ compile, onState: () => undefined });
    controller.setSource("paper/main.typ");
    controller.notifySaved("paper/main.typ");
    await vi.advanceTimersByTimeAsync(300);

    controller.dispose();

    expect(signal?.aborted).toBe(true);
    controller.notifySaved("paper/main.typ");
    await vi.advanceTimersByTimeAsync(300);
    expect(compile).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("cancels work for a source that is no longer followed", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const compile = vi.fn((_path: string, currentSignal: AbortSignal) => {
      signal = currentSignal;
      return new Promise<string>(() => undefined);
    });
    const controller = new PreviewController({ compile, onState: () => undefined });
    controller.setSource("paper/old.typ");
    controller.notifySaved("paper/old.typ");
    await vi.advanceTimersByTimeAsync(300);

    controller.setSource("paper/new.typ");

    expect(signal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("keeps an in-flight compile alive when the buffer changes and recompiles after it settles", async () => {
    vi.useFakeTimers();
    const resolvers: Array<(value: string) => void> = [];
    const signals: AbortSignal[] = [];
    const compile = vi.fn((_path: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<string>((resolve) => { resolvers.push(resolve); });
    });
    const ready: string[] = [];
    const controller = new PreviewController<string>({
      compile,
      dirtyDebounceMs: 300,
      onState: (state) => {
        if (state.status === "ready" && state.result !== undefined) ready.push(state.result);
      }
    });
    controller.setSource("paper/main.typ");
    controller.notifySaved("paper/main.typ");
    await vi.advanceTimersByTimeAsync(300);

    controller.markDirty();
    await vi.advanceTimersByTimeAsync(300);
    expect(signals[0]?.aborted).toBe(false);
    expect(compile).toHaveBeenCalledOnce();

    resolvers[0]?.("old");
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toEqual([]);
    expect(compile).toHaveBeenCalledTimes(2);

    resolvers[1]?.("new");
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toEqual(["new"]);
    vi.useRealTimers();
  });

it("waits for the latest dirty debounce after an active compile settles", async () => {
    vi.useFakeTimers();
    const resolvers: Array<(value: string) => void> = [];
    const compile = vi.fn(() => new Promise<string>((resolve) => {
      resolvers.push(resolve);
    }));
    const controller = new PreviewController<string>({
      compile,
      debounceMs: 0,
      dirtyDebounceMs: 300,
      onState: vi.fn(),
    });
    controller.setSource("paper/main.typ");
    controller.notifySaved("paper/main.typ");
    await vi.advanceTimersByTimeAsync(0);

    controller.markDirty();
    await vi.advanceTimersByTimeAsync(300);
    controller.markDirty();
    resolvers[0]?.("old");
    await vi.advanceTimersByTimeAsync(0);

    expect(compile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(299);
    expect(compile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(compile).toHaveBeenCalledTimes(2);

    resolvers[1]?.("new");
    await vi.advanceTimersByTimeAsync(0);
    expect(compile).toHaveBeenCalledTimes(2);
    controller.dispose();
    vi.useRealTimers();
  });

  it("drops a superseded compile result when a newer save arrives", async () => {
    vi.useFakeTimers();
    const resolvers: Array<(value: string) => void> = [];
    const signals: AbortSignal[] = [];
    const compile = vi.fn((_path: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<string>((resolve) => { resolvers.push(resolve); });
    });
    const ready: string[] = [];
    const controller = new PreviewController<string>({
      compile,
      onState: (state) => {
        if (state.status === "ready" && state.result !== undefined) ready.push(state.result);
      }
    });
    controller.setSource("paper/main.typ");
    controller.notifySaved("paper/main.typ");
    await vi.advanceTimersByTimeAsync(300);

    controller.notifySaved("paper/main.typ");
    await vi.advanceTimersByTimeAsync(300);
    expect(signals[0]?.aborted).toBe(false);

    resolvers[0]?.("old");
    await vi.advanceTimersByTimeAsync(0);
    resolvers[1]?.("new");
    await vi.advanceTimersByTimeAsync(0);

    expect(ready).toEqual(["new"]);
    vi.useRealTimers();
  });

  it("exposes the original compile failure without losing the safe status", async () => {
    vi.useFakeTimers();
    const failure = new Error("compiler unavailable");
    const states: Array<{ status: string; error?: unknown }> = [];
    const controller = new PreviewController({
      compile: vi.fn().mockRejectedValue(failure),
      onState: (state) => states.push(state)
    });
    controller.setSource("paper/main.typ");

    controller.notifySaved("paper/main.typ");
    await vi.advanceTimersByTimeAsync(300);

    expect(states.at(-1)).toEqual({ status: "error", error: failure });
    vi.useRealTimers();
  });
});
