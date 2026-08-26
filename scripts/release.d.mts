export declare function nextVersion(current: string, bump: string): string;

export interface ReleaseFiles {
  manifest: { version: string; minAppVersion: string } & Record<string, unknown>;
  packageJson: { version: string } & Record<string, unknown>;
  packageLock: {
    version: string;
    packages: Record<string, { version: string } & Record<string, unknown>>;
  } & Record<string, unknown>;
  versions: Record<string, string>;
}

export declare function releaseEdits(files: ReleaseFiles, version: string): ReleaseFiles;
