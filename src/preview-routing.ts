export interface PreviewRoute<T> {
  preview: T;
  sourcePath: string | null;
}

export interface ForwardSnapshot {
  sourcePath: string;
  sourceText: string;
}

export function chooseForwardPreview<T>(
  previews: readonly PreviewRoute<T>[],
  sourcePath: string,
  affectedEntries: ReadonlySet<string>
): T | undefined {
  const exact = previews.find((preview) => preview.sourcePath === sourcePath);
  if (exact !== undefined) return exact.preview;

  return previews
    .filter((preview) =>
      preview.sourcePath !== null && affectedEntries.has(preview.sourcePath)
    )
    .sort((left, right) =>
      (left.sourcePath ?? "").localeCompare(right.sourcePath ?? "")
    )[0]?.preview;
}

export function shouldPreviewFollow(
  entryPath: string | null,
  activePath: string,
  affectedEntries: ReadonlySet<string>
): boolean {
  return entryPath !== activePath
    && (entryPath === null || !affectedEntries.has(entryPath));
}

export function isSavedForwardSnapshot(
  currentPath: string | null,
  currentText: string,
  savedText: string,
  snapshot: ForwardSnapshot
): boolean {
  return currentPath === snapshot.sourcePath
    && currentText === snapshot.sourceText
    && savedText === snapshot.sourceText;
}
