export interface TypstianSettings {
  rootPath: string;
}

export const DEFAULT_SETTINGS: TypstianSettings = {
  rootPath: ""
};

export function normalizeSettings(
  value: Partial<TypstianSettings> & {
    executablePath?: string;
    helperExecutablePath?: string;
    fontPaths?: string[];
    ignoreSystemFonts?: boolean;
  }
): TypstianSettings {
  return {
    rootPath: value.rootPath?.trim() ?? DEFAULT_SETTINGS.rootPath
  };
}
