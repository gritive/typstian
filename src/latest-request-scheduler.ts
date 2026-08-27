interface PendingRequest<T, R> {
  generation: number;
  request: T;
  upstreamCurrent: () => boolean;
  resolve: (value: R) => void;
  reject: (error: unknown) => void;
}

export class LatestRequestScheduler<T, R> {
  private generation = 0;
  private pending: PendingRequest<T, R> | null = null;
  private running = false;
  private disposed = false;

  constructor(
    private readonly run: (
      request: T,
      isCurrent: () => boolean,
    ) => R | Promise<R>,
    private readonly supersededValue: R,
  ) {}

  isDisposed(): boolean {
    return this.disposed;
  }

  schedule(request: T, upstreamCurrent: () => boolean): Promise<R> {
    if (this.disposed) return Promise.resolve(this.supersededValue);
    const generation = ++this.generation;
    this.pending?.resolve(this.supersededValue);
    return new Promise<R>((resolve, reject) => {
      this.pending = { generation, request, upstreamCurrent, resolve, reject };
      void this.drain();
    });
  }

  cancel(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.pending?.resolve(this.supersededValue);
    this.pending = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending !== null) {
        const pending = this.pending;
        this.pending = null;
        const isCurrent = (): boolean =>
          !this.disposed
          && pending.generation === this.generation
          && pending.upstreamCurrent();
        try {
          pending.resolve(await this.run(pending.request, isCurrent));
        } catch (error) {
          pending.reject(error);
        }
      }
    } finally {
      this.running = false;
      if (this.pending !== null) void this.drain();
    }
  }
}
