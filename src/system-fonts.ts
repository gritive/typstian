import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MAX_RESIDENT_FONT_BYTES, planFontResidency, type FontResidencyCandidate } from "./font-residency";

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
  // Injectable so a test can exercise the skipped-candidate branch without a
  // 256 MiB fixture corpus.
  residencyCapBytes: number = MAX_RESIDENT_FONT_BYTES,
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

// fontconfig's configuration is XML, but the only thing discovery needs from it
// is the `<dir>` elements. A regex over the comment-stripped text avoids
// pulling in a parser — and avoids depending on DOMParser, which exists in the
// renderer but not in the worker or in tests.
// Discovery runs synchronously on the thread that initializes the engine, so
// these bound what a hostile or merely broken fontconfig tree can cost it. A
// real fonts.conf is a few kilobytes and a conf.d holds a few dozen fragments.
export const MAX_FONTCONFIG_FILE_BYTES = 1024 * 1024;
export const MAX_FONTCONFIG_FRAGMENTS = 256;
// fontconfig configurations include each other, sometimes in a cycle. The
// visited set alone would terminate, but the depth keeps a legal deep chain
// from costing the init thread an unbounded number of synchronous reads.
export const MAX_FONTCONFIG_INCLUDE_DEPTH = 8;

const FONTCONFIG_DIR_ELEMENT = /<dir\b([^>]*)>([^<]*)<\/dir>/g;
const FONTCONFIG_INCLUDE_ELEMENT = /<include\b([^>]*)>([^<]*)<\/include>/g;
const FONTCONFIG_COMMENT = /<!--[\s\S]*?-->/g;
const FONTCONFIG_CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
const XML_ENTITY = /&(amp|lt|gt|quot|apos);/g;
const XML_ENTITY_VALUES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

