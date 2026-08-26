export interface SourceEditorLeafCandidate<TLeaf> {
  leaf: TLeaf;
  sourcePath: string | undefined;
}

export function chooseSourceEditorLeaf<TLeaf>(
  candidates: SourceEditorLeafCandidate<TLeaf>[],
  targetPath: string
): TLeaf | undefined {
  return candidates.find((candidate) => candidate.sourcePath === targetPath)?.leaf;
}
