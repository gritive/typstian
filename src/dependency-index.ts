function normalizePath(path: string): string {
  const slashPath = path.replaceAll("\\", "/");
  const absolute = slashPath.startsWith("/");
  const segments: string[] = [];

  for (const segment of slashPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      const previous = segments.at(-1);
      if (previous !== undefined && previous !== "..") {
        segments.pop();
      } else if (!absolute) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }

  return `${absolute ? "/" : ""}${segments.join("/")}`;
}

export class DependencyIndex {
  private readonly dependenciesByEntry = new Map<string, Set<string>>();
  private readonly entriesByDependency = new Map<string, Set<string>>();

  update(entryPath: string, dependencyPaths: Iterable<string>): void {
    const entry = normalizePath(entryPath);
    this.remove(entry);

    const dependencies = new Set(
      Array.from(dependencyPaths, (dependency) => normalizePath(dependency))
    );
    this.dependenciesByEntry.set(entry, dependencies);

    for (const dependency of dependencies) {
      const entries = this.entriesByDependency.get(dependency) ?? new Set<string>();
      entries.add(entry);
      this.entriesByDependency.set(dependency, entries);
    }
  }

  extend(entryPath: string, dependencyPaths: Iterable<string>): void {
    const entry = normalizePath(entryPath);
    const dependencies = new Set(this.dependenciesByEntry.get(entry) ?? []);
    for (const dependency of dependencyPaths) {
      dependencies.add(normalizePath(dependency));
    }
    this.update(entry, dependencies);
  }

  affectedBy(changedPath: string): string[] {
    return Array.from(
      this.entriesByDependency.get(normalizePath(changedPath)) ?? []
    ).sort();
  }

  remove(entryPath: string): void {
    const entry = normalizePath(entryPath);
    const dependencies = this.dependenciesByEntry.get(entry);
    if (dependencies === undefined) return;

    for (const dependency of dependencies) {
      const entries = this.entriesByDependency.get(dependency);
      entries?.delete(entry);
      if (entries?.size === 0) this.entriesByDependency.delete(dependency);
    }
    this.dependenciesByEntry.delete(entry);
  }

  clear(): void {
    this.dependenciesByEntry.clear();
    this.entriesByDependency.clear();
  }
}
