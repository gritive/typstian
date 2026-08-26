const FORWARD_SEARCH_DEBOUNCE_MS = 75;

export class ForwardSearchScheduler<T> {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private owner: object | null = null;
  private disposed = false;

  constructor(
    private readonly run: (
      request: T,
      isCurrent: () => boolean,
    ) => void | Promise<void>,
  ) {}

  schedule(owner: object, request: T): void {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.owner = owner;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const isCurrent = (): boolean =>
        !this.disposed
        && generation === this.generation
        && this.owner === owner;
      void this.run(request, isCurrent);
    }, FORWARD_SEARCH_DEBOUNCE_MS);
  }

  cancel(owner: object): void {
    if (this.disposed || this.owner !== owner) return;
    this.generation += 1;
    this.owner = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.owner = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
