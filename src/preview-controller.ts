export type PreviewStatus =
  | "idle"
  | "compiling"
  | "ready"
  | "error";

export interface PreviewState<Result> {
  status: PreviewStatus;
  result?: Result;
  error?: unknown;
}

export interface PreviewControllerOptions<Result> {
  compile: (sourcePath: string, signal: AbortSignal) => Promise<Result>;
  onState: (state: PreviewState<Result>) => void;
  debounceMs?: number;
  dirtyDebounceMs?: number;
}

export class PreviewController<Result = unknown> {
  private sourcePath: string | null = null;
  private timer: number | null = null;
  private active: AbortController | null = null;
  private queued = false;
  private generation = 0;
  private disposed = false;

  constructor(private readonly options: PreviewControllerOptions<Result>) {}

  setSource(sourcePath: string | null): void {
    if (this.disposed) return;
    if (sourcePath !== this.sourcePath) {
      this.cancel();
    }
    this.sourcePath = sourcePath;
  }

  markDirty(): void {
    this.schedule(this.options.dirtyDebounceMs ?? 300);
  }

  notifySaved(path: string): void {
    if (path !== this.sourcePath) return;
    this.schedule(this.options.debounceMs ?? 75);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }

  /**
   * A compile in flight cannot be cancelled without terminating the compiler
   * worker, which discards its retained document and its registered fonts. Edits
   * therefore supersede the pending result without aborting the work that
   * produced it, and the newest revision compiles once that work settles.
   */
  private schedule(delayMs: number): void {
    if (this.disposed || this.sourcePath === null) return;
    this.generation += 1;
    this.queued = false;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (this.active !== null) {
        this.queued = true;
        return;
      }
      void this.compileCurrent();
    }, delayMs);
  }

  private cancel(): void {
    this.generation += 1;
    this.queued = false;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.active?.abort();
    this.active = null;
  }

  private async compileCurrent(): Promise<void> {
    const sourcePath = this.sourcePath;
    if (sourcePath === null) {
      return;
    }
    const active = new AbortController();
    this.active = active;
    const generation = this.generation;
    this.options.onState({ status: "compiling" });
    try {
      const result = await this.options.compile(sourcePath, active.signal);
      if (generation === this.generation && !active.signal.aborted) {
        this.options.onState({ status: "ready", result });
      }
    } catch (error) {
      if (generation === this.generation && !active.signal.aborted) {
        this.options.onState({ status: "error", error });
      }
    } finally {
      if (this.active === active) {
        this.active = null;
        if (this.queued && !this.disposed) {
          this.queued = false;
          void this.compileCurrent();
        }
      }
    }
  }
}