// The element regexes capture `[^<]*`, so a CDATA section would break the match
// and its markup would survive into the path. Re-escaping the section's text
// puts it back on the ordinary path: the entity decode below undoes exactly
// this escape, so the round trip is lossless.
function inlineCdata(xml: string): string {
  return xml.replace(FONTCONFIG_CDATA, (_match, text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  );
}

// `&` is legal in a filename, so `<dir>/opt/rock&amp;roll</dir>` names a real
// directory that a raw read would miss. One left-to-right pass, so `&amp;lt;`
// correctly yields `&lt;` rather than `<`.
function decodeXmlEntities(text: string): string {
  return text.replace(XML_ENTITY, (match, name: string) => XML_ENTITY_VALUES[name] ?? match);
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// The bases a `~` or a `prefix="xdg"` path expands against. Not a "root": this
// file already spends that word on a configuration root, and the plugin spends
// it on discovery roots and the compilation root.
interface FontconfigPrefixes {
  readonly home: string;
  readonly dataHome: string;
  readonly configHome: string;
}

// What a relative path in one kind of element means. `<dir>` and `<include>`
// expand `~` alike but differ on the rest: their `prefix="xdg"` bases are
// $XDG_DATA_HOME and $XDG_CONFIG_HOME respectively, and only an include
// resolves a bare relative name — against the directory of the file declaring
// it. A `<dir>` with no base leaves relative values dropped, per AC6.
interface FontconfigBases {
  readonly xdg: string;
  readonly relative?: string;
}

// A path that resolves to nothing absolute is dropped, not guessed at.
function expandFontconfigPath(
  value: string,
  attributes: string,
  prefixes: FontconfigPrefixes,
  bases: FontconfigBases,
): string | undefined {
  // Only this process's own home. "~otheruser/fonts" names another account,
  // which nothing here can resolve, so it is dropped rather than rewritten
  // under $HOME.
  if (value === "~" || value.startsWith("~/")) return path.join(prefixes.home, value.slice(1));
  if (path.isAbsolute(value)) return value;
  if (/\bprefix\s*=\s*["']xdg["']/.test(attributes)) return path.join(bases.xdg, value);
  return bases.relative ? path.join(bases.relative, value) : undefined;
}

function parseFontconfigElements(
  xml: string,
  element: RegExp,
  prefixes: FontconfigPrefixes,
  bases: FontconfigBases,
): string[] {
  const paths: string[] = [];
  const text = inlineCdata(xml.replace(FONTCONFIG_COMMENT, ""));
  for (const match of text.matchAll(element)) {
    const value = decodeXmlEntities(match[2] ?? "").trim();
    if (!value) continue;
    const expanded = expandFontconfigPath(value, match[1] ?? "", prefixes, bases);
    if (expanded) paths.push(expanded);
  }
  return paths;
}

// One configuration root contributes its own fonts.conf plus every fragment in
// its conf.d, which is where a distribution and a user alike drop declarations.
function readFontconfigRoot(directory: string, prefixes: FontconfigPrefixes): string[] {
  return [
    path.join(directory, "fonts.conf"),
    ...dotConfFiles(path.join(directory, "conf.d")),
  ].flatMap((file) => readFontconfigFile(file, prefixes));
}

// The `.conf` files a directory contributes: a root's conf.d, and what an
// `<include>` naming a directory resolves to.
function dotConfFiles(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory)
      .filter((entry) => entry.endsWith(".conf"))
      .sort()
      // Sorted first, so the bound cuts the tail rather than an arbitrary set:
      // fontconfig's own numeric prefixes put the important fragments early.
      .slice(0, MAX_FONTCONFIG_FRAGMENTS)
      .map((entry) => path.join(directory, entry));
  } catch {
    return [];
  }
}

function readFontconfigFile(
  file: string,
  prefixes: FontconfigPrefixes,
  visited: Set<string> = new Set(),
  depth = 0,
): string[] {
  if (depth > MAX_FONTCONFIG_INCLUDE_DEPTH || visited.has(file)) return [];
  visited.add(file);
  try {
    // Size first, so an oversized file is never pulled into memory at all.
    if (fs.statSync(file).size > MAX_FONTCONFIG_FILE_BYTES) return [];
    const xml = fs.readFileSync(file, "utf8");
    const included = parseFontconfigElements(
      xml,
      FONTCONFIG_INCLUDE_ELEMENT,
      prefixes,
      { xdg: prefixes.configHome, relative: path.dirname(file) },
    ).flatMap(
      (target) =>
        // An include naming a directory means every `.conf` inside it.
        (isDirectory(target) ? dotConfFiles(target) : [target]).flatMap((next) =>
          readFontconfigFile(next, prefixes, visited, depth + 1),
        ),
    );
    return [
      ...parseFontconfigElements(xml, FONTCONFIG_DIR_ELEMENT, prefixes, {
        xdg: prefixes.dataHome,
      }),
      ...included,
    ];
  } catch {
    // A missing, unreadable, or malformed configuration is not an error worth
    // failing discovery over: the standard paths still stand on their own.
    return [];
  }
}

// $FONTCONFIG_FILE names one configuration, the way `FcConfigGetFilename`
// reads it: `~` is this user's home, and a bare name is looked for in each
// configuration root, so the caller tries them in order.
function expandConfigurationFile(
  value: string,
  home: string,
  configurationRoots: readonly string[],
): string[] {
  if (value === "~" || value.startsWith("~/")) return [path.join(home, value.slice(1))];
  if (path.isAbsolute(value)) return [value];
  return configurationRoots.map((directory) => path.join(directory, value));
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
  // FONTCONFIG_FILE names a whole configuration and replaces the system one;
  // otherwise the system configuration lives under FONTCONFIG_PATH or /etc/fonts.
  const fontconfigFile = process.env.FONTCONFIG_FILE;
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  const prefixes = { home, dataHome, configHome };
  // FONTCONFIG_PATH is a search path, not a directory: fontconfig reads every
  // root on it, the way XDG_DATA_DIRS is read above.
  const configurationRoots = (process.env.FONTCONFIG_PATH ?? "/etc/fonts")
    .split(path.delimiter)
    .filter(Boolean);
  const systemFontconfig = fontconfigFile
    ? // The env value is a configuration path like any other, so it expands
      // like one: `~` for this user, a relative name against a config root.
      expandConfigurationFile(fontconfigFile, home, configurationRoots).flatMap((file) =>
        readFontconfigFile(file, prefixes),
      )
    : configurationRoots.flatMap((directory) => readFontconfigRoot(directory, prefixes));
  const userFontconfig = [
    ...readFontconfigRoot(path.join(configHome, "fontconfig"), prefixes),
    // fontconfig still honours this pre-XDG location, so a user whose <dir>
    // lives there is visible to every other application but would not be here.
    ...readFontconfigFile(path.join(home, ".fonts.conf"), prefixes),
  ];
  // A fontconfig configuration routinely re-declares a standard path, and the
  // first occurrence is the ranking that matters, so the Set keeps it.
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
  ])];
}
