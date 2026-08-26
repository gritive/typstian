import { describe, expect, it } from "vitest";

import {
  EMPTY_COMPILE_STATUS,
  compileOutcomeForFailure,
  compileStatusLabel,
  reduceCompileStatus,
  type CompileStatusEvent,
  type CompileStatusState
} from "../src/compile-status";

const apply = (...events: CompileStatusEvent[]): CompileStatusState =>
  events.reduce(reduceCompileStatus, EMPTY_COMPILE_STATUS);

const labelAfter = (...events: CompileStatusEvent[]): string =>
  compileStatusLabel(apply(...events));

describe("compileStatusLabel", () => {
  it("shows nothing until a preview compiles", () => {
    expect(labelAfter()).toBe("");
  });

  it("goes idle after a successful compile started from nothing", () => {
    expect(labelAfter({ type: "started", preview: "a" })).toBe("Typst: compiling…");
    expect(labelAfter(
      { type: "started", preview: "a" },
      { type: "settled", preview: "a", outcome: "ok" }
    )).toBe("Typst: idle");
  });

  it("reports the error count of the last failed compile", () => {
    expect(labelAfter(
      { type: "started", preview: "a" },
      { type: "settled", preview: "a", outcome: "error", errorCount: 3 }
    )).toBe("Typst: failed (3 errors)");
  });

  it("counts a single error in the singular", () => {
    expect(labelAfter(
      { type: "started", preview: "a" },
      { type: "settled", preview: "a", outcome: "error", errorCount: 1 }
    )).toBe("Typst: failed (1 error)");
  });

  it("omits the count when a failure carries no diagnostics", () => {
    expect(labelAfter(
      { type: "started", preview: "a" },
      { type: "settled", preview: "a", outcome: "error" }
    )).toBe("Typst: failed");
  });

  it("clears an earlier failure when the preview compiles again", () => {
    expect(labelAfter(
      { type: "started", preview: "a" },
      { type: "settled", preview: "a", outcome: "error", errorCount: 2 },
      { type: "started", preview: "a" },
      { type: "settled", preview: "a", outcome: "ok" }
    )).toBe("Typst: idle");
  });

  it("stays compiling while a second preview is still running", () => {
    expect(labelAfter(
      { type: "started", preview: "a" },
      { type: "started", preview: "b" },
      { type: "settled", preview: "a", outcome: "ok" }
    )).toBe("Typst: compiling…");
  });

  it("speaks for the preview that settled most recently", () => {
    expect(labelAfter(
      { type: "started", preview: "a" },
      { type: "settled", preview: "a", outcome: "error", errorCount: 4 },
      { type: "started", preview: "b" },
      { type: "settled", preview: "b", outcome: "ok" }
    )).toBe("Typst: idle");
    expect(labelAfter(
      { type: "started", preview: "a" },
      { type: "settled", preview: "a", outcome: "ok" },
      { type: "started", preview: "b" },
      { type: "settled", preview: "b", outcome: "error", errorCount: 4 }
    )).toBe("Typst: failed (4 errors)");
  });

  it("clears the label when the failing preview closes", () => {
    expect(labelAfter(
      { type: "started", preview: "a" },
      { type: "settled", preview: "a", outcome: "error", errorCount: 2 },
      { type: "disposed", preview: "a" }
    )).toBe("");
  });

  it("clears a preview that closes mid-compile instead of compiling forever", () => {
    expect(labelAfter(
      { type: "started", preview: "a" },
      { type: "disposed", preview: "a" }
    )).toBe("");
  });

  it("ignores a compile that settles after its preview closed", () => {
    expect(labelAfter(
      { type: "started", preview: "a" },
      { type: "disposed", preview: "a" },
      { type: "settled", preview: "a", outcome: "error", errorCount: 9 }
    )).toBe("");
  });

  it("drops a stale failure when the compile was cancelled rather than failed", () => {
    expect(labelAfter(
      { type: "started", preview: "a" },
      { type: "settled", preview: "a", outcome: "error", errorCount: 2 },
      { type: "started", preview: "a" },
      { type: "settled", preview: "a", outcome: "cancelled" }
    )).toBe("Typst: idle");
  });

  it("leaves the previous state untouched", () => {
    const first = apply({ type: "started", preview: "a" });
    reduceCompileStatus(first, { type: "settled", preview: "a", outcome: "ok" });
    expect(compileStatusLabel(first)).toBe("Typst: compiling…");
  });
});

describe("compileOutcomeForFailure", () => {
  it("counts a superseded or closed compile as cancelled, not as a failure", () => {
    // A newer revision and a backend restart both reject the in-flight compile.
    // Reporting either as a failure flashes an error the document does not have.
    expect(compileOutcomeForFailure({ code: "stale" }, false)).toBe("cancelled");
    expect(compileOutcomeForFailure({ code: "closed" }, false)).toBe("cancelled");
  });

  it("counts an aborted compile as cancelled whatever the rejection carries", () => {
    expect(compileOutcomeForFailure(new Error("boom"), true)).toBe("cancelled");
  });

  it("counts every other rejection as a failure", () => {
    expect(compileOutcomeForFailure({ code: "timeout" }, false)).toBe("error");
    expect(compileOutcomeForFailure(new Error("boom"), false)).toBe("error");
    expect(compileOutcomeForFailure(undefined, false)).toBe("error");
  });
});
