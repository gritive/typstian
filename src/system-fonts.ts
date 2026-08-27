import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fontconfigDirectories } from "./fontconfig-directories";
import { MAX_RESIDENT_FONT_BYTES, planFontResidency, type FontResidencyCandidate } from "./font-residency";

// The fontconfig reader owns these; re-exported so callers of system-font
// discovery see one set of bounds rather than two modules' worth.
export {
  MAX_FONTCONFIG_FILE_BYTES,
  MAX_FONTCONFIG_FILES,
  MAX_FONTCONFIG_FRAGMENTS,
  MAX_FONTCONFIG_INCLUDE_DEPTH,
} from "./fontconfig-directories";

export const MAX_SYSTEM_FONT_BYTES = 64 * 1024 * 1024;

export const MAX_SYSTEM_FONT_FILES = 10_000;
export const MAX_SYSTEM_FONT_SCAN_BYTES = 2 * 1024 * 1024 * 1024;

const FONT_EXTENSIONS = new Set([".otc", ".otf", ".ttc", ".ttf"]);

export interface RegisteredSystemFonts {
  readSync(fontPath: string): Uint8Array | undefined;
  read(fontPath: string, signal?: AbortSignal): Promise<Uint8Array | undefined>;
}

interface DiscoveredFont {
  readonly path: string;
  readonly root: number;
}

