// Type-only, so it costs nothing at runtime and keeps the caller's request
// union from widening to `string` at this seam.
import type { RequestKind } from "./compiler-client";

// Blowing a compile deadline is not a cheap retry: it calls `failSession`,
// which disposes the engine, terminates the worker, and discards the retained
// document and the registered fonts. The next attempt therefore starts cold and
// is *more* likely to time out again. A cold session pays for font residency,
// first-pass layout, and PDF assembly that a warm one does not, so the first
// compile of a session gets a wider budget than the ones that follow. The
// deadline stays finite either way.
export const COLD_COMPILE_DEADLINE_MULTIPLIER = 4;

/**
 * Deadline for one engine request. Only the first compile of a session is
 * widened; every other request, compile or not, keeps the steady-state budget.
 */
export function requestDeadlineMs(
  kind: RequestKind,
  timeoutMs: number,
  sessionCompileCount: number,
): number {
  return kind === "compile" && sessionCompileCount === 0
    ? timeoutMs * COLD_COMPILE_DEADLINE_MULTIPLIER
    : timeoutMs;
}
