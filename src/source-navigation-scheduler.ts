interface PendingNavigation<T> {
  generation: number;
  request: T;
  upstreamCurrent: () => boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class SourceNavigationScheduler<T> {
  private generation = 0;
  private pending: PendingNavigation<T> | null = null;
  private running = false;
  private disposed = false;

  constructor(
    private readonly run: (
      request: T,
      isCurrent: () => boolean,
    ) => void | Promise<void>,
  ) {}

  schedule(request: T, upstreamCurrent: () => boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const generation = ++this.generation;
    this.pending?.resolve();
    return new Promise<void>((resolve, reject) => {
      this.pending = { generation, request, upstreamCurrent, resolve, reject };
      void this.drain();
    });
  }

  cancel(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.pending?.resolve();
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
        const navigation = this.pending;
        this.pending = null;
        const isCurrent = (): boolean =>
          !this.disposed
          && navigation.generation === this.generation
          && navigation.upstreamCurrent();
        try {
          await this.run(navigation.request, isCurrent);
          navigation.resolve();
        } catch (error) {
          navigation.reject(error);
        }
      }
    } finally {
      this.running = false;
      if (this.pending !== null) void this.drain();
    }
  }
}
