import { describe, expect, it } from "vitest";

import {
  COLD_COMPILE_DEADLINE_MULTIPLIER,
  requestDeadlineMs,
} from "../src/compile-deadline";

describe("requestDeadlineMs", () => {
  it("gives the first compile of a session a multiple of the steady-state budget", () => {
    expect(requestDeadlineMs("compile", 15_000, 0)).toBe(
      15_000 * COLD_COMPILE_DEADLINE_MULTIPLIER,
    );
  });

  it("returns to the steady-state budget once the session has compiled", () => {
    expect(requestDeadlineMs("compile", 15_000, 1)).toBe(15_000);
    expect(requestDeadlineMs("compile", 15_000, 9)).toBe(15_000);
  });

  it("never widens a non-compile request", () => {
    expect(requestDeadlineMs("jump", 15_000, 0)).toBe(15_000);
    expect(requestDeadlineMs("environment", 15_000, 0)).toBe(15_000);
  });

  it("keeps a finite deadline", () => {
    expect(Number.isFinite(requestDeadlineMs("compile", 15_000, 0))).toBe(true);
    expect(COLD_COMPILE_DEADLINE_MULTIPLIER).toBeGreaterThan(1);
  });
});