async function discoverFontFiles(
  directories: readonly string[],
  signal?: AbortSignal,
): Promise<DiscoveredFont[]> {
  // The root index travels with each directory so the residency plan can rank
  // the user's own font directories ahead of the ones the OS ships.
  const pending = [...new Set(directories)].map((directory, root) => ({ directory, root }));
  const visitedDirectories = new Set<string>();
  const fonts = new Map<string, number>();

  while (
    pending.length > 0 &&
    fonts.size < MAX_SYSTEM_FONT_FILES &&
    visitedDirectories.size < MAX_SYSTEM_FONT_FILES
  ) {
    throwIfAborted(signal);
    const next = pending.shift();
    if (!next) break;
    try {
      const canonicalDirectory = await fs.promises.realpath(next.directory);
      throwIfAborted(signal);
      if (visitedDirectories.has(canonicalDirectory)) continue;
      visitedDirectories.add(canonicalDirectory);
      const entries = await fs.promises.readdir(canonicalDirectory, { withFileTypes: true });
      throwIfAborted(signal);
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        throwIfAborted(signal);
        const candidate = path.join(canonicalDirectory, entry.name);
        if (entry.isDirectory()) {
          pending.push({ directory: candidate, root: next.root });
          continue;
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (!FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        try {
          const canonicalFont = await fs.promises.realpath(candidate);
          throwIfAborted(signal);
          if (!fonts.has(canonicalFont)) fonts.set(canonicalFont, next.root);
          if (fonts.size >= MAX_SYSTEM_FONT_FILES) break;
        } catch {
          throwIfAborted(signal);
          // Broken and disappearing font links are skipped.
        }
      }
    } catch {
      throwIfAborted(signal);
      // Unreadable and disappearing font directories are skipped.
    }
  }

  return [...fonts].map(([fontPath, root]) => ({ path: fontPath, root }));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("System font loading was aborted.");
  error.name = "AbortError";
  throw error;
}

function isUsableFont(stat: fs.Stats): boolean {
  return stat.isFile() && stat.size > 0 && stat.size <= MAX_SYSTEM_FONT_BYTES;
}

function registeredFontReader(allowed: ReadonlySet<string>): RegisteredSystemFonts {
  return {
    readSync(fontPath) {
      if (!allowed.has(fontPath)) return undefined;
      try {
        if (fs.realpathSync(fontPath) !== fontPath) return undefined;
        const stat = fs.statSync(fontPath);
        if (!isUsableFont(stat)) return undefined;
        const bytes = fs.readFileSync(fontPath);
        return bytes.byteLength <= MAX_SYSTEM_FONT_BYTES ? bytes : undefined;
      } catch {
        return undefined;
      }
    },
    async read(fontPath, signal) {
      if (!allowed.has(fontPath)) return undefined;
      try {
        throwIfAborted(signal);
        if (await fs.promises.realpath(fontPath) !== fontPath) return undefined;
        const stat = await fs.promises.stat(fontPath);
        if (!isUsableFont(stat)) return undefined;
        const bytes = await fs.promises.readFile(fontPath, { signal });
        throwIfAborted(signal);
        return bytes.byteLength <= MAX_SYSTEM_FONT_BYTES ? bytes : undefined;
      } catch {
        throwIfAborted(signal);
        return undefined;
      }
    },
  };
}

export async function registerSystemFonts(
  directories: readonly string[],
  registerFont: (
    fontPath: string,
    bytes: Uint8Array,
    resident: boolean,
  ) => number | Promise<number>,
  signal?: AbortSignal,
  // Injectable so a test can exercise the skipped-candidate branch without a
  // 256 MiB fixture corpus.
  residencyCapBytes: number = MAX_RESIDENT_FONT_BYTES,
): Promise<RegisteredSystemFonts> {
  // Discovery and sizing run first so the residency plan can rank the whole
  // corpus before any file is read; every candidate is still read exactly once.
  const candidates: FontResidencyCandidate[] = [];
  for (const discovered of await discoverFontFiles(directories, signal)) {
    throwIfAborted(signal);
    try {
      const stat = await fs.promises.stat(discovered.path);
      if (!isUsableFont(stat)) continue;
      candidates.push({
        path: discovered.path,
        byteLength: stat.size,
        root: discovered.root,
      });
    } catch {
      throwIfAborted(signal);
      // Unreadable and disappearing fonts are skipped.
    }
  }
  // The plan may only rank what the read loop will reach: budgeting a file the
  // scan stops short of would shrink the residency below its own cap.
  const readable: FontResidencyCandidate[] = [];
  let plannedBytes = 0;
  for (const candidate of candidates) {
    if (plannedBytes + candidate.byteLength > MAX_SYSTEM_FONT_SCAN_BYTES) break;
    plannedBytes += candidate.byteLength;
    readable.push(candidate);
  }
  const resident = planFontResidency(readable, residencyCapBytes);

  const allowed = new Set<string>();
  let scannedBytes = 0;

  for (const candidate of readable) {
    throwIfAborted(signal);
    try {
      // The sizing pass ran before the plan, so re-check the file right before
      // reading it: discovery may have walked thousands of entries since, and
      // reading what is no longer a regular file can block instead of failing.
      if (!isUsableFont(await fs.promises.stat(candidate.path))) continue;
      const bytes = await fs.promises.readFile(candidate.path, { signal });
      throwIfAborted(signal);
      if (bytes.byteLength > MAX_SYSTEM_FONT_BYTES) continue;
      if (scannedBytes + bytes.byteLength > MAX_SYSTEM_FONT_SCAN_BYTES) break;
      scannedBytes += bytes.byteLength;
      const accepted = await registerFont(
        candidate.path,
        bytes,
        resident.has(candidate.path),
      );
      if (accepted >= 0) allowed.add(candidate.path);
      throwIfAborted(signal);
    } catch {
      throwIfAborted(signal);
      // Invalid, unsupported, unreadable, and disappearing fonts are skipped.
    }
  }

  return registeredFontReader(allowed);
}

export function systemFontDirectories(): string[] {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [
      path.join(home, "Library/Fonts"),
      "/Library/Fonts",
      "/Network/Library/Fonts",
      "/System/Library/Fonts",
    ];
  }
  if (process.platform === "win32") {
    const configuredWindows = process.env.WINDIR;
    const windows =
      configuredWindows && path.win32.isAbsolute(configuredWindows)
        ? configuredWindows
        : "C:\\Windows";
    const configuredLocal = process.env.LOCALAPPDATA;
    const local =
      configuredLocal && path.win32.isAbsolute(configuredLocal)
        ? configuredLocal
        : undefined;
    return [
      ...(local ? [path.join(local, "Microsoft/Windows/Fonts")] : []),
      path.join(windows, "Fonts"),
    ];
  }

  const configuredDataHome = process.env.XDG_DATA_HOME;
  const dataHome =
    configuredDataHome && path.isAbsolute(configuredDataHome)
      ? configuredDataHome
      : path.join(home, ".local/share");
  const dataDirectories = (process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share")
    .split(path.delimiter)
    .filter((directory) => path.isAbsolute(directory));
  const configuredConfigHome = process.env.XDG_CONFIG_HOME;
  const configHome =
    configuredConfigHome && path.isAbsolute(configuredConfigHome)
      ? configuredConfigHome
      : path.join(home, ".config");
  const { system: systemFontconfig, user: userFontconfig } = fontconfigDirectories({
    home,
    dataHome,
    configHome,
  });
  // A fontconfig configuration routinely re-declares a standard path, often
  // spelled differently ("/usr/share/fonts/", "//usr/share/fonts"). Dedupe on
  // the normalized path, not the string, or the same directory enters twice and
  // takes two discovery-root ranks. The first occurrence keeps its rank.
  return [...new Set([
    path.join(home, ".fonts"),
    path.join(dataHome, "fonts"),
    // The user's own configuration outranks the system's, because
    // `planFontResidency` ranks by discovery root and the user's fonts are the
    // ones a document is most likely to ask for.
    ...userFontconfig,
    ...systemFontconfig,
    ...dataDirectories.map((directory) => path.join(directory, "fonts")),
    // Under Flatpak the host's system and user fonts are bound at these mount
    // points; the sandbox's own /usr/share/fonts is the runtime's near-empty
    // set, so without these the host's fonts are invisible.
    "/run/host/fonts",
    "/run/host/local-fonts",
    "/run/host/user-fonts",
  ].filter((directory) => path.isAbsolute(directory)).map(normalizeDirectory))];
}

// One spelling per directory. `path.normalize` collapses "." segments and
// duplicate separators; the trailing separator it keeps is dropped here, since
// "/usr/share/fonts/" and "/usr/share/fonts" are the same directory.
function normalizeDirectory(directory: string): string {
  const normalized = path.normalize(directory);
  return normalized.length > 1 && normalized.endsWith(path.sep)
    ? normalized.slice(0, -1)
    : normalized;
}
