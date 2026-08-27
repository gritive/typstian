import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { planFontResidency, type FontResidencyCandidate } from "./font-residency";

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
): Promise<DiscoveredFont[]> {
  // The root index travels with each directory so the residency plan can rank
  // the user's own font directories ahead of the ones the OS ships.
  const pending = [...new Set(directories)].map((directory, root) => ({ directory, root }));
  const visitedDirectories = new Set<string>();
  const fonts = new Map<string, number>();

  while (pending.length > 0 && fonts.size < MAX_SYSTEM_FONT_FILES) {
    const next = pending.shift();
    if (!next) break;
    try {
      const canonicalDirectory = await fs.promises.realpath(next.directory);
      if (visitedDirectories.has(canonicalDirectory)) continue;
      visitedDirectories.add(canonicalDirectory);
      const entries = await fs.promises.readdir(canonicalDirectory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const candidate = path.join(canonicalDirectory, entry.name);
        if (entry.isDirectory()) {
          pending.push({ directory: candidate, root: next.root });
          continue;
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (!FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        try {
          const canonicalFont = await fs.promises.realpath(candidate);
          if (!fonts.has(canonicalFont)) fonts.set(canonicalFont, next.root);
          if (fonts.size >= MAX_SYSTEM_FONT_FILES) break;
        } catch {
          // Broken and disappearing font links are skipped.
        }
      }
    } catch {
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
): Promise<RegisteredSystemFonts> {
  // Discovery and sizing run first so the residency plan can rank the whole
  // corpus before any file is read; every candidate is still read exactly once.
  const candidates: FontResidencyCandidate[] = [];
  for (const discovered of await discoverFontFiles(directories)) {
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
  const resident = planFontResidency(readable);

  const allowed = new Set<string>();
  let scannedBytes = 0;

  for (const candidate of readable) {
    throwIfAborted(signal);
    try {
      if (scannedBytes + candidate.byteLength > MAX_SYSTEM_FONT_SCAN_BYTES) break;
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
    const windows = process.env.WINDIR ?? "C:\\Windows";
    const local = process.env.LOCALAPPDATA;
    return [
      ...(local ? [path.join(local, "Microsoft/Windows/Fonts")] : []),
      path.join(windows, "Fonts"),
    ];
  }

  const dataHome = process.env.XDG_DATA_HOME ?? path.join(home, ".local/share");
  const dataDirectories = (process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share")
    .split(path.delimiter)
    .filter(Boolean);
  return [
    path.join(home, ".fonts"),
    path.join(dataHome, "fonts"),
    ...dataDirectories.map((directory) => path.join(directory, "fonts")),
  ];
}
