import fs from "node:fs";
import path from "node:path";

// The font directories fontconfig's own configuration declares, which is what
// makes Typstian agree with every other application on the machine about where
// fonts live. This module is the reader for that configuration and nothing
// else: it maps the environment onto a list of directories, and never opens a
// font. `src/system-fonts.ts` decides what to do with the list.
//
// fontconfig's configuration is XML, but the only thing discovery needs from it
// is the `<dir>` elements. A regex over the comment-stripped text avoids
// pulling in a parser — and avoids depending on DOMParser, which exists in the
// renderer but not in the worker or in tests.
//
// Discovery runs synchronously on the thread that initializes the engine, so
// these bound what a hostile or merely broken fontconfig tree can cost it. A
// real fonts.conf is a few kilobytes and a conf.d holds a few dozen fragments.
export const MAX_FONTCONFIG_FILE_BYTES = 1024 * 1024;
export const MAX_FONTCONFIG_FRAGMENTS = 256;
// fontconfig configurations include each other, sometimes in a cycle. The
// visited set alone would terminate, but the depth keeps a legal deep chain
// from costing the init thread an unbounded number of synchronous reads.
export const MAX_FONTCONFIG_INCLUDE_DEPTH = 8;

// The two element kinds this reader understands. Naming the kind rather than
// passing a regex and a set of bases keeps the rules that differ between them
// in one place, where they cannot be paired up wrongly.
type FontconfigElement = "dir" | "include";

const FONTCONFIG_ELEMENT_PATTERN: Record<FontconfigElement, RegExp> = {
  dir: /<dir\b([^>]*)>([^<]*)<\/dir>/g,
  include: /<include\b([^>]*)>([^<]*)<\/include>/g,
};
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

// The bases a `~` or a `prefix="xdg"` path expands against. Not a "root": this
// file already spends that word on a configuration root, and the plugin spends
// it on discovery roots and the compilation root.
export interface FontconfigPrefixes {
  readonly home: string;
  readonly dataHome: string;
  readonly configHome: string;
}

// The two halves of the configuration, kept apart because they rank
// differently: the user's directories outrank the system's.
export interface FontconfigDirectories {
  readonly system: string[];
  readonly user: string[];
}

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

// `<dir>` and `<include>` expand `~` alike but differ on the rest, and the
// difference is derived from the element kind here rather than passed in:
// `prefix="xdg"` means $XDG_DATA_HOME for a directory and $XDG_CONFIG_HOME for
// an include, and only an include resolves a bare relative name — against the
// directory of the file declaring it. A relative `<dir>` is dropped, per AC6.
// A path that resolves to nothing absolute is dropped, not guessed at.
function expandFontconfigPath(
  value: string,
  attributes: string,
  element: FontconfigElement,
  prefixes: FontconfigPrefixes,
  file: string,
): string | undefined {
  // Only this process's own home. "~otheruser/fonts" names another account,
  // which nothing here can resolve, so it is dropped rather than rewritten
  // under $HOME.
  if (value === "~" || value.startsWith("~/")) return path.join(prefixes.home, value.slice(1));
  if (path.isAbsolute(value)) return value;
  if (/\bprefix\s*=\s*["']xdg["']/.test(attributes)) {
    return path.join(element === "include" ? prefixes.configHome : prefixes.dataHome, value);
  }
  return element === "include" ? path.join(path.dirname(file), value) : undefined;
}

// `file` is the configuration file `xml` was read from: it names the directory
// a relative include resolves against.
function parseFontconfigElements(
  xml: string,
  element: FontconfigElement,
  prefixes: FontconfigPrefixes,
  file: string,
): string[] {
  const paths: string[] = [];
  const text = inlineCdata(xml.replace(FONTCONFIG_COMMENT, ""));
  for (const match of text.matchAll(FONTCONFIG_ELEMENT_PATTERN[element])) {
    const value = decodeXmlEntities(match[2] ?? "").trim();
    if (!value) continue;
    const expanded = expandFontconfigPath(value, match[1] ?? "", element, prefixes, file);
    if (expanded) paths.push(expanded);
  }
  return paths;
}

// One scan of the whole configuration. The visited set lives here, not in a
// single recursive call, so "a file is read at most once" holds across every
// root, fragment, and include of one `fontconfigDirectories()` — a fragment
// that includes what another fragment already included costs nothing.
interface FontconfigScan {
  readonly prefixes: FontconfigPrefixes;
  readonly visited: Set<string>;
  filesRemaining: number;
}

// One configuration root contributes its own fonts.conf plus every fragment in
// its conf.d, which is where a distribution and a user alike drop declarations.
function readFontconfigRoot(directory: string, scan: FontconfigScan): string[] {
  return [
    path.join(directory, "fonts.conf"),
    ...dotConfFiles(path.join(directory, "conf.d")),
  ].flatMap((file) => readFontconfigFile(file, scan));
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

function readFontconfigFile(file: string, scan: FontconfigScan, depth = 0): string[] {
  const { prefixes, visited } = scan;
  if (
    depth > MAX_FONTCONFIG_INCLUDE_DEPTH ||
    visited.has(file) ||
    scan.filesRemaining <= 0
  ) {
    return [];
  }
  visited.add(file);
  scan.filesRemaining -= 1;
  try {
    // Size first, so an oversized file is never pulled into memory at all.
    if (fs.statSync(file).size > MAX_FONTCONFIG_FILE_BYTES) return [];
    const xml = fs.readFileSync(file, "utf8");
    const included = parseFontconfigElements(xml, "include", prefixes, file).flatMap(
      (target) =>
        // An include naming a directory means every `.conf` inside it.
        (isDirectory(target) ? dotConfFiles(target) : [target]).flatMap((next) =>
          readFontconfigFile(next, scan, depth + 1),
        ),
    );
    return [...parseFontconfigElements(xml, "dir", prefixes, file), ...included];
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

// Every `<dir>` the system's and the user's fontconfig configuration declare.
// One scan, so a file reachable from both halves is still read only once.
export function fontconfigDirectories(prefixes: FontconfigPrefixes): FontconfigDirectories {
  const scan: FontconfigScan = {
    prefixes,
    visited: new Set(),
    filesRemaining: MAX_FONTCONFIG_FRAGMENTS,
  };
  // FONTCONFIG_PATH is a search path, not a directory: fontconfig reads every
  // root on it, the way XDG_DATA_DIRS is read by the caller.
  const configurationRoots = (process.env.FONTCONFIG_PATH ?? "/etc/fonts")
    .split(path.delimiter)
    .filter(Boolean);
  // FONTCONFIG_FILE names a whole configuration and replaces the system one;
  // otherwise the system configuration lives under FONTCONFIG_PATH or /etc/fonts.
  const fontconfigFile = process.env.FONTCONFIG_FILE;
  const system = fontconfigFile
    ? // The env value is a configuration path like any other, so it expands
      // like one: `~` for this user, a relative name against a config root.
      expandConfigurationFile(fontconfigFile, prefixes.home, configurationRoots).flatMap((file) =>
        readFontconfigFile(file, scan),
      )
    : configurationRoots.flatMap((directory) => readFontconfigRoot(directory, scan));
  const user = [
    ...readFontconfigRoot(path.join(prefixes.configHome, "fontconfig"), scan),
    // fontconfig still honours this pre-XDG location, so a user whose <dir>
    // lives there is visible to every other application but would not be here.
    ...readFontconfigFile(path.join(prefixes.home, ".fonts.conf"), scan),
  ];
  return { system, user };
}
