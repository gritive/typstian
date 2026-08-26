import { describe, expect, it, vi } from "vitest";

import { ForwardSearchScheduler } from "../src/forward-search-scheduler";

describe("ForwardSearchScheduler", () => {
  it("coalesces a pointer burst and discards an older read that resolves last", async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: string) => void;
    let resolveLatest!: (value: string) => void;
    const read = vi.fn((request: string) => new Promise<string>((resolve) => {
      if (request === "old") resolveOld = resolve;
      if (request === "latest") resolveLatest = resolve;
    }));
    const forward = vi.fn();
    const scheduler = new ForwardSearchScheduler<string>(async (request, isCurrent) => {
      const saved = await read(request);
      if (isCurrent()) forward(saved);
    });

    const owner = {};
    scheduler.schedule(owner, "old");
    await vi.advanceTimersByTimeAsync(100);
    scheduler.schedule(owner, "middle");
    scheduler.schedule(owner, "latest");
    await vi.advanceTimersByTimeAsync(100);

    expect(read.mock.calls.map(([request]) => request)).toEqual(["old", "latest"]);
    resolveLatest("latest saved");
    await Promise.resolve();
    expect(forward).toHaveBeenCalledWith("latest saved");

    resolveOld("old saved");
    await Promise.resolve();
    expect(forward).toHaveBeenCalledOnce();
    scheduler.dispose();
    vi.useRealTimers();
  });

  it("cancels an owner's request before the debounce expires", async () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const scheduler = new ForwardSearchScheduler<string>(run);
    const owner = {};

    scheduler.schedule(owner, "queued");
    scheduler.cancel(owner);
    await vi.advanceTimersByTimeAsync(100);

    expect(run).not.toHaveBeenCalled();
    scheduler.dispose();
    vi.useRealTimers();
  });

  it("does not cancel another editor's newer request", async () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const scheduler = new ForwardSearchScheduler<string>(run);
    const closingEditor = {};
    const activeEditor = {};

    scheduler.schedule(closingEditor, "old");
    scheduler.schedule(activeEditor, "latest");
    scheduler.cancel(closingEditor);
    await vi.advanceTimersByTimeAsync(100);

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith("latest", expect.any(Function));
    scheduler.dispose();
    vi.useRealTimers();
  });

  it("invalidates an owner's request while its read is in flight", async () => {
    vi.useFakeTimers();
    let finishRead!: () => void;
    const read = new Promise<void>((resolve) => { finishRead = resolve; });
    const forward = vi.fn();
    const scheduler = new ForwardSearchScheduler<string>(async (_request, isCurrent) => {
      await read;
      if (isCurrent()) forward();
    });
    const owner = {};

    scheduler.schedule(owner, "in-flight");
    await vi.advanceTimersByTimeAsync(100);
    scheduler.cancel(owner);
    finishRead();
    await Promise.resolve();

    expect(forward).not.toHaveBeenCalled();
    scheduler.dispose();
    vi.useRealTimers();
  });
});
