export interface ReleaseCommit {
  subject: string;
  hash: string;
}

export interface ReleaseNotesContext {
  previousTag: string | undefined;
  tag: string;
  repository: string;
}

export declare function renderReleaseNotes(
  commits: ReleaseCommit[],
  context: ReleaseNotesContext,
): string;
