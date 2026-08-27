/**
 * The compile state behind the status bar item, as a pure reducer so it can be
 * exercised without Obsidian.
 *
 * A compile is only ever observed here: the reducer never cancels, delays, or
 * reorders anything, because aborting a running compile would terminate the
 * compiler worker and throw away its retained document.
 */
export type CompileStatusEvent =
  | { readonly type: "started"; readonly preview: string }
  | {
    readonly type: "settled";
    readonly preview: string;
    /**
     * `cancelled` covers a compile the preview walked away from — a new source
     * or a disposal — which is neither a success nor a failure to report.
     */
    readonly outcome: "ok" | "error" | "cancelled";
    readonly errorCount?: number;
  }
  | { readonly type: "disposed"; readonly preview: string };

import { failedCompileStatus, MESSAGES } from "./messages";

interface PreviewCompileStatus {
  readonly compiling: boolean;
  /** `null` once the last compile succeeded, was cancelled, or never ran. */
  readonly errorCount: number | null;
}

export interface CompileStatusState {
  /**
   * Insertion-ordered, and a settled preview moves to the end, so the last
   * entry is the preview that produced the newest result the user can see.
   */
  readonly previews: ReadonlyMap<string, PreviewCompileStatus>;
}

export const EMPTY_COMPILE_STATUS: CompileStatusState = { previews: new Map() };

export function reduceCompileStatus(
  state: CompileStatusState,
  event: CompileStatusEvent
): CompileStatusState {
  const previews = new Map(state.previews);
  if (event.type === "disposed") {
    if (!previews.delete(event.preview)) return state;
    return { previews };
  }
  if (event.type === "started") {
    previews.set(event.preview, {
      compiling: true,
      errorCount: previews.get(event.preview)?.errorCount ?? null
    });
    return { previews };
  }
  // A result that arrives after its preview closed must not resurrect it.
  if (!previews.has(event.preview)) return state;
  previews.delete(event.preview);
  previews.set(event.preview, {
    compiling: false,
    errorCount: event.outcome === "error" ? event.errorCount ?? 0 : null
  });
  return { previews };
}

export function compileStatusLabel(state: CompileStatusState): string {
  const previews = [...state.previews.values()];
  if (previews.length === 0) return "";
  if (previews.some((preview) => preview.compiling)) return MESSAGES.status.compiling;
  const newest = previews[previews.length - 1]!;
  if (newest.errorCount === null) return MESSAGES.status.idle;
  if (newest.errorCount === 0) return MESSAGES.status.failed;
  return failedCompileStatus(newest.errorCount);
}

/**
 * A compile that is superseded by a newer revision, or dropped when the backend
 * restarts, rejects like any other failure. Reporting those as failures would
 * flash an error the document does not have, so they read as cancellations.
 */
export function compileOutcomeForFailure(
  error: unknown,
  aborted: boolean
): "cancelled" | "error" {
  if (aborted) return "cancelled";
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === "stale" || code === "closed" ? "cancelled" : "error";
}
