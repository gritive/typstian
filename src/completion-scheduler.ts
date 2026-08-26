interface PendingCompletion<T, R> {
  generation: number;
  request: T;
  upstreamCurrent: () => boolean;
  settle: (value: R | null) => void;
}

/**
 * Keeps one completion request in flight and only the newest one queued behind
 * it. Typing produces a request per keystroke, and the compiler client
 * serializes everything it is handed, so a scheduler that queued them all would
 * answer each keystroke with the results of the one before it. Superseded
 * requests answer `null`, which is how CodeMirror says "no completions here".
 *
 * This is `SourceNavigationScheduler`'s coalescing with a return value: a
 * navigation only has to happen, a completion has to be handed back.
 */
export class CompletionScheduler<T, R> {
  private generation = 0;
  private pending: PendingCompletion<T, R> | null = null;
  private running = false;
  private disposed = false;

  constructor(
    private readonly run: (
      request: T,
      isCurrent: () => boolean,
    ) => Promise<R | null>,
  ) {}

  schedule(request: T, upstreamCurrent: () => boolean): Promise<R | null> {
    if (this.disposed || !upstreamCurrent()) return Promise.resolve(null);
    const generation = ++this.generation;
    this.pending?.settle(null);
    return new Promise<R | null>((settle) => {
      this.pending = { generation, request, upstreamCurrent, settle };
      void this.drain();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.pending?.settle(null);
    this.pending = null;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending !== null) {
        const completion = this.pending;
        this.pending = null;
        const isCurrent = (): boolean =>
          !this.disposed
          && completion.generation === this.generation
          && completion.upstreamCurrent();
        let value: R | null = null;
        try {
          value = isCurrent() ? await this.run(completion.request, isCurrent) : null;
        } catch {
          // A completion is an optional convenience: a failed lookup offers
          // nothing rather than surfacing an error over the editor.
          value = null;
        }
        completion.settle(isCurrent() ? value : null);
      }
    } finally {
      this.running = false;
      if (this.pending !== null) void this.drain();
    }
  }
}
