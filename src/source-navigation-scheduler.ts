import { LatestRequestScheduler } from "./latest-request-scheduler";

export class SourceNavigationScheduler<T> {
  private readonly scheduler: LatestRequestScheduler<T, void>;

  constructor(
    run: (
      request: T,
      isCurrent: () => boolean,
    ) => void | Promise<void>,
  ) {
    this.scheduler = new LatestRequestScheduler(run, undefined);
  }

  schedule(request: T, upstreamCurrent: () => boolean): Promise<void> {
    return this.scheduler.schedule(request, upstreamCurrent);
  }

  cancel(): void {
    this.scheduler.cancel();
  }

  dispose(): void {
    this.scheduler.dispose();
  }
}
