import { describe, expect, it, vi } from "vitest";

import { SourceNavigationScheduler } from "../src/source-navigation-scheduler";

describe("SourceNavigationScheduler", () => {
  it("serializes navigation and commits only the latest queued target", async () => {
    let finishOld!: () => void;
    const oldOpen = new Promise<void>((resolve) => { finishOld = resolve; });
    const committed: string[] = [];
    const run = vi.fn(async (target: string, isCurrent: () => boolean) => {
      if (target === "old.typ") await oldOpen;
      if (isCurrent()) committed.push(target);
    });
    const scheduler = new SourceNavigationScheduler(run);

    const old = scheduler.schedule("old.typ", () => true);
    const latest = scheduler.schedule("latest.typ", () => true);
    expect(run).toHaveBeenCalledTimes(1);

    finishOld();
    await old;
    await latest;

    expect(run.mock.calls.map(([target]) => target)).toEqual(["old.typ", "latest.typ"]);
    expect(committed).toEqual(["latest.typ"]);
    scheduler.dispose();
  });

  it("invalidates an in-flight navigation when the workspace context changes", async () => {
    let finishOpen!: () => void;
    const opened = new Promise<void>((resolve) => { finishOpen = resolve; });
    const commit = vi.fn();
    const scheduler = new SourceNavigationScheduler(async (_target, isCurrent) => {
      await opened;
      if (isCurrent()) commit();
    });

    const navigation = scheduler.schedule("section.typ", () => true);
    scheduler.cancel();
    finishOpen();
    await navigation;

    expect(commit).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it("propagates navigation failures", async () => {
    const failure = new Error("navigation failed");
    const scheduler = new SourceNavigationScheduler(() => Promise.reject(failure));

    await expect(scheduler.schedule("section.typ", () => true)).rejects.toBe(failure);

    scheduler.dispose();
  });

  it("cancel resolves queued navigation without running it", async () => {
    let finishRunning!: () => void;
    const running = new Promise<void>((resolve) => { finishRunning = resolve; });
    const run = vi.fn(async (target: string) => {
      if (target === "running.typ") await running;
    });
    const scheduler = new SourceNavigationScheduler(run);

    const first = scheduler.schedule("running.typ", () => true);
    const queued = scheduler.schedule("queued.typ", () => true);
    scheduler.cancel();

    await expect(queued).resolves.toBeUndefined();
    expect(run.mock.calls.map(([target]) => target)).toEqual(["running.typ"]);

    finishRunning();
    await first;
    scheduler.dispose();
  });

  it("cancel invalidates the running navigation", async () => {
    let finishRunning!: () => void;
    const running = new Promise<void>((resolve) => { finishRunning = resolve; });
    let isCurrentResult: boolean | undefined;
    const run = vi.fn(async (_target: string, isCurrent: () => boolean) => {
      await running;
      isCurrentResult = isCurrent();
    });
    const scheduler = new SourceNavigationScheduler(run);

    const first = scheduler.schedule("running.typ", () => true);
    scheduler.cancel();
    finishRunning();
    await first;

    expect(isCurrentResult).toBe(false);
    scheduler.dispose();
  });
});
