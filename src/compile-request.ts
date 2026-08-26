/**
 * The compile request the WASM session parses. Both the in-process engine and
 * the browser worker build it, so the shape lives here rather than being
 * hand-rolled at each call site.
 */
interface CompileRequestPayload {
  revision: number;
  entry: string;
  clock: HostClock;
}

/**
 * The host's wall clock. The compiler has neither a clock nor a timezone
 * database of its own, so the host samples both the instant and its own UTC
 * offset and sends them with the request.
 */
export interface HostClock {
  /** Milliseconds since the Unix epoch, UTC. */
  nowMs: number;
  /** Minutes to add to UTC to reach the host's local time. */
  localOffsetMinutes: number;
}

export function hostClock(): HostClock {
  const now = new Date();
  return {
    nowMs: now.getTime(),
    localOffsetMinutes: -now.getTimezoneOffset(),
  };
}

export function compileRequestJson(
  request: { revision: number; entryPath: string },
  clock: HostClock,
): string {
  const payload: CompileRequestPayload = {
    revision: request.revision,
    entry: request.entryPath,
    clock,
  };
  return JSON.stringify(payload);
}
