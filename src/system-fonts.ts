import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_SYSTEM_FONT_BYTES = 64 * 1024 * 1024;

export const MAX_SYSTEM_FONT_FILES = 10_000;
export const MAX_SYSTEM_FONT_SCAN_BYTES = 2 * 1024 * 1024 * 1024;

const FONT_EXTENSIONS = new Set([".otc", ".otf", ".ttc", ".ttf"]);

export interface RegisteredSystemFonts {
  readSync(fontPath: string): Uint8Array | undefined;
  read(fontPath: string, signal?: AbortSignal): Promise<Uint8Array | undefined>;
}

async function discoverFontFiles(directories: readonly string[]): Promise<string[]> {
  const pending = [...new Set(directories)];
  const visitedDirectories = new Set<string>();
  const fonts = new Set<string>();

  while (pending.length > 0 && fonts.size < MAX_SYSTEM_FONT_FILES) {
    const directory = pending.shift();
    if (!directory) break;
    try {
      const canonicalDirectory = await fs.promises.realpath(directory);
      if (visitedDirectories.has(canonicalDirectory)) continue;
      visitedDirectories.add(canonicalDirectory);
      const entries = await fs.promises.readdir(canonicalDirectory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const candidate = path.join(canonicalDirectory, entry.name);
        if (entry.isDirectory()) {
          pending.push(candidate);
          continue;
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (!FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        try {
          const canonicalFont = await fs.promises.realpath(candidate);
          fonts.add(canonicalFont);
          if (fonts.size >= MAX_SYSTEM_FONT_FILES) break;
        } catch {
          // Broken and disappearing font links are skipped.
        }
      }
    } catch {
      // Unreadable and disappearing font directories are skipped.
    }
  }

  return [...fonts];
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
  registerFont: (fontPath: string, bytes: Uint8Array) => number | Promise<number>,
  signal?: AbortSignal,
): Promise<RegisteredSystemFonts> {
  const allowed = new Set<string>();
  let scannedBytes = 0;

  for (const fontPath of await discoverFontFiles(directories)) {
    throwIfAborted(signal);
    try {
      const stat = await fs.promises.stat(fontPath);
      if (!isUsableFont(stat)) continue;
      if (scannedBytes + stat.size > MAX_SYSTEM_FONT_SCAN_BYTES) break;
      const bytes = await fs.promises.readFile(fontPath, { signal });
      throwIfAborted(signal);
      if (bytes.byteLength > MAX_SYSTEM_FONT_BYTES) continue;
      if (scannedBytes + bytes.byteLength > MAX_SYSTEM_FONT_SCAN_BYTES) break;
      scannedBytes += bytes.byteLength;
      if (await registerFont(fontPath, bytes) >= 0) allowed.add(fontPath);
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
